// Package server implements the Helium Sync HTTP and WebSocket API.
package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"helium-sync/internal/crx"
	"helium-sync/internal/extpack"
	"helium-sync/internal/store"
)

// Version is the server version, set at build time.
var Version = "dev"

type Config struct {
	// PublicURL is the externally reachable base URL (e.g.
	// https://sync.example.com). When empty it is derived from requests.
	PublicURL string
	DataDir   string
	// Registration is "invite" (default), "open" or "closed".
	Registration string
	// TrustProxy makes the server honour X-Forwarded-For/-Proto/-Host.
	TrustProxy bool

	QuotaBytes       int64         // per user; 0 = unlimited
	MaxRecordBytes   int           // per record payload
	HistoryRetention time.Duration // server-side expiry of history records
	TombstoneTTL     time.Duration // how long deletions are remembered

	ExtensionFS fs.FS // extension source
	WebFS       fs.FS // landing page and tweak scripts
	Logger      *slog.Logger
}

type Server struct {
	cfg    Config
	store  *store.Store
	log    *slog.Logger
	hub    *hub
	key    *rsa.PrivateKey
	secret []byte

	authLimiter  *limiter
	loginFails   *limiter
	hashSem      chan struct{}
	pkgMu        sync.Mutex
	pkgs         map[string]*extpack.Package
	shutdownOnce sync.Once
	done         chan struct{}
}

func New(cfg Config, st *store.Store) (*Server, error) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Registration == "" {
		cfg.Registration = "invite"
	}
	switch cfg.Registration {
	case "invite", "open", "closed":
	default:
		return nil, fmt.Errorf("invalid registration mode %q", cfg.Registration)
	}
	if cfg.MaxRecordBytes == 0 {
		cfg.MaxRecordBytes = 512 << 10
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	if cfg.PublicURL != "" {
		if err := ValidPublicURL(cfg.PublicURL); err != nil {
			return nil, err
		}
	}

	key, err := crx.LoadOrCreateKey(filepath.Join(cfg.DataDir, "extension-key.pem"))
	if err != nil {
		return nil, fmt.Errorf("extension signing key: %w", err)
	}
	secret, err := st.GetMeta(context.Background(), "server_secret")
	if errors.Is(err, store.ErrNotFound) {
		secret = make([]byte, 32)
		rand.Read(secret)
		err = st.SetMeta(context.Background(), "server_secret", secret)
	}
	if err != nil {
		return nil, err
	}

	s := &Server{
		cfg:    cfg,
		store:  st,
		log:    cfg.Logger,
		key:    key,
		secret: secret,
		// Auth endpoints: bursts of 20, refilling one every 3s per client IP.
		authLimiter: newLimiter(20, 3*time.Second),
		// Failed logins: 10 per account, refilling one per minute.
		loginFails: newLimiter(10, time.Minute),
		hashSem:    make(chan struct{}, 2),
		pkgs:       map[string]*extpack.Package{},
		done:       make(chan struct{}),
	}
	s.hub = newHub(s)
	return s, nil
}

// ExtensionID is the ID of the extension this server signs.
func (s *Server) ExtensionID() string { return crx.ExtensionID(s.key) }

// Close disconnects all WebSocket clients.
func (s *Server) Close() {
	s.shutdownOnce.Do(func() {
		close(s.done)
		s.hub.closeAll()
	})
}

// RunMaintenance periodically purges old tombstones and expired history.
func (s *Server) RunMaintenance(ctx context.Context) {
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		ret := map[string]time.Duration{}
		if s.cfg.HistoryRetention > 0 {
			ret["h"] = s.cfg.HistoryRetention
		}
		if err := s.store.Maintenance(ctx, s.cfg.TombstoneTTL, ret); err != nil && ctx.Err() == nil {
			s.log.Error("maintenance", "err", err)
		}
		s.authLimiter.gc()
		s.loginFails.gc()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/info", s.handleInfo)
	mux.HandleFunc("POST /api/v1/prelogin", s.limited(s.handlePrelogin))
	mux.HandleFunc("POST /api/v1/register", s.limited(s.handleRegister))
	mux.HandleFunc("POST /api/v1/login", s.limited(s.handleLogin))
	mux.HandleFunc("POST /api/v1/logout", s.authed(s.handleLogout))
	mux.HandleFunc("GET /api/v1/account", s.authed(s.handleAccount))
	mux.HandleFunc("POST /api/v1/account/password", s.limited(s.authed(s.handlePassword)))
	mux.HandleFunc("POST /api/v1/account/delete", s.limited(s.authed(s.handleDeleteAccount)))
	mux.HandleFunc("PATCH /api/v1/devices/{id}", s.authed(s.handleRenameDevice))
	mux.HandleFunc("DELETE /api/v1/devices/{id}", s.authed(s.handleDeleteDevice))
	mux.HandleFunc("GET /api/v1/pull", s.authed(s.handlePull))
	mux.HandleFunc("POST /api/v1/push", s.authed(s.handlePush))
	mux.HandleFunc("GET /api/v1/ws", s.handleWS)

	mux.HandleFunc("GET /ext/updates.xml", s.handleUpdates)
	mux.HandleFunc("GET /ext/helium-sync.crx", s.handleCRX)
	mux.HandleFunc("GET /ext/helium-sync.zip", s.handleZip)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /install", s.handleInstall)
	mux.HandleFunc("GET /{$}", s.handleIndex)

	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		if r.TLS != nil || (s.cfg.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https") {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
			// Bearer tokens are not ambient credentials, so allowing the
			// extension's origin does not expose anything to websites.
			if o := r.Header.Get("Origin"); strings.HasPrefix(o, "chrome-extension://") {
				h.Set("Access-Control-Allow-Origin", o)
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
				h.Set("Access-Control-Max-Age", "86400")
				h.Add("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP returns the request's client address.
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return xr
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Repository hosts the install scripts referenced by the server's pages.
const Repository = "https://github.com/j4ckxyz/helium-sync-server"

var publicURLRE = regexp.MustCompile(`^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$`)

// ValidPublicURL accepts plain http(s) base URLs only: the value ends up in
// install commands and extension packages.
func ValidPublicURL(u string) error {
	if !publicURLRE.MatchString(strings.TrimRight(u, "/")) {
		return fmt.Errorf("invalid public URL %q: use the form https://sync.example.com", u)
	}
	return nil
}

var hostRE = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]{1,5})?$|^\[[0-9a-fA-F:]+\](:[0-9]{1,5})?$`)

// publicURL returns the base URL clients should use to reach this server.
// Without --public-url (local use only) it comes from the request, so the
// Host header is validated first.
func (s *Server) publicURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	if !hostRE.MatchString(r.Host) {
		return "http://localhost"
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if s.cfg.TrustProxy {
		if p := r.Header.Get("X-Forwarded-Proto"); p == "https" || p == "http" {
			scheme = p
		}
		if h := r.Header.Get("X-Forwarded-Host"); h != "" {
			host = h
		}
	}
	return scheme + "://" + host
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, apiError{Error: kind, Message: msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return false
	}
	return true
}

func (s *Server) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authLimiter.allow(s.clientIP(r)) {
			w.Header().Set("Retry-After", "10")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many requests, slow down")
			return
		}
		h(w, r)
	}
}

type ctxKey struct{}

func deviceFrom(r *http.Request) *store.Device { return r.Context().Value(ctxKey{}).(*store.Device) }

func bearer(r *http.Request) string {
	a := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(a, "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

func (s *Server) authed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := bearer(r)
		if tok == "" {
			writeErr(w, http.StatusUnauthorized, "auth_required", "missing bearer token")
			return
		}
		d, err := s.store.DeviceByToken(r.Context(), tok)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				s.log.Error("auth lookup", "err", err)
			}
			writeErr(w, http.StatusUnauthorized, "auth_required", "invalid or revoked token")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, d)))
	}
}

// ---------------------------------------------------------------------------
// Rate limiter: token buckets keyed by string.

type limiter struct {
	mu      sync.Mutex
	burst   float64
	every   time.Duration
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(burst int, every time.Duration) *limiter {
	return &limiter{burst: float64(burst), every: every, buckets: map[string]*bucket{}}
}

func (l *limiter) take(key string, consume bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+float64(now.Sub(b.last))/float64(l.every))
	b.last = now
	if b.tokens < 1 {
		return false
	}
	if consume {
		b.tokens--
	}
	return true
}

func (l *limiter) allow(key string) bool { return l.take(key, true) }
func (l *limiter) peek(key string) bool  { return l.take(key, false) }

func (l *limiter) gc() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-time.Duration(l.burst) * l.every)
	for k, b := range l.buckets {
		if b.last.Before(cut) {
			delete(l.buckets, k)
		}
	}
}
