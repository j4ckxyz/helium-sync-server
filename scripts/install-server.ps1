# Installs the helium-sync server on Windows from GitHub Releases, verifying
# the binary's SHA-256 checksum. In PowerShell:
#
#   irm https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/install-server.ps1 | iex
#
# Environment: HELIUM_SYNC_VERSION (default: latest), HELIUM_SYNC_DIR
# (default: %LOCALAPPDATA%\Programs\helium-sync).
# Then, from an elevated PowerShell:  helium-sync service install --acme-domain sync.example.com

$ErrorActionPreference = 'Stop'
$Repo = 'j4ckxyz/helium-sync-server'
$Version = if ($env:HELIUM_SYNC_VERSION) { $env:HELIUM_SYNC_VERSION } else { 'latest' }
if ($Version -notmatch '^(latest|v\d+\.\d+\.\d+[A-Za-z0-9.-]*)$') { throw "Invalid version: $Version" }
$Dir = if ($env:HELIUM_SYNC_DIR) { $env:HELIUM_SYNC_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\helium-sync' }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'amd64' } 'ARM64' { 'arm64' } default { throw "Unsupported CPU $env:PROCESSOR_ARCHITECTURE" } }
$asset = "helium-sync-windows-$arch.exe"
$base = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
try {
  Write-Host "Downloading $asset ($Version)..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')
  $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { ($_ -split '\s+')[1].TrimStart('*') -eq $asset } | Select-Object -First 1
  if (-not $line) { throw "No checksum for $asset in this release" }
  $want = ($line -split '\s+')[0].ToLower()
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($got -ne $want) { throw "Checksum mismatch for $asset (expected $want, got $got)" }
  Write-Host 'OK  Checksum verified' -ForegroundColor Green

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $exe = Join-Path $Dir 'helium-sync.exe'
  Copy-Item -Force (Join-Path $tmp $asset) $exe
  Write-Host "OK  Installed $(& $exe version)" -ForegroundColor Green
  Write-Host "    $exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $Dir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $Dir).TrimStart(';'), 'User')
    Write-Host "    Added $Dir to your PATH (open a new terminal to use it)."
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Next, from an elevated PowerShell (Run as administrator), run it as a service with HTTPS, e.g.:' -ForegroundColor Cyan
Write-Host '  helium-sync service install --acme-domain sync.example.com'
Write-Host '  helium-sync service install --addr :8080 --insecure-http --public-url http://100.x.y.z:8080   # private network only'
Write-Host 'It writes the first invite code to its log. Guide: https://github.com/j4ckxyz/helium-sync-server#quick-start'
