package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStore(t testing.TB) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func newUser(t testing.TB, s *Store, name string) *User {
	t.Helper()
	u := &User{Username: name, KDFSalt: []byte("s"), KDFIters: 1, AuthSalt: []byte("a"), AuthHash: []byte("h"), WrappedKey: []byte("k")}
	if err := s.CreateUser(context.Background(), u, ""); err != nil {
		t.Fatal(err)
	}
	return u
}

func ptr[T any](v T) *T { return &v }

func TestUsersAndInvites(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	if err := s.CreateInvite(ctx, "ABCD-EFGH", 1, time.Hour, ""); err != nil {
		t.Fatal(err)
	}
	if !s.InviteValid(ctx, "abcd efgh") {
		t.Fatal("invite should be valid, normalised")
	}
	u := &User{Username: "Alice", KDFSalt: []byte("s"), KDFIters: 1, AuthSalt: []byte("a"), AuthHash: []byte("h"), WrappedKey: []byte("k")}
	if err := s.CreateUser(ctx, u, "WRONG"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("want invalid invite, got %v", err)
	}
	if err := s.CreateUser(ctx, u, "abcdefgh"); err != nil {
		t.Fatal(err)
	}
	u2 := *u
	if err := s.CreateUser(ctx, &u2, ""); !errors.Is(err, ErrExists) {
		t.Fatalf("want exists, got %v", err)
	}
	if s.InviteValid(ctx, "ABCD-EFGH") {
		t.Fatal("single-use invite should be consumed")
	}
	got, err := s.UserByName(ctx, "alice")
	if err != nil || got.ID != u.ID {
		t.Fatalf("lookup is case-insensitive: %v %v", got, err)
	}
}

func TestDevices(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u := newUser(t, s, "bob")
	d := &Device{ID: "dev1", UserID: u.ID, Name: "Laptop"}
	if err := s.CreateDevice(ctx, d, "tok"); err != nil {
		t.Fatal(err)
	}
	got, err := s.DeviceByToken(ctx, "tok")
	if err != nil || got.ID != "dev1" || got.UserID != u.ID {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := s.DeviceByToken(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	other := newUser(t, s, "eve")
	if _, err := s.DeleteDevice(ctx, other.ID, "dev1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("another user must not revoke the device")
	}
	if owner, err := s.DeleteDevice(ctx, u.ID, "dev1"); err != nil || owner != u.ID {
		t.Fatal(err)
	}
	if _, err := s.DeviceByToken(ctx, "tok"); !errors.Is(err, ErrNotFound) {
		t.Fatal("revoked token still valid")
	}
}

func TestPushPull(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u := newUser(t, s, "carol")
	other := newUser(t, s, "dave")

	res, err := s.Push(ctx, u.ID, &Device{Num: 1, ID: "d1"}, []Write{
		{Coll: "bm", ID: "a", Data: []byte("1")},
		{Coll: "bm", ID: "b", Data: []byte("2")},
		{Coll: "h", ID: "x", Data: []byte("3")},
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(res.Seqs) != "[1 2 3]" || res.MaxSeq != 3 {
		t.Fatalf("seqs %v", res.Seqs)
	}
	// Update a, delete b.
	if _, err := s.Push(ctx, u.ID, &Device{Num: 1, ID: "d2"}, []Write{{Coll: "bm", ID: "a", Data: []byte("1b")}, {Coll: "bm", ID: "b", Deleted: true}}, 0); err != nil {
		t.Fatal(err)
	}
	recs, more, err := s.Pull(ctx, u.ID, 0, 100, nil)
	if err != nil || more {
		t.Fatal(err, more)
	}
	// Only latest versions, in seq order: x(3), a(4), b(5).
	if len(recs) != 3 || recs[0].ID != "x" || recs[1].ID != "a" || string(recs[1].Data) != "1b" || recs[2].ID != "b" || !recs[2].Deleted {
		t.Fatalf("%+v", recs)
	}
	recs, _, _ = s.Pull(ctx, u.ID, 3, 100, nil)
	if len(recs) != 2 {
		t.Fatalf("since 3: %+v", recs)
	}
	recs, _, _ = s.Pull(ctx, u.ID, 0, 100, []string{"h"})
	if len(recs) != 1 || recs[0].Coll != "h" {
		t.Fatalf("filter: %+v", recs)
	}
	recs, more, _ = s.Pull(ctx, u.ID, 0, 2, nil)
	if len(recs) != 2 || !more {
		t.Fatal("pagination")
	}
	// Isolation between users.
	recs, _, _ = s.Pull(ctx, other.ID, 0, 100, nil)
	if len(recs) != 0 {
		t.Fatal("leak between users")
	}
	seq, _, _ := s.UserSeq(ctx, u.ID)
	if seq != 5 {
		t.Fatalf("seq %d", seq)
	}
}

func TestConditionalWrites(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u := newUser(t, s, "erin")
	// Base 0 = create only if absent.
	res, err := s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, []Write{{Coll: "v", ID: "o", Data: []byte("1"), Base: ptr(int64(0))}}, 0)
	if err != nil || len(res.Conflicts) != 0 || res.Seqs[0] != 1 {
		t.Fatal(err, res)
	}
	res, _ = s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, []Write{{Coll: "v", ID: "o", Data: []byte("2"), Base: ptr(int64(0))}}, 0)
	if len(res.Conflicts) != 1 || res.Conflicts[0].Current == nil || string(res.Conflicts[0].Current.Data) != "1" {
		t.Fatalf("expected conflict with current: %+v", res)
	}
	res, _ = s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, []Write{{Coll: "v", ID: "o", Data: []byte("2"), Base: ptr(int64(1))}}, 0)
	if len(res.Conflicts) != 0 || res.Seqs[0] != 2 {
		t.Fatalf("CAS should succeed: %+v", res)
	}
}

func TestQuota(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u := newUser(t, s, "q")
	if _, err := s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, []Write{{Coll: "c", ID: "1", Data: make([]byte, 60)}}, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, []Write{{Coll: "c", ID: "2", Data: make([]byte, 60)}}, 100); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want quota error, got %v", err)
	}
}

func TestMaintenance(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	u := newUser(t, s, "m")
	s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, []Write{{Coll: "bm", ID: "a", Deleted: true}, {Coll: "h", ID: "x", Data: []byte("1")}, {Coll: "bm", ID: "b", Data: []byte("1")}}, 0)
	time.Sleep(5 * time.Millisecond)
	if err := s.Maintenance(ctx, time.Millisecond, map[string]time.Duration{"h": time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	recs, _, _ := s.Pull(ctx, u.ID, 0, 100, nil)
	if len(recs) != 1 || recs[0].ID != "b" {
		t.Fatalf("%+v", recs)
	}
	_, gc, _ := s.UserSeq(ctx, u.ID)
	if gc != 1 {
		t.Fatalf("gc horizon %d", gc)
	}
}

func BenchmarkPush100(b *testing.B) {
	ctx := context.Background()
	s := newStore(b)
	u := newUser(b, s, "bench")
	ws := make([]Write, 100)
	payload := make([]byte, 200)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for j := range ws {
			ws[j] = Write{Coll: "h", ID: fmt.Sprintf("%d-%d", i, j), Data: payload}
		}
		if _, err := s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, ws, 0); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(b.N*100)/b.Elapsed().Seconds(), "records/s")
}

func BenchmarkPull1000(b *testing.B) {
	ctx := context.Background()
	s := newStore(b)
	u := newUser(b, s, "bench")
	payload := make([]byte, 200)
	for i := 0; i < 20; i++ {
		ws := make([]Write, 1000)
		for j := range ws {
			ws[j] = Write{Coll: "h", ID: fmt.Sprintf("%d-%d", i, j), Data: payload}
		}
		s.Push(ctx, u.ID, &Device{Num: 1, ID: "d"}, ws, 0)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if recs, _, err := s.Pull(ctx, u.ID, int64(i%19)*1000, 1000, nil); err != nil || len(recs) != 1000 {
			b.Fatal(err, len(recs))
		}
	}
	b.ReportMetric(float64(b.N*1000)/b.Elapsed().Seconds(), "records/s")
}

func TestMigrations(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "db.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	u := newUser(t, s, "mig")
	s.Close()

	// Reopening an up-to-date database keeps its data.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.UserByName(ctx, "mig"); err != nil || got.ID != u.ID {
		t.Fatalf("reopen lost data: %v", err)
	}
	var av int
	s.w.QueryRow(`PRAGMA auto_vacuum`).Scan(&av)
	if av != 2 {
		t.Fatalf("auto_vacuum = %d, want incremental", av)
	}
	// A database from a newer server is refused, not misread.
	s.w.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, SchemaVersion+1))
	s.Close()
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("want newer-schema error, got %v", err)
	}
}

// A reader connection opened while a write is in progress must not wait for
// the write (WAL readers never block); setting persistent pragmas on connect
// once made it stall for the busy timeout.
func TestFreshReaderDuringWrite(t *testing.T) {
	s := newStore(t)
	newUser(t, s, "w")
	s.r.SetMaxIdleConns(0) // force a brand-new reader connection
	tx, err := s.w.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET seq = seq + 1`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if _, err := s.UserByName(ctx, "w"); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("reader stalled %v during a write", d)
	}
}
