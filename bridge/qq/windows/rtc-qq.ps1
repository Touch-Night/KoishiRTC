# SPDX-License-Identifier: GPL-3.0-only
# Windows PowerShell 5.1 / PowerShell 7. No elevation or registry changes.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('install','doctor','run-av-host','run-napcat','control','disable')]
  [string]$Operation,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [string]$QQSource,
  [string]$NapCatSource,
  [ValidateRange(1024,65535)][int]$Port = 6110,
  [ValidateRange(1024,65535)][int]$AVPort = 6111,
  [string]$Action = 'status',
  [string]$BodyFile,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  throw 'This launcher is for Windows x64. Offline JavaScript tests also run on Linux.'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = & $node -p 'JSON.stringify({version:process.versions.node,arch:process.arch})' | ConvertFrom-Json
if ($version.arch -ne 'x64' -or [version]$version.version -lt [version]'22.19.0') {
  throw 'Install Node.js 22.19 or newer x64 before running this script.'
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$argv = @((Join-Path $PSScriptRoot 'manage.mjs'), $Operation, '--install-dir', $InstallDir)
if ($Operation -eq 'install') {
  if (-not $QQSource -or -not $NapCatSource) { throw 'Provide fresh QQSource and NapCatSource directories.' }
  $argv += @('--qq-source', [System.IO.Path]::GetFullPath($QQSource), '--napcat-source', [System.IO.Path]::GetFullPath($NapCatSource), '--port', "$Port", '--av-port', "$AVPort")
  if ($Check) { $argv += '--check' }
}
if ($Operation -eq 'control') {
  $argv += @('--action', $Action)
  if ($BodyFile) { $argv += @('--body-file', [System.IO.Path]::GetFullPath($BodyFile)) }
}
& $node @argv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Operation -eq 'install' -and -not $Check) {
  # POSIX mode bits do not protect tokens on NTFS: set a private runtime ACL.
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe (Join-Path $InstallDir 'runtime') /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' /T /Q
  if ($LASTEXITCODE -ne 0) { throw 'Installation files are prepared, but runtime ACL protection failed. Do not launch until fixed.' }
}
if ($Operation -eq 'doctor') {
  $m = Get-Content -LiteralPath (Join-Path $InstallDir 'runtime\install-manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  $files = @((Join-Path $m.qqRoot 'QQ.exe'), (Join-Path $m.qqDir 'QQNT.dll'), (Join-Path $m.qqDir 'resources\app\avsdk\AVSDKPlugin.dll'))
  foreach ($item in $files) {
    $sig = Get-AuthenticodeSignature -LiteralPath $item
    [PSCustomObject]@{ File = $item; SignatureStatus = "$($sig.Status)"; Signer = $sig.SignerCertificate.Subject } | Format-List
  }
  foreach ($name in @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll')) {
    [PSCustomObject]@{ Dependency = $name; System32Present = Test-Path -LiteralPath (Join-Path "$env:WINDIR\System32" $name) } | Format-List
  }
  Write-Output 'No QQ/native DLL/audio device was opened. Signature/VC runtime presence does not prove call support.'
}
