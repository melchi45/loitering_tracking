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
    # CudaHome: 생략 시 설치된 CUDA 버전 중 최신을 자동 감지합니다.
    # 예) -CudaHome "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8"
    [string]$CudaHome = "",
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

function Resolve-CudaHome([string]$requested) {
    # 명시적으로 지정된 경우 존재 여부 검증 후 반환
    if ($requested) {
        if (Test-Path $requested -PathType Container) {
            return $requested
        }
        throw "지정한 CUDA 경로가 존재하지 않습니다: $requested`n설치된 CUDA 버전을 확인하거나 -CudaHome 파라미터를 올바른 경로로 수정하세요."
    }

    # 환경변수 우선 탐색 (CUDA 설치 시 자동 설정됨, 최신 버전 우선)
    $cudaEnvVars = @(
        "CUDA_PATH_V13_3", "CUDA_PATH_V13_2", "CUDA_PATH_V13_1", "CUDA_PATH_V13_0",
        "CUDA_PATH_V12_9", "CUDA_PATH_V12_8", "CUDA_PATH_V12_7", "CUDA_PATH_V12_6",
        "CUDA_PATH_V12_5", "CUDA_PATH_V12_4", "CUDA_PATH_V12_3", "CUDA_PATH_V12_2",
        "CUDA_PATH_V12_1", "CUDA_PATH_V12_0", "CUDA_PATH_V11_8", "CUDA_PATH_V11_7",
        "CUDA_PATH"  # 버전 무관 최신 가리킴 — 마지막 순위
    )
    foreach ($var in $cudaEnvVars) {
        $val = [System.Environment]::GetEnvironmentVariable($var, "Machine")
        if (-not $val) { $val = [System.Environment]::GetEnvironmentVariable($var, "User") }
        if (-not $val) {
            $envItem = Get-Item "Env:$var" -ErrorAction SilentlyContinue
            if ($envItem) { $val = $envItem.Value }
        }
        if ($val -and (Test-Path $val -PathType Container)) {
            Write-Host "  [CUDA] 자동 감지: $var → $val"
            return $val
        }
    }

    # 환경변수 없으면 기본 설치 디렉토리에서 최신 버전 스캔
    $cudaBase = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if (Test-Path $cudaBase -PathType Container) {
        $versions = Get-ChildItem $cudaBase -Directory |
            Where-Object { $_.Name -match '^v(\d+)\.(\d+)$' } |
            Sort-Object {
                $m = [regex]::Match($_.Name, 'v(\d+)\.(\d+)')
                [version]::new([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, 0)
            } -Descending
        if ($versions) {
            $found = $versions[0].FullName
            Write-Host "  [CUDA] 자동 감지 (디렉토리 스캔): $found"
            return $found
        }
    }

    throw @"
CUDA Toolkit을 찾을 수 없습니다.
설치 확인: https://developer.nvidia.com/cuda-downloads
또는 -CudaHome 파라미터로 경로를 직접 지정하세요.
예) -CudaHome "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8"
"@
}

function Resolve-CudnnHome([string]$requested) {
    # 명시적으로 지정된 경우 그대로 반환
    if ($requested) {
        if (Test-Path $requested -PathType Container) {
            return $requested
        }
        throw "지정한 cuDNN 경로가 존재하지 않습니다: $requested"
    }

    # CUDNN_HOME 환경변수
    $envVal = $env:CUDNN_HOME
    if ($envVal -and (Test-Path $envVal -PathType Container)) {
        Write-Host "  [cuDNN] CUDNN_HOME 환경변수 사용: $envVal"
        return $envVal
    }

    # cuDNN 9.x EXE 설치 경로 스캔
    # 구조: C:\Program Files\NVIDIA\CUDNN\v9.x\bin\{cudaVer}\{arch}\{dll}
    # ORT build.bat은 --cudnn_home 에 v9.x 최상위 경로를 기대함
    $cudnnEXEBase = "C:\Program Files\NVIDIA\CUDNN"
    if (Test-Path $cudnnEXEBase -PathType Container) {
        # 프로세서 아키텍처 결정 (cuDNN EXE 설치 시 bin\{cudaVer}\{arch}\ 구조)
        $archSubDir = switch ($env:PROCESSOR_ARCHITECTURE) {
            "AMD64"  { "x64" }
            "ARM64"  { "arm64" }
            default  { "x64" }   # 기본값
        }

        $cudaShortVers = @('12.9','12.8','12.7','12.6','12.5','12.4','12.3','12.2','12.1')
        $cudnnDlls = @('cudnn64_9.dll','cudnn_ops.dll','cudnn_cnn.dll','cudnn_graph.dll')

        $cudnnDirs = Get-ChildItem $cudnnEXEBase -Directory |
            Where-Object { $_.Name -match '^v\d+\.' } |
            Sort-Object {
                $m = [regex]::Match($_.Name, 'v(\d+)\.(\d+)')
                [version]::new([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, 0)
            } -Descending

        foreach ($dir in $cudnnDirs) {
            # DLL 존재 여부로 유효성 확인:
            # bin\{cudaVer}\{arch}\{dll}  (EXE 설치 — 아키텍처 서브디렉토리 포함)
            # bin\{cudaVer}\{dll}         (zip 방식)
            # bin\{dll}                   (직접 복사)
            $verified = $false
            foreach ($cudaVer in $cudaShortVers) {
                foreach ($dll in $cudnnDlls) {
                    $archPath  = Join-Path $dir.FullName "bin\$cudaVer\$archSubDir\$dll"
                    $plainPath = Join-Path $dir.FullName "bin\$cudaVer\$dll"
                    $directPath = Join-Path $dir.FullName "bin\$dll"
                    if ((Test-Path $archPath) -or (Test-Path $plainPath) -or (Test-Path $directPath)) {
                        $verified = $true
                        break
                    }
                }
                if ($verified) { break }
            }
            if ($verified) {
                Write-Host "  [cuDNN] 자동 감지 (EXE 설치 경로, arch=$archSubDir): $($dir.FullName)"
                return $dir.FullName
            }
        }
    }

    # cuDNN을 CUDA 경로에 복사(zip 방식)한 경우 → cudnn_home 불필요 (build.bat이 CUDA 경로에서 찾음)
    Write-Host "  [cuDNN] cuDNN 경로 미지정 — CUDA Toolkit 경로에서 탐색됩니다 (zip 설치 방식)."
    return ""
}

# deps.txt 에서 태그를 읽으려다 실패하면 $null 반환 (안전 래퍼)
function Get-DepTagOrNull([string]$ortRepoDir, [string]$depName) {
    try { return Get-DepTagFromDeps $ortRepoDir $depName }
    catch { return $null }
}

# FetchContent 네트워크 다운로드를 로컬 git clone 으로 대체하는 범용 함수
function Ensure-DepGitSource([string]$ortRepoDir, [string]$depName, [string]$gitUrl, [string]$depTag) {
    $cacheRoot = Join-Path $ortRepoDir "_source_cache"
    $depDir    = Join-Path $cacheRoot "$depName-$depTag"

    if (-not (Test-Path $cacheRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    }

    if (-not (Test-Path (Join-Path $depDir ".git") -PathType Container)) {
        if (Test-Path $depDir) { Remove-Item -Recurse -Force $depDir }
        Write-Host "  [$depName] git clone --branch $depTag $gitUrl"
        git clone --depth 1 --branch $depTag $gitUrl $depDir
    } else {
        Write-Host "  [$depName] existing git cache — refreshing tag $depTag"
        Push-Location $depDir
        try { git fetch --tags --prune; git checkout $depTag }
        finally { Pop-Location }
    }
    return $depDir
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

Require-Command git
Require-Command python
Require-Command node
Require-Command npm

# CUDA / cuDNN 경로 해석 (자동 감지 포함) — 헤더 출력 전에 실행
$CudaHome  = Resolve-CudaHome  $CudaHome
$CudnnHome = Resolve-CudnnHome $CudnnHome

Write-Host ""
Write-Host "================================================================"
Write-Host "   ONNX Runtime Source Build + Local onnxruntime-node Link"
Write-Host "================================================================"
Write-Host "  ServerDir : $ServerDir"
Write-Host "  OrtRepo   : $OrtRepoDir"
Write-Host "  OrtRef    : $OrtRef"
Write-Host "  CudaHome  : $CudaHome"
Write-Host "  CudnnHome : $(if ($CudnnHome) { $CudnnHome } else { '(CUDA 경로에서 탐색)' })"
Write-Host "  CmakePath : $CmakePath"
Write-Host "  InsecureTLSForFetch : $AllowInsecureTlsForFetch"
Write-Host ""

$cmakeExe = Resolve-CmakeExecutable $CmakePath
$cmakeVersion = Assert-MinimumCmakeVersion $cmakeExe ([version]::new(3,28,0))
Write-Host "  CMake     : $cmakeExe ($cmakeVersion)"

if (-not $SkipBuild) {
    $vsPath = Assert-VisualStudioCppToolchain
    Write-Host "  VS C++    : $vsPath"
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

    # CMAKE_CXX_STANDARD=20 을 명시 — cmake 캐시에 이전 값(17 등)이 잔류하면
    # ORT 의 if(NOT DEFINED ...) 조건부 set이 무시되어 C++20 필수 체크가 실패함.
    # -D 플래그로 전달하면 캐시값을 항상 덮어씀.
    $cmakeDefines = @(
        "onnxruntime_USE_FLASH_ATTENTION=OFF",
        "CMAKE_CXX_STANDARD=20"
    )

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
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_PROTOBUF=$protobufSourceDirCmake"

    # date (Howard Hinnant's date library) — FetchContent zip 다운로드를 git clone 으로 대체
    $dateTag = Get-DepTagOrNull $OrtRepoDir "date"
    if ($dateTag) {
        Write-Host "  [date] tag from deps.txt: $dateTag"
        $dateSourceDir = Ensure-DepGitSource $OrtRepoDir "date" "https://github.com/HowardHinnant/date.git" $dateTag
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_DATE=$($dateSourceDir -replace '\\','/')"
    } else {
        Write-Host "  [date] tag not found in deps.txt — FetchContent will download"
    }

    # nlohmann/json — ORT FetchContent 이름은 "nlohmann_json" → 변수명 FETCHCONTENT_SOURCE_DIR_NLOHMANN_JSON
    $jsonTag = Get-DepTagOrNull $OrtRepoDir "nlohmann_json"
    if (-not $jsonTag) { $jsonTag = Get-DepTagOrNull $OrtRepoDir "json" }  # fallback
    if ($jsonTag) {
        Write-Host "  [nlohmann_json] tag from deps.txt: $jsonTag"
        $jsonSourceDir = Ensure-DepGitSource $OrtRepoDir "nlohmann_json" "https://github.com/nlohmann/json.git" $jsonTag
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_NLOHMANN_JSON=$($jsonSourceDir -replace '\\','/')"
    } else {
        Write-Host "  [nlohmann_json] tag not found in deps.txt — FetchContent will download"
    }

    # gsl (Microsoft GSL) — Cygwin patch.exe 권한 오류 우회: git clone 으로 patch step 건너뜀
    $gslTag = Get-DepTagOrNull $OrtRepoDir "gsl"
    if ($gslTag) {
        Write-Host "  [gsl] tag from deps.txt: $gslTag"
        $gslSourceDir = Ensure-DepGitSource $OrtRepoDir "gsl" "https://github.com/microsoft/GSL.git" $gslTag
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_GSL=$($gslSourceDir -replace '\\','/')"
    } else {
        Write-Host "  [gsl] tag not found in deps.txt — FetchContent will download"
    }

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
