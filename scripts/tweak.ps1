# Helium Sync tweak for Windows: prepares Helium to install the Helium Sync
# extension from your own server. In PowerShell:
#
#   $env:HELIUM_SYNC_SERVER='https://sync.example.com'; irm https://raw.githubusercontent.com/j4ckxyz/helium-sync-server/main/scripts/tweak.ps1 | iex
#
# What it does (nothing else):
#   1. Turns on Helium's own flag "Handling of extension MIME type requests:
#      Always prompt for install" (chrome://flags/#extension-mime-request-handling)
#      by editing Helium's Local State while Helium is closed. A backup of
#      Local State is kept next to it; HELIUM_SYNC_UNDO=1 restores it.
#   2. Opens your server's install page in Helium. Click "Add extension".
#      The extension then updates itself from your server.
#
# Environment: HELIUM_SYNC_SERVER (asked for if missing), HELIUM_SYNC_DATA_DIR,
# HELIUM_SYNC_ALLOW_HTTP=1 (plain HTTP to a public address, not recommended),
# HELIUM_SYNC_UNDO=1.

$ErrorActionPreference = 'Stop'

if ($env:HELIUM_SYNC_UNDO -ne '1') {
  $Server = $env:HELIUM_SYNC_SERVER
  if (-not $Server) { $Server = Read-Host 'Your Helium Sync server address (e.g. https://sync.example.com)' }
  $Server = $Server.Trim().TrimEnd('/')
  if ($Server -notmatch '^https?://') { $Server = "https://$Server" }
  # Only plain addresses: the value is used in URLs and process arguments.
  if ($Server -notmatch '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$') { throw "Not a valid server address: $Server" }
  $private = $Server -match '^http://(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|[^/]+\.local(:|/|$)|[^/]+\.ts\.net(:|/|$))'
  if ($Server.StartsWith('http://') -and -not $private -and $env:HELIUM_SYNC_ALLOW_HTTP -ne '1') {
    throw "Refusing plain HTTP to a public address ($Server): your sign-in could be intercepted. Use https://."
  }
}

$DataDir = if ($env:HELIUM_SYNC_DATA_DIR) { $env:HELIUM_SYNC_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'imput\Helium\User Data' }
$LocalState = Join-Path $DataDir 'Local State'
$Backup = "$LocalState.helium-sync.bak"
$Flag = 'extension-mime-request-handling@2'

function Find-Helium {
  foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $base) { continue }
    $c = Join-Path $base 'imput\Helium\Application\chrome.exe'
    if (Test-Path $c) { return $c }
  }
  return $null
}

function Get-HeliumProcesses {
  Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\imput\Helium\*' }
}

function Wait-HeliumClosed {
  if (Get-HeliumProcesses) {
    Write-Host 'Helium is running. Please quit Helium completely (all windows).' -ForegroundColor Yellow
    while (Get-HeliumProcesses) {
      Read-Host 'Press Enter once Helium is closed' | Out-Null
    }
  }
}

if ($env:HELIUM_SYNC_UNDO -eq '1') {
  if (-not (Test-Path $Backup)) { throw "No backup at $Backup" }
  Wait-HeliumClosed
  Copy-Item $Backup $LocalState -Force
  Write-Host "Restored $LocalState from backup."
  return
}

Write-Host 'Helium Sync setup' -ForegroundColor Cyan
Write-Host "Server: $Server"

try {
  $info = Invoke-RestMethod -Uri "$Server/api/v1/info" -TimeoutSec 15
} catch {
  throw "Cannot reach a Helium Sync server at $Server"
}
if ($info.service -ne 'helium-sync') { throw "$Server is not a Helium Sync server" }
Write-Host 'OK  Server reachable' -ForegroundColor Green

Wait-HeliumClosed
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
if ((Test-Path $LocalState) -and -not (Test-Path $Backup)) { Copy-Item $LocalState $Backup }

$raw = if (Test-Path $LocalState) { [IO.File]::ReadAllText($LocalState) } else { '{}' }
if ($PSVersionTable.PSVersion.Major -ge 6) {
  $state = $raw | ConvertFrom-Json -AsHashtable
  if (-not $state.ContainsKey('browser')) { $state['browser'] = @{} }
  $flags = @($state['browser']['enabled_labs_experiments'] | Where-Object { $_ -and -not $_.StartsWith('extension-mime-request-handling@') })
  $state['browser']['enabled_labs_experiments'] = @($flags + $Flag)
  $json = $state | ConvertTo-Json -Depth 100 -Compress
} else {
  # Windows PowerShell 5: ConvertTo-Json mangles deep objects; use the .NET
  # serializer, which round-trips Chromium's JSON faithfully.
  Add-Type -AssemblyName System.Web.Extensions
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = [int]::MaxValue
  $ser.RecursionLimit = 1000
  $state = $ser.DeserializeObject($raw)
  if (-not $state.ContainsKey('browser')) { $state['browser'] = New-Object 'System.Collections.Generic.Dictionary[string,object]' }
  $old = @()
  if ($state['browser'].ContainsKey('enabled_labs_experiments')) { $old = @($state['browser']['enabled_labs_experiments']) }
  $flags = @($old | Where-Object { $_ -and -not ([string]$_).StartsWith('extension-mime-request-handling@') })
  $state['browser']['enabled_labs_experiments'] = [object[]]($flags + $Flag)
  $json = $ser.Serialize($state)
}
$tmp = "$LocalState.tmp"
[IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
Move-Item -Force $tmp $LocalState
Write-Host 'OK  Enabled extension installs from your server (Local State backed up)' -ForegroundColor Green

$url = "$Server/install"
$exe = Find-Helium
if ($exe) {
  Start-Process -FilePath $exe -ArgumentList $url
} else {
  Write-Host "Could not find Helium. Start it and open: $url" -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Almost done:' -ForegroundColor Cyan
Write-Host '  In Helium, click "Add extension" when asked. Helium Sync then opens its setup page,'
Write-Host '  where you sign in or create your account (the server address is filled in).'
Write-Host "  If nothing happens, open $url in Helium."
