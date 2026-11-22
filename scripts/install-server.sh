#!/bin/sh
# Installs the helium-sync server on Linux, macOS or FreeBSD from GitHub
# Releases, verifying the binary's SHA-256 checksum.
#
#   curl -fsSL https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/install-server.sh | sh
#
# Options:
#   --version vX.Y.Z   a specific release (default: latest)
#   --dir DIR          where to put the binary (default: ~/.local/bin, or
#                      /usr/local/bin when run as root)
# Then run it, e.g.:  helium-sync service install --acme-domain sync.example.com
set -eu

REPO="j4ckxyz/helium-sync-server"
VERSION="latest"
DIR=""

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
printf '%s' "$VERSION" | grep -Eq '^(latest|v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.-]*)$' || die "invalid version: $VERSION"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  FreeBSD) os=freebsd ;;
  *) die "unsupported system $(uname -s); on Windows use install-server.ps1" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  armv7*|armv6*|armhf) arch=arm ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

if [ -z "$DIR" ]; then
  if [ "$(id -u)" = 0 ]; then DIR=/usr/local/bin; else DIR="$HOME/.local/bin"; fi
fi

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
asset="helium-sync-$os-$arch"

command -v curl >/dev/null 2>&1 || die "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'Downloading %s (%s)…\n' "$asset" "$VERSION"
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/checksums.txt" "$base/checksums.txt" || die "download failed: checksums.txt"

want="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")"
[ -n "$want" ] || die "no checksum for $asset in this release"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
[ "$got" = "$want" ] || die "checksum mismatch for $asset (expected $want, got $got)"
printf '✓ Checksum verified\n'

mkdir -p "$DIR"
install -m 755 "$tmp/$asset" "$DIR/helium-sync" 2>/dev/null || { cp "$tmp/$asset" "$DIR/helium-sync" && chmod 755 "$DIR/helium-sync"; }
printf '✓ Installed %s\n' "$("$DIR/helium-sync" version)"
printf '  %s\n' "$DIR/helium-sync"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) printf '  Add it to your PATH:  export PATH="%s:$PATH"\n' "$DIR" ;;
esac
cat <<'EOF'

Next, run it in the background at boot, with HTTPS. For example:
  helium-sync service install --acme-domain sync.example.com        # public server, automatic HTTPS
  helium-sync service install --addr :8080 --insecure-http \
      --public-url http://100.x.y.z:8080                            # private network (LAN / Tailscale)
It prints the first invite code in its log. Guide: https://github.com/j4ckxyz/helium-sync-server#quick-start
EOF
