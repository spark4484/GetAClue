# play.ps1 - start the GetAClue server and share it online through a Cloudflare quick tunnel.
# Run:  powershell -ExecutionPolicy Bypass -File .\play.ps1
# Send your friend the https://....trycloudflare.com link that appears in the box below.
# Press Ctrl+C to stop; the game server is shut down with the tunnel.

$port = 3477

$cloudflared = @(
  "$env:ProgramFiles\cloudflared\cloudflared.exe",
  "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cloudflared) { $cloudflared = "cloudflared" }  # hope it's on PATH

$server = Start-Process node -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden
Write-Host "GetAClue server running on http://localhost:$port (pid $($server.Id))"
Write-Host "Opening the tunnel - give your friend the trycloudflare.com link below." -ForegroundColor Yellow

try {
  & $cloudflared tunnel --url "http://localhost:$port"
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Write-Host "Game server stopped."
}
