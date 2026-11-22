// Package store persists accounts, devices and end-to-end encrypted sync
// records in SQLite.
//
// The server never sees plaintext: a record is an opaque (collection, id,
// ciphertext) triple. Every write gets the next value of a per-user sequence
// number, which is what clients use as their sync cursor.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrExists        = errors.New("already exists")
	ErrQuotaExceeded = errors.New("quota exceeded")
	ErrInvalidInvite = errors.New("invalid or expired invite")
)

// migrations upgrade the schema step by step; PRAGMA user_version records
// how many have run. Append new steps, never edit old ones, so any older
// database can be opened by any newer server.
var migrations = []string{
	// 1: initial schema.
	`
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v BLOB
) WITHOUT ROWID;

CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kdf_salt    BLOB NOT NULL,
  kdf_iters   INTEGER NOT NULL,
  auth_salt   BLOB NOT NULL,
  auth_hash   BLOB NOT NULL,
  wrapped_key BLOB NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  gc_seq      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- num is referenced by records (compactly) and never reused.
CREATE TABLE devices (
  num        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX devices_by_user ON devices(user_id);

CREATE TABLE records (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coll    TEXT NOT NULL,
  rid     TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data    BLOB,
  device  INTEGER NOT NULL DEFAULT 0,
  mtime   INTEGER NOT NULL,
  PRIMARY KEY (user_id, coll, rid)
) WITHOUT ROWID;
CREATE UNIQUE INDEX records_by_seq ON records(user_id, seq);

CREATE TABLE invites (
  code_hash  BLOB PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses_left  INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;
`,
}

// SchemaVersion is the schema version this build creates and understands.
var SchemaVersion = len(migrations)

// Store is safe for concurrent use. Writes go through a single connection
// (SQLite allows one writer at a time anyway); reads use a pool, which WAL
// mode lets run concurrently with the writer.
type Store struct {
	w *sql.DB
	r *sql.DB

	// Approximate stored bytes per user, for quota checks without scanning
	// on every push. Lazily loaded and adjusted on writes.
	usageMu sync.Mutex
	usage   map[int64]int64

	devIDs sync.Map // device num -> device id ("" once deleted)
}

// Open opens (creating if needed) the database at path.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	// Small caches and no mmap keep memory low on home servers; WAL with
	// synchronous=NORMAL is durable across crashes of the process and fast
	// on SD cards and HDDs alike.
	// Per-connection settings. Persistent database settings (WAL mode,
	// auto-vacuum) are applied by the writer only: they need a lock, and a
	// reader opening during a write would otherwise stall for the busy
	// timeout.
	common := []string{
		"busy_timeout(10000)",
		"foreign_keys(1)",
		"temp_store(MEMORY)",
		"cache_size(-2000)", // 2 MiB per connection
	}
	writer := append([]string{
		// Must come first: only takes effect before the file header exists.
		// Lets Maintenance give freed pages back to the filesystem.
		"auto_vacuum(INCREMENTAL)",
		"journal_mode(WAL)",
		"synchronous(NORMAL)",
		"journal_size_limit(4194304)", // truncate the WAL back to 4 MiB after checkpoints
	}, common...)
	dsnFor := func(pragmas []string) string {
		q := url.Values{}
		for _, p := range pragmas {
			q.Add("_pragma", p)
		}
		return "file:" + path + "?" + q.Encode()
	}
	dsn := dsnFor(writer)

	w, err := sql.Open("sqlite", dsn+"&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	w.SetConnMaxLifetime(0)

	r, err := sql.Open("sqlite", dsnFor(append([]string{"query_only(1)"}, common...)))
	if err != nil {
		w.Close()
		return nil, err
	}
	// Readers are opened on demand and closed when idle.
	r.SetMaxOpenConns(4)
	r.SetMaxIdleConns(2)
	r.SetConnMaxIdleTime(2 * time.Minute)

	if err := migrate(w); err != nil {
		w.Close()
		r.Close()
		return nil, err
	}
	// The database holds password hashes and wrapped keys; keep it private.
	_ = os.Chmod(path, 0o600)
	return &Store{w: w, r: r, usage: map[int64]int64{}}, nil
}

func migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if v > len(migrations) {
		return fmt.Errorf("database schema v%d is newer than this server (v%d); upgrade helium-sync", v, len(migrations))
	}
	for i := v; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("schema migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Close checkpoints the WAL so the database is a single file at rest.
func (s *Store) Close() error {
	_, _ = s.w.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	err1 := s.r.Close()
	err2 := s.w.Close()
	return errors.Join(err1, err2)
}

func now() int64 { return time.Now().UnixMilli() }

// ---------------------------------------------------------------------------
// Meta

func (s *Store) GetMeta(ctx context.Context, k string) ([]byte, error) {
	var v []byte
	err := s.r.QueryRowContext(ctx, `SELECT v FROM meta WHERE k=?`, k).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return v, err
}

func (s *Store) SetMeta(ctx context.Context, k string, v []byte) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v)
	return err
}

// ---------------------------------------------------------------------------
// Users

type User struct {
	ID         int64
	Username   string
	KDFSalt    []byte
	KDFIters   int
	AuthSalt   []byte
	AuthHash   []byte
	WrappedKey []byte
	Seq        int64
	GCSeq      int64
	CreatedAt  int64
}

const userCols = `id, username, kdf_salt, kdf_iters, auth_salt, auth_hash, wrapped_key, seq, gc_seq, created_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Username, &u.KDFSalt, &u.KDFIters, &u.AuthSalt, &u.AuthHash, &u.WrappedKey, &u.Seq, &u.GCSeq, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

func (s *Store) UserByName(ctx context.Context, name string) (*User, error) {
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username=?`, name))
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id=?`, id))
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

// CreateUser creates a user, consuming an invite when inviteCode is non-empty.
func (s *Store) CreateUser(ctx context.Context, u *User, inviteCode string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if inviteCode != "" {
		h := hashInvite(inviteCode)
		res, err := tx.ExecContext(ctx, `UPDATE invites SET uses_left = uses_left - 1
			WHERE code_hash=? AND uses_left > 0 AND expires_at > ?`, h, now())
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return ErrInvalidInvite
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM invites WHERE uses_left <= 0 OR expires_at <= ?`, now()); err != nil {
			return err
		}
	}
	u.CreatedAt = now()
	res, err := tx.ExecContext(ctx, `INSERT INTO users(username, kdf_salt, kdf_iters, auth_salt, auth_hash, wrapped_key, created_at)
		VALUES(?,?,?,?,?,?,?)`, u.Username, u.KDFSalt, u.KDFIters, u.AuthSalt, u.AuthHash, u.WrappedKey, u.CreatedAt)
	if err != nil {
		if isUnique(err) {
			return ErrExists
		}
		return err
	}
	u.ID, _ = res.LastInsertId()
	return tx.Commit()
}

// UpdateCredentials replaces the login verifier and wrapped data key (password
// change). All devices except keepDevice are signed out.
func (s *Store) UpdateCredentials(ctx context.Context, userID int64, kdfSalt []byte, kdfIters int, authSalt, authHash, wrappedKey []byte, keepDevice string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE users SET kdf_salt=?, kdf_iters=?, auth_salt=?, auth_hash=?, wrapped_key=? WHERE id=?`,
		kdfSalt, kdfIters, authSalt, authHash, wrappedKey, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE user_id=? AND id<>?`, userID, keepDevice); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteUser(ctx context.Context, userID int64) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{`DELETE FROM records WHERE user_id=?`, `DELETE FROM devices WHERE user_id=?`, `DELETE FROM users WHERE id=?`} {
		if _, err := tx.ExecContext(ctx, q, userID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.usageMu.Lock()
	delete(s.usage, userID)
	s.usageMu.Unlock()
	return nil
}

// ---------------------------------------------------------------------------
// Devices

type Device struct {
	Num       int64  `json:"-"`
	ID        string `json:"id"`
	UserID    int64  `json:"-"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	LastSeen  int64  `json:"lastSeen"`
}

func TokenHash(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

func (s *Store) CreateDevice(ctx context.Context, d *Device, token string) error {
	t := now()
	d.CreatedAt, d.LastSeen = t, t
	res, err := s.w.ExecContext(ctx, `INSERT INTO devices(id, user_id, name, token_hash, created_at, last_seen) VALUES(?,?,?,?,?,?)`,
		d.ID, d.UserID, d.Name, TokenHash(token), t, t)
	if err != nil {
		return err
	}
	d.Num, _ = res.LastInsertId()
	s.devIDs.Store(d.Num, d.ID)
	return nil
}

// DeviceByToken authenticates a bearer token.
func (s *Store) DeviceByToken(ctx context.Context, token string) (*Device, error) {
	d := &Device{}
	err := s.r.QueryRowContext(ctx, `SELECT num, id, user_id, name, created_at, last_seen FROM devices WHERE token_hash=?`, TokenHash(token)).
		Scan(&d.Num, &d.ID, &d.UserID, &d.Name, &d.CreatedAt, &d.LastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return d, err
}

func (s *Store) DeviceExists(ctx context.Context, id string) (bool, error) {
	var one int
	err := s.r.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id=?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) ListDevices(ctx context.Context, userID int64) ([]Device, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT num, id, user_id, name, created_at, last_seen FROM devices WHERE user_id=? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.Num, &d.ID, &d.UserID, &d.Name, &d.CreatedAt, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) RenameDevice(ctx context.Context, userID int64, id, name string) error {
	res, err := s.w.ExecContext(ctx, `UPDATE devices SET name=? WHERE id=? AND user_id=?`, name, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteDevice revokes a device. userID 0 means any user (admin). The
// device's published open-tabs snapshot ("dev" record) goes with it.
func (s *Store) DeleteDevice(ctx context.Context, userID int64, id string) (int64, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var owner int64
	q := `DELETE FROM devices WHERE id=? RETURNING user_id`
	args := []any{id}
	if userID != 0 {
		q = `DELETE FROM devices WHERE id=? AND user_id=? RETURNING user_id`
		args = append(args, userID)
	}
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&owner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM records WHERE user_id=? AND coll='dev' AND rid=?`, owner, id); err != nil {
		return 0, err
	}
	return owner, tx.Commit()
}

// TouchDevice records activity, at most every ten minutes per device to
// spare the disk.
func (s *Store) TouchDevice(ctx context.Context, id string) error {
	t := now()
	_, err := s.w.ExecContext(ctx, `UPDATE devices SET last_seen=? WHERE id=? AND last_seen<?`, t, id, t-10*60*1000)
	return err
}

// deviceID maps a record's device number to the device id.
func (s *Store) deviceID(ctx context.Context, num int64) string {
	if num == 0 {
		return ""
	}
	if v, ok := s.devIDs.Load(num); ok {
		return v.(string)
	}
	var id string
	if err := s.r.QueryRowContext(ctx, `SELECT id FROM devices WHERE num=?`, num).Scan(&id); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ""
	}
	s.devIDs.Store(num, id) // nums are never reused, so "" (deleted) is final
	return id
}

// ---------------------------------------------------------------------------
// Invites

func hashInvite(code string) []byte {
	c := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
	h := sha256.Sum256([]byte("invite:" + c))
	return h[:]
}

func (s *Store) CreateInvite(ctx context.Context, code string, uses int, ttl time.Duration, note string) error {
	t := now()
	_, err := s.w.ExecContext(ctx, `INSERT INTO invites(code_hash, created_at, expires_at, uses_left, note) VALUES(?,?,?,?,?)`,
		hashInvite(code), t, t+ttl.Milliseconds(), uses, note)
	return err
}

// DeleteInvitesByNote removes invites with the given note (used to rotate the
// bootstrap invite on every start).
func (s *Store) DeleteInvitesByNote(ctx context.Context, note string) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM invites WHERE note=?`, note)
	return err
}

func (s *Store) InviteValid(ctx context.Context, code string) bool {
	var one int
	err := s.r.QueryRowContext(ctx, `SELECT 1 FROM invites WHERE code_hash=? AND uses_left>0 AND expires_at>?`, hashInvite(code), now()).Scan(&one)
	return err == nil
}

// ---------------------------------------------------------------------------
// Records

// Record is one encrypted sync entity.
type Record struct {
	Coll    string `json:"c"`
	ID      string `json:"id"`
	Seq     int64  `json:"s,omitempty"`
	Deleted bool   `json:"x,omitempty"`
	Data    []byte `json:"d,omitempty"`
	Device  string `json:"dv,omitempty"`
}

// Write is a client-submitted change. Base, when non-nil, makes the write
// conditional on the record's current sequence number (0 = must not exist).
type Write struct {
	Coll    string `json:"c"`
	ID      string `json:"id"`
	Deleted bool   `json:"x,omitempty"`
	Data    []byte `json:"d,omitempty"`
	Base    *int64 `json:"b,omitempty"`
}

// Conflict reports a conditional write that was rejected, with the current
// server version.
type Conflict struct {
	Index   int     `json:"i"`
	Current *Record `json:"cur,omitempty"`
}

type PushResult struct {
	Seqs      []int64    `json:"seqs"` // per write; 0 when rejected
	Conflicts []Conflict `json:"conflicts,omitempty"`
	Applied   []Record   `json:"-"` // accepted records, in seq order
	MaxSeq    int64      `json:"seq"`
}

// Push applies writes atomically and assigns sequence numbers in order.
func (s *Store) Push(ctx context.Context, userID int64, dev *Device, writes []Write, quotaBytes int64) (*PushResult, error) {
	if quotaBytes > 0 {
		used, err := s.Usage(ctx, userID)
		if err != nil {
			return nil, err
		}
		var add int64
		for _, w := range writes {
			add += int64(len(w.Data))
		}
		if used+add > quotaBytes {
			return nil, ErrQuotaExceeded
		}
	}

	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT seq FROM users WHERE id=?`, userID).Scan(&seq); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	res := &PushResult{Seqs: make([]int64, len(writes))}
	upsert, err := tx.PrepareContext(ctx, `INSERT INTO records(user_id, coll, rid, seq, deleted, data, device, mtime)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id, coll, rid) DO UPDATE SET seq=excluded.seq, deleted=excluded.deleted,
		  data=excluded.data, device=excluded.device, mtime=excluded.mtime`)
	if err != nil {
		return nil, err
	}
	defer upsert.Close()
	var cur *sql.Stmt
	t := now()
	var delta int64
	for i, w := range writes {
		if w.Base != nil {
			if cur == nil {
				if cur, err = tx.PrepareContext(ctx, `SELECT seq, deleted, data, device FROM records WHERE user_id=? AND coll=? AND rid=?`); err != nil {
					return nil, err
				}
				defer cur.Close()
			}
			r := Record{Coll: w.Coll, ID: w.ID}
			var del int
			var num int64
			err := cur.QueryRowContext(ctx, userID, w.Coll, w.ID).Scan(&r.Seq, &del, &r.Data, &num)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			r.Deleted = del != 0
			if num != 0 {
				_ = tx.QueryRowContext(ctx, `SELECT id FROM devices WHERE num=?`, num).Scan(&r.Device)
			}
			if r.Seq != *w.Base {
				c := Conflict{Index: i}
				if r.Seq != 0 {
					c.Current = &r
				}
				res.Conflicts = append(res.Conflicts, c)
				continue
			}
		}
		seq++
		data := w.Data
		if w.Deleted && len(data) == 0 {
			data = nil
		}
		if _, err := upsert.ExecContext(ctx, userID, w.Coll, w.ID, seq, boolInt(w.Deleted), data, dev.Num, t); err != nil {
			return nil, err
		}
		delta += int64(len(data))
		res.Seqs[i] = seq
		res.Applied = append(res.Applied, Record{Coll: w.Coll, ID: w.ID, Seq: seq, Deleted: w.Deleted, Data: data, Device: dev.ID})
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET seq=? WHERE id=?`, seq, userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	res.MaxSeq = seq
	s.usageMu.Lock()
	if _, ok := s.usage[userID]; ok {
		// Overwrites are counted as growth; Usage() periodically re-measures.
		s.usage[userID] += delta
	}
	s.usageMu.Unlock()
	return res, nil
}

// Pull returns records changed after since, in sequence order. Only the
// latest version of each record is kept, so a client that pulls until more
// is false has the complete current state.
func (s *Store) Pull(ctx context.Context, userID int64, since int64, limit int, colls []string) (recs []Record, more bool, err error) {
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	q := `SELECT coll, rid, seq, deleted, data, device FROM records WHERE user_id=? AND seq>?`
	args := []any{userID, since}
	if len(colls) > 0 {
		q += ` AND coll IN (` + strings.TrimSuffix(strings.Repeat("?,", len(colls)), ",") + `)`
		for _, c := range colls {
			args = append(args, c)
		}
	}
	q += ` ORDER BY seq LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	recs = make([]Record, 0, min(limit, 256))
	for rows.Next() {
		var r Record
		var del int
		var num int64
		if err := rows.Scan(&r.Coll, &r.ID, &r.Seq, &del, &r.Data, &num); err != nil {
			return nil, false, err
		}
		r.Deleted = del != 0
		r.Device = s.deviceID(ctx, num)
		recs = append(recs, r)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(recs) > limit {
		recs = recs[:limit]
		more = true
	}
	return recs, more, nil
}

// UserSeq returns the user's latest sequence number and the tombstone GC
// horizon (clients with an older cursor must resync from scratch).
func (s *Store) UserSeq(ctx context.Context, userID int64) (seq, gcSeq int64, err error) {
	err = s.r.QueryRowContext(ctx, `SELECT seq, gc_seq FROM users WHERE id=?`, userID).Scan(&seq, &gcSeq)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// Usage returns the approximate number of stored payload bytes for a user.
func (s *Store) Usage(ctx context.Context, userID int64) (int64, error) {
	s.usageMu.Lock()
	v, ok := s.usage[userID]
	s.usageMu.Unlock()
	if ok {
		return v, nil
	}
	var n sql.NullInt64
	if err := s.r.QueryRowContext(ctx, `SELECT sum(length(data)) FROM records WHERE user_id=?`, userID).Scan(&n); err != nil {
		return 0, err
	}
	s.usageMu.Lock()
	s.usage[userID] = n.Int64
	s.usageMu.Unlock()
	return n.Int64, nil
}

type Stats struct {
	Records    int64 `json:"records"`
	Tombstones int64 `json:"tombstones"`
	Bytes      int64 `json:"bytes"`
}

func (s *Store) UserStats(ctx context.Context, userID int64) (map[string]Stats, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT coll, sum(deleted=0), sum(deleted<>0), coalesce(sum(length(data)),0) FROM records WHERE user_id=? GROUP BY coll`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Stats{}
	for rows.Next() {
		var c string
		var st Stats
		if err := rows.Scan(&c, &st.Records, &st.Tombstones, &st.Bytes); err != nil {
			return nil, err
		}
		out[c] = st
	}
	return out, rows.Err()
}

// Maintenance purges tombstones older than tombstoneTTL, expires records of
// the given collections that were not updated within their retention, and
// forgets cached usage so quotas are re-measured.
func (s *Store) Maintenance(ctx context.Context, tombstoneTTL time.Duration, retention map[string]time.Duration) error {
	t := now()
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if tombstoneTTL > 0 {
		cut := t - tombstoneTTL.Milliseconds()
		// Raise each user's gc horizon to the newest tombstone being removed.
		if _, err := tx.ExecContext(ctx, `UPDATE users SET gc_seq = max(gc_seq, coalesce((
			SELECT max(seq) FROM records r WHERE r.user_id=users.id AND r.deleted<>0 AND r.mtime<?), 0))`, cut); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM records WHERE deleted<>0 AND mtime<?`, cut); err != nil {
			return err
		}
	}
	for coll, keep := range retention {
		if keep <= 0 {
			continue
		}
		// Expired records vanish without a tombstone: clients expire the same
		// data locally on their own schedule.
		if _, err := tx.ExecContext(ctx, `DELETE FROM records WHERE coll=? AND mtime<?`, coll, t-keep.Milliseconds()); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.usageMu.Lock()
	s.usage = map[int64]int64{}
	s.usageMu.Unlock()
	// Give freed pages back to the filesystem and keep the WAL small.
	for _, q := range []string{`PRAGMA incremental_vacuum`, `PRAGMA wal_checkpoint(TRUNCATE)`, `PRAGMA optimize`} {
		if _, err := s.w.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}
