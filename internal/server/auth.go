package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"unicode"

	"golang.org/x/crypto/argon2"

	"helium-sync/internal/store"
)

// Account model (zero-knowledge, similar to Bitwarden):
//
//   - The client stretches the password with PBKDF2-SHA256 (salt and
//     iteration count are stored here and returned by /prelogin), then derives
//     two independent keys with HKDF: an auth key and a key-encryption key.
//   - Only the auth key is sent to the server, which stores an Argon2id hash
//     of it. The password and the key-encryption key never leave the device.
//   - The account's random data key is stored here wrapped (AES-GCM) with the
//     key-encryption key, so a fresh device can recover it after logging in.
//
// A full database leak therefore yields only ciphertext plus slow-to-attack
// verifiers.

const (
	defaultKDFIters = 600_000
	minKDFIters     = 100_000
	maxKDFIters     = 10_000_000
)

var usernameRE = regexp.MustCompile(`^[A-Za-z0-9._@+-]{1,64}$`)

// Verifier format: a version byte, then the Argon2id output. Parameters can
// change in later versions without invalidating stored accounts; a 32-byte
// value without version byte is the pre-release format.
const verifierV1 = 1

func argonParams(version byte) (time, memKiB uint32) {
	if version == verifierV1 {
		return 2, 19 * 1024 // OWASP baseline; the client already runs 600k PBKDF2 rounds
	}
	return 2, 32 * 1024
}

func hashAuthKey(authKey, salt []byte) []byte {
	t, m := argonParams(verifierV1)
	return append([]byte{verifierV1}, argon2.IDKey(authKey, salt, t, m, 1, 32)...)
}

func checkAuthKey(authKey, salt, stored []byte) bool {
	version, want := byte(0), stored
	if len(stored) == 33 {
		version, want = stored[0], stored[1:]
	}
	t, m := argonParams(version)
	return subtle.ConstantTimeCompare(argon2.IDKey(authKey, salt, t, m, 1, 32), want) == 1
}

// withHashSlot runs fn while holding one of a few Argon2 slots, so a burst
// of logins cannot exhaust memory, then hands the scratch memory back to the
// OS: logins are rare and a home server should idle small.
func (s *Server) withHashSlot(fn func()) {
	s.hashSem <- struct{}{}
	defer func() {
		<-s.hashSem
		if len(s.hashSem) == 0 {
			go debug.FreeOSMemory()
		}
	}()
	fn()
}

func (s *Server) verify(authKey []byte, u *store.User) (ok bool) {
	s.withHashSlot(func() { ok = checkAuthKey(authKey, u.AuthSalt, u.AuthHash) })
	return ok
}

func (s *Server) hash(authKey []byte) (salt, hash []byte) {
	salt = make([]byte, 16)
	rand.Read(salt)
	s.withHashSlot(func() { hash = hashAuthKey(authKey, salt) })
	return salt, hash
}

// fakeSalt gives unknown usernames a stable salt so /prelogin does not reveal
// which accounts exist.
func (s *Server) fakeSalt(username string) []byte {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte("prelogin:" + strings.ToLower(username)))
	return m.Sum(nil)[:16]
}

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return "hs1_" + base64.RawURLEncoding.EncodeToString(b)
}

func newDeviceID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func cleanDeviceName(n string) string {
	n = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(n))
	if r := []rune(n); len(r) > 64 {
		n = string(r[:64])
	}
	if n == "" {
		n = "Helium"
	}
	return n
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	pkg, _ := s.pkg(r)
	info := map[string]any{
		"service":      "helium-sync",
		"version":      Version,
		"protocol":     protocolVersion,
		"registration": s.cfg.Registration,
		"extensionId":  s.ExtensionID(),
	}
	if pkg != nil {
		info["extensionVersion"] = pkg.Version
	}
	writeJSON(w, http.StatusOK, info)
}

type preloginReq struct {
	Username string `json:"username"`
}

type preloginResp struct {
	Salt       []byte `json:"salt"`
	Iterations int    `json:"iterations"`
}

func (s *Server) handlePrelogin(w http.ResponseWriter, r *http.Request) {
	var req preloginReq
	if !readJSON(w, r, 4<<10, &req) {
		return
	}
	u, err := s.store.UserByName(r.Context(), req.Username)
	if err == nil {
		writeJSON(w, http.StatusOK, preloginResp{Salt: u.KDFSalt, Iterations: u.KDFIters})
		return
	}
	if !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, preloginResp{Salt: s.fakeSalt(req.Username), Iterations: defaultKDFIters})
}

type registerReq struct {
	Username   string `json:"username"`
	Invite     string `json:"invite"`
	Salt       []byte `json:"salt"`
	Iterations int    `json:"iterations"`
	AuthKey    []byte `json:"authKey"`
	WrappedKey []byte `json:"wrappedKey"`
	DeviceName string `json:"deviceName"`
}

type sessionResp struct {
	Token      string `json:"token"`
	DeviceID   string `json:"deviceId"`
	Username   string `json:"username"`
	WrappedKey []byte `json:"wrappedKey,omitempty"`
}

func validCreds(salt []byte, iters int, authKey, wrapped []byte) string {
	switch {
	case len(salt) < 16 || len(salt) > 64:
		return "salt must be 16-64 bytes"
	case iters < minKDFIters || iters > maxKDFIters:
		return "iterations out of range"
	case len(authKey) != 32:
		return "authKey must be 32 bytes"
	case len(wrapped) < 28 || len(wrapped) > 512:
		return "wrappedKey has an invalid size"
	}
	return ""
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if !readJSON(w, r, 16<<10, &req) {
		return
	}
	if !usernameRE.MatchString(req.Username) {
		writeErr(w, http.StatusBadRequest, "invalid_username", "usernames are 1-64 characters: letters, digits and . _ @ + -")
		return
	}
	if msg := validCreds(req.Salt, req.Iterations, req.AuthKey, req.WrappedKey); msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}
	invite := ""
	switch s.cfg.Registration {
	case "closed":
		writeErr(w, http.StatusForbidden, "registration_closed", "registration is disabled on this server")
		return
	case "invite":
		invite = strings.TrimSpace(req.Invite)
		if invite == "" {
			writeErr(w, http.StatusForbidden, "invite_required", "an invite code is required to create an account")
			return
		}
	}
	authSalt, authHash := s.hash(req.AuthKey)
	u := &store.User{
		Username: req.Username, KDFSalt: req.Salt, KDFIters: req.Iterations,
		AuthSalt: authSalt, AuthHash: authHash, WrappedKey: req.WrappedKey,
	}
	switch err := s.store.CreateUser(r.Context(), u, invite); {
	case errors.Is(err, store.ErrInvalidInvite):
		writeErr(w, http.StatusForbidden, "invalid_invite", "the invite code is invalid, used or expired")
		return
	case errors.Is(err, store.ErrExists):
		writeErr(w, http.StatusConflict, "username_taken", "that username is taken")
		return
	case err != nil:
		s.log.Error("create user", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.log.Info("account created", "user", u.Username)
	s.newSession(w, r, u, req.DeviceName, false)
}

// maxDevicesPerUser bounds device records per account.
const maxDevicesPerUser = 64

func (s *Server) newSession(w http.ResponseWriter, r *http.Request, u *store.User, deviceName string, includeKey bool) {
	if devs, err := s.store.ListDevices(r.Context(), u.ID); err == nil && len(devs) >= maxDevicesPerUser {
		writeErr(w, http.StatusConflict, "too_many_devices", "this account has too many devices; sign some out first")
		return
	}
	tok := newToken()
	d := &store.Device{ID: newDeviceID(), UserID: u.ID, Name: cleanDeviceName(deviceName)}
	if err := s.store.CreateDevice(r.Context(), d, tok); err != nil {
		s.log.Error("create device", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	resp := sessionResp{Token: tok, DeviceID: d.ID, Username: u.Username}
	if includeKey {
		resp.WrappedKey = u.WrappedKey
	}
	writeJSON(w, http.StatusOK, resp)
}

type loginReq struct {
	Username   string `json:"username"`
	AuthKey    []byte `json:"authKey"`
	DeviceName string `json:"deviceName"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if !readJSON(w, r, 8<<10, &req) {
		return
	}
	failKey := strings.ToLower(req.Username)
	if !s.loginFails.peek(failKey) {
		w.Header().Set("Retry-After", "60")
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many failed sign-in attempts for this account, try again later")
		return
	}
	u, err := s.store.UserByName(r.Context(), req.Username)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if u == nil || len(req.AuthKey) != 32 || !s.verify(req.AuthKey, u) {
		s.loginFails.allow(failKey)
		s.log.Warn("failed login", "user", req.Username, "ip", s.clientIP(r))
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "wrong username or password")
		return
	}
	s.newSession(w, r, u, req.DeviceName, true)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	if _, err := s.store.DeleteDevice(r.Context(), d.UserID, d.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.hub.disconnectDevice(d.UserID, d.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAccount(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	ctx := r.Context()
	u, err := s.store.UserByID(ctx, d.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	devs, err := s.store.ListDevices(ctx, d.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	stats, _ := s.store.UserStats(ctx, d.UserID)
	usage, _ := s.store.Usage(ctx, d.UserID)
	writeJSON(w, http.StatusOK, map[string]any{
		"username":   u.Username,
		"deviceId":   d.ID,
		"devices":    devs,
		"online":     s.hub.online(d.UserID),
		"stats":      stats,
		"usage":      usage,
		"quota":      s.cfg.QuotaBytes,
		"seq":        u.Seq,
		"createdAt":  u.CreatedAt,
		"iterations": u.KDFIters,
		// Useless without the password; lets a signed-in device re-wrap the
		// data key when the password changes.
		"wrappedKey": u.WrappedKey,
	})
}

type passwordReq struct {
	AuthKey    []byte `json:"authKey"` // current
	Salt       []byte `json:"salt"`
	Iterations int    `json:"iterations"`
	NewAuthKey []byte `json:"newAuthKey"`
	WrappedKey []byte `json:"wrappedKey"`
}

// handlePassword changes the password. The data key is unchanged, only
// re-wrapped by the client, so no data needs re-encrypting. Other devices are
// signed out.
func (s *Server) handlePassword(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	var req passwordReq
	if !readJSON(w, r, 16<<10, &req) {
		return
	}
	if msg := validCreds(req.Salt, req.Iterations, req.NewAuthKey, req.WrappedKey); msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", msg)
		return
	}
	u, err := s.store.UserByID(r.Context(), d.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if len(req.AuthKey) != 32 || !s.verify(req.AuthKey, u) {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "current password is wrong")
		return
	}
	authSalt, authHash := s.hash(req.NewAuthKey)
	if err := s.store.UpdateCredentials(r.Context(), u.ID, req.Salt, req.Iterations, authSalt, authHash, req.WrappedKey, d.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.hub.disconnectOthers(u.ID, d.ID)
	s.log.Info("password changed", "user", u.Username)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	var req struct {
		AuthKey []byte `json:"authKey"`
	}
	if !readJSON(w, r, 4<<10, &req) {
		return
	}
	u, err := s.store.UserByID(r.Context(), d.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if len(req.AuthKey) != 32 || !s.verify(req.AuthKey, u) {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "password is wrong")
		return
	}
	if err := s.store.DeleteUser(r.Context(), u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.hub.disconnectOthers(u.ID, "")
	s.log.Info("account deleted", "user", u.Username)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRenameDevice(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, 4<<10, &req) {
		return
	}
	id := r.PathValue("id")
	if id == "self" {
		id = d.ID
	}
	if err := s.store.RenameDevice(r.Context(), d.UserID, id, cleanDeviceName(req.Name)); err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "no such device")
		return
	}
	s.hub.broadcastPresence(d.UserID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteDevice(w http.ResponseWriter, r *http.Request) {
	d := deviceFrom(r)
	id := r.PathValue("id")
	if _, err := s.store.DeleteDevice(r.Context(), d.UserID, id); err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "no such device")
		return
	}
	s.hub.disconnectDevice(d.UserID, id)
	s.log.Info("device revoked", "device", id)
	w.WriteHeader(http.StatusNoContent)
}
