#Requires -Version 5.1
<#!
.SYNOPSIS
    Build ONNX Runtime from source with CUDA on Windows and wire local onnxruntime-node into this server project.

.DESCRIPTION
    1) Clone/update onnxruntime source
    2) Build native ONNX Runtime with CUDA EP (shared lib)
    3) Build js/node package inside onnxruntime/js/node
    4) Install that local package into server project with --no-save

.NOTES
    - Run from any directory.
    - Use "x64 Native Tools Command Prompt for VS 2022" when possible.
    - This script does not edit server/package.json dependencies.
#>

param(
    [string]$OrtRepoDir = "$env:USERPROFILE\source\onnxruntime",
    [string]$OrtRef = "v1.26.0",
    [string]$CudaHome = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3",
    [string]$CudnnHome = "",
    [string]$CmakePath = "",
    [string]$CudaArch = "",
    [switch]$AllowInsecureTlsForFetch,
    [switch]$SkipClone,
    [switch]$SkipBuild,
    [switch]$SkipNodePackageBuild,
    [switch]$SkipProjectInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path

function Require-Command([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $name"
    }
}

function Parse-SemVer([string]$text) {
    $m = [regex]::Match($text, '(\d+)\.(\d+)\.(\d+)')
    if (-not $m.Success) {
        throw "Could not parse semantic version from: $text"
    }
    return [version]::new([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
}

function Resolve-CmakeExecutable([string]$requestedPath) {
    if ($requestedPath) {
        if (Test-Path $requestedPath -PathType Leaf) {
            return (Resolve-Path $requestedPath).Path
        }
        throw "CMake executable not found at -CmakePath: $requestedPath"
    }

    $cm = Get-Command cmake -ErrorAction SilentlyContinue
    if ($cm) {
        return $cm.Source
    }

    throw "Required command not found: cmake"
}

function Assert-MinimumCmakeVersion([string]$cmakeExe, [version]$minimumVersion) {
    $firstLine = (& $cmakeExe --version | Select-Object -First 1)
    $actual = Parse-SemVer $firstLine
    if ($actual -lt $minimumVersion) {
        throw "CMake $minimumVersion or higher is required (detected: $actual at $cmakeExe). Re-run with -CmakePath <new cmake.exe> after upgrading CMake."
    }
    return $actual
}

function Resolve-VSWherePath() {
    $default = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $default -PathType Leaf) {
        return $default
    }

    $cmd = Get-Command vswhere -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    return $null
}

function Assert-VisualStudioCppToolchain() {
    $vswhere = Resolve-VSWherePath
    if (-not $vswhere) {
        throw "Visual Studio installer tool (vswhere.exe) not found. Install Visual Studio 2022 Build Tools with C++ workload."
    }

    $installPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if (-not $installPath) {
        throw "Visual Studio 2022 C++ toolchain not found. Install 'Desktop development with C++' or Build Tools component 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'."
    }

    return $installPath
}

function Get-AbseilTagFromDeps([string]$ortRepoDir) {
    $depsFile = Join-Path $ortRepoDir "cmake\deps.txt"
    if (-not (Test-Path $depsFile -PathType Leaf)) {
        throw "deps.txt not found: $depsFile"
    }

    $line = Get-Content $depsFile | Where-Object { $_ -match '^abseil_cpp;' } | Select-Object -First 1
    if (-not $line) {
        throw "Could not find abseil_cpp entry in deps.txt"
    }

    $parts = $line.Split(';')
    if ($parts.Count -lt 2) {
        throw "Unexpected abseil_cpp deps entry format: $line"
    }

    $url = $parts[1]
    $m = [regex]::Match($url, 'refs/tags/([^/]+)\.(zip|tar\.gz)$')
    if (-not $m.Success) {
        throw "Could not parse abseil tag from URL: $url"
    }

    return $m.Groups[1].Value
}

function Get-DepTagFromDeps([string]$ortRepoDir, [string]$depName) {
    $depsFile = Join-Path $ortRepoDir "cmake\deps.txt"
    if (-not (Test-Path $depsFile -PathType Leaf)) {
        throw "deps.txt not found: $depsFile"
    }

    $pattern = "^" + [regex]::Escape($depName) + ";"
    $line = Get-Content $depsFile | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line) {
        throw "Could not find $depName entry in deps.txt"
    }

    $parts = $line.Split(';')
    if ($parts.Count -lt 2) {
        throw "Unexpected $depName deps entry format: $line"
    }

    $url = $parts[1]
    $m = [regex]::Match($url, 'refs/tags/([^/]+)\.(zip|tar\.gz)$')
    if (-not $m.Success) {
        throw "Could not parse $depName tag from URL: $url"
    }

    return $m.Groups[1].Value
}

function Ensure-AbseilGitSource([string]$ortRepoDir, [string]$abseilTag) {
    $cacheRoot = Join-Path $ortRepoDir "_source_cache"
    $abseilDir = Join-Path $cacheRoot "abseil_cpp-$abseilTag"
    $abseilGit = "https://github.com/abseil/abseil-cpp.git"

    if (-not (Test-Path $cacheRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    }

    if (-not (Test-Path (Join-Path $abseilDir ".git") -PathType Container)) {
        if (Test-Path $abseilDir) {
            Remove-Item -Recurse -Force $abseilDir
        }
        Write-Host "  [Abseil] git clone --branch $abseilTag"
        git clone --depth 1 --branch $abseilTag $abseilGit $abseilDir
    } else {
        Write-Host "  [Abseil] existing git cache found, refreshing tag $abseilTag"
        Push-Location $abseilDir
        try {
            git fetch --tags --prune
            git checkout $abseilTag
        }
        finally {
            Pop-Location
        }
    }

    return $abseilDir
}

function Ensure-ProtobufGitSource([string]$ortRepoDir, [string]$protobufTag) {
    $cacheRoot = Join-Path $ortRepoDir "_source_cache"
    $protobufDir = Join-Path $cacheRoot "protobuf-$protobufTag"
    $protobufGit = "https://github.com/protocolbuffers/protobuf.git"

    if (-not (Test-Path $cacheRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    }

    if (-not (Test-Path (Join-Path $protobufDir ".git") -PathType Container)) {
        if (Test-Path $protobufDir) {
            Remove-Item -Recurse -Force $protobufDir
        }
        Write-Host "  [Protobuf] git clone --branch $protobufTag"
        git clone --depth 1 --branch $protobufTag $protobufGit $protobufDir
    } else {
        Write-Host "  [Protobuf] existing git cache found, refreshing tag $protobufTag"
        Push-Location $protobufDir
        try {
            git fetch --tags --prune
            git checkout $protobufTag
        }
        finally {
            Pop-Location
        }
    }

    return $protobufDir
}

Write-Host ""
Write-Host "================================================================"
Write-Host "   ONNX Runtime Source Build + Local onnxruntime-node Link"
Write-Host "================================================================"
Write-Host "  ServerDir : $ServerDir"
Write-Host "  OrtRepo   : $OrtRepoDir"
Write-Host "  OrtRef    : $OrtRef"
Write-Host "  CudaHome  : $CudaHome"
Write-Host "  CudnnHome : $CudnnHome"
Write-Host "  CmakePath : $CmakePath"
Write-Host "  InsecureTLSForFetch : $AllowInsecureTlsForFetch"
Write-Host ""

Require-Command git
Require-Command python
Require-Command node
Require-Command npm

$cmakeExe = Resolve-CmakeExecutable $CmakePath
$cmakeVersion = Assert-MinimumCmakeVersion $cmakeExe ([version]::new(3,28,0))
Write-Host "  CMake     : $cmakeExe ($cmakeVersion)"

if (-not $SkipBuild) {
    $vsPath = Assert-VisualStudioCppToolchain
    Write-Host "  VS C++    : $vsPath"
}

if (-not (Test-Path $CudaHome -PathType Container)) {
    throw "CUDA home does not exist: $CudaHome"
}

if (-not $CudnnHome -and $env:CUDNN_HOME) {
    $CudnnHome = $env:CUDNN_HOME
}

if ($CudnnHome -and -not (Test-Path $CudnnHome -PathType Container)) {
    throw "cuDNN home does not exist: $CudnnHome"
}

if (-not $SkipClone) {
    if (-not (Test-Path $OrtRepoDir)) {
        $parent = Split-Path -Parent $OrtRepoDir
        if ($parent -and -not (Test-Path $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Write-Host "[1/4] Cloning onnxruntime..."
        git clone --recursive https://github.com/microsoft/onnxruntime "$OrtRepoDir"
    }

    Push-Location $OrtRepoDir
    try {
        Write-Host "[1/4] Fetching and checking out $OrtRef..."
        git fetch --tags --prune
        git checkout $OrtRef
        git submodule sync --recursive
        git submodule update --init --recursive
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipBuild) {
    $buildBat = Join-Path $OrtRepoDir "build.bat"
    if (-not (Test-Path $buildBat)) {
        throw "build.bat not found: $buildBat"
    }

    $cmakeDefines = @("onnxruntime_USE_FLASH_ATTENTION=OFF")

    $abseilTag = Get-AbseilTagFromDeps $OrtRepoDir
    Write-Host "  [Abseil] tag from deps.txt: $abseilTag"
    $abseilSourceDir = Ensure-AbseilGitSource $OrtRepoDir $abseilTag
    $abseilSourceDirCmake = $abseilSourceDir -replace '\\','/'
    Write-Host "  [Abseil] using local source dir: $abseilSourceDirCmake"
    # Force FetchContent(abseil_cpp) to use local git-cloned source instead of downloading zip.
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_ABSEIL_CPP=$abseilSourceDirCmake"

    $protobufTag = Get-DepTagFromDeps $OrtRepoDir "protobuf"
    Write-Host "  [Protobuf] tag from deps.txt: $protobufTag"
    $protobufSourceDir = Ensure-ProtobufGitSource $OrtRepoDir $protobufTag
    $protobufSourceDirCmake = $protobufSourceDir -replace '\\','/'
    Write-Host "  [Protobuf] using local source dir: $protobufSourceDirCmake"
    # Avoid protobuf FetchContent download/patch path on Windows by using local git source.
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_PROTOBUF=$protobufSourceDirCmake"

    if ($CudaArch) {
        $cmakeDefines += "CMAKE_CUDA_ARCHITECTURES=$CudaArch"
    }

    $buildArgs = @(
        "--config", "Release",
        "--build_shared_lib",
        "--use_cuda",
        "--cuda_home", $CudaHome,
        "--cmake_path", $cmakeExe
    )

    if ($CudnnHome) {
        $buildArgs += @("--cudnn_home", $CudnnHome)
    }

    $buildArgs += @("--cmake_extra_defines")
    $buildArgs += $cmakeDefines

    Write-Host "[2/4] Building native ONNX Runtime (this can take a long time)..."
    Push-Location $OrtRepoDir
    try {
        $oldCmakeTlsVerify = $env:CMAKE_TLS_VERIFY
        if ($AllowInsecureTlsForFetch) {
            # Corporate TLS interception / revocation-check environments may block FetchContent downloads.
            # This disables cert verification for CMake downloads only for the current process.
            $env:CMAKE_TLS_VERIFY = "0"
            # Persist for next shells as requested (user-level env var).
            & setx CMAKE_TLS_VERIFY 0 | Out-Null
            Write-Warning "CMAKE_TLS_VERIFY=0 is enabled for this build run. Use only in trusted/internal networks."
            Write-Warning "Persistent user env var set: setx CMAKE_TLS_VERIFY 0"
        }

        & $buildBat @buildArgs
        if ($LASTEXITCODE -ne 0) {
            throw "onnxruntime native build failed with exit code $LASTEXITCODE"
        }

        if ($AllowInsecureTlsForFetch) {
            if ($null -eq $oldCmakeTlsVerify) {
                Remove-Item Env:CMAKE_TLS_VERIFY -ErrorAction SilentlyContinue
            } else {
                $env:CMAKE_TLS_VERIFY = $oldCmakeTlsVerify
            }
        }
    }
    finally {
        if ($AllowInsecureTlsForFetch) {
            if ($null -eq $oldCmakeTlsVerify) {
                Remove-Item Env:CMAKE_TLS_VERIFY -ErrorAction SilentlyContinue
            } else {
                $env:CMAKE_TLS_VERIFY = $oldCmakeTlsVerify
            }
        }
        Pop-Location
    }
}

if (-not $SkipNodePackageBuild) {
    $nodePkgDir = Join-Path $OrtRepoDir "js\node"
    if (-not (Test-Path $nodePkgDir -PathType Container)) {
        throw "ONNX Runtime node package dir not found: $nodePkgDir"
    }

    Write-Host "[3/4] Building js/node package..."
    Push-Location $nodePkgDir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw "onnxruntime js/node npm install failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipProjectInstall) {
    $nodePkgDir = Join-Path $OrtRepoDir "js\node"

    Write-Host "[4/4] Installing local onnxruntime-node into server project (--no-save)..."
    npm --prefix $ServerDir uninstall onnxruntime-node
    npm --prefix $ServerDir install "$nodePkgDir" --no-save
    if ($LASTEXITCODE -ne 0) {
        throw "server install of local onnxruntime-node failed with exit code $LASTEXITCODE"
    }
}

Write-Host ""
Write-Host "Done. Verify with:"
Write-Host "  npm --prefix $ServerDir run restart"
Write-Host ""
