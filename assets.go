// Package heliumsync embeds the browser extension and web assets so the
// server ships as a single binary.
package heliumsync

import (
	"embed"
	"io/fs"
)

//go:embed extension
var extensionFS embed.FS

//go:embed web
var webFS embed.FS

// Extension returns the extension source tree.
func Extension() fs.FS { sub, _ := fs.Sub(extensionFS, "extension"); return sub }

// Web returns the landing page and tweak scripts.
func Web() fs.FS { sub, _ := fs.Sub(webFS, "web"); return sub }
