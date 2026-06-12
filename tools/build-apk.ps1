# Builds the Android debug APK.
# Usage: powershell -File tools\build-apk.ps1 [-DefaultServer "host-or-url"]
# Output: public\VoxelCraft.apk (downloadable from the game server itself).
param(
  [string]$DefaultServer = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if (-not $env:JAVA_HOME) {
  $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory | Select-Object -First 1
  if (-not $jdk) { throw 'JDK not found; install Temurin 21 first.' }
  $env:JAVA_HOME = $jdk.FullName
}

Set-Location $root
npx cap sync android
if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }

# public\VoxelCraft.apk (the previous build, served for phone download) must
# not be bundled INTO the new APK — cap sync copies all of public/.
$staleApk = Join-Path $root 'android\app\src\main\assets\public\VoxelCraft.apk'
if (Test-Path $staleApk) { Remove-Item $staleApk -Force }

# Bake the default relay server into the app bundle (menu field stays editable).
$cfg = Join-Path $root 'android\app\src\main\assets\public\app-config.js'
if ($DefaultServer) {
  @"
// App-build override (regenerated on each APK build - do not edit by hand).
window.VC_DEFAULT_SERVER = '$DefaultServer';
"@ | Set-Content -Path $cfg -Encoding utf8
}

Set-Location (Join-Path $root 'android')
.\gradlew.bat assembleDebug --console=plain
if ($LASTEXITCODE -ne 0) { throw 'gradle build failed' }

$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
Copy-Item $apk (Join-Path $root 'public\VoxelCraft.apk') -Force
Write-Host "APK ready: public\VoxelCraft.apk ($([math]::Round((Get-Item $apk).Length/1MB,1)) MB)"
