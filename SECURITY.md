# Security

## Reporting a vulnerability

Please report security issues privately through [GitHub's private vulnerability reporting](https://github.com/j4ckxyz/helium-sync-server/security/advisories/new), not as public issues. Include what you found, how to reproduce it, and the version (`helium-sync version`).

## Model

Helium Sync is end-to-end encrypted: the server stores ciphertext and never sees your password or keys.

```
password ─PBKDF2-SHA256 (600k, per-user salt)─▶ master ─HKDF─┬─▶ authKey  → server stores Argon2id(authKey)
                                                             └─▶ kek      (never leaves the device)
dataKey (random 256-bit, stored on the server wrapped with kek)
dataKey ─HKDF─┬─▶ AES-256-GCM record key   (fresh IV; AAD = collection + record id)
              └─▶ HMAC-SHA256 id key       (URLs etc. become opaque record ids)
```

- **The server sees** usernames, device names, collection names (`bm`, `h`, `lt`, …), record counts and sizes, and timestamps. **It doesn't see** URLs, titles, bookmarks, history, tabs, your password or any key. A full database leak yields ciphertext plus slow-to-attack verifiers. Ciphertext is bound to its record, so the server can't swap or replay records between ids or collections.
- **Keys** stay in the browser as non-extractable WebCrypto keys (IndexedDB). Changing the password re-wraps the data key and signs out other devices. A forgotten password can't be recovered; that's what end-to-end means.
- **Sessions** use 256-bit bearer tokens, stored hashed. They can be revoked from any device or the CLI. The WebSocket authenticates in its first frame (so tokens never appear in URLs or proxy logs) and rejects website origins.
- **Accounts** are created with single-use invite codes by default. Unknown usernames get a stable fake salt, so accounts can't be enumerated.
- **Abuse limits:**
  - per-IP rate limits on sign-in, and a per-account failed-login lockout
  - bounded Argon2 concurrency
  - request, message and record size limits
  - per-account caps on open connections (32) and devices (64)
  - a storage quota (1 GiB by default)
- **The extension** has no host permissions: the server allows CORS from extension origins only, which is safe because tokens aren't cookies. Only its own pages can talk to its service worker. Content from other devices is rendered as text, and only web URLs become links or tabs.

## Safe by default on the public internet

The server refuses configurations that would put sign-in tokens on the wire unencrypted:

- **It binds to `127.0.0.1` unless told otherwise.** Listening on any other address requires one of the following, or it won't start:
  - HTTPS (`--acme-domain` or `--tls-cert`)
  - a reverse proxy that does HTTPS (`--trust-proxy`)
  - an explicit `--insecure-http`, meant for a LAN or Tailscale only
- **`--public-url` is required beyond localhost.** The address devices use, and the one baked into extension packages, never comes from a request's `Host` header. It's validated to be a plain `http(s)://host[:port][/path]`.
- **HSTS** is sent on HTTPS responses, and pages use a strict Content-Security-Policy.

Checklist for a public server:

1. Use HTTPS: `--acme-domain sync.example.com`, or Caddy/nginx in front with `--addr 127.0.0.1:8080 --trust-proxy --public-url https://sync.example.com`.
2. With `--trust-proxy`, make sure only the proxy can reach the server's port. Otherwise clients could spoof `X-Forwarded-For` to dodge rate limits.
3. Keep `--registration invite` (the default), and hand out invite codes with `helium-sync invite`.
4. Back up the data directory: `helium-sync.db` and `extension-key.pem`. The key signs your extension builds and fixes the extension ID.
5. Keep the binary up to date. Installed extensions update themselves from your server.

## Install scripts

The one-line installers in [`scripts/`](scripts) are short, readable shell and PowerShell. Read them before you run them.

- The **server installers** download a release binary over HTTPS, verify its SHA-256 against the release's `checksums.txt`, and install it for your user, without admin rights.
- The **Helium tweak** changes exactly one thing: Helium's own `extension-mime-request-handling` flag in `Local State` (backed up first; `--undo` restores it). Then it opens your server's install page.

To pin a version, replace `main` in the URLs with a release tag such as `v0.1.0`.
