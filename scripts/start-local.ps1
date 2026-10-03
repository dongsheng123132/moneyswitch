param(
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
  [Parameter(Mandatory=$true)][ValidateSet('eip155:143','eip155:10143','eip155:8453','eip155:84532')][string]$Network,
  [string]$PasswordFile,
  [switch]$NoBrowser,
  [switch]$Stop
)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$dataPath=[IO.Path]::GetFullPath($DataDir)
$worker=Join-Path $PSScriptRoot 'local-server.mjs'
$stateFile=Join-Path $dataPath 'local-launcher.json'
$base="http://127.0.0.1:$Port"
$sha=[Security.Cryptography.SHA256]::Create()
$id=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataPath.ToLowerInvariant())))).Replace('-','')
$mutex=New-Object Threading.Mutex($false, "Local\MoneySwitch-$id")
$held=$false
try {
  try { $held=$mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $held=$true }
  if (!$held) { throw 'Another launch is still in progress. Please try again shortly.' }
  $owned=$null
  if (Test-Path -LiteralPath $stateFile) {
    $state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.data_dir -ne $dataPath -or $state.port -ne $Port -or $state.network -ne $Network) { throw 'The saved launcher configuration differs from this shortcut.' }
    $candidate=Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine -and $candidate.CommandLine.Contains($worker) -and $candidate.CommandLine.Contains($dataPath)) { $owned=$candidate }
  }
  if ($Stop) {
    if ($owned) { Stop-Process -Id $owned.ProcessId -ErrorAction Stop }
    Write-Output 'MoneySwitch local instance stopped.'
    return
  }
  $healthy=$false
  try { $healthy=(Invoke-RestMethod "$base/healthz" -TimeoutSec 2).ok -eq $true } catch {}
  if ($healthy -and !$owned) { throw "Port $Port belongs to another service. This launcher will not replace it." }
  if (!$healthy) {
    if ($owned) { throw 'The local process exists but is not responding. Stop this instance before restarting it.' }
    if (!(Test-Path (Join-Path $root 'apps/server/dist/start.js')) -or !(Test-Path (Join-Path $root 'apps/dashboard/dist/index.html'))) { throw 'Build MoneySwitch first: pnpm build' }
    if ($PasswordFile -and !(Test-Path -LiteralPath $PasswordFile)) { throw 'The configured wallet password file is missing.' }
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    $node=(Get-Command node.exe -ErrorAction Stop).Source
    $nodeArgs='"'+$worker+'" --data-dir "'+$dataPath+'" --port '+$Port+' --network '+$Network
    if ($PasswordFile) { $nodeArgs+=' --password-file "'+[IO.Path]::GetFullPath($PasswordFile)+'"' }
    $launched=Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'local-launcher.stdout.log') -RedirectStandardError (Join-Path $dataPath 'local-launcher.stderr.log')
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 250
      $launched.Refresh()
      if ($launched.HasExited) { throw "MoneySwitch could not start. See $dataPath\local-launcher.stderr.log" }
      try { $healthy=(Invoke-RestMethod "$base/healthz" -TimeoutSec 2).ok -eq $true } catch {}
    } while (!$healthy -and [DateTime]::UtcNow -lt $deadline)
    if (!$healthy) { throw 'MoneySwitch did not become ready within 30 seconds.' }
  }
  $adminFile=Join-Path $dataPath 'admin-token.txt'
  if (!(Test-Path -LiteralPath $adminFile)) { throw "Administrator login is required. Restore your admin-token.txt in $dataPath; the launcher does not reset it." }
  $admin=(Get-Content -LiteralPath $adminFile -Raw).Trim()
  $headers=@{Authorization="Bearer $admin"}
  $meta=Invoke-RestMethod "$base/v1/admin/meta" -Headers $headers -TimeoutSec 5
  if ($meta.network -ne $Network) { throw 'Network mismatch: refusing to open the wrong wallet environment.' }
  if (!$NoBrowser) {
    $entry=Invoke-RestMethod "$base/v1/admin/local-link" -Method Post -ContentType 'application/json' -Body '{}' -Headers $headers -TimeoutSec 5
    if ($entry.path -notmatch '^/local#ms_setup_[A-Za-z0-9_-]+$') { throw 'Invalid local login response.' }
    Start-Process -FilePath ($base+$entry.path) | Out-Null
  }
  Write-Output "MoneySwitch ready: $base/wallet ($Network)"
} catch {
  if (!$NoBrowser) {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message,'MoneySwitch') | Out-Null
  }
  throw
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose(); $sha.Dispose()
}
