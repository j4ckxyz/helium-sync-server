# How it works

```
 Helium (device A)                         your server                         Helium (device B)
 ┌───────────────────────┐   WebSocket   ┌──────────────────┐   WebSocket   ┌───────────────────────┐
 │ adapters: tabs, bm, … │──── push ────▶│ SQLite: opaque   │──changes────▶│ adapters apply only   │
 │ scan ▸ diff ▸ encrypt │◀── changes ───│ (coll, id, seq,  │◀──── push ────│ fields that changed   │
 │ AES-256-GCM per record│               │  ciphertext)     │               │ decrypt ▸ merge       │
 └───────────────────────┘               └──────────────────┘               └───────────────────────┘
```

## Server

A record is an opaque `(collection, id, ciphertext)` triple. Every write gets the next value of a per-user sequence number, and clients sync from a cursor.

All frames sent to a connection are produced under the user's lock, in sequence order. A connection only starts receiving live changes once it has caught up, so a client never sees a gap, or an older version after a newer one. Pushes reach your other devices in about 1 ms (`go test -bench Fanout ./internal/server`).

## Client engine

Every data type is reconciled by *state*, not by replaying events:

- `scan` reads the browser, diffs it against the last-synced model, and queues the differences.
- `apply` merges remote records and changes only what they changed.

After an apply, the browser's own events lead to a scan that finds nothing new. So there are no echo loops, whatever order Chromium delivers events and callbacks in. Changes made offline wait in a persisted outbox.

## Conflicts

Each field (URL, title, pin, group, position, bookmark parent…) carries its own version: a hybrid-logical-clock stamp plus the device id. Merges take the newest value per field. If one device renames a tab group while another moves a tab, both changes survive. A device that hadn't seen a newer change yet can never roll it back, and merges converge in any order.

Ordering uses fractional index keys, so a move rewrites a single record. A user edit is detected as a change from what the browser looked like right after the last sync, not from the model. That way, state the browser couldn't apply yet (for example, a group whose record hasn't arrived) is never mistaken for an edit.

## Live tabs in Helium

- Helium pins are profile-wide and mirrored into every window. So one window per device is mirrored, and pin copies in other windows are ignored.
- Tab ids don't survive restarts, so tabs are matched to records by URL again once session restore settles.
- Closing a window or quitting never deletes tabs. A tab deleted elsewhere while this device was off is closed when its restored copy reappears.
- Redirects (detected with `webNavigation` qualifiers) aren't synced back, so device-specific redirects such as login pages or locale redirects can't make devices fight.
- Only the device that navigated a tab reports its title, so loading placeholders and unread counts don't flip-flop between devices.
- Discarding a tab replaces its id, and a tab mid-replacement is adopted rather than duplicated.

## Compatibility

The extension uses only stable APIs and checks for each optional one at runtime. A missing or changed API turns off just the feature that needs it (shown in settings), never the whole extension.

- **Tested browsers:** the end-to-end suites pass on the oldest Helium (0.3.5.1, Chromium 139), the current Helium (0.22.2, Chromium 158), and Chrome for Testing 120, 145, 150, 156 and 159.
- **Lazy loading** of tabs from other devices relies on tab discarding. That brought the whole browser down on Chromium 120–155 in headless tests, so lazy loading is only enabled on 156 and newer.
- **Mixed extension versions:**
  - Records carry a format number (plain or compressed).
  - Fields a device doesn't know about are kept when it rewrites a record.
  - Records in a format a device can't read yet are fetched again once it updates.
- **Loop breaker:** a record rewritten more than 120 times a minute is sent at most every 5 s. Deletions are never held back.
- **Protocol:** `/api/v1` is versioned, and the WebSocket handshake carries a protocol number. Unknown messages and fields are ignored on both sides. The database schema is migrated in place, and a database written by a newer server is refused rather than misread.

## Tests

```sh
make test                                  # Go (race detector) + JS unit tests
HELIUM=/path/to/helium make e2e            # real server + two real browsers
make matrix BROWSERS="/path/a /path/b"     # e2e against several browser builds
HELIUM=/path/to/helium make perf           # timings
```

The end-to-end suites drive the real server binary and two or three headless browser profiles. They cover:

- bookmarks; live tabs (open, navigate, pin, group, reorder, close); redirects not being echoed; history; open tabs; send-tab
- first-sync merge without duplicates; edits made while the server is down; restarts while another device keeps changing things; a third device catching up
- **quiescence**: once things settle, no device writes anything

`HS_TRACE=1` dumps a full trace on failure.

Measured on Helium 0.22.2, localhost:

| | |
|---|---|
| New tab on A appears on B | ~75–200 ms |
| 5,000 bookmarks in 50 folders | on B 2.2 s after A finished creating them |
| History backfill, 5,000 visits | 1.5 s |
| New device fully synced | ~0.7 s, including key derivation |

## Layout

```
cmd/helium-sync/     CLI, server entry point, OS services
internal/server/     HTTP API, auth, WebSocket hub, pages
internal/store/      SQLite storage and migrations
internal/crx/        CRX3 signing and verification
internal/extpack/    per-server extension packages
extension/           the MV3 extension (no build step)
scripts/             server installers and the Helium tweak
web/                 landing and install pages
test/                unit, end-to-end and demo recording
deploy/              Docker Compose, Caddy, systemd
```
