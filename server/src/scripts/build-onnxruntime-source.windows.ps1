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

# VS 2022 MSVC 도구체인 내 dumpbin.exe / lib.exe 등을 검색 (여러 Edition 대응)
function Find-VsDevBinTool([string]$toolName) {
    $vsRoot = "C:\Program Files\Microsoft Visual Studio\2022"
    foreach ($edition in @('Enterprise', 'Professional', 'Community', 'BuildTools')) {
        $msvcRoot = Join-Path $vsRoot "$edition\VC\Tools\MSVC"
        if (-not (Test-Path $msvcRoot -PathType Container)) { continue }
        $verDir = Get-ChildItem $msvcRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if (-not $verDir) { continue }
        $candidate = Join-Path $verDir.FullName "bin\Hostx64\x64\$toolName"
        if (Test-Path $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

# NVIDIA 공식 Windows pip 배포판(nvidia-cudnn-cu{ver})은 런타임용 .dll 만 포함하고
# 링크 단계에 필요한 .lib(import library) 은 제공하지 않습니다
# (PyTorch/JAX 등은 ctypes/delay-load 로 .dll 을 직접 로드하므로 .lib 이 불필요).
# ONNX Runtime 소스 빌드는 CMake find_library(cudnn_LIBRARY) 로 .lib 을 요구하므로,
# dumpbin.exe 로 cudnn64_9.dll 의 export 심볼을 추출해 .def 파일을 만들고
# lib.exe 로 import library(.lib) 를 직접 생성합니다. developer.nvidia.com 로그인 불필요.
function Ensure-CudnnImportLib([string]$cudnnHome) {
    $existingCandidates = @(
        (Join-Path $cudnnHome "lib\x64\cudnn.lib"),
        (Join-Path $cudnnHome "lib\cudnn.lib")
    )
    foreach ($c in $existingCandidates) {
        if (Test-Path $c -PathType Leaf) { return $c }
    }

    $binDir = Join-Path $cudnnHome "bin"
    if (-not (Test-Path $binDir -PathType Container)) { return $null }
    $dll = Get-ChildItem $binDir -Filter "cudnn64_*.dll" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $dll) { return $null }

    $dumpbin = Find-VsDevBinTool "dumpbin.exe"
    $libExe  = Find-VsDevBinTool "lib.exe"
    if (-not $dumpbin -or -not $libExe) {
        Write-Warning "  [cuDNN] dumpbin.exe/lib.exe 를 찾지 못해 pip cuDNN용 링크 라이브러리를 생성할 수 없습니다."
        return $null
    }

    Write-Host "  [cuDNN] pip 배포판에 cudnn.lib 이 없어 $($dll.Name) 로부터 생성합니다 (dumpbin+lib.exe)..."
    $outDir = Join-Path $cudnnHome "lib\x64"
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null

    $exportsOutput = & $dumpbin "/exports" $dll.FullName
    $defLines = @("LIBRARY $($dll.BaseName)", "EXPORTS")
    foreach ($line in $exportsOutput) {
        # dumpbin /exports 데이터 행 형식: "  <ordinal>  <hint>  <RVA>  <symbol>"
        if ($line -match '^\s*(\d+)\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)\s*$') {
            $defLines += "    $($Matches[2])"
        }
    }
    if ($defLines.Count -le 2) {
        Write-Warning "  [cuDNN] $($dll.Name) 에서 내보낸 심볼을 찾지 못했습니다 — dumpbin 출력 형식을 확인하세요."
        return $null
    }

    $defFile = Join-Path $outDir "cudnn.def"
    $defLines | Set-Content -Path $defFile -Encoding ASCII

    $libOut = Join-Path $outDir "cudnn.lib"
    & $libExe "/def:$defFile" "/out:$libOut" "/machine:x64" | Out-Null

    if (Test-Path $libOut -PathType Leaf) {
        Write-Host "  [cuDNN] cudnn.lib 생성 완료 ($($defLines.Count - 2)개 심볼): $libOut"
        return $libOut
    }
    Write-Warning "  [cuDNN] cudnn.lib 생성 실패 (lib.exe 종료 코드 $LASTEXITCODE)"
    return $null
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
    # 커밋 해시 패턴 (/archive/40hexchars.zip 또는 /archive/40hexchars/repo-40hexchars.zip —
    # GitHub archive URL 은 종종 해시 뒤에 "repo-해시.zip" 경로 세그먼트가 하나 더 붙음, 예: eigen deps.txt 항목)
    $m = [regex]::Match($url, '/archive/([0-9a-f]{40})(?:/[^/]+)?\.(zip|tar\.gz)$')
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
    if ($content -match 'diag-suppress=2803' -and $content -match 'diag-suppress=20011') {
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
list(APPEND onnxruntime_NVCC_FLAGS --diag-suppress=20011) # cutlass v4.4.2: __host__ called from __host__ __device__
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

# Eigen 3.4.0 + MSVC 2022 C++20: element_wise_ops.cc ArrayBase::min/max 스칼라 오버로드 패치
# MSVC 2022 C++20 모드에서 Eigen ArrayBase::min(Scalar) / max(Scalar) 의
# 템플릿 인수 추론이 실패 (C2672) 하는 문제를 cwiseMin / cwiseMax 로 교체하여 수정합니다.
# 영향 파일: onnxruntime/core/providers/cpu/math/element_wise_ops.cc
function Patch-OrtElementWiseOps([string]$ortRepoDir) {
    $srcFile = Join-Path $ortRepoDir "onnxruntime\core\providers\cpu\math\element_wise_ops.cc"
    if (-not (Test-Path $srcFile)) {
        Write-Warning "  [patch] element_wise_ops.cc 없음 — 패치 건너뜀: $srcFile"
        return
    }

    $content = Get-Content $srcFile -Raw
    if ($content -match '__ort_patched_eigen_minmax__') {
        Write-Host "  [patch] element_wise_ops Eigen min/max 패치 이미 적용됨 — 건너뜀"
        return
    }

    $changed = $false

    # .array().min(expr) → .array().cwiseMin(expr)
    # .array().max(expr) → .array().cwiseMax(expr)
    # cwiseMin/cwiseMax 는 scalar 와 array 모두 지원하므로 안전하게 교체 가능합니다.
    if ($content -match '\.array\(\)\.min\(') {
        $content = $content -replace '(\.array\(\))\.min\(', '$1.cwiseMin('
        $changed = $true
        Write-Host "  [patch] .array().min( → .array().cwiseMin( 치환 완료"
    }
    if ($content -match '\.array\(\)\.max\(') {
        $content = $content -replace '(\.array\(\))\.max\(', '$1.cwiseMax('
        $changed = $true
        Write-Host "  [patch] .array().max( → .array().cwiseMax( 치환 완료"
    }

    if (-not $changed) {
        Write-Warning "  [patch] element_wise_ops.cc 에서 .array().min/.max 패턴을 찾지 못했습니다 — 건너뜀"
        return
    }

    # 중복 적용 방지 마커 삽입 (파일 맨 앞에 주석으로 추가)
    $content = "// __ort_patched_eigen_minmax__ (auto-patched by build script)`n" + $content

    $backup = "$srcFile.minmax-patch.bak"
    Copy-Item $srcFile $backup -Force
    Set-Content $srcFile $content -NoNewline
    Write-Host "  [patch] element_wise_ops.cc 패치 완료, 백업: $backup"
}

Require-Command git
Require-Command python
Require-Command node
Require-Command npm

# CUDA / cuDNN 경로 해석 (자동 감지 포함) — 헤더 출력 전에 실행
$CudaHome  = Resolve-CudaHome  $CudaHome
$CudnnHome = Resolve-CudnnHome $CudnnHome

# CUDA 버전 문자열 추출 (예: "...\CUDA\v12.9" → "12.9")
# ORT build.py 는 --cuda_version 이 주어지면 CMake 생성기 툴셋을
# "-T host=x64,cuda=<version>" 형태로 구성합니다 (버전 문자열만 사용, 공백 없음).
# --cuda_version 없이 --cuda_home 만 주어지면 "-T host=x64,cuda=<CudaHome 전체 경로>" 로 구성되는데,
# CUDA 기본 설치 경로("C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9")는
# 공백을 포함하므로 CMake 의 VS 생성기 툴셋 파서가 이를 파싱하지 못해
# "CMake Error: Error: generator toolset: host=x64,cuda=C:\Program Files\..." 오류가 발생합니다.
# (VS 의 CUDA 12.9 BuildCustomizations 통합 파일이 정상 설치되어 있어도 발생하는, 경로 공백 자체의 문제)
$CudaVersionStr = $null
if ($CudaHome -match 'v(\d+\.\d+)(\.\d+)?\s*$') {
    $CudaVersionStr = $Matches[1]
}

# MSBuild 의 CUDA X.Y.targets 파일은 CudaToolkitDir 속성을 환경변수 CUDA_PATH_V<major>_<minor>
# (없으면 CUDA_PATH) 로부터 읽습니다. 이 값들은 CUDA Toolkit 설치 시 Machine 레벨에 기록되지만,
# 이미 실행 중인 셸 세션은 그 이후 갱신되지 않으므로(터미널이 CUDA 설치보다 먼저 열린 경우 등)
# "The CUDA Toolkit vX.Y directory '' does not exist." 오류가 발생할 수 있습니다.
# 현재 프로세스 범위에서 명시적으로 재설정하여 이 문제를 회피합니다.
if ($CudaVersionStr -and ($CudaVersionStr -match '^(\d+)\.(\d+)$')) {
    $cudaEnvVarName = "CUDA_PATH_V$($Matches[1])_$($Matches[2])"
    if (-not (Test-Path "env:$cudaEnvVarName") -or ((Get-Item "env:$cudaEnvVarName").Value -ne $CudaHome)) {
        Write-Host "  [env] $cudaEnvVarName 이(가) 현재 셸 세션에 없어 설정합니다: $CudaHome"
        Set-Item -Path "env:$cudaEnvVarName" -Value $CudaHome
    }
}
if (-not $env:CUDA_PATH -or ($env:CUDA_PATH -ne $CudaHome)) {
    Write-Host "  [env] CUDA_PATH 이(가) 현재 셸 세션에 없어 설정합니다: $CudaHome"
    $env:CUDA_PATH = $CudaHome
}

Write-Host ""
Write-Host "================================================================"
Write-Host "   ONNX Runtime Source Build + Local onnxruntime-node Link"
Write-Host "================================================================"
Write-Host "  ServerDir : $ServerDir"
Write-Host "  OrtRepo   : $OrtRepoDir"
Write-Host "  OrtRef    : $OrtRef"
Write-Host "  CudaHome  : $CudaHome"
Write-Host "  CudaVersion : $(if ($CudaVersionStr) { $CudaVersionStr } else { '(경로 기반 툴셋 — 공백 포함 시 CMake 오류 위험)' })"
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
    # deps.txt 의 "eigen" 항목은 gitlab.com/libeigen/eigen 의 3.4.0 태그가 아니라
    # github.com/eigen-mirror/eigen 의 특정 커밋(NaN 전파 min/max<NaNPropagationOptions> 등 백포트 포함,
    # onnxruntime/core/providers/cpu/math/element_wise_ops.cc 가 이 오버로드를 사용)을 고정합니다.
    # 커밋 해시로 확인되면 반드시 같은 미러(eigen-mirror)에서 clone 해야 그 커밋이 실제로 존재합니다 —
    # gitlab.com/libeigen/eigen.git 에는 동일 해시가 없을 수 있습니다(다른 리포지토리).
    $eigenRef = Get-DepRefFromDeps $OrtRepoDir "eigen3"
    if (-not $eigenRef) { $eigenRef = Get-DepRefFromDeps $OrtRepoDir "eigen" }
    $eigenGitUrl = "https://gitlab.com/libeigen/eigen.git"
    if ($eigenRef -and ($eigenRef -match '^[0-9a-f]{40}$')) {
        $eigenGitUrl = "https://github.com/eigen-mirror/eigen.git"
    }
    if (-not $eigenRef) { $eigenRef = "3.4.0" }
    Write-Host "  [eigen3] ref: $eigenRef (source: $eigenGitUrl)"
    $eigenSourceDir = Ensure-DepGitSource $OrtRepoDir "eigen3" $eigenGitUrl $eigenRef
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
        } else {
            # flat 레이아웃 (pip nvidia-cudnn-cu{ver} 패키지: include\cudnn.h, bin\cudnn64_9.dll)
            # NVIDIA 공식 Windows pip wheel 은 런타임용 .dll 만 포함하고 링크용 .lib 은 없습니다
            # (PyTorch 등은 ctypes/delay-load 로 .dll 을 직접 로드하므로 .lib 이 불필요).
            # ORT cmake 소스 빌드는 링크 단계에서 cudnn_LIBRARY(.lib) 이 반드시 필요하므로,
            # dumpbin(.exe)+lib(.exe) 로 .dll 의 export 심볼을 추출해 .lib 을 직접 생성합니다.
            $generatedLib = Ensure-CudnnImportLib $CudnnHome
            if ($generatedLib) {
                $cmakeDefines += "CUDNN_INCLUDE_DIR=$(($CudnnHome -replace '\\','/'))/include"
                $cmakeDefines += "cudnn_LIBRARY=$($generatedLib -replace '\\','/')"
            }
        }
    }

    if ($CudaArch) {
        $cmakeDefines += "CMAKE_CUDA_ARCHITECTURES=$CudaArch"
    }

    # ORT cmake/CMakeLists.txt 는 onnxruntime_BUILD_UNIT_TESTS 기본값이 ON 이며, build.py 의
    # --skip_tests 플래그는 빌드 후 ctest 실행만 건너뛸 뿐 테스트 타겟(onnxruntime_test_all,
    # onnxruntime_shared_lib_test 등 수백 개 파일) 자체는 여전히 빌드합니다. onnxruntime-node
    # 통합에는 이 테스트 바이너리가 전혀 필요 없고, onnxruntime_shared_lib_test 의
    # test/shared_lib/cuda_ops.cu 컴파일이 MSBuild CudaCompile 규칙 문제로 "nvcc fatal: A single
    # input file is required..." 를 내며 전체 빌드를 실패시키므로, 테스트 타겟 자체를 CMake 구성
    # 단계에서 끕니다.
    $cmakeDefines += "onnxruntime_BUILD_UNIT_TESTS=OFF"

    $buildArgs = @(
        "--config", "Release",
        "--build_shared_lib",
        "--use_cuda",
        "--cuda_home", $CudaHome,
        "--cmake_path", $cmakeExe,
        # ORT 소스 빌드는 기본적으로 CMake의 --compile-no-warning-as-error 미적용(dev mode) 상태로
        # nvcc 에 "-Werror all-warnings" 를 주입합니다. GSL v4.0.0의 [[gsl::suppress(...)]] 속성이나
        # abseil-cpp 헤더의 EDG 프런트엔드 경고(부호 변환/절단 등)가 이로 인해 하드 에러로 승격되어
        # onnxruntime_providers_cuda 컴파일이 실패하므로, 경고를 오류로 취급하지 않도록 명시적으로 끕니다.
        "--compile_no_warning_as_error",
        # onnxruntime-node 통합에는 ORT 자체 유닛테스트 바이너리(onnxruntime_test_all,
        # onnxruntime_shared_lib_test 등 수백 개 .cc/.cu 파일)가 전혀 필요 없고, 빌드 시간만 크게
        # 늘어납니다. 또한 onnxruntime_shared_lib_test 의 cuda_ops.cu 컴파일이 MSBuild
        # CudaCompile 커스텀 빌드 규칙 문제로 "nvcc fatal: A single input file is required for a
        # non-link phase when an outputfile is specified" 를 내며 전체 빌드를 실패시키는 것이 확인되어,
        # 테스트 타겟 자체를 빌드 대상에서 제외합니다.
        "--skip_tests"
    )

    if ($CudaVersionStr) {
        # CMake 생성기 툴셋을 버전 문자열 기반("cuda=12.9")으로 구성시켜
        # CudaHome 경로 내 공백(Program Files 등)으로 인한 툴셋 파싱 오류를 회피합니다.
        $buildArgs += @("--cuda_version", $CudaVersionStr)
    }

    if ($CudnnHome) {
        $buildArgs += @("--cudnn_home", $CudnnHome)
    }

    $buildArgs += @("--cmake_extra_defines")
    $buildArgs += $cmakeDefines

    # 이전 실행에서 남은 CMakeCache.txt 가 다른 CUDA_HOME/툴셋으로 생성된 경우
    # ("generator toolset ... Does not match the toolset used previously") CMake 가
    # 재구성을 거부하므로, 캐시에 기록된 CUDA 툴셋 값이 현재 값과 다르면 캐시를 지웁니다.
    $buildCacheFile = Join-Path $OrtRepoDir "build\Windows\Release\CMakeCache.txt"
    if (Test-Path $buildCacheFile) {
        $cachedToolset = Select-String -Path $buildCacheFile -Pattern '^CMAKE_GENERATOR_TOOLSET:' -ErrorAction SilentlyContinue |
            ForEach-Object { ($_ -split '=', 2)[1] }
        $desiredCudaToolsetVal = if ($CudaVersionStr) { $CudaVersionStr } else { $CudaHome }
        if ($cachedToolset -and ($cachedToolset -notmatch [regex]::Escape("cuda=$desiredCudaToolsetVal"))) {
            Write-Host "  [cleanup] CMakeCache 툴셋 불일치 감지 (cached: $cachedToolset) — 빌드 트리 재생성..."
            $buildWindowsDir = Join-Path $OrtRepoDir "build\Windows"
            Remove-Item -Recurse -Force $buildWindowsDir -ErrorAction SilentlyContinue
        }
    }

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
    # Eigen 3.4.0 + MSVC 2022 C++20: ArrayBase::min/max scalar 오버로드 패치
    Patch-OrtElementWiseOps $OrtRepoDir

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

    # js/node, js/common 은 자체 typescript devDependency 를 선언하지 않고, js/ 워크스페이스
    # 루트의 typescript(js/package-lock.json 에 5.2.2 로 고정)가 js/node_modules 로 설치된 뒤
    # Node 의 상위 디렉터리 node_modules 탐색 규칙으로 tsc 를 찾는 구조입니다. js/ 루트 설치를
    # 건너뛰면 tsc 가 시스템에 남아있는 호환되지 않는 다른 버전으로 해석되어 tsconfig.json 의
    # moduleResolution=node10 / esModuleInterop=false 옵션이 "제거된 옵션(TS5108/TS5011)"
    # 오류를 내며 js/common 빌드가 실패하므로, js/ 루트에서 락파일 고정 버전을 먼저 설치합니다.
    $jsRootDir = Join-Path $OrtRepoDir "js"
    Write-Host "[3a/4] Installing js/ workspace root devDependencies (pinned typescript)..."
    Push-Location $jsRootDir
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "onnxruntime js/ root npm ci failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "[3b/4] Building js/node package..."
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

    # "npm install" 의 postinstall/prepare 스크립트는 TypeScript 컴파일(tsc)만 수행하고,
    # 실제 N-API 네이티브 애드온(onnxruntime_binding.node)을 CUDA 를 링크해서 컴파일하는
    # cmake-js 단계("npm run build" = "tsc && node ./script/build")는 별도로 호출해야 합니다.
    Write-Host "[3c/4] Compiling js/node native addon with CUDA support (cmake-js)..."
    $ortWinBuildDir = (Join-Path $OrtRepoDir "build\Windows\Release") -replace '\\', '/'
    $ortBinDir = Join-Path $OrtRepoDir "build\Windows\Release\Release"

    # 과거 시도에서 --dll_deps/--onnxruntime-generator 값이 깨진 채로 CMake 캐시(CMakeCache.txt)에
    # 저장되었을 수 있으므로, 매번 cmake-js 의 build 출력 폴더를 지우고 새로 configure 합니다.
    $addonCmakeBuildDir = Join-Path $nodePkgDir "build"
    if (Test-Path $addonCmakeBuildDir) {
        Write-Host "  [clean] 이전 cmake-js build 캐시 삭제: $addonCmakeBuildDir"
        Remove-Item $addonCmakeBuildDir -Recurse -Force
    }

    # 주의: node ./script/build 는 내부적으로 spawnSync(..., { shell: true }) 를 두 단계
    # (npx cmake-js -> cmake) 거치면서 인자 배열을 공백으로만 join 하고 별도 quoting 을 하지
    # 않습니다. "C:\Program Files\..." 처럼 공백이 들어간 경로를 --dll_deps/--onnxruntime-generator
    # 값으로 넘기면 중간에 잘려서 cmake 에 깨진 인자로 전달됩니다(실제로 재현 확인됨:
    # "-DORT_NODEJS_DLL_DEPS=...;C:\Program" 뒤에 "Files\NVIDIA" 가 별개 인자로 분리됨).
    # 그래서 여기서는 --dll_deps/--onnxruntime-generator 를 아예 넘기지 않고, cmake-js 빌드가
    # 끝난 뒤 CUDA/cuDNN 관련 dll 들을 우리 스크립트가 직접 bin 폴더로 복사합니다.
    $addonBuildArgs = @(
        "./script/build",
        "--config=Release",
        "--use_cuda",
        "--onnxruntime-build-dir=$ortWinBuildDir"
    )
    Push-Location $nodePkgDir
    try {
        # cmake-js 는 자체적으로 설치된 Visual Studio 중 "가장 최신" 버전을 자동 탐지합니다.
        # 이 머신에는 VS2022 Professional 외에 C++ 워크로드가 없는 VS2026 Insiders 미리보기도
        # 설치되어 있어, cmake-js 가 이를 먼저 골라 "There is no Visual C++ compiler installed"
        # 오류를 내며 실패합니다. cmake-js 는 npm config 값(npm_config_msvs_version 환경변수)으로
        # 강제 지정하는 것을 지원하므로(node-gyp 관례와 동일), 여기서 2022 를 명시적으로 설정합니다.
        $env:npm_config_msvs_version = "2022"
        & node @addonBuildArgs
        if ($LASTEXITCODE -ne 0) {
            throw "onnxruntime-node native addon build (cmake-js, CUDA) failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    # js/node/CMakeLists.txt 는 onnxruntime.dll 만 자동으로 bin 폴더에 복사하므로,
    # CUDA EP 로딩에 필요한 onnxruntime_providers_cuda.dll/onnxruntime_providers_shared.dll
    # 및 그 런타임 의존 dll(CUDA/cuDNN) 들은 여기서 직접 복사합니다.
    $addonDistDir = Join-Path $nodePkgDir "bin\napi-v6\win32\x64"
    if (-not (Test-Path $addonDistDir -PathType Container)) {
        throw "onnxruntime-node native addon 출력 폴더를 찾지 못했습니다: $addonDistDir"
    }
    Write-Host "  [dll_deps] CUDA/cuDNN 런타임 dll 을 $addonDistDir 로 복사합니다..."
    $extraDlls = New-Object System.Collections.Generic.List[string]
    foreach ($extraDll in @("onnxruntime_providers_cuda.dll", "onnxruntime_providers_shared.dll")) {
        $extraDllPath = Join-Path $ortBinDir $extraDll
        if (Test-Path $extraDllPath -PathType Leaf) {
            $extraDlls.Add($extraDllPath)
        }
        else {
            Write-Warning "  [dll_deps] 찾지 못함: $extraDllPath"
        }
    }
    $cudaBinDir = Join-Path $CudaHome "bin"
    if (Test-Path $cudaBinDir) {
        Get-ChildItem $cudaBinDir -Filter "*.dll" -ErrorAction SilentlyContinue | ForEach-Object { $extraDlls.Add($_.FullName) }
    }
    if ($CudnnHome -and (Test-Path $CudnnHome)) {
        Get-ChildItem $CudnnHome -Recurse -Filter "*.dll" -ErrorAction SilentlyContinue | ForEach-Object { $extraDlls.Add($_.FullName) }
    }
    foreach ($dllPath in ($extraDlls | Select-Object -Unique)) {
        Copy-Item -Path $dllPath -Destination $addonDistDir -Force
    }
    Write-Host "  [dll_deps] $($extraDlls.Count)개 dll 복사 완료."
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
