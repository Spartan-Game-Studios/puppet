# Build softcam.dll for VPuppet's Windows virtual camera.
#
# softcam (MIT, https://github.com/tshino/softcam) is a DirectShow virtual
# camera: one DLL that camera apps load as a "video input device" filter, and
# that VPuppet loads to send frames (shared memory). We build it from a pinned
# commit and patch three identifiers so it can't collide with other softcam
# users: the filter name ("VPuppet Virtual Camera"), its CLSID, and the names
# of the shared memory / mutex. The CLSID must match CLSID in
# src-tauri/src/vcam/windows.rs.
#
# Output: src-tauri/vendor/softcam/softcam.dll (+ LICENSE-softcam.txt), which
# tauri.windows.conf.json bundles next to vpuppet.exe.
#
# Needs git and Visual Studio 2022+ with the C++ desktop workload (the same
# toolchain Rust/Tauri already need on Windows). Runs automatically from
# `pnpm tauri dev` / `pnpm tauri build` on Windows; skips if the DLL exists
# (pass -Force to rebuild).
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$Commit = 'afb424c2415b04da627fa1a7b4706575c2ba3010' # v1.8.1
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root 'src-tauri\vendor\softcam'
$Dll = Join-Path $Out 'softcam.dll'
if ((Test-Path $Dll) -and -not $Force) {
  Write-Host "build-softcam: $Dll exists (use -Force to rebuild)"
  exit 0
}

$Work = Join-Path $Root 'src-tauri\target\softcam-src'
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
git clone --quiet https://github.com/tshino/softcam.git $Work
if ($LASTEXITCODE) { throw 'build-softcam: git clone failed' }
git -C $Work -c advice.detachedHead=false checkout --quiet $Commit
if ($LASTEXITCODE) { throw "build-softcam: commit $Commit not found" }

function Patch([string]$file, [string]$from, [string]$to) {
  $p = Join-Path $Work $file
  $t = [IO.File]::ReadAllText($p)
  if (-not $t.Contains($from)) { throw "build-softcam: '$from' not found in $file" }
  [IO.File]::WriteAllText($p, $t.Replace($from, $to))
}
# Filter name shown in camera pickers.
Patch 'src\softcam\softcam.cpp' 'L"DirectShow Softcam"' 'L"VPuppet Virtual Camera"'
# CLSID {233F85CE-D09F-4E37-B572-149BB9E17F11}
Patch 'src\softcam\softcam.cpp' '0xaef3b972, 0x5fa5, 0x4647, 0x95, 0x71, 0x35, 0x8e, 0xb4, 0x72, 0xbc, 0x9e' '0x233f85ce, 0xd09f, 0x4e37, 0xb5, 0x72, 0x14, 0x9b, 0xb9, 0xe1, 0x7f, 0x11'
# Shared memory / mutex names.
Patch 'src\softcamcore\FrameBuffer.cpp' '"DirectShow Softcam/NamedMutex"' '"VPuppet Virtual Camera/NamedMutex"'
Patch 'src\softcamcore\FrameBuffer.cpp' '"DirectShow Softcam/SharedMemory"' '"VPuppet Virtual Camera/SharedMemory"'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'build-softcam: Visual Studio not found (vswhere.exe missing)' }
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
$vsver = & $vswhere -latest -products * -property installationVersion | Select-Object -First 1
# softcam's projects say v143 (VS 2022); use whatever toolset is installed.
$toolset = switch -Wildcard ($vsver) { '17.*' { 'v143' } '18.*' { 'v145' } default { 'v143' } }
Write-Host "build-softcam: MSBuild $msbuild (VS $vsver, toolset $toolset)"
& $msbuild (Join-Path $Work 'softcam.sln') /t:softcam /m /nologo /v:minimal `
  /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=$toolset
if ($LASTEXITCODE) { throw 'build-softcam: msbuild failed' }

$built = Join-Path $Work 'x64\Release\softcam.dll'
if (-not (Test-Path $built)) { throw "build-softcam: $built not produced" }
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item $built $Dll -Force
Copy-Item (Join-Path $Work 'LICENSE') (Join-Path $Out 'LICENSE-softcam.txt') -Force
Write-Host "build-softcam: wrote $Dll"
