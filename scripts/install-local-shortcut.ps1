param(
  [Parameter(Mandatory=$true)][string]$Name,
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
  [Parameter(Mandatory=$true)][ValidateSet('eip155:143','eip155:10143','eip155:8453','eip155:84532')][string]$Network,
  [string]$PasswordFile,
  [string]$Destination=([Environment]::GetFolderPath('Desktop'))
)
$ErrorActionPreference='Stop'
if ($Name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Invalid shortcut name' }
$launcher=Join-Path $PSScriptRoot 'start-local.ps1'
$target=Join-Path $Destination ($Name+'.lnk')
if (Test-Path -LiteralPath $target) { throw 'Shortcut already exists; choose another name instead of overwriting it.' }
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($target)
$shortcut.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launcher+'" -DataDir "'+[IO.Path]::GetFullPath($DataDir)+'" -Port '+$Port+' -Network '+$Network
if ($PasswordFile) { $shortcut.Arguments+=' -PasswordFile "'+[IO.Path]::GetFullPath($PasswordFile)+'"' }
$shortcut.WorkingDirectory=Split-Path $PSScriptRoot -Parent
$shortcut.Description="MoneySwitch local wallet ($Network). Starts the local server and opens your browser."
$shortcut.IconLocation=(Join-Path $env:WINDIR 'System32\shell32.dll')+',21'
$shortcut.Save()
Write-Output $target
