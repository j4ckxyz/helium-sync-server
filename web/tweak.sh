#!/bin/sh
# Helium Sync tweak for macOS and Linux.
#
# Installs the Helium Sync extension into Helium, configured for your server:
#   curl -fsSL https://your-server/tweak.sh | sh
#
# What it does:
#   1. Turns on Helium's "Handling of extension MIME type requests: Always
#      prompt for install" flag (chrome://flags/#extension-mime-request-handling)
#      in Helium's Local State, so Helium can install extensions from your
#      server. A backup of Local State is kept next to it.
#   2. Opens your server's install page in Helium. Click "Add extension".
#   Updates then come from your server automatically.
#
# Options:
#   --server URL     server address (defaults to the server this came from)
#   --unpacked       install as an unpacked extension instead (Developer mode)
#   --data-dir DIR   Helium's user data directory, if not the default
#   --no-launch      only change the flag, do not open Helium
#   --undo           restore Local State from the backup this script made
set -eu

SERVER="${HELIUM_SYNC_SERVER:-__HELIUM_SYNC_SERVER__}"
MODE=crx
LAUNCH=1
DATA_DIR=""
UNDO=0

say() { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --server=*) SERVER="${1#*=}"; shift ;;
    --unpacked) MODE=unpacked; shift ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --data-dir=*) DATA_DIR="${1#*=}"; shift ;;
    --no-launch) LAUNCH=0; shift ;;
    --undo) UNDO=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$SERVER" in
  __HELIUM_SYNC_*|"") die "no server address. Run: sh tweak.sh --server https://your-server" ;;
esac
SERVER="${SERVER%/}"

OS="$(uname -s)"
case "$OS" in
  Darwin)
    [ -n "$DATA_DIR" ] || DATA_DIR="$HOME/Library/Application Support/net.imput.helium"
    APP=""
    for a in "/Applications/Helium.app" "$HOME/Applications/Helium.app"; do
      [ -d "$a" ] && APP="$a" && break
    done
    EXT_HOME="$HOME/Library/Application Support/helium-sync"
    ;;
  Linux)
    [ -n "$DATA_DIR" ] || DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/net.imput.helium"
    BIN=""
    for b in helium helium-browser; do
      if command -v "$b" >/dev/null 2>&1; then BIN="$(command -v "$b")"; break; fi
    done
    if [ -z "$BIN" ]; then
      for f in /opt/helium/helium /opt/helium-browser-bin/helium "$HOME/Applications"/helium*.AppImage "$HOME"/helium*.AppImage "$HOME/Downloads"/helium*.AppImage; do
        [ -x "$f" ] && BIN="$f" && break
      done
    fi
    EXT_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/helium-sync"
    ;;
  *) die "unsupported system $OS (use tweak.ps1 on Windows)" ;;
esac

LOCAL_STATE="$DATA_DIR/Local State"
BACKUP="$LOCAL_STATE.helium-sync.bak"

helium_running() {
  # Chromium keeps a SingletonLock symlink ("host-pid") in the profile while
  # it runs: precise, and specific to this profile.
  lock="$(readlink "$DATA_DIR/SingletonLock" 2>/dev/null || true)"
  if [ -n "$lock" ]; then
    pid="${lock##*-}"
    host="${lock%-*}"
    if [ "$host" = "$(hostname 2>/dev/null || uname -n)" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    return 1
  fi
  if [ "$OS" = Darwin ]; then
    pgrep -x Helium >/dev/null 2>&1
  else
    pgrep -x helium >/dev/null 2>&1
  fi
}

ask() {
  # Read from the terminal even when piped from curl.
  if { exec 3<>/dev/tty; } 2>/dev/null; then
    printf '%s' "$1" >&3
    read -r REPLY <&3 || REPLY=""
    exec 3>&-
    return 0
  fi
  return 1
}

wait_for_helium_to_quit() {
  if helium_running; then
    bold "Helium is running. Please quit Helium completely (all windows), then press Enter."
    while helium_running; do
      ask "Waiting for Helium to quit… [Enter to check again] " || die "Helium is still running. Quit it and run this again."
      helium_running || break
      sleep 1
    done
  fi
}

if [ "$UNDO" = 1 ]; then
  [ -f "$BACKUP" ] || die "no backup found at $BACKUP"
  wait_for_helium_to_quit
  cp "$BACKUP" "$LOCAL_STATE"
  say "Restored $LOCAL_STATE from backup."
  exit 0
fi

bold "Helium Sync setup"
say "Server: $SERVER"

# 1. Check the server.
if command -v curl >/dev/null 2>&1; then
  INFO="$(curl -fsS --max-time 15 "$SERVER/api/v1/info" 2>/dev/null || true)"
elif command -v wget >/dev/null 2>&1; then
  INFO="$(wget -qO- --timeout=15 "$SERVER/api/v1/info" 2>/dev/null || true)"
else
  die "curl or wget is required"
fi
case "$INFO" in
  *helium-sync*) say "✓ Server reachable" ;;
  *) die "cannot reach a Helium Sync server at $SERVER" ;;
esac

# 2. Unpacked mode: download and extract the extension.
if [ "$MODE" = unpacked ]; then
  mkdir -p "$EXT_HOME"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$SERVER/ext/helium-sync.zip" -o "$TMP/ext.zip" || die "download failed"
  rm -rf "$EXT_HOME/extension"
  mkdir -p "$EXT_HOME/extension"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$TMP/ext.zip" -d "$EXT_HOME/extension"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I -m zipfile -e "$TMP/ext.zip" "$EXT_HOME/extension"
  elif command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$TMP/ext.zip" "$EXT_HOME/extension"
  else
    die "need unzip, python3 or ditto to extract the extension"
  fi
  say "✓ Extension saved to $EXT_HOME/extension"
  say ""
  bold "Load it in Helium:"
  say "  1. Open helium://extensions (or chrome://extensions)"
  say "  2. Turn on Developer mode (top right)"
  say "  3. Click \"Load unpacked\" and choose: $EXT_HOME/extension"
  say "Unpacked extensions do not update automatically; re-run this script after upgrading the server."
  exit 0
fi

# 3. Enable the install flag in Local State (Helium must be closed).
wait_for_helium_to_quit
mkdir -p "$DATA_DIR"
if [ -f "$LOCAL_STATE" ] && [ ! -f "$BACKUP" ]; then
  cp "$LOCAL_STATE" "$BACKUP"
fi

FLAG="extension-mime-request-handling@2"
enable_flag_python() {
  python3 -I - "$LOCAL_STATE" "$FLAG" <<'PY'
import json, os, sys
path, flag = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        state = json.load(f)
except FileNotFoundError:
    state = {}
browser = state.setdefault("browser", {})
flags = [x for x in browser.get("enabled_labs_experiments", []) if not x.startswith("extension-mime-request-handling@")]
flags.append(flag)
browser["enabled_labs_experiments"] = flags
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(state, f, separators=(",", ":"))
os.replace(tmp, path)
PY
}
enable_flag_perl() {
  perl -MJSON::PP -e '
    my ($path, $flag) = @ARGV; my $state = {};
    if (open(my $f, "<:raw", $path)) { local $/; my $t = <$f>; close $f; $state = JSON::PP->new->decode($t) if length $t; }
    my $b = ($state->{browser} ||= {});
    my @flags = grep { !/^extension-mime-request-handling@/ } @{ $b->{enabled_labs_experiments} || [] };
    push @flags, $flag; $b->{enabled_labs_experiments} = \@flags;
    open(my $o, ">:raw", "$path.tmp") or die $!; print $o JSON::PP->new->canonical(0)->encode($state); close $o;
    rename("$path.tmp", $path) or die $!;
  ' "$LOCAL_STATE" "$FLAG"
}
enable_flag_jxa() {
  osascript -l JavaScript - "$LOCAL_STATE" "$FLAG" <<'JS'
function run(argv) {
  ObjC.import('Foundation');
  const path = argv[0], flag = argv[1];
  const data = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  const state = data.isNil() ? {} : JSON.parse(data.js);
  state.browser = state.browser || {};
  const flags = (state.browser.enabled_labs_experiments || []).filter((x) => !x.startsWith('extension-mime-request-handling@'));
  flags.push(flag);
  state.browser.enabled_labs_experiments = flags;
  $(JSON.stringify(state)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}
JS
}

if command -v python3 >/dev/null 2>&1 && python3 -c 'import json' >/dev/null 2>&1; then
  enable_flag_python
elif command -v perl >/dev/null 2>&1 && perl -MJSON::PP -e1 >/dev/null 2>&1; then
  enable_flag_perl
elif [ "$OS" = Darwin ]; then
  enable_flag_jxa
else
  die "need python3 or perl to edit Helium's settings. Or enable chrome://flags/#extension-mime-request-handling (\"Always prompt for install\") yourself, then open $SERVER/install in Helium."
fi
say "✓ Enabled extension installs from your server (Local State backed up to $(basename "$BACKUP"))"

# 4. Open the install page in Helium.
URL="$SERVER/install"
if [ "$LAUNCH" = 1 ]; then
  if [ "$OS" = Darwin ]; then
    if [ -n "$APP" ]; then open -a "$APP" "$URL"; else open -b net.imput.helium "$URL" 2>/dev/null || die "Helium.app not found; open $URL in Helium"; fi
  elif [ -n "${BIN:-}" ]; then
    nohup "$BIN" "$URL" >/dev/null 2>&1 &
  else
    say "Could not find Helium. Start it and open: $URL"
  fi
fi

say ""
bold "Almost done:"
say "  In Helium, click \"Add extension\" when asked. Helium Sync then opens its setup page,"
say "  where you sign in or create your account (the server address is filled in)."
say "  If nothing happens, open $URL in Helium."
