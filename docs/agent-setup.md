# Setting up Helium Sync with an AI agent

These are instructions for a coding agent (Claude Code, Codex and similar) setting up Helium Sync for its user. People can follow them too.

**Goal:** a running Helium Sync server, reachable by the user's devices over HTTPS or a private network, with Helium on each device connected to it.

## Rules

- **Ask before anything that exposes a service to the internet**: opening firewall ports, DNS changes, using `--acme-domain`. Also ask before anything you can't undo.
- **Never serve plain HTTP on a public address.** The server refuses to anyway. Use `--insecure-http` only on a LAN or Tailscale network the user controls.
- **Keep `--registration invite`** (the default). Never use `--registration open` on a reachable server.
- **Don't create the account or type the user's password for them.** The password encrypts their data and must stay theirs. You may relay the invite code.
- **Don't modify Helium beyond the tweak script.** Quitting Helium is up to the user: ask them to.
- Use the official scripts from this repository and read them first. They are short, and the server installers verify checksums.

## 1. Find out the setup

Ask the user, or work it out:

1. **Which machine runs the server?** It should be on whenever they browse: a home server, NAS, Raspberry Pi, VPS, or one of their computers.
2. **How do the other devices reach it?** Pick one:
   - **A. Public domain**: the user has a domain pointing at the machine, with ports 80 and 443 reachable. Uses automatic HTTPS.
   - **B. Existing reverse proxy**: Caddy, nginx or Traefik already does HTTPS on that machine.
   - **C. Private network**: all devices are on the same LAN, or on Tailscale. Simplest, and nothing is exposed to the internet.
3. **Which computers have Helium?** They can be macOS, Linux or Windows.

## 2. Install the server

On the server machine:

```sh
# Linux / macOS / FreeBSD
curl -fsSL https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/install-server.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/install-server.ps1 | iex
```

Check: `helium-sync version`. (On Linux/macOS the binary goes to `~/.local/bin`; add it to `PATH` if needed.)

## 3. Run it in the background

Pick the command for the option from step 1. `service install` sets up systemd (Linux), launchd (macOS) or a Windows service (needs an elevated PowerShell). The server then starts at boot and restarts on failure.

```sh
# A. Public domain, automatic HTTPS. Needs ports 80 and 443; on Linux, run as root (sudo)
#    or grant the binary CAP_NET_BIND_SERVICE.
helium-sync service install --acme-domain sync.example.com

# B. Behind an existing HTTPS reverse proxy that forwards to 127.0.0.1:8080
helium-sync service install --addr 127.0.0.1:8080 --trust-proxy --public-url https://sync.example.com

# C. Private network (LAN or Tailscale). Use the machine's LAN or Tailscale IP or name.
helium-sync service install --addr :8080 --insecure-http --public-url http://100.101.102.103:8080
```

For option B, the proxy needs a site like this (Caddy):

```
sync.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

On Linux user services, also run `loginctl enable-linger $USER` so the server keeps running after logout.

**Verify** from another device if you can:

```sh
curl -fsS https://sync.example.com/healthz          # → ok
curl -fsS https://sync.example.com/api/v1/info      # → {"service":"helium-sync",…}
```

## 4. Get the first invite code

The server logs a single-use invite code while no account exists:

- Linux: `journalctl --user -u helium-sync` (or `sudo journalctl -u helium-sync` for a system service)
- macOS: `~/Library/Application Support/helium-sync/helium-sync.log`
- Windows: `%ProgramData%\helium-sync\helium-sync.log`

Or create one: `helium-sync invite --data <data dir>`. The data directory is shown when the service is installed.

## 5. Connect Helium on each computer

Ask the user to **quit Helium completely**, then run the tweak with their server address:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/tweak.sh | sh -s -- --server https://sync.example.com
```

```powershell
# Windows (PowerShell)
$env:HELIUM_SYNC_SERVER='https://sync.example.com'; irm https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/tweak.ps1 | iex
```

Helium opens the server's install page. Then tell the user:

1. Click **Install extension**, then **Add extension**.
2. On the setup page that opens: **Create account** on the first computer, using the invite code and a strong password. On the others, **Sign in** with the same username and password.

## 6. Report back

Tell the user:

- the server address, and how the server runs (service type, data directory, log location);
- to **back up** the data directory (`helium-sync.db` and `extension-key.pem`);
- how to connect more devices (step 5) and create invites (`helium-sync invite`);
- that their password can't be recovered by anyone, including the server.
