package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"helium-sync/internal/store"
)

// Realtime protocol (JSON text frames over /api/v1/ws):
//
//	client → {"t":"hello","token":"…","colls":["bm","lt"]}   (first frame, ≤10s)
//	server → {"t":"ready","device":"…","seq":N,"gc":G,"online":[…]}
//	client → {"t":"pull","id":1,"since":N,"limit":1000,"sub":true}
//	server → {"t":"pulled","id":1,"records":[…],"more":bool,"seq":N}
//	client → {"t":"push","id":2,"writes":[{"c":"bm","id":"…","d":"…"}]}
//	server → {"t":"ack","id":2,"seqs":[…],"conflicts":[…],"seq":N}
//	server → {"t":"changes","records":[…],"seq":N}           (other devices' writes)
//	server → {"t":"presence","online":[deviceIds]}
//	client → {"t":"ping"}  server → {"t":"pong"}
//
// Ordering: all frames sent to a connection are produced while holding the
// user's lock, in sequence-number order. A connection only receives
// "changes" once it has caught up (a "sub" pull answered with more=false),
// so a client never sees a gap or an older version after a newer one.
// Pulls without "sub" (e.g. back-filling one collection) do not subscribe.

// protocolVersion is bumped only for incompatible protocol changes. Messages
// and fields are otherwise added in a backward-compatible way: unknown ones
// are ignored on both sides.
const protocolVersion = 1

// maxConnsPerUser bounds what one account (or a stolen token) can hold open.
const maxConnsPerUser = 32

const (
	closeAuth       websocket.StatusCode = 4001 // re-login required
	closeSlow       websocket.StatusCode = 4008 // reconnect and resume
	maxWritesPerReq                      = 1000
	sendQueue                            = 1024
)

var (
	collRE = regexp.MustCompile(`^[a-z0-9]{1,16}$`)
	ridRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

type hub struct {
	s     *Server
	mu    sync.Mutex
	users map[int64]*userHub
}

type userHub struct {
	mu    sync.Mutex // orders DB writes/reads with fan-out for this user
	conns map[*wsConn]struct{}
}

func newHub(s *Server) *hub { return &hub{s: s, users: map[int64]*userHub{}} }

// get returns the user's hub. Hubs are never removed, so every goroutine
// working for a user agrees on the same lock.
func (h *hub) get(uid int64) *userHub {
	h.mu.Lock()
	defer h.mu.Unlock()
	uh, ok := h.users[uid]
	if !ok {
		uh = &userHub{conns: map[*wsConn]struct{}{}}
		h.users[uid] = uh
	}
	return uh
}

func (h *hub) online(uid int64) []string {
	uh := h.get(uid)
	uh.mu.Lock()
	defer uh.mu.Unlock()
	return uh.onlineLocked()
}

func (uh *userHub) onlineLocked() []string {
	set := map[string]bool{}
	for c := range uh.conns {
		set[c.dev.ID] = true
	}
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func (uh *userHub) presenceLocked() {
	msg, _ := json.Marshal(map[string]any{"t": "presence", "online": uh.onlineLocked()})
	for c := range uh.conns {
		c.enqueue(msg)
	}
}

func (h *hub) broadcastPresence(uid int64) {
	uh := h.get(uid)
	uh.mu.Lock()
	uh.presenceLocked()
	uh.mu.Unlock()
}

func (h *hub) disconnect(uid int64, match func(*wsConn) bool) {
	uh := h.get(uid)
	uh.mu.Lock()
	var victims []*wsConn
	for c := range uh.conns {
		if match(c) {
			victims = append(victims, c)
		}
	}
	uh.mu.Unlock()
	for _, c := range victims {
		c.close(closeAuth, "signed out")
	}
}

func (h *hub) disconnectDevice(uid int64, dev string) {
	h.disconnect(uid, func(c *wsConn) bool { return c.dev.ID == dev })
}

func (h *hub) disconnectOthers(uid int64, keep string) {
	h.disconnect(uid, func(c *wsConn) bool { return c.dev.ID != keep })
}

func (h *hub) closeAll() {
	h.mu.Lock()
	var all []*wsConn
	for _, uh := range h.users {
		uh.mu.Lock()
		for c := range uh.conns {
			all = append(all, c)
		}
		uh.mu.Unlock()
	}
	h.mu.Unlock()
	for _, c := range all {
		c.close(websocket.StatusGoingAway, "server shutting down")
	}
}

// ---------------------------------------------------------------------------
// Shared push/pull logic

type pushError struct {
	code int
	kind string
	msg  string
}

func (s *Server) validateWrites(writes []store.Write) *pushError {
	if len(writes) == 0 || len(writes) > maxWritesPerReq {
		return &pushError{http.StatusBadRequest, "bad_request", "a push carries 1-1000 writes"}
	}
	for _, w := range writes {
		if !collRE.MatchString(w.Coll) || !ridRE.MatchString(w.ID) {
			return &pushError{http.StatusBadRequest, "bad_request", "invalid collection or record id"}
		}
		if len(w.Data) > s.cfg.MaxRecordBytes {
			return &pushError{http.StatusRequestEntityTooLarge, "too_large", "record exceeds the size limit"}
		}
	}
	return nil
}

type recordsMsg struct {
	T       string         `json:"t"`
	Records []store.Record `json:"records"`
	Seq     int64          `json:"seq"`
}

// push stores writes and fans them out. origin (may be nil for HTTP) gets an
// ack instead of the change broadcast.
func (s *Server) push(ctx context.Context, dev *store.Device, writes []store.Write, origin *wsConn, reqID int64) (*store.PushResult, *pushError) {
	if perr := s.validateWrites(writes); perr != nil {
		return nil, perr
	}
	uh := s.hub.get(dev.UserID)
	uh.mu.Lock()
	defer uh.mu.Unlock()
	res, err := s.store.Push(ctx, dev.UserID, dev, writes, s.cfg.QuotaBytes)
	if errors.Is(err, store.ErrQuotaExceeded) {
		return nil, &pushError{http.StatusInsufficientStorage, "quota_exceeded", "storage quota exceeded"}
	}
	if err != nil {
		s.log.Error("push", "err", err)
		return nil, &pushError{http.StatusInternalServerError, "internal", ""}
	}
	if origin != nil {
		ack, _ := json.Marshal(map[string]any{"t": "ack", "id": reqID, "seqs": res.Seqs, "conflicts": res.Conflicts, "seq": res.MaxSeq})
		origin.enqueue(ack)
	}
	if len(res.Applied) > 0 {
		var full []byte
		filtered := map[string][]byte{}
		for c := range uh.conns {
			if c == origin || !c.live {
				continue
			}
			if c.colls == nil {
				if full == nil {
					full, _ = json.Marshal(recordsMsg{T: "changes", Records: res.Applied, Seq: res.MaxSeq})
				}
				c.enqueue(full)
				continue
			}
			msg, ok := filtered[c.collsKey]
			if !ok {
				var recs []store.Record
				for _, r := range res.Applied {
					if c.colls[r.Coll] {
						recs = append(recs, r)
					}
				}
				if recs == nil {
					recs = []store.Record{}
				}
				msg, _ = json.Marshal(recordsMsg{T: "changes", Records: recs, Seq: res.MaxSeq})
				filtered[c.collsKey] = msg
			}
			c.enqueue(msg)
		}
	}
	return res, nil
}

func parseColls(cs []string) (map[string]bool, string) {
	if len(cs) == 0 {
		return nil, ""
	}
	m := map[string]bool{}
	for _, c := range cs {
		if collRE.MatchString(c) {
			m[c] = true
		}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return m, strings.Join(keys, ",")
}

// ---------------------------------------------------------------------------
// HTTP sync endpoints (fallback for clients that cannot keep a socket open)

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	var colls []string
	if c := r.URL.Query().Get("colls"); c != "" {
		colls = strings.Split(c, ",")
	}
	recs, more, err := s.store.Pull(r.Context(), d.UserID, since, limit, colls)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	seq, gc, _ := s.store.UserSeq(r.Context(), d.UserID)
	if more && len(recs) > 0 {
		seq = recs[len(recs)-1].Seq
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": recs, "more": more, "seq": seq, "gc": gc})
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	var req struct {
		Writes []store.Write `json:"writes"`
	}
	if !readJSON(w, r, 16<<20, &req) {
		return
	}
	res, perr := s.push(r.Context(), d, req.Writes, nil, 0)
	if perr != nil {
		writeErr(w, perr.code, perr.kind, perr.msg)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ---------------------------------------------------------------------------
// WebSocket connections

type wsConn struct {
	s        *Server
	c        *websocket.Conn
	dev      *store.Device
	send     chan []byte
	live     bool // guarded by userHub.mu
	colls    map[string]bool
	collsKey string
	ctx      context.Context
	cancel   context.CancelFunc
	once     sync.Once
}

func (c *wsConn) enqueue(msg []byte) {
	select {
	case c.send <- msg:
	default:
		// The client is not keeping up. Dropping messages would break
		// ordering, so disconnect; it resumes from its cursor.
		go c.close(closeSlow, "send queue overflow")
	}
}

func (c *wsConn) close(code websocket.StatusCode, reason string) {
	c.once.Do(func() {
		c.cancel()
		c.c.Close(code, reason)
	})
}

type clientMsg struct {
	T      string        `json:"t"`
	ID     int64         `json:"id"`
	Token  string        `json:"token"`
	Since  int64         `json:"since"`
	Limit  int           `json:"limit"`
	Colls  []string      `json:"colls"`
	Sub    bool          `json:"sub"`
	Writes []store.Write `json:"writes"`
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Websites must not be able to talk to the sync socket; the
		// extension (and non-browser clients without Origin) may.
		OriginPatterns:  []string{"chrome-extension://*"},
		CompressionMode: websocket.CompressionDisabled, // payloads are ciphertext
	})
	if err != nil {
		return
	}
	c.SetReadLimit(16 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Authenticate with the first frame, so tokens never appear in URLs or
	// proxy logs.
	hctx, hcancel := context.WithTimeout(ctx, 10*time.Second)
	var hello clientMsg
	_, data, err := c.Read(hctx)
	hcancel()
	if err != nil || json.Unmarshal(data, &hello) != nil || hello.T != "hello" {
		c.Close(websocket.StatusPolicyViolation, "expected hello")
		return
	}
	if !s.authLimiter.peek(s.clientIP(r)) {
		c.Close(websocket.StatusTryAgainLater, "rate limited")
		return
	}
	dev, err := s.store.DeviceByToken(ctx, hello.Token)
	if err != nil {
		s.authLimiter.allow(s.clientIP(r))
		c.Close(closeAuth, "invalid or revoked token")
		return
	}
	_ = s.store.TouchDevice(ctx, dev.ID)

	conn := &wsConn{s: s, c: c, dev: dev, send: make(chan []byte, sendQueue), ctx: ctx, cancel: cancel}
	conn.colls, conn.collsKey = parseColls(hello.Colls)

	uh := s.hub.get(dev.UserID)
	uh.mu.Lock()
	if len(uh.conns) >= maxConnsPerUser {
		uh.mu.Unlock()
		c.Close(websocket.StatusTryAgainLater, "too many connections for this account")
		return
	}
	seq, gc, _ := s.store.UserSeq(ctx, dev.UserID)
	uh.conns[conn] = struct{}{}
	ready, _ := json.Marshal(map[string]any{"t": "ready", "proto": protocolVersion, "version": Version, "device": dev.ID, "seq": seq, "gc": gc, "online": uh.onlineLocked()})
	conn.enqueue(ready)
	uh.presenceLocked()
	uh.mu.Unlock()

	defer func() {
		uh.mu.Lock()
		delete(uh.conns, conn)
		uh.presenceLocked()
		uh.mu.Unlock()
		conn.close(websocket.StatusNormalClosure, "")
	}()

	go conn.writer()
	conn.reader(uh)
}

func (c *wsConn) writer() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case msg := <-c.send:
			wctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
			err := c.c.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				c.close(websocket.StatusInternalError, "write failed")
				return
			}
		}
	}
}

func (c *wsConn) reader(uh *userHub) {
	s := c.s
	lastCheck := time.Now()
	for {
		// Clients ping every ~20s; a silent connection is dead.
		rctx, cancel := context.WithTimeout(c.ctx, 75*time.Second)
		_, data, err := c.c.Read(rctx)
		cancel()
		if err != nil {
			return
		}
		var m clientMsg
		if err := json.Unmarshal(data, &m); err != nil {
			c.close(websocket.StatusUnsupportedData, "invalid JSON")
			return
		}
		// Revocations from the admin CLI happen outside this process, so
		// re-validate the device now and then.
		if time.Since(lastCheck) > time.Minute {
			lastCheck = time.Now()
			if ok, err := s.store.DeviceExists(c.ctx, c.dev.ID); err == nil && !ok {
				c.close(closeAuth, "device revoked")
				return
			}
			_ = s.store.TouchDevice(c.ctx, c.dev.ID)
		}
		switch m.T {
		case "ping":
			c.enqueue([]byte(`{"t":"pong"}`))
		case "pull":
			colls := m.Colls
			if colls == nil && c.colls != nil {
				for k := range c.colls {
					colls = append(colls, k)
				}
			}
			uh.mu.Lock()
			recs, more, err := s.store.Pull(c.ctx, c.dev.UserID, m.Since, m.Limit, colls)
			if err != nil {
				uh.mu.Unlock()
				s.log.Error("pull", "err", err)
				c.enqueue(errMsg(m.ID, "internal", ""))
				continue
			}
			seq := int64(0)
			if more {
				seq = recs[len(recs)-1].Seq
			} else {
				seq, _, _ = s.store.UserSeq(c.ctx, c.dev.UserID)
				if m.Sub {
					c.live = true
				}
			}
			msg, _ := json.Marshal(map[string]any{"t": "pulled", "id": m.ID, "records": recs, "more": more, "seq": seq})
			c.enqueue(msg)
			uh.mu.Unlock()
		case "push":
			if _, perr := s.push(c.ctx, c.dev, m.Writes, c, m.ID); perr != nil {
				c.enqueue(errMsg(m.ID, perr.kind, perr.msg))
			}
		default:
			c.enqueue(errMsg(m.ID, "bad_request", "unknown message type"))
		}
	}
}

func errMsg(id int64, kind, msg string) []byte {
	b, _ := json.Marshal(map[string]any{"t": "error", "id": id, "error": kind, "message": msg})
	return b
}
