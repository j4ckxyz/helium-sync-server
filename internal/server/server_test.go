package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"helium-sync/internal/crx"
	"helium-sync/internal/store"
)

type env struct {
	t   testing.TB
	srv *Server
	ts  *httptest.Server
	st  *store.Store
}

func newEnv(t testing.TB, mutate ...func(*Config)) *env {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir + "/db.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		DataDir:      dir,
		Registration: "open",
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		ExtensionFS: fstest.MapFS{
			"manifest.json": {Data: []byte(`{"manifest_version":3,"name":"Helium Sync","version":"1.2.3"}`)},
			"background.js": {Data: []byte(`console.log(1)`)},
			"embed.go":      {Data: []byte(`package x`)},
		},
		WebFS: fstest.MapFS{
			"index.html": {Data: []byte(`<p>{{.URL}} {{.ExtensionID}} {{.TweakSh}}</p>`)},
		},
	}
	for _, m := range mutate {
		m(&cfg)
	}
	srv, err := New(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		srv.Close()
		ts.Close()
		st.Close()
	})
	return &env{t: t, srv: srv, ts: ts, st: st}
}

func (e *env) do(method, path, token string, body any, out any) int {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func rnd(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

type account struct {
	user, token, device string
	authKey             []byte
}

func (e *env) register(user string) account {
	e.t.Helper()
	auth := rnd(32)
	var resp sessionResp
	code := e.do("POST", "/api/v1/register", "", registerReq{
		Username: user, Salt: rnd(16), Iterations: 600000, AuthKey: auth, WrappedKey: rnd(60), DeviceName: "first",
	}, &resp)
	if code != 200 {
		e.t.Fatalf("register %s: %d", user, code)
	}
	return account{user, resp.Token, resp.DeviceID, auth}
}

func (e *env) login(a account, name string) account {
	e.t.Helper()
	var resp sessionResp
	if code := e.do("POST", "/api/v1/login", "", loginReq{Username: a.user, AuthKey: a.authKey, DeviceName: name}, &resp); code != 200 {
		e.t.Fatalf("login: %d", code)
	}
	return account{a.user, resp.Token, resp.DeviceID, a.authKey}
}

func TestRegisterLoginFlow(t *testing.T) {
	e := newEnv(t)
	a := e.register("alice")

	var pre preloginResp
	e.do("POST", "/api/v1/prelogin", "", preloginReq{Username: "alice"}, &pre)
	var pre2 preloginResp
	e.do("POST", "/api/v1/prelogin", "", preloginReq{Username: "nobody"}, &pre2)
	var pre3 preloginResp
	e.do("POST", "/api/v1/prelogin", "", preloginReq{Username: "nobody"}, &pre3)
	if len(pre2.Salt) != 16 || !bytes.Equal(pre2.Salt, pre3.Salt) || pre2.Iterations != defaultKDFIters {
		t.Fatal("unknown users must get a stable fake salt")
	}

	if code := e.do("POST", "/api/v1/login", "", loginReq{Username: "alice", AuthKey: rnd(32)}, nil); code != 401 {
		t.Fatalf("bad password: %d", code)
	}
	var sess sessionResp
	if code := e.do("POST", "/api/v1/login", "", loginReq{Username: "ALICE", AuthKey: a.authKey, DeviceName: "laptop"}, &sess); code != 200 {
		t.Fatalf("login: %d", code)
	}
	if len(sess.WrappedKey) != 60 || sess.Token == a.token {
		t.Fatal("login must return wrapped key and a new token")
	}
	var acct map[string]any
	if code := e.do("GET", "/api/v1/account", sess.Token, nil, &acct); code != 200 || len(acct["devices"].([]any)) != 2 {
		t.Fatalf("account: %d %v", code, acct)
	}
	if code := e.do("POST", "/api/v1/register", "", registerReq{Username: "alice", Salt: rnd(16), Iterations: 600000, AuthKey: rnd(32), WrappedKey: rnd(60)}, nil); code != 409 {
		t.Fatalf("duplicate: %d", code)
	}
	// Revoke the first device from the second.
	if code := e.do("DELETE", "/api/v1/devices/"+a.device, sess.Token, nil, nil); code != 204 {
		t.Fatalf("revoke: %d", code)
	}
	if code := e.do("GET", "/api/v1/account", a.token, nil, nil); code != 401 {
		t.Fatal("revoked token still works")
	}
}

func TestInviteRegistration(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.Registration = "invite" })
	body := registerReq{Username: "bob", Salt: rnd(16), Iterations: 600000, AuthKey: rnd(32), WrappedKey: rnd(60)}
	if code := e.do("POST", "/api/v1/register", "", body, nil); code != 403 {
		t.Fatalf("no invite: %d", code)
	}
	e.st.CreateInvite(context.Background(), "INV-ITE1", 1, time.Hour, "")
	body.Invite = "inv-ite1"
	if code := e.do("POST", "/api/v1/register", "", body, nil); code != 200 {
		t.Fatalf("with invite: %d", code)
	}
	body.Username = "bob2"
	if code := e.do("POST", "/api/v1/register", "", body, nil); code != 403 {
		t.Fatalf("reused invite: %d", code)
	}
}

func TestPasswordChange(t *testing.T) {
	e := newEnv(t)
	a := e.register("carol")
	b := e.login(a, "other")
	newAuth := rnd(32)
	req := passwordReq{AuthKey: a.authKey, Salt: rnd(16), Iterations: 700000, NewAuthKey: newAuth, WrappedKey: rnd(60)}
	if code := e.do("POST", "/api/v1/account/password", a.token, req, nil); code != 204 {
		t.Fatalf("change: %d", code)
	}
	if code := e.do("GET", "/api/v1/account", b.token, nil, nil); code != 401 {
		t.Fatal("other devices must be signed out")
	}
	if code := e.do("GET", "/api/v1/account", a.token, nil, nil); code != 200 {
		t.Fatal("current device stays signed in")
	}
	if code := e.do("POST", "/api/v1/login", "", loginReq{Username: "carol", AuthKey: a.authKey}, nil); code != 401 {
		t.Fatal("old password still accepted")
	}
	if code := e.do("POST", "/api/v1/login", "", loginReq{Username: "carol", AuthKey: newAuth}, nil); code != 200 {
		t.Fatal("new password rejected")
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := newEnv(t)
	e.register("dan")
	var last int
	for i := 0; i < 12; i++ {
		last = e.do("POST", "/api/v1/login", "", loginReq{Username: "dan", AuthKey: rnd(32)}, nil)
	}
	if last != 429 {
		t.Fatalf("expected lockout, got %d", last)
	}
}

// ---------------------------------------------------------------------------
// WebSocket

type wsClient struct {
	t    testing.TB
	c    *websocket.Conn
	msgs chan map[string]json.RawMessage
	id   int64
}

func (e *env) dial(token string, colls ...string) *wsClient {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, strings.Replace(e.ts.URL, "http", "ws", 1)+"/api/v1/ws", nil)
	if err != nil {
		e.t.Fatal(err)
	}
	c.SetReadLimit(64 << 20)
	w := &wsClient{t: e.t, c: c, msgs: make(chan map[string]json.RawMessage, 1000)}
	go func() {
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				close(w.msgs)
				return
			}
			var m map[string]json.RawMessage
			json.Unmarshal(data, &m)
			w.msgs <- m
		}
	}()
	w.send(map[string]any{"t": "hello", "token": token, "colls": colls})
	return w
}

func (w *wsClient) send(v any) {
	b, _ := json.Marshal(v)
	if err := w.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		w.t.Fatal(err)
	}
}

func (w *wsClient) next(typ string) map[string]json.RawMessage {
	w.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case m, ok := <-w.msgs:
			if !ok {
				w.t.Fatalf("connection closed waiting for %s", typ)
			}
			var t string
			json.Unmarshal(m["t"], &t)
			if t == typ {
				return m
			}
		case <-timeout:
			w.t.Fatalf("timeout waiting for %s", typ)
		}
	}
}

func (w *wsClient) pullAll(since int64) ([]store.Record, int64) {
	var all []store.Record
	for {
		w.id++
		w.send(map[string]any{"t": "pull", "id": w.id, "since": since, "limit": 2, "sub": true})
		m := w.next("pulled")
		var recs []store.Record
		var more bool
		json.Unmarshal(m["records"], &recs)
		json.Unmarshal(m["more"], &more)
		json.Unmarshal(m["seq"], &since)
		all = append(all, recs...)
		if !more {
			return all, since
		}
	}
}

func TestWebSocketSync(t *testing.T) {
	e := newEnv(t)
	a := e.register("erin")
	b := e.login(a, "desktop")

	c1 := e.dial(a.token)
	c1.next("ready")
	c1.pullAll(0)

	// Pre-existing data for c2's catch-up.
	c1.send(map[string]any{"t": "push", "id": 1, "writes": []store.Write{
		{Coll: "bm", ID: "a", Data: []byte("A")}, {Coll: "bm", ID: "b", Data: []byte("B")}, {Coll: "h", ID: "c", Data: []byte("C")},
	}})
	ack := c1.next("ack")
	var seqs []int64
	json.Unmarshal(ack["seqs"], &seqs)
	if fmt.Sprint(seqs) != "[1 2 3]" {
		t.Fatalf("seqs %v", seqs)
	}

	c2 := e.dial(b.token)
	ready := c2.next("ready")
	var online []string
	json.Unmarshal(ready["online"], &online)
	if len(online) != 2 {
		t.Fatalf("presence %v", online)
	}
	recs, cursor := c2.pullAll(0)
	if len(recs) != 3 || cursor != 3 {
		t.Fatalf("catch-up: %d records cursor %d", len(recs), cursor)
	}

	// Realtime: c1 pushes, c2 receives a change frame.
	start := time.Now()
	c1.send(map[string]any{"t": "push", "id": 2, "writes": []store.Write{{Coll: "lt", ID: "tab1", Data: []byte("T")}}})
	ch := c2.next("changes")
	t.Logf("fan-out latency: %v", time.Since(start))
	var got []store.Record
	json.Unmarshal(ch["records"], &got)
	if len(got) != 1 || got[0].ID != "tab1" || got[0].Seq != 4 || got[0].Device != a.device {
		t.Fatalf("%+v", got)
	}
	c1.next("ack")

	// Collection filtering: a client subscribed only to "bm" gets an empty
	// frame (to advance its cursor) for other collections.
	c3 := e.dial(b.token, "bm")
	c3.next("ready")
	c3.pullAll(cursor)
	c1.send(map[string]any{"t": "push", "id": 3, "writes": []store.Write{{Coll: "h", ID: "x", Data: []byte("1")}}})
	ch = c3.next("changes")
	json.Unmarshal(ch["records"], &got)
	if len(got) != 0 {
		t.Fatalf("filter leaked %+v", got)
	}

	// Invalid writes are rejected.
	c1.send(map[string]any{"t": "push", "id": 4, "writes": []store.Write{{Coll: "BAD!", ID: "x"}}})
	c1.next("error")

	// Revocation closes the socket.
	e.do("DELETE", "/api/v1/devices/"+b.device, a.token, nil, nil)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-c2.msgs:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("revoked device still connected")
		}
	}
}

func TestWebSocketRejectsBadAuthAndOrigins(t *testing.T) {
	e := newEnv(t)
	c := e.dial("hs1_invalid")
	select {
	case _, ok := <-c.msgs:
		if ok {
			t.Fatal("expected close")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("not closed")
	}
	ctx := context.Background()
	_, _, err := websocket.Dial(ctx, strings.Replace(e.ts.URL, "http", "ws", 1)+"/api/v1/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://evil.example"}},
	})
	if err == nil {
		t.Fatal("website origin must be rejected")
	}
	_, _, err = websocket.Dial(ctx, strings.Replace(e.ts.URL, "http", "ws", 1)+"/api/v1/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"chrome-extension://abcdefghijklmnopabcdefghijklmnop"}},
	})
	if err != nil {
		t.Fatalf("extension origin rejected: %v", err)
	}
}

// Many concurrent writers: every client must observe every change exactly
// once and in strictly increasing sequence order.
func TestOrderingUnderConcurrency(t *testing.T) {
	e := newEnv(t)
	a := e.register("frank")
	const writers, perWriter = 4, 50
	var clients []*wsClient
	for i := 0; i < writers; i++ {
		acc := e.login(a, fmt.Sprint("d", i))
		c := e.dial(acc.token)
		c.next("ready")
		c.pullAll(0)
		clients = append(clients, c)
	}
	var wg sync.WaitGroup
	for i, c := range clients {
		wg.Add(1)
		go func(i int, c *wsClient) {
			defer wg.Done()
			for j := 0; j < perWriter; j++ {
				b, _ := json.Marshal(map[string]any{"t": "push", "id": j, "writes": []store.Write{{Coll: "lt", ID: fmt.Sprintf("w%d-%d", i, j), Data: []byte("x")}}})
				c.c.Write(context.Background(), websocket.MessageText, b)
			}
		}(i, c)
	}
	wg.Wait()
	total := writers * perWriter
	for i, c := range clients {
		last := int64(0)
		seen := 0
		timeout := time.After(10 * time.Second)
		for seen < total {
			select {
			case m := <-c.msgs:
				var typ string
				json.Unmarshal(m["t"], &typ)
				var s int64
				switch typ {
				case "ack", "changes":
					json.Unmarshal(m["seq"], &s)
					if s <= last {
						t.Fatalf("client %d: seq %d after %d", i, s, last)
					}
					last = s
					seen++
				}
			case <-timeout:
				t.Fatalf("client %d saw %d/%d", i, seen, total)
			}
		}
	}
}

func TestExtensionPackaging(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.PublicURL = "https://sync.example.com/" })
	res, err := http.Get(e.ts.URL + "/ext/helium-sync.crx")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.Header.Get("Content-Type") != "application/x-chrome-extension" {
		t.Fatal(res.Header)
	}
	zip, id, err := crx.Verify(body)
	if err != nil || id != e.srv.ExtensionID() || len(zip) == 0 {
		t.Fatalf("crx: %v %s", err, id)
	}
	res, _ = http.Get(e.ts.URL + "/ext/updates.xml")
	xml, _ := io.ReadAll(res.Body)
	if !bytes.Contains(xml, []byte("appid='"+id+"'")) || !bytes.Contains(xml, []byte("version='1.2.3'")) ||
		!bytes.Contains(xml, []byte("https://sync.example.com/ext/helium-sync.crx")) {
		t.Fatalf("%s", xml)
	}
	res, _ = http.Get(e.ts.URL + "/")
	page, _ := io.ReadAll(res.Body)
	if !bytes.Contains(page, []byte("raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/tweak.sh | sh -s -- --server https://sync.example.com")) {
		t.Fatalf("landing page lacks the tweak command: %s", page)
	}
	// CORS for the extension only.
	req, _ := http.NewRequest("OPTIONS", e.ts.URL+"/api/v1/login", nil)
	req.Header.Set("Origin", "chrome-extension://"+id)
	res, _ = http.DefaultClient.Do(req)
	if res.Header.Get("Access-Control-Allow-Origin") != "chrome-extension://"+id {
		t.Fatal("missing CORS for extension")
	}
	req.Header.Set("Origin", "https://evil.example")
	res, _ = http.DefaultClient.Do(req)
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS granted to a website")
	}
}

func BenchmarkFanout(b *testing.B) {
	e := newEnv(b)
	a := e.register("bench")
	c1 := e.dial(a.token)
	c1.next("ready")
	c1.pullAll(0)
	c2acc := e.login(a, "rx")
	c2 := e.dial(c2acc.token)
	c2.next("ready")
	c2.pullAll(0)
	payload := rnd(300)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c1.send(map[string]any{"t": "push", "id": i, "writes": []store.Write{{Coll: "lt", ID: "tab", Data: payload}}})
		c2.next("changes")
	}
	b.ReportMetric(float64(b.Elapsed().Microseconds())/float64(b.N), "µs/roundtrip")
}

func TestPublicURLValidation(t *testing.T) {
	for _, ok := range []string{"https://sync.example.com", "http://100.64.1.2:8080", "https://example.com/sync/"} {
		if err := ValidPublicURL(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"sync.example.com", "https://a.com/$(id)", "https://a.com\"; echo", "javascript:alert(1)", "https://a b.com"} {
		if ValidPublicURL(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestHostHeaderIsValidated(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest("GET", e.ts.URL+"/", nil)
	req.Host = "evil.com\"$(id)"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if bytes.Contains(body, []byte("$(id)")) {
		t.Fatal("unvalidated Host header reached the page")
	}
}
