// Package extpack turns the embedded extension source into installable
// packages configured for one server: a zip (for "Load unpacked") and a signed
// CRX3 with an update_url pointing back at the server, so installed copies
// update themselves whenever the server is upgraded.
package extpack

import (
	"archive/zip"
	"bytes"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"

	"helium-sync/internal/crx"
)

// Package is a built extension.
type Package struct {
	ID      string
	Version string
	Zip     []byte
	CRX     []byte
	ETag    string
}

// Config is written to config.json inside the package. The extension reads
// it to pre-fill the server address.
type Config struct {
	ServerURL string `json:"serverUrl"`
}

// skip reports files that are part of the source tree but not the extension.
func skip(p string) bool {
	base := path.Base(p)
	return strings.HasSuffix(p, ".go") || strings.HasPrefix(base, ".") || base == "config.json" ||
		strings.HasSuffix(p, ".md") || strings.HasPrefix(p, "test/")
}

// Build packages the extension in src for the server at serverURL.
func Build(src fs.FS, key *rsa.PrivateKey, serverURL string) (*Package, error) {
	serverURL = strings.TrimRight(serverURL, "/")
	raw, err := fs.ReadFile(src, "manifest.json")
	if err != nil {
		return nil, fmt.Errorf("extpack: %w", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("extpack: manifest: %w", err)
	}
	version, _ := manifest["version"].(string)
	manifest["key"] = crx.ManifestKey(key)
	manifest["update_url"] = serverURL + "/ext/updates.xml"
	mbytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	cbytes, _ := json.MarshalIndent(Config{ServerURL: serverURL}, "", "  ")

	var files []string
	err = fs.WalkDir(src, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || skip(p) || p == "manifest.json" {
			return nil
		}
		files = append(files, p)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// Fixed timestamps keep the package byte-identical across restarts, so
	// ETags stay valid and updates are only offered on real changes.
	mtime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	add := func(name string, data []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: mtime})
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	if err := add("manifest.json", mbytes); err != nil {
		return nil, err
	}
	if err := add("config.json", cbytes); err != nil {
		return nil, err
	}
	for _, p := range files {
		b, err := fs.ReadFile(src, p)
		if err != nil {
			return nil, err
		}
		if err := add(p, b); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}

	crxBytes, err := crx.Build(key, buf.Bytes())
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(buf.Bytes())
	return &Package{
		ID:      crx.ExtensionID(key),
		Version: version,
		Zip:     buf.Bytes(),
		CRX:     crxBytes,
		ETag:    `"` + hex.EncodeToString(sum[:12]) + `"`,
	}, nil
}

// UpdateManifest returns the Omaha-style update manifest Chromium polls.
func UpdateManifest(id, version, crxURL string) []byte {
	return []byte(fmt.Sprintf(`<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='%s'>
    <updatecheck codebase='%s' version='%s' />
  </app>
</gupdate>
`, id, xmlEscape(crxURL), xmlEscape(version)))
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "'", "&apos;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}
