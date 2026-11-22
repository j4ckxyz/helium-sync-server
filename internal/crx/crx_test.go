package crx

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestBuildVerify(t *testing.T) {
	p := filepath.Join(t.TempDir(), "key.pem")
	k, err := LoadOrCreateKey(p)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := LoadOrCreateKey(p)
	if err != nil || ExtensionID(k) != ExtensionID(k2) {
		t.Fatal("key not persisted", err)
	}
	zip := []byte("PK\x03\x04 fake zip payload")
	pkg, err := Build(k, zip)
	if err != nil {
		t.Fatal(err)
	}
	gotZip, id, err := Verify(pkg)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotZip, zip) || id != ExtensionID(k) || len(id) != 32 {
		t.Fatalf("id=%s", id)
	}
	pkg[len(pkg)-1] ^= 1
	if _, _, err := Verify(pkg); err == nil {
		t.Fatal("tampered package verified")
	}
}
