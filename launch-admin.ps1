$serverDir = Join-Path $PSScriptRoot 'server'
$cmd = "Set-Location '$serverDir'; node server.js"
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-Command', $cmd
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  if (netstat -an 2>$null | Select-String '127.0.0.1:3000') { break }
}
Start-Process 'http://localhost:3000'
