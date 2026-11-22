package server

import (
	"bytes"
	"html/template"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"helium-sync/internal/extpack"
)

// pkg returns the extension package configured for the requesting base URL.
func (s *Server) pkg(r *http.Request) (*extpack.Package, error) {
	base := s.publicURL(r)
	s.pkgMu.Lock()
	defer s.pkgMu.Unlock()
	if p, ok := s.pkgs[base]; ok {
		return p, nil
	}
	if s.cfg.ExtensionFS == nil {
		return nil, fs.ErrNotExist
	}
	p, err := extpack.Build(s.cfg.ExtensionFS, s.key, base)
	if err != nil {
		return nil, err
	}
	if len(s.pkgs) > 16 { // bound memory if clients send many Host values
		s.pkgs = map[string]*extpack.Package{}
	}
	s.pkgs[base] = p
	return p, nil
}

func (s *Server) servePkg(w http.ResponseWriter, r *http.Request, contentType, filename string, body func(*extpack.Package) []byte) {
	p, err := s.pkg(r)
	if err != nil {
		s.log.Error("build extension package", "err", err)
		http.Error(w, "extension package unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	if filename != "" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	}
	w.Header().Set("ETag", p.ETag)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body(p)))
}

func (s *Server) handleCRX(w http.ResponseWriter, r *http.Request) {
	// Served inline (no attachment disposition) so Helium offers to install
	// it when navigated to.
	s.servePkg(w, r, "application/x-chrome-extension", "", func(p *extpack.Package) []byte { return p.CRX })
}

func (s *Server) handleZip(w http.ResponseWriter, r *http.Request) {
	s.servePkg(w, r, "application/zip", "helium-sync-extension.zip", func(p *extpack.Package) []byte { return p.Zip })
}

func (s *Server) handleUpdates(w http.ResponseWriter, r *http.Request) {
	p, err := s.pkg(r)
	if err != nil {
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/xml")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(extpack.UpdateManifest(p.ID, p.Version, s.publicURL(r)+"/ext/helium-sync.crx"))
}

type pageData struct {
	URL          string
	ExtensionID  string
	Version      string
	ExtVersion   string
	Registration string
	TweakSh      string
	TweakPs1     string
}

// TweakCommands are the one-liners that prepare Helium for this server.
func TweakCommands(base string) (sh, ps1 string) {
	raw := strings.Replace(Repository, "github.com", "raw.githubusercontent.com", 1) + "/main/scripts"
	sh = "curl -fsSL " + raw + "/tweak.sh | sh -s -- --server " + base
	ps1 = "$env:HELIUM_SYNC_SERVER='" + base + "'; irm " + raw + "/tweak.ps1 | iex"
	return sh, ps1
}

func (s *Server) data(r *http.Request) pageData {
	d := pageData{URL: s.publicURL(r), ExtensionID: s.ExtensionID(), Version: Version, Registration: s.cfg.Registration}
	d.TweakSh, d.TweakPs1 = TweakCommands(d.URL)
	if p, err := s.pkg(r); err == nil {
		d.ExtVersion = p.Version
	}
	return d
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	s.page(w, r, "index.html")
}

func (s *Server) handleInstall(w http.ResponseWriter, r *http.Request) {
	s.page(w, r, "install.html")
}

func (s *Server) page(w http.ResponseWriter, r *http.Request, name string) {
	if s.cfg.WebFS == nil {
		w.Write([]byte("helium-sync server\n"))
		return
	}
	t, err := template.ParseFS(s.cfg.WebFS, name)
	if err != nil {
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, s.data(r)); err != nil {
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.Write(buf.Bytes())
}
