# Download the official Node.js 22 for this Windows PC into .node\ (used by setup.bat when Node.js is missing or too
# old). Same steps as setup.sh: read SHASUMS256.txt from nodejs.org, download the zip for this processor, verify its
# SHA-256 checksum, unpack. No administrator rights, nothing installed system-wide.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = 'https://nodejs.org/dist/latest-v22.x'
Write-Host "[setup] Downloading the official Node.js 22 for win-$arch into .node\ (no administrator rights needed)..."
$sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
$line = ($sums -split "`n") | Where-Object { $_ -match "^[0-9a-f]{64}\s+node-v22\.\d+\.\d+-win-$arch\.zip\s*$" } | Select-Object -First 1
if (-not $line) { throw "No Node.js 22 download for win-$arch." }
$sum, $file = ($line.Trim() -split '\s+')
$tmp = Join-Path $env:TEMP ('parashurama-node-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp $file
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sum) { throw "Checksum mismatch for $file: download not used." }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dest = Join-Path $root '.node'
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $dest
  Write-Host '[setup] Node.js installed in .node\ (checksum verified).'
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
