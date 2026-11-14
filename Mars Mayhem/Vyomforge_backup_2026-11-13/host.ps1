# MARS: Outpost Survival - Windows host script.
#
# Serves this folder over HTTP so the ES-module game will load. Uses a plain
# TCP socket (System.Net.Sockets.TcpListener), so it needs no install, no admin
# rights and no Windows URL reservation.
#
#   host.ps1                  http://localhost:8123/
#   host.ps1 --port 9000      another port (busy ports fall forward)
#   host.ps1 --no-browser     serve only
#   host.ps1 --lan            accept connections from other machines (firewall prompt)
#
# Run it with:  powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1
# or double-click start.bat.

$ErrorActionPreference = 'Stop'

# ---- arguments (accept --flag and -flag alike) -------------------------------
$Port = 8123
$Lan = $false
$NoBrowser = $false

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^--?port$' {
      if ($i + 1 -ge $args.Count) {
        Write-Host 'host.ps1: --port needs a number, for example --port 9000' -ForegroundColor Red
        exit 1
      }
      try { $Port = [int]$args[$i + 1] }
      catch {
        Write-Host "host.ps1: '$($args[$i + 1])' is not a port number" -ForegroundColor Red
        exit 1
      }
      $i++
    }
    '^--?lan$'         { $Lan = $true }
    '^--?no-?browser$' { $NoBrowser = $true }
    '^--?help$|^-\?$' {
      Write-Host 'usage: host.ps1 [--port N] [--lan] [--no-browser]'
      exit 0
    }
  }
}

if ($PSScriptRoot) { $Root = $PSScriptRoot } else { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Test-Path (Join-Path $Root 'index.html'))) {
  Write-Host "index.html not found in $Root - run this script from the game folder." -ForegroundColor Red
  exit 1
}
$RootWithSep = $Root.TrimEnd('\') + '\'

$Mime = @{
  '.html'  = 'text/html; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.mjs'   = 'text/javascript; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.md'    = 'text/markdown; charset=utf-8'
  '.txt'   = 'text/plain; charset=utf-8'
  '.svg'   = 'image/svg+xml'
  '.png'   = 'image/png'
  '.jpg'   = 'image/jpeg'
  '.jpeg'  = 'image/jpeg'
  '.webp'  = 'image/webp'
  '.ico'   = 'image/x-icon'
  '.woff2' = 'font/woff2'
  '.map'   = 'application/json; charset=utf-8'
  '.wasm'  = 'application/wasm'
}

function Get-Mime($Path) {
  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($Mime.ContainsKey($ext)) { return $Mime[$ext] }
  return 'application/octet-stream'
}

function Send-Response($Stream, $Code, $Text, $ContentType, $Body, $HeadOnly) {
  $lines = @(
    "HTTP/1.1 $Code $Text",
    "Content-Type: $ContentType",
    "Content-Length: $($Body.Length)",
    'Cache-Control: no-store, no-cache, must-revalidate, max-age=0',
    'Pragma: no-cache',
    'Expires: 0',
    'Connection: close'
  )
  $head = [System.Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
  $Stream.Write($head, 0, $head.Length)
  if (-not $HeadOnly -and $Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
  $Stream.Flush()
}

function Handle-Request($Client) {
  $Client.ReceiveTimeout = 8000
  $Client.SendTimeout = 8000
  $stream = $Client.GetStream()

  # Browsers open speculative connections that never send a request. Do not let
  # one of those hold up the queue: wait briefly for the first byte, then hang up.
  $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
  while (-not $stream.DataAvailable) {
    if ([DateTime]::UtcNow -gt $deadline) { return }
    Start-Sleep -Milliseconds 20
  }

  $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)

  $requestLine = $reader.ReadLine()
  if ([string]::IsNullOrWhiteSpace($requestLine)) { return }

  # drain the header block (we do not need any of it)
  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line -or $line -eq '') { break }
  }

  $parts = $requestLine -split ' '
  if ($parts.Count -lt 2) {
    Send-Response $stream 400 'Bad Request' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('400')) $false
    return
  }
  $method = $parts[0].ToUpperInvariant()
  $target = $parts[1]
  if ($target.Contains('?')) { $target = $target.Split('?')[0] }

  try { $rel = [System.Uri]::UnescapeDataString($target).TrimStart('/') }
  catch { $rel = $target.TrimStart('/') }
  if ($rel -eq '') { $rel = 'index.html' }
  $rel = $rel.Replace('/', '\')

  try {
    $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
  }
  catch {
    Send-Response $stream 400 'Bad Request' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('400')) $false
    return
  }

  # never serve outside the game folder
  if (-not $full.StartsWith($RootWithSep, [StringComparison]::OrdinalIgnoreCase)) {
    Send-Response $stream 403 'Forbidden' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('403 - outside the game folder')) $false
    return
  }
  if (Test-Path $full -PathType Container) { $full = Join-Path $full 'index.html' }

  if (-not (Test-Path $full -PathType Leaf)) {
    Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes("404 - $rel not found")) $false
    Write-Host "  404  $rel" -ForegroundColor DarkYellow
    return
  }

  $bytes = [System.IO.File]::ReadAllBytes($full)
  Send-Response $stream 200 'OK' (Get-Mime $full) $bytes ($method -eq 'HEAD')
}

# ---- bind, stepping forward if the port is taken ----------------------------
$Requested = $Port
$Address = if ($Lan) { [System.Net.IPAddress]::Any } else { [System.Net.IPAddress]::Loopback }
$Listener = $null
$Bound = 0
$LastError = $null

for ($Candidate = $Requested; $Candidate -lt $Requested + 25; $Candidate++) {
  $attempt = $null
  try {
    $attempt = New-Object System.Net.Sockets.TcpListener($Address, $Candidate)
    $attempt.Start()
    $Listener = $attempt
    $Bound = $Candidate
    break
  }
  catch {
    $LastError = $_.Exception.Message
    if ($null -ne $attempt) { try { $attempt.Stop() } catch { } }
  }
}

if ($null -eq $Listener) {
  Write-Host "Could not open any port from $Requested to $($Requested + 24)." -ForegroundColor Red
  if ($LastError) { Write-Host "  $LastError" -ForegroundColor DarkGray }
  Write-Host 'Try another port:  host.ps1 --port 9000'
  exit 1
}

# 127.0.0.1, not localhost: localhost can resolve to IPv6 ::1 while this
# listener is IPv4-only, and a mistaken address looks exactly like a dead server.
$Url = "http://127.0.0.1:$Bound/"
Write-Host 'MARS: Outpost Survival'
Write-Host "  serving   $Root"
Write-Host "  local     $Url"
if ($Lan) {
  $ips = @()
  try {
    $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.IsLoopback } |
      ForEach-Object { $_.IPAddressToString }
  }
  catch { }
  if ($ips.Count -gt 0) {
    foreach ($ip in $ips) { Write-Host "  network   http://${ip}:$Bound/" }
  }
  else {
    Write-Host '  network   could not determine a LAN address'
  }
  Write-Host '  note      allow it through the Windows firewall if prompted'
}
else {
  Write-Host '  network   only this machine (use --lan to share)'
}
if ($Bound -ne $Requested) { Write-Host "  note      port $Requested was unavailable, using $Bound" }
Write-Host '  stop      Ctrl+C'
Write-Host ''

if (-not $NoBrowser) {
  try { Start-Process $Url } catch { Write-Host "Open $Url manually." }
}

# ---- serve ------------------------------------------------------------------
$served = 0
try {
  while ($true) {
    $client = $Listener.AcceptTcpClient()
    try {
      Handle-Request $client
      $served++
    }
    catch {
      Write-Host ("  error  {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
    finally {
      try { $client.Close() } catch { }
    }
  }
}
finally {
  try { $Listener.Stop() } catch { }
  Write-Host ''
  Write-Host "  served $served requests - server stopped"
}
