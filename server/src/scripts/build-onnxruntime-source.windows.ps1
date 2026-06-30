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

# deps.txt 에서 태그 또는 커밋 해시 반환 (refs/tags/ 패턴 + /archive/HASH 패턴 지원)
function Get-DepRefFromDeps([string]$ortRepoDir, [string]$depName) {
    $depsFile = Join-Path $ortRepoDir "cmake\deps.txt"
    if (-not (Test-Path $depsFile -PathType Leaf)) { return $null }
    $pattern = "^" + [regex]::Escape($depName) + ";"
    $line = Get-Content $depsFile | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line) { return $null }
    $url = ($line.Split(';'))[1]
    # refs/tags 패턴
    $m = [regex]::Match($url, 'refs/tags/([^/]+)\.(zip|tar\.gz)$')
    if ($m.Success) { return $m.Groups[1].Value }
    # 커밋 해시 패턴 (/archive/40hexchars.zip)
    $m = [regex]::Match($url, '/archive/([0-9a-f]{40})\.(zip|tar\.gz)$')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

# FetchContent 네트워크 다운로드를 로컬 git clone 으로 대체하는 범용 함수
# $depTag 에 40자 커밋 해시가 오면 git clone + checkout 으로 처리
function Ensure-DepGitSource([string]$ortRepoDir, [string]$depName, [string]$gitUrl, [string]$depTag) {
    $isCommitHash = $depTag -match '^[0-9a-f]{40}$'
    $dirSuffix    = if ($isCommitHash) { $depTag.Substring(0, 12) } else { $depTag }
    $cacheRoot = Join-Path $ortRepoDir "_source_cache"
    $depDir    = Join-Path $cacheRoot "$depName-$dirSuffix"

    if (-not (Test-Path $cacheRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    }

    if (-not (Test-Path (Join-Path $depDir ".git") -PathType Container)) {
        if (Test-Path $depDir) { Remove-Item -Recurse -Force $depDir }
        if ($isCommitHash) {
            Write-Host "  [$depName] git clone + checkout $($depTag.Substring(0,12))"
            git clone $gitUrl $depDir
            Push-Location $depDir
            try { git checkout $depTag }
            finally { Pop-Location }
        } else {
            Write-Host "  [$depName] git clone --branch $depTag"
            git clone --depth 1 --branch $depTag $gitUrl $depDir
        }
    } else {
        Write-Host "  [$depName] existing git cache found (tag/ref: $dirSuffix)"
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

# GSL v4.0.0 / abseil-cpp NVCC 진단 에러 억제 패치
# [[gsl::suppress(...)]] 속성을 NVCC 가 인식하지 못해 -Werror all-warnings 에 의해 빌드 실패하는 문제 수정.
# cmake/CMakeLists.txt 의 onnxruntime_NVCC_FLAGS 목록에 --diag-suppress 플래그를 추가합니다.
function Patch-OrtCmakeNvccFlags([string]$ortRepoDir) {
    $cmakeFile = Join-Path $ortRepoDir "cmake\CMakeLists.txt"
    if (-not (Test-Path $cmakeFile)) {
        Write-Warning "  [patch] cmake\CMakeLists.txt 없음 — 패치 건너뜀: $cmakeFile"
        return
    }

    $content = Get-Content $cmakeFile -Raw
    if ($content -match 'diag-suppress=2803') {
        Write-Host "  [patch] NVCC 진단 억제 패치 이미 적용됨 — 건너뜀"
        return
    }

    # 기존 억제 플래그 바로 뒤에 삽입할 앵커 탐색 (우선순위 순)
    $anchors = @(
        'list\(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=221\)',
        'list\(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=177\)',
        'list\(APPEND onnxruntime_NVCC_FLAGS -Werror all-warnings\)'
    )

    $insertBlock = @"
list(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=2803)  # GSL v4.0.0 [[gsl::suppress]] unrecognized by nvcc
list(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=68)    # abseil: sign change
list(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=549)   # abseil: variable used before set
list(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=69)    # abseil: integer truncation
"@

    $patched = $false
    foreach ($anchor in $anchors) {
        if ($content -match $anchor) {
            $content = $content -replace "($anchor)", "`$1`n$insertBlock"
            $patched = $true
            Write-Host "  [patch] NVCC 진단 억제 플래그 삽입 완료 (anchor: $anchor)"
            break
        }
    }

    if (-not $patched) {
        Write-Warning "  [patch] 앵커를 찾지 못했습니다 — cmake\CMakeLists.txt 를 직접 확인하세요."
        return
    }

    # 백업 후 저장
    $backup = "$cmakeFile.nvcc-patch.bak"
    Copy-Item $cmakeFile $backup -Force
    Set-Content $cmakeFile $content -NoNewline
    Write-Host "  [patch] 원본 백업: $backup"
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
    # ORT v1.26.0 은 deps.txt 미등록 — 알려진 버전 v4.0.0 을 fallback 으로 사용
    $gslTag = Get-DepRefFromDeps $OrtRepoDir "GSL"
    if (-not $gslTag) { $gslTag = Get-DepRefFromDeps $OrtRepoDir "gsl" }
    if (-not $gslTag) { $gslTag = "v4.0.0" }  # cmake output 에서 확인된 버전
    Write-Host "  [gsl] ref: $gslTag"
    $gslSourceDir = Ensure-DepGitSource $OrtRepoDir "gsl" "https://github.com/microsoft/GSL.git" $gslTag
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_GSL=$($gslSourceDir -replace '\\','/')"

    # re2 (Google RE2)
    $re2Tag = Get-DepRefFromDeps $OrtRepoDir "re2"
    if (-not $re2Tag) { $re2Tag = "2024-07-02" }
    Write-Host "  [re2] ref: $re2Tag"
    $re2SourceDir = Ensure-DepGitSource $OrtRepoDir "re2" "https://github.com/google/re2.git" $re2Tag
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_RE2=$($re2SourceDir -replace '\\','/')"

    # googletest
    $gtestTag = Get-DepRefFromDeps $OrtRepoDir "googletest"
    if (-not $gtestTag) { $gtestTag = "v1.17.0" }
    Write-Host "  [googletest] ref: $gtestTag"
    $gtestSourceDir = Ensure-DepGitSource $OrtRepoDir "googletest" "https://github.com/google/googletest.git" $gtestTag
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_GOOGLETEST=$($gtestSourceDir -replace '\\','/')"

    # mp11 (Boost.Mp11)
    $mp11Tag = Get-DepRefFromDeps $OrtRepoDir "mp11"
    if (-not $mp11Tag) { $mp11Tag = "boost-1.82.0" }
    Write-Host "  [mp11] ref: $mp11Tag"
    $mp11SourceDir = Ensure-DepGitSource $OrtRepoDir "mp11" "https://github.com/boostorg/mp11.git" $mp11Tag
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_MP11=$($mp11SourceDir -replace '\\','/')"

    # pytorch_cpuinfo (커밋 해시 — Ensure-DepGitSource 가 git clone+checkout 으로 처리)
    $cpuinfoRef = Get-DepRefFromDeps $OrtRepoDir "pytorch_cpuinfo"
    if (-not $cpuinfoRef) { $cpuinfoRef = "403d652dca4c1046e8145950b1c0997a9f748b57" }
    Write-Host "  [pytorch_cpuinfo] ref: $cpuinfoRef"
    $cpuinfoSourceDir = Ensure-DepGitSource $OrtRepoDir "pytorch_cpuinfo" "https://github.com/pytorch/cpuinfo.git" $cpuinfoRef
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_PYTORCH_CPUINFO=$($cpuinfoSourceDir -replace '\\','/')"

    # flatbuffers — Cygwin patch.exe 권한 오류 우회 (flatbuffers-populate-patch.rule 실패)
    $fbsTag = Get-DepRefFromDeps $OrtRepoDir "flatbuffers"
    if (-not $fbsTag) { $fbsTag = "v24.3.25" }  # ORT v1.26.0 에서 확인된 버전
    Write-Host "  [flatbuffers] ref: $fbsTag"
    $fbsSourceDir = Ensure-DepGitSource $OrtRepoDir "flatbuffers" "https://github.com/google/flatbuffers.git" $fbsTag
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_FLATBUFFERS=$($fbsSourceDir -replace '\\','/')"

    # onnx — ORT v1.26.0 은 git submodule 이지만 cmake 가 FetchContent 를 사용함.
    # 서브모듈이 존재하면 해당 경로를 직접 지정하고, 없으면 deps.txt 버전으로 clone.
    $onnxSubmoduleDir = Join-Path $OrtRepoDir "cmake\external\onnx"
    if (Test-Path (Join-Path $onnxSubmoduleDir "CMakeLists.txt") -PathType Leaf) {
        Write-Host "  [onnx] using existing submodule: $($onnxSubmoduleDir -replace '\\','/')"
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_ONNX=$($onnxSubmoduleDir -replace '\\','/')"
    } else {
        $onnxRef = Get-DepRefFromDeps $OrtRepoDir "onnx"
        if (-not $onnxRef) { $onnxRef = "v1.17.0" }
        Write-Host "  [onnx] submodule missing — git clone ref: $onnxRef"
        $onnxSourceDir = Ensure-DepGitSource $OrtRepoDir "onnx" "https://github.com/onnx/onnx.git" $onnxRef
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_ONNX=$($onnxSourceDir -replace '\\','/')"
    }

    # safeint (Microsoft SafeInt)
    $safeintRef = Get-DepRefFromDeps $OrtRepoDir "safeint"
    if ($safeintRef) {
        Write-Host "  [safeint] ref: $safeintRef"
        $safeintSourceDir = Ensure-DepGitSource $OrtRepoDir "safeint" "https://github.com/dcleblanc/SafeInt.git" $safeintRef
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_SAFEINT=$($safeintSourceDir -replace '\\','/')"
    } else {
        Write-Host "  [safeint] not in deps.txt — FetchContent will download"
    }

    # eigen3 — cmake FetchContent 이름이 "eigen3" (not "eigen"), cmake/external/eigen.cmake 에 별도 선언
    # deps.txt 에 없으므로 알려진 버전 3.4.0 을 fallback 으로 사용
    $eigenRef = Get-DepRefFromDeps $OrtRepoDir "eigen3"
    if (-not $eigenRef) { $eigenRef = Get-DepRefFromDeps $OrtRepoDir "eigen" }
    if (-not $eigenRef) { $eigenRef = "3.4.0" }
    Write-Host "  [eigen3] ref: $eigenRef"
    $eigenSourceDir = Ensure-DepGitSource $OrtRepoDir "eigen3" "https://gitlab.com/libeigen/eigen.git" $eigenRef
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_EIGEN3=$($eigenSourceDir -replace '\\','/')"

    # wil (Windows Implementation Library)
    $wilRef = Get-DepRefFromDeps $OrtRepoDir "wil"
    if ($wilRef) {
        Write-Host "  [wil] ref: $wilRef"
        $wilSourceDir = Ensure-DepGitSource $OrtRepoDir "wil" "https://github.com/microsoft/wil.git" $wilRef
        $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_WIL=$($wilSourceDir -replace '\\','/')"
    } else {
        Write-Host "  [wil] not in deps.txt — FetchContent will download"
    }

    # cutlass — CUDA EP 전용 dep, deps.txt 미등록, cmake/external/cutlass.cmake 에서 직접 선언
    # Cygwin patch.exe 가 include/cute/layout.hpp 패치 실패 → 로컬 clone 으로 우회
    $cutlassRef = Get-DepRefFromDeps $OrtRepoDir "cutlass"
    if (-not $cutlassRef) { $cutlassRef = "v4.4.2" }
    Write-Host "  [cutlass] ref: $cutlassRef"
    $cutlassSourceDir = Ensure-DepGitSource $OrtRepoDir "cutlass" "https://github.com/NVIDIA/cutlass.git" $cutlassRef
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_CUTLASS=$($cutlassSourceDir -replace '\\','/')"

    # cudnn_frontend — CUDA EP 전용 dep, deps.txt 미등록, cmake/external/cudnn_frontend.cmake 에서 직접 선언
    # zip 다운로드 방식이지만 사전 캐시로 네트워크 의존성 제거
    $cudnnFERef = Get-DepRefFromDeps $OrtRepoDir "cudnn_frontend"
    if (-not $cudnnFERef) { $cudnnFERef = "v1.12.0" }
    Write-Host "  [cudnn_frontend] ref: $cudnnFERef"
    $cudnnFESourceDir = Ensure-DepGitSource $OrtRepoDir "cudnn_frontend" "https://github.com/NVIDIA/cudnn-frontend.git" $cudnnFERef
    $cmakeDefines += "FETCHCONTENT_SOURCE_DIR_CUDNN_FRONTEND=$($cudnnFESourceDir -replace '\\','/')"

    # cuDNN 9.x EXE 설치: include/lib 경로가 버전 서브디렉토리 구조
    #   include\{cudaVer}\cudnn.h
    #   lib\{cudaVer}\{arch}\cudnn.lib
    # ORT cmake/external/cuDNN.cmake 탐색 변수:
    #   CUDNN_INCLUDE_DIR  → find_path(CUDNN_INCLUDE_DIR cudnn.h ...)  [대문자]
    #   cudnn_LIBRARY      → find_library(cudnn_LIBRARY NAMES cudnn ...)  [소문자c]
    #   cudnn_adv_LIBRARY  → find_library(cudnn_adv_LIBRARY NAMES cudnn_adv ...)  [9.x 이전]
    #   cudnn_cnn_LIBRARY  → find_library(cudnn_cnn_LIBRARY NAMES cudnn_cnn ...)  [9.x 이전]
    #   cudnn_ops_LIBRARY  → find_library(cudnn_ops_LIBRARY NAMES cudnn_ops ...)  [9.x 이전]
    # cmake 는 대소문자를 구분: CUDNN_LIBRARY ≠ cudnn_LIBRARY
    if ($CudnnHome) {
        $cudnnHFlat = Join-Path $CudnnHome "include\cudnn.h"
        if (-not (Test-Path $cudnnHFlat -PathType Leaf)) {
            $cudaVerDirs = @('12.9','12.8','12.7','12.6','12.5','12.4','12.3','12.2','12.1','12.0','11.8','11.7')
            foreach ($cv in $cudaVerDirs) {
                $hPath = Join-Path $CudnnHome "include\$cv\cudnn.h"
                if (Test-Path $hPath -PathType Leaf) {
                    $cudnnIncDir = (Join-Path $CudnnHome "include\$cv") -replace '\\','/'
                    Write-Host "  [cuDNN] versioned include 감지 (CUDA $cv): $cudnnIncDir"
                    $cmakeDefines += "CUDNN_INCLUDE_DIR=$cudnnIncDir"

                    # lib 탐색: lib\{cudaVer}\{arch}\{name}.lib 또는 lib\{cudaVer}\{name}.lib
                    # ORT 가 찾는 lib 이름 목록 (cudnn_LIBRARY, cudnn_adv_LIBRARY 등)
                    $cudnnLibNames = @('cudnn','cudnn_adv','cudnn_cnn','cudnn_ops','cudnn_graph')
                    foreach ($libName in $cudnnLibNames) {
                        $libFound = $false
                        foreach ($arch in @('x64','x86')) {
                            $lPath = Join-Path $CudnnHome "lib\$cv\$arch\$libName.lib"
                            if (Test-Path $lPath -PathType Leaf) {
                                $cudnnLibVal = $lPath -replace '\\','/'
                                Write-Host "  [cuDNN] lib 감지 ($libName, CUDA $cv/$arch): $cudnnLibVal"
                                # cmake 변수명: cudnn_LIBRARY, cudnn_adv_LIBRARY, ...
                                $cmakeVarName = $libName + "_LIBRARY"
                                $cmakeDefines += "$cmakeVarName=$cudnnLibVal"
                                $libFound = $true
                                break
                            }
                        }
                        if (-not $libFound) {
                            $lPath2 = Join-Path $CudnnHome "lib\$cv\$libName.lib"
                            if (Test-Path $lPath2 -PathType Leaf) {
                                $cudnnLibVal2 = $lPath2 -replace '\\','/'
                                Write-Host "  [cuDNN] lib 감지 ($libName, CUDA $cv): $cudnnLibVal2"
                                $cmakeVarName = $libName + "_LIBRARY"
                                $cmakeDefines += "$cmakeVarName=$cudnnLibVal2"
                            }
                        }
                    }
                    break
                }
            }
            if (-not ($cmakeDefines -match 'CUDNN_INCLUDE_DIR=')) {
                Write-Warning "  [cuDNN] cudnn.h 를 CUDNN_HOME=$CudnnHome 에서 찾지 못했습니다. cmake 가 직접 탐색합니다."
            }
        }
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

    # 이전 cmake 실패로 남은 stale *-subbuild 디렉토리 정리
    # FETCHCONTENT_SOURCE_DIR_* 변수는 subbuild CMakeLists.txt 가 새로 생성될 때만 반영됩니다.
    # 기존 subbuild 가 남아있으면 이전 실패 설정(다운로드+패치)으로 재실행됩니다.
    $buildDepsDir = Join-Path $OrtRepoDir "build\Windows\Release\_deps"
    if (Test-Path $buildDepsDir) {
        $staleDirs = Get-ChildItem $buildDepsDir -Directory -Filter "*-subbuild" -ErrorAction SilentlyContinue
        if ($staleDirs) {
            Write-Host "  [cleanup] stale FetchContent subbuild 정리..."
            foreach ($d in $staleDirs) {
                Write-Host "    - $($d.Name)"
                Remove-Item -Recurse -Force $d.FullName
            }
        }
    }

    # GSL v4.0.0 / abseil-cpp NVCC 진단 에러 억제 패치 적용
    Patch-OrtCmakeNvccFlags $OrtRepoDir

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
