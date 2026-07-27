#Requires -Version 5.1
<#!
.SYNOPSIS
    cuDNN 자동 설치 (Windows, pip 패키지 방식)

.DESCRIPTION
    NVIDIA 공식 cuDNN 다운로드(zip/EXE)는 developer.nvidia.com 로그인이 필요하여
    완전 자동화가 불가능합니다. 대신 PyPI 의 nvidia-cudnn-cuXX 패키지(로그인 불필요,
    PyTorch/JAX 등이 사용하는 것과 동일한 NVIDIA 공식 재배포 채널)를 pip 로 설치하여
    cuDNN 헤더/라이브러리/DLL 을 확보합니다.

    설치 순서:
      1) 이미 pip 패키지가 설치되어 있으면 경로를 CUDNN_HOME=<path> 로 출력 후 종료
      2) python -m pip install nvidia-cudnn-cu{major} 시도
      3) 실패 시 수동 설치 안내(zip/EXE, NVIDIA 계정 필요) 출력 후 종료(exit 1)

    성공 시 표준 출력 마지막 줄에 "CUDNN_HOME=<경로>" 형태로 경로를 출력합니다.
    이 출력을 buildOrtWithCuda.js 가 파싱하여 -CudnnHome 인자로 사용합니다.
    (경로는 <site-packages>\nvidia\cudnn 이며 bin/include/lib 하위 디렉토리를 포함합니다.)

.PARAMETER CudaMajorMinor
    설치 대상 CUDA 버전 (예: "12.9", "11.8") — major 버전만 pip 패키지명에 사용됩니다.
    (nvidia-cudnn-cu12, nvidia-cudnn-cu11)

.PARAMETER PythonExe
    사용할 Python 실행 파일 경로. 생략 시 $env:VIRTUAL_ENV, PYTHON_EXEC_WINDOWS,
    PATH 의 python 순으로 탐색합니다.

.PARAMETER ShowUrls
    설치 없이 pip 패키지명 및 참고 URL 만 출력하고 종료합니다.

.PARAMETER AllowInsecureTls
    기업 프록시 환경에서 pip 의 TLS 검증을 우회합니다 (--trusted-host 추가).

.EXAMPLE
    .\ensure-cudnn.windows.ps1 -CudaMajorMinor "12.9"

.NOTES
    - NVIDIA 로그인 없이 자동화 가능한 유일한 공식 채널(PyPI)을 사용합니다.
    - pip 패키지가 실패하면(오프라인 등) zip/EXE 수동 설치만 남습니다 — 이 경우
      cuDNN 없이도 빌드는 계속 진행되므로(선택적 의존성) 실패해도 치명적이지 않습니다.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$CudaMajorMinor,

    [string]$PythonExe,
    [switch]$ShowUrls,
    [switch]$AllowInsecureTls
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
# UTF-8 출력 인코딩 강제 (한글 깨짐 방지)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$null = chcp 65001 2>$null  # 콘솔 코드 페이지 UTF-8 전환

$CudaMajorMinor = $CudaMajorMinor -replace '^v', ''
$CudaMajor      = $CudaMajorMinor.Split('.')[0]
$PkgName        = "nvidia-cudnn-cu$CudaMajor"

Write-Host ""
Write-Host "=================================================="
Write-Host "  cuDNN Installer (pip) — 대상 CUDA: $CudaMajorMinor"
Write-Host "=================================================="
Write-Host ""

if ($ShowUrls) {
    Write-Host "  pip 패키지: $PkgName"
    Write-Host "  PyPI: https://pypi.org/project/$PkgName/"
    Write-Host ""
    Write-Host "  참고(로그인 필요, 수동 설치): https://developer.nvidia.com/cudnn"
    exit 0
}

# ── Python 실행 파일 탐색 ─────────────────────────────────────────────────────
# 주의: PATH 상의 `python`이 실제로 동작하지 않는 shim(예: 깨진 cygwin 심볼릭 링크)일 수 있으므로
# Get-Command로 "찾았는지"만 보지 말고 실제로 --version 실행이 되는지까지 검증한다.
function Test-PythonWorks([string]$exe) {
    if (-not $exe) { return $false }
    try {
        $out = & $exe --version 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Find-PythonExe([string]$override) {
    if ($override -and (Test-PythonWorks $override)) { return $override }

    if ($env:VIRTUAL_ENV) {
        $venvPy = Join-Path $env:VIRTUAL_ENV "Scripts\python.exe"
        if ((Test-Path $venvPy -PathType Leaf) -and (Test-PythonWorks $venvPy)) { return $venvPy }
    }

    # 저장소 루트의 .venv (VIRTUAL_ENV 미설정 터미널에서 npm 스크립트를 실행하는 경우 대비)
    # 이 스크립트 경로: server/src/scripts/ensure-cudnn.windows.ps1 → 3단계 상위가 저장소 루트
    $repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $repoVenvPy = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if ((Test-Path $repoVenvPy -PathType Leaf) -and (Test-PythonWorks $repoVenvPy)) { return $repoVenvPy }

    if ($env:PYTHON_EXEC -and (Test-PythonWorks $env:PYTHON_EXEC)) { return $env:PYTHON_EXEC }
    if ($env:PYTHON_EXEC_WINDOWS -and (Test-PythonWorks $env:PYTHON_EXEC_WINDOWS)) { return $env:PYTHON_EXEC_WINDOWS }

    if (Test-PythonWorks "python") { return "python" }
    if (Test-PythonWorks "py") { return "py" }
    return $null
}

$python = Find-PythonExe $PythonExe
if (-not $python) {
    Write-Warning "  Python 실행 파일을 찾을 수 없습니다 (venv/PATH 모두 미감지)."
    Write-Host ""
    Write-Host "  [수동 설치 안내]"
    Write-Host "  1. Python 설치 후 재시도하거나, 직접 pip 설치:"
    Write-Host "     pip install $PkgName"
    Write-Host "  2. 또는 NVIDIA 계정으로 zip/EXE 수동 설치: https://developer.nvidia.com/cudnn"
    exit 1
}
Write-Host "  Python: $python"

# ── 이미 설치되어 있는지 확인 ─────────────────────────────────────────────────
$probe = "import importlib.util; s=importlib.util.find_spec('nvidia.cudnn'); print(s.submodule_search_locations[0] if s else '')"
function Get-PipCudnnDir([string]$py, [string]$probeCode) {
    try {
        $out = & $py -c $probeCode 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -and (Test-Path $out -PathType Container)) {
            return $out.Trim()
        }
    } catch { }
    return $null
}

$existing = Get-PipCudnnDir $python $probe
if ($existing -and (Test-Path (Join-Path $existing "bin") -PathType Container)) {
    Write-Host "  ✅ cuDNN 이미 설치됨(pip): $existing"
    Write-Host ""
    Write-Host "CUDNN_HOME=$existing"
    exit 0
}

# ── pip install ───────────────────────────────────────────────────────────────
Write-Host "  cuDNN 미설치 — pip install $PkgName 시도..."
Write-Host ""

$pipArgs = @("-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--upgrade", $PkgName)
if ($AllowInsecureTls) {
    $pipArgs += @("--trusted-host", "pypi.org", "--trusted-host", "files.pythonhosted.org")
}

$pipExitCode = 0
try {
    $proc = Start-Process $python -ArgumentList $pipArgs -Wait -PassThru -NoNewWindow
    $pipExitCode = $proc.ExitCode
} catch {
    Write-Warning "  pip 실행 오류: $_"
    $pipExitCode = 1
}

if ($pipExitCode -ne 0) {
    Write-Warning "  pip install 종료 코드: $pipExitCode"
    Write-Host ""
    Write-Host "  [수동 설치 안내]"
    Write-Host "  1. 직접 pip 설치 재시도:"
    Write-Host "     $python -m pip install $PkgName"
    Write-Host "  2. 오프라인/사내망이면 --insecure-tls 옵션으로 재시도하거나"
    Write-Host "     NVIDIA 계정으로 zip/EXE 수동 설치: https://developer.nvidia.com/cudnn"
    exit 1
}

$installed = Get-PipCudnnDir $python $probe
if ($installed -and (Test-Path (Join-Path $installed "bin") -PathType Container)) {
    Write-Host "  ✅ cuDNN 설치 완료(pip): $installed"
    Write-Host ""
    Write-Host "CUDNN_HOME=$installed"
    exit 0
}

Write-Warning "  pip install 은 성공했지만 설치 경로를 확인할 수 없습니다."
Write-Host ""
Write-Host "  [수동 설치 안내]"
Write-Host "  1. 설치 확인: $python -c `"import nvidia.cudnn; print(nvidia.cudnn.__file__)`""
Write-Host "  2. 또는 NVIDIA 계정으로 zip/EXE 수동 설치: https://developer.nvidia.com/cudnn"
exit 1
