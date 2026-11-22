# Running the server

## Install

```sh
# Linux / macOS / FreeBSD: installs to ~/.local/bin (or /usr/local/bin as root)
curl -fsSL https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/install-server.sh | sh
```

```powershell
# Windows: installs to %LOCALAPPDATA%\Programs\helium-sync and adds it to PATH
irm https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/install-server.ps1 | iex
```

Both verify the binary against the release's `checksums.txt`. Binaries are also on the [releases page](https://github.com/j4ckxyz/helium-sync-server/releases), for amd64 and arm64, plus armv7 on Linux. To build from source with Go 1.26+, run `make build`.

## Choose how devices reach it

| Setup | Command |
|---|---|
| Public domain, automatic HTTPS (ports 80 and 443) | `helium-sync serve --acme-domain sync.example.com` |
| Behind Caddy/nginx doing HTTPS | `helium-sync serve --addr 127.0.0.1:8080 --trust-proxy --public-url https://sync.example.com` |
| Private network (LAN, Tailscale) | `helium-sync serve --addr :8080 --insecure-http --public-url http://100.101.102.103:8080` |
| Just this machine | `helium-sync serve` (binds `127.0.0.1:8080`) |

The server refuses to serve plain HTTP beyond localhost unless you pass `--insecure-http`, and it requires `--public-url` there. See [SECURITY.md](../SECURITY.md).

## Run in the background

`helium-sync service install [serve flags]` registers the server with your OS: a systemd unit (a user unit, or a system unit as root), a launchd job on macOS, or a Windows service (from an elevated PowerShell). It starts at boot, restarts on failure, and runs at background priority.

```sh
helium-sync service install --acme-domain sync.example.com
helium-sync service status
helium-sync service uninstall          # keeps your data
```

Where the logs go, including the first invite code:

| OS | Logs |
|---|---|
| Linux | `journalctl --user -u helium-sync` (system service: `sudo journalctl -u helium-sync`) |
| macOS | `~/Library/Application Support/helium-sync/helium-sync.log` |
| Windows | `%ProgramData%\helium-sync\helium-sync.log` |

For a Linux user service that should keep running after you log out, run `loginctl enable-linger $USER`.

### Docker

[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs the server behind Caddy, which provides automatic HTTPS. Set your domain in it (two places), then:

```sh
cd deploy && docker compose up -d
docker compose logs helium-sync     # first invite code
```

A hardened [systemd unit](../deploy/helium-sync.service) and a [Caddyfile](../deploy/Caddyfile) are there for manual setups.

## Accounts and devices

```
helium-sync invite  [--uses N] [--ttl 168h] create an invite code
helium-sync users                           list accounts
helium-sync devices <username>              list an account's devices
helium-sync revoke  <device-id>             sign a device out
helium-sync delete-user <username>          delete an account and its data
```

While no account exists, the server logs a fresh single-use invite code at every start. Admin commands need the same `--data` directory as the server.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--data` | `HELIUM_SYNC_DATA` | per-user directory, see below |
| `--addr` | `HELIUM_SYNC_ADDR` | `127.0.0.1:8080` (`:443` with ACME, `:8443` with `--tls-cert`) |
| `--public-url` | `HELIUM_SYNC_PUBLIC_URL` | required beyond localhost |
| `--acme-domain`, `--acme-email` | `HELIUM_SYNC_ACME_DOMAIN`, `…_EMAIL` | off |
| `--tls-cert`, `--tls-key` | `HELIUM_SYNC_TLS_CERT`, `…_KEY` | off |
| `--trust-proxy` | `HELIUM_SYNC_TRUST_PROXY` | `false` |
| `--insecure-http` | `HELIUM_SYNC_INSECURE_HTTP` | `false` |
| `--registration` | `HELIUM_SYNC_REGISTRATION` | `invite` (`open`, `closed`) |
| `--quota-mb` | `HELIUM_SYNC_QUOTA_MB` | `1024` per account |
| `--history-days` | `HELIUM_SYNC_HISTORY_DAYS` | `90` |
| `--tombstone-days` | `HELIUM_SYNC_TOMBSTONE_DAYS` | `180` |
| `--memory-limit-mb` | `HELIUM_SYNC_MEMORY_LIMIT_MB` | `64` (soft GC target) |
| `--log-file` | `HELIUM_SYNC_LOG_FILE` | stderr |

**Data directory:**

- Linux: `~/.local/share/helium-sync`, or `/var/lib/helium-sync` as root
- macOS: `~/Library/Application Support/helium-sync`
- Windows: `%LOCALAPPDATA%\helium-sync`, or `%ProgramData%\helium-sync` for the service

It holds `helium-sync.db` (SQLite) and `extension-key.pem`. **Back up both.** The key signs your extension builds and fixes the extension ID. Upgrading the server also upgrades the bundled extension, and installed copies update themselves.

## Footprint

Measured on Linux x86-64:

| | |
|---|---|
| Binary | ~15 MB, static, no dependencies |
| Memory at start / idle with 10 devices | 16 MB / 20 MB |
| Peak (a login plus 50,000 records sent to 19 devices) | 38 MB |
| CPU while idle with 10 devices | ~40 ms per minute (0.07% of a core) |
| Disk | roughly payload plus one index; large records compressed, freed space returned to the filesystem |
