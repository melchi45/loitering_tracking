#Requires -Version 5.1
<#!
.SYNOPSIS
.SYNOPSIS
    CUDA Toolkit 특정 버전 설치 확인 및 자동 설치 (Windows)

.DESCRIPTION
    cuDNN 버전과 일치하는 CUDA Toolkit이 없을 때 자동으로 설치합니다.
    설치 시도 순서:
      1) 이미 설치되어 있으면 경로를 CUDA_HOME=<path> 형식으로 출력 후 종료
      2) winget install Nvidia.CUDA --version {major}.{minor}
      3) NVIDIA 네트워크 인스톨러 직접 다운로드 + 자동 설치
      4) 수동 설치 안내 출력

    성공 시 표준 출력 마지막 줄에 "CUDA_HOME=<경로>" 형태로 경로를 출력합니다.
    이 출력을 buildOrtWithCuda.js 가 파싱하여 빌드에 사용합니다.

.PARAMETER RequiredVersion
    설치할 CUDA 버전 (예: "12.9", "12.8", "11.8")
    전체 버전(예: "12.9.0")도 허용 — 자동으로 major.minor 만 추출합니다.

.PARAMETER WingetOnly
    winget 방식만 시도합니다. 실패 시 오류로 종료합니다.

.PARAMETER DownloadOnly
    설치 없이 인스톨러만 다운로드합니다. 다운로드 경로를 출력 후 종료합니다.
    다운로드된 파일은 직접 실행하여 설치해야 합니다.

.PARAMETER ShowUrls
    다운로드 URL 목록만 출력하고 종료합니다 (설치 없음).

.PARAMETER DownloadDir
    인스톨러 다운로드 디렉토리 (기본: $env:TEMP\cuda-installers)

.PARAMETER AllowInsecureTls
    CMAKE_TLS_VERIFY=0 과 동일 — 기업 프록시 환경에서 TLS 검증을 우회합니다.

.EXAMPLE
    # 버전 감지 후 설치
    .\ensure-cuda-toolkit.windows.ps1 -RequiredVersion "12.9"

.EXAMPLE
    # URL 확인만
    .\ensure-cuda-toolkit.windows.ps1 -RequiredVersion "12.9" -ShowUrls

.EXAMPLE
    # 인스톨러 다운로드만 (설치 없음)
    .\ensure-cuda-toolkit.windows.ps1 -RequiredVersion "12.9" -DownloadOnly

.NOTES
    - 설치에는 관리자 권한이 필요합니다.
    - 네트워크 설치 관리자는 설치 중 추가 파일을 다운로드합니다 (~2-4 GB).
    - 자동 설치 컴포넌트: cuda_nvcc, cuda_cudart, cuda_cufft, cuda_cublas,
      cuda_curand, cuda_cusolver, cuda_cusparse, cuda_libraries_dev (링크용 lib 포함)
    - 전체 설치가 필요한 경우 직접 인스톨러를 실행하세요.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$RequiredVersion,

    [switch]$WingetOnly,
    [switch]$DownloadOnly,
    [switch]$ShowUrls,
    [string]$DownloadDir = "$env:TEMP\cuda-installers",
    [switch]$AllowInsecureTls
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
# UTF-8 출력 인코딩 강제 (한글 깨짐 방지)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$null = chcp 65001 2>$null  # 콘솔 코드 페이지 UTF-8 전환

# ── 버전 정규화 ───────────────────────────────────────────────────────────────
# "v12.9", "12.9.0" → "12.9"
$RequiredVersion = $RequiredVersion -replace '^v', ''
$vParts    = $RequiredVersion.Split('.')
$MinorVer  = "$($vParts[0]).$($vParts[1])"   # "12.9"
$MajorNum  = [int]$vParts[0]                  # 12
$MinorNum  = [int]$vParts[1]                  # 9

Write-Host ""
Write-Host "=================================================="
Write-Host "  CUDA Toolkit Installer — 필요 버전: $MinorVer"
Write-Host "=================================================="
Write-Host ""

# ── CUDA Toolkit 버전별 네트워크 설치 파일 URL 맵 ────────────────────────────
#
# URL 패턴:
#   https://developer.download.nvidia.com/compute/cuda/{full_ver}/
#     network_installers/cuda_{full_ver}_windows_network.exe
#
# full_ver = major.minor.patch (각 버전의 최신 패치 기준)
# NVIDIA 다운로드 페이지: https://developer.nvidia.com/cuda-downloads
#
$CudaNetworkInstallerMap = @{
    "13.3" = @{ full = "13.3.0"; driver = "NA" }
    "13.2" = @{ full = "13.2.0"; driver = "NA" }
    "13.1" = @{ full = "13.1.0"; driver = "NA" }
    "13.0" = @{ full = "13.0.0"; driver = "NA" }
    "12.9" = @{ full = "12.9.0"; driver = "576.57" }
    "12.8" = @{ full = "12.8.1"; driver = "572.61" }
    "12.7" = @{ full = "12.7.1"; driver = "565.98" }
    "12.6" = @{ full = "12.6.3"; driver = "561.17" }
    "12.5" = @{ full = "12.5.1"; driver = "555.85" }
    "12.4" = @{ full = "12.4.1"; driver = "551.61" }
    "12.3" = @{ full = "12.3.2"; driver = "546.12" }
    "12.2" = @{ full = "12.2.2"; driver = "537.13" }
    "12.1" = @{ full = "12.1.1"; driver = "531.14" }
    "12.0" = @{ full = "12.0.1"; driver = "528.33" }
    "11.8" = @{ full = "11.8.0"; driver = "522.06" }
    "11.7" = @{ full = "11.7.1"; driver = "516.94" }
    "11.6" = @{ full = "11.6.2"; driver = "511.65" }
}

# winget 패키지 ID 맵 (major.minor → winget ID)
# winget search "CUDA Toolkit" 또는 winget search Nvidia.CUDA 로 확인
$WingetPackageMap = @{
    "12.9" = "Nvidia.CUDA.12.9"
    "12.8" = "Nvidia.CUDA.12.8"
    "12.7" = "Nvidia.CUDA.12.7"
    "12.6" = "Nvidia.CUDA.12.6"
    "12.5" = "Nvidia.CUDA.12.5"
    "12.4" = "Nvidia.CUDA.12.4"
    "12.3" = "Nvidia.CUDA.12.3"
    "12.2" = "Nvidia.CUDA.12.2"
    "12.1" = "Nvidia.CUDA.12.1"
    "12.0" = "Nvidia.CUDA.12.0"
    "11.8" = "Nvidia.CUDA.11.8"
    # 범용 패키지 (버전 선택 지원 여부는 winget registry에 따라 다름)
    "_latest" = "Nvidia.CUDA"
}

# ── URL 조회 함수 ─────────────────────────────────────────────────────────────
function Get-CudaNetworkInstallerUrl([string]$minorVer) {
    if (-not $CudaNetworkInstallerMap.ContainsKey($minorVer)) {
        return $null
    }
    $info    = $CudaNetworkInstallerMap[$minorVer]
    $full    = $info.full
    $baseUrl = "https://developer.download.nvidia.com/compute/cuda/$full/network_installers"
    return "$baseUrl/cuda_${full}_windows_network.exe"
}

# --show-urls 모드
if ($ShowUrls) {
    Write-Host "CUDA Toolkit 다운로드 URL 목록:"
    Write-Host ""
    foreach ($ver in ($CudaNetworkInstallerMap.Keys | Sort-Object -Descending)) {
        $url = Get-CudaNetworkInstallerUrl $ver
        Write-Host "  $ver  →  $url"
    }
    Write-Host ""
    Write-Host "NVIDIA 공식 다운로드 페이지: https://developer.nvidia.com/cuda-downloads"
    exit 0
}

# ── 버전 지원 확인 ────────────────────────────────────────────────────────────
if (-not $CudaNetworkInstallerMap.ContainsKey($MinorVer)) {
    Write-Warning "알 수 없는 CUDA 버전: $MinorVer"
    Write-Warning "지원되는 버전: $($CudaNetworkInstallerMap.Keys -join ', ')"
    Write-Host ""
    Write-Host "NVIDIA 공식 다운로드 페이지에서 직접 다운로드하세요:"
    Write-Host "  https://developer.nvidia.com/cuda-downloads"
    exit 1
}

# ── 이미 설치되어 있는지 확인 ─────────────────────────────────────────────────
function Find-InstalledCudaHome([string]$minorVer) {
    $verDash = $minorVer.Replace('.', '_')    # "12.9" → "12_9"
    $envName = "CUDA_PATH_V$verDash"          # "CUDA_PATH_V12_9"

    foreach ($scope in @([System.EnvironmentVariableTarget]::Machine, [System.EnvironmentVariableTarget]::User)) {
        $val = [System.Environment]::GetEnvironmentVariable($envName, $scope)
        if ($val -and (Test-Path $val -PathType Container)) {
            $nvccPath = Join-Path $val "bin\nvcc.exe"
            if (Test-Path $nvccPath -PathType Leaf) { return $val }
        }
    }
    # 현재 프로세스 환경변수 (inherit)
    $val = [System.Environment]::GetEnvironmentVariable($envName)
    if ($val -and (Test-Path (Join-Path $val "bin\nvcc.exe") -PathType Leaf)) { return $val }

    # 기본 설치 경로 직접 스캔
    $defaultPath = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v$minorVer"
    if (Test-Path (Join-Path $defaultPath "bin\nvcc.exe") -PathType Leaf) { return $defaultPath }

    return $null
}

$existingHome = Find-InstalledCudaHome $MinorVer
if ($existingHome) {
    Write-Host "  ✅ CUDA $MinorVer 이미 설치됨: $existingHome"
    Write-Host ""
    # 빌드 스크립트가 파싱할 수 있는 출력 (마지막 줄)
    Write-Host "CUDA_HOME=$existingHome"
    exit 0
}

Write-Host "  CUDA Toolkit $MinorVer 미설치 — 설치를 시작합니다."
Write-Host ""

# ── 관리자 권한 확인 ──────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Warning "관리자 권한이 없습니다. 설치에 실패할 수 있습니다."
    Write-Warning "PowerShell을 '관리자 권한으로 실행' 후 다시 시도하세요."
    Write-Host ""
}

# ══════════════════════════════════════════════════════════════════
# 방법 1: winget
# ══════════════════════════════════════════════════════════════════
$wingetOk = $false
if (-not $DownloadOnly) {
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        Write-Host "[1/3] winget으로 CUDA $MinorVer 설치 시도..."
        $pkgId = if ($WingetPackageMap.ContainsKey($MinorVer)) { $WingetPackageMap[$MinorVer] } else { $WingetPackageMap["_latest"] }
        Write-Host "      winget install --id $pkgId --silent --accept-package-agreements --accept-source-agreements"

        try {
            $proc = Start-Process winget -ArgumentList @(
                "install", "--id", $pkgId,
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements"
            ) -Wait -PassThru -NoNewWindow

            if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq -1978335189) {
                # 0 = 설치 성공, -1978335189 (0x8A15002B) = 이미 설치됨
                $newHome = Find-InstalledCudaHome $MinorVer
                if ($newHome) {
                    Write-Host "  ✅ winget 설치 완료: $newHome"
                    $wingetOk = $true
                    Write-Host ""
                    Write-Host "CUDA_HOME=$newHome"
                    exit 0
                } else {
                    Write-Warning "  winget 종료 코드는 성공이지만 설치 경로를 찾을 수 없습니다."
                    Write-Warning "  PowerShell 또는 터미널을 재시작한 후 환경변수를 다시 로드하세요."
                }
            } else {
                Write-Warning "  winget 종료 코드: $($proc.ExitCode) — 다음 방법으로 대체합니다."
            }
        } catch {
            Write-Warning "  winget 실행 오류: $_"
        }

        if ($WingetOnly) {
            Write-Error "winget 설치 실패 (-WingetOnly 모드). 수동 설치가 필요합니다."
            exit 1
        }
    } else {
        Write-Host "[1/3] winget 미설치 — 건너뜁니다."
    }
}

# ══════════════════════════════════════════════════════════════════
# 방법 2: NVIDIA 네트워크 인스톨러 직접 다운로드 + 설치
# ══════════════════════════════════════════════════════════════════
$installerUrl = Get-CudaNetworkInstallerUrl $MinorVer
$fullVerInfo  = $CudaNetworkInstallerMap[$MinorVer]
$fullVer      = $fullVerInfo.full

Write-Host "[2/3] NVIDIA 네트워크 인스톨러 다운로드..."
Write-Host "      URL: $installerUrl"
Write-Host "      대상: $DownloadDir"
Write-Host ""
Write-Host "  ⚠️  네트워크 인스톨러는 설치 중 ~2-4 GB를 추가 다운로드합니다."
Write-Host "      안정적인 인터넷 연결이 필요합니다."
Write-Host ""

if (-not (Test-Path $DownloadDir -PathType Container)) {
    New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
}

$installerPath = Join-Path $DownloadDir "cuda_${fullVer}_windows_network.exe"

# TLS 설정
if ($AllowInsecureTls) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    Write-Warning "TLS 인증서 검증이 비활성화되었습니다 (-AllowInsecureTls)."
}

# ── 진행 표시 다운로드 함수 ────────────────────────────────────────────────────
# Invoke-WebRequest 는 파이프 환경에서 진행 표시가 없으므로
# HttpWebRequest 스트림으로 직접 읽어 5 MB 마다 진행 상황을 출력합니다.
function Invoke-DownloadWithProgress {
    param(
        [Parameter(Mandatory)] [string]$Uri,
        [Parameter(Mandatory)] [string]$OutFile,
        [int]$BufferSizeKB  = 256,   # 읽기 버퍼 크기 (KB)
        [long]$ReportEveryB = 5MB    # 진행 출력 간격 (바이트)
    )

    # HTTP 요청
    $req                        = [System.Net.HttpWebRequest]::Create($Uri)
    $req.Method                 = "GET"
    $req.Timeout                = 30000     # 연결 타임아웃 30s
    $req.ReadWriteTimeout       = 180000    # 읽기 타임아웃 3분
    $req.AllowAutoRedirect      = $true
    $req.UserAgent              = "LTS-2026-CudaInstaller/1.0"
    if ($script:AllowInsecureTls) {
        $req.ServerCertificateValidationCallback =
            [System.Net.Security.RemoteCertificateValidationCallback]{ $true }
    }

    try   { $resp = $req.GetResponse() }
    catch { throw "HTTP 요청 실패 ($Uri): $_" }

    $totalLen  = $resp.ContentLength    # -1 이면 Content-Length 없음
    $respStream = $resp.GetResponseStream()

    $fileStream = [System.IO.FileStream]::new(
        $OutFile,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None,
        65536
    )

    $buf        = New-Object byte[] ($BufferSizeKB * 1024)
    $downloaded = [long]0
    $startTime  = [DateTime]::UtcNow
    $lastReport = [long]0

    # 총 크기 출력
    if ($totalLen -gt 0) {
        Write-Host ("  총 파일 크기: {0:N1} MB" -f ($totalLen / 1MB))
    } else {
        Write-Host "  총 파일 크기: 알 수 없음 (서버 Content-Length 없음)"
    }
    Write-Host "  ┌─────────────────────────────────────────────────────┐"
    Write-Host "  │  진행     다운로드량           속도         ETA     │"
    Write-Host "  ├─────────────────────────────────────────────────────┤"

    try {
        $bytesRead = 0
        while (($bytesRead = $respStream.Read($buf, 0, $buf.Length)) -gt 0) {
            $fileStream.Write($buf, 0, $bytesRead)
            $downloaded += $bytesRead

            # ReportEveryB 바이트마다 한 줄 출력
            if ($downloaded - $lastReport -ge $ReportEveryB) {
                $lastReport = $downloaded
                $elapsed    = ([DateTime]::UtcNow - $startTime).TotalSeconds
                $dlMB       = $downloaded / 1MB
                $speedMBs   = if ($elapsed -gt 0) { $downloaded / 1MB / $elapsed } else { 0 }
                $speedStr   = if ($speedMBs -ge 1) {
                                  "{0:N2} MB/s" -f $speedMBs
                              } else {
                                  "{0:N0} KB/s" -f ($speedMBs * 1024)
                              }

                if ($totalLen -gt 0) {
                    $pct    = [int]($downloaded * 100 / $totalLen)
                    $totMB  = $totalLen / 1MB
                    $remain = ($totalLen - $downloaded) / 1MB
                    $etaSec = if ($speedMBs -gt 0) { [int]($remain / $speedMBs) } else { 0 }
                    $etaStr = if    ($etaSec -ge 3600) { "{0}h {1}m"   -f [int]($etaSec/3600), [int](($etaSec%3600)/60) }
                              elseif ($etaSec -ge  60) { "{0}m {1:D2}s" -f [int]($etaSec/60),  ($etaSec%60) }
                              else                     { "${etaSec}s" }
                    # 막대 그래프 (20칸)
                    $barFill  = [int]($pct / 5)
                    $barEmpty = 20 - $barFill
                    $bar      = ("█" * $barFill) + ("░" * $barEmpty)
                    Write-Host ("  │ {0,3}% [{1}] {2,5:N1}/{3,5:N1} MB  {4,10}  {5,6} │" `
                                -f $pct, $bar, $dlMB, $totMB, $speedStr, $etaStr)
                } else {
                    Write-Host ("  │  ???  {0,5:N1} MB 다운로드됨         {1,10}        │" `
                                -f $dlMB, $speedStr)
                }
            }
        }
    } finally {
        $fileStream.Flush()
        $fileStream.Close()
        $respStream.Close()
        $resp.Close()
    }

    # 완료 행
    $elapsed  = ([DateTime]::UtcNow - $startTime).TotalSeconds
    $finalMB  = $downloaded / 1MB
    $avgSpeed = if ($elapsed -gt 0) { $downloaded / 1MB / $elapsed } else { 0 }
    $avgStr   = if ($avgSpeed -ge 1) { "{0:N2} MB/s" -f $avgSpeed } else { "{0:N0} KB/s" -f ($avgSpeed * 1024) }
    Write-Host ("  │ 100% [████████████████████] {0,5:N1} MB  {1,10}  완료  │" `
                -f $finalMB, $avgStr)
    Write-Host "  └─────────────────────────────────────────────────────┘"
    Write-Host ("  ✅ 다운로드 완료: {0:N1} MB / {1:N1}초" -f $finalMB, $elapsed)
}

# 다운로드 (이미 있으면 건너뜀, 불완전하면 재시도)
$doDownload = $true
if (Test-Path $installerPath -PathType Leaf) {
    $existingSize = (Get-Item $installerPath).Length
    if ($existingSize -gt 1MB) {
        Write-Host "  인스톨러 이미 존재함 (재사용): $installerPath"
        Write-Host ("  크기: {0:N1} MB" -f ($existingSize / 1MB))
        $doDownload = $false
    } else {
        Write-Warning "  기존 파일이 너무 작음 ($existingSize bytes) — 재다운로드합니다."
        Remove-Item $installerPath -Force
    }
}

if ($doDownload) {
    try {
        Invoke-DownloadWithProgress -Uri $installerUrl -OutFile $installerPath
    } catch {
        Write-Error "  다운로드 실패: $_"
        Write-Host ""
        Write-Host "[수동 설치 안내]"
        Write-Host "  1. 아래 URL에서 직접 다운로드하세요:"
        Write-Host "     $installerUrl"
        Write-Host "  2. 다운로드한 파일을 실행하고 지시에 따라 설치하세요."
        Write-Host "  3. 설치 후 PowerShell을 재시작하고 다시 빌드를 실행하세요."
        exit 1
    }
}

# --download-only 모드: 설치 없이 경로 출력
if ($DownloadOnly) {
    Write-Host ""
    Write-Host "  인스톨러가 준비되었습니다. 직접 실행하여 설치하세요:"
    Write-Host "  $installerPath"
    Write-Host ""
    Write-Host "  자동 설치 (관리자 터미널에서):"
    Write-Host "  & '$installerPath' -s nvcc_$MinorVer cudart_$MinorVer cufft_$MinorVer cufft_dev_$MinorVer cublas_$MinorVer cublas_dev_$MinorVer curand_$MinorVer curand_dev_$MinorVer cusolver_$MinorVer cusolver_dev_$MinorVer cusparse_$MinorVer cusparse_dev_$MinorVer nvtx_$MinorVer"
    exit 0
}

# 자동 설치 실행
# -s : 자동 무인 설치
# 컴포넌트 이름은 "<name>_<major>.<minor>" 버전 접미사 형식이어야 합니다.
# (메타패키지 이름 "cuda_nvcc" 등은 네트워크 인스톨러 사일런트 모드에서
#  인식되지 않아 설치가 파싱 단계에서 즉시 실패합니다 — 관리자 권한 여부와 무관)
#   nvcc               — nvcc 컴파일러 + 헤더
#   cudart             — CUDA 런타임 (lib + dll)
#   cufft / cufft_dev  — cuFFT (+ 링크용 .lib)
#   cublas / cublas_dev — cuBLAS (+ 링크용 .lib)
#   curand / curand_dev — cuRAND (+ 링크용 .lib)
#   cusolver / cusolver_dev — cuSOLVER (+ 링크용 .lib)
#   cusparse / cusparse_dev — cuSPARSE (+ 링크용 .lib)
#   nvtx               — NVTX 프로파일링 (ORT 빌드 옵션 중 사용됨)
$components = @(
    "nvcc_$MinorVer",
    "cudart_$MinorVer",
    "cufft_$MinorVer", "cufft_dev_$MinorVer",
    "cublas_$MinorVer", "cublas_dev_$MinorVer",
    "curand_$MinorVer", "curand_dev_$MinorVer",
    "cusolver_$MinorVer", "cusolver_dev_$MinorVer",
    "cusparse_$MinorVer", "cusparse_dev_$MinorVer",
    "nvtx_$MinorVer"
)
$installArgs = @("-s") + $components
Write-Host "[3/3] CUDA $MinorVer 자동 설치 중..."
Write-Host "      컴포넌트: $($components -join ', ')"
Write-Host "      (전체 설치는 직접 인스톨러를 실행하세요: $installerPath)"
Write-Host ""

$installerExitCode = 0
try {
    $proc = Start-Process $installerPath -ArgumentList $installArgs -Wait -PassThru
    $installerExitCode = $proc.ExitCode
    if ($installerExitCode -ne 0) {
        Write-Warning "  인스톨러 종료 코드: $installerExitCode"
        Write-Warning "  일부 컴포넌트 설치가 실패했을 수 있습니다."
    }
} catch {
    Write-Error "  설치 실행 오류: $_"
    exit 1
}

# ── 설치 결과 확인 ────────────────────────────────────────────────────────────
# 설치 후 환경변수가 즉시 반영되지 않으므로 레지스트리에서 직접 읽음
function Get-MachineEnvVar([string]$name) {
    try {
        return [System.Environment]::GetEnvironmentVariable($name, [System.EnvironmentVariableTarget]::Machine)
    } catch { return $null }
}

$newCudaHome = $null
$verDash = $MinorVer.Replace('.', '_')

# 레지스트리에서 새 환경변수 읽기
$regVal = Get-MachineEnvVar "CUDA_PATH_V$verDash"
if ($regVal -and (Test-Path (Join-Path $regVal "bin\nvcc.exe") -PathType Leaf)) {
    $newCudaHome = $regVal
}
if (-not $newCudaHome) {
    $defaultPath = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v$MinorVer"
    if (Test-Path (Join-Path $defaultPath "bin\nvcc.exe") -PathType Leaf) {
        $newCudaHome = $defaultPath
    }
}

if ($newCudaHome) {
    Write-Host "  ✅ CUDA $MinorVer 설치 완료: $newCudaHome"
    Write-Host ""
    Write-Host "  [다음 단계]"
    Write-Host "  현재 터미널 세션에서는 환경변수가 즉시 반영되지 않을 수 있습니다."
    Write-Host "  PowerShell을 재시작하거나 아래 명령으로 환경변수를 수동 적용하세요:"
    Write-Host "    `$env:CUDA_PATH_V$verDash = '$newCudaHome'"
    Write-Host "    `$env:PATH = `$env:PATH + ';$newCudaHome\bin'"
    Write-Host ""
    Write-Host "CUDA_HOME=$newCudaHome"
    exit 0
}

# ── 설치 실패 — 수동 설치 안내 (admin 여부 무관) ──────────────────────────────
# CUDA 네트워크 인스톨러는 백그라운드 프로세스에서 실행 시 UAC 권한 획득이
# 불안정합니다. 인스톨러를 직접 실행해야 합니다.

# CUDA 인스톨러 로그 경로 (CUDA 설치 프로그램이 기록하는 기본 위치)
$cudaLogDir  = Join-Path $env:TEMP "CUDA"
$cudaLogHint = if (Test-Path $cudaLogDir) { $cudaLogDir } else { $env:TEMP }

$adminHint = if ($isAdmin) { "" } else { " (관리자 권한 필요)" }

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "  [CUDA $MinorVer 수동 설치 필요$adminHint]"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "  자동 설치 중 오류가 발생했습니다 (종료 코드: $installerExitCode)."
Write-Host "  인스톨러가 이미 다운로드되어 있으니 직접 실행하세요."
Write-Host ""
Write-Host "  인스톨러 경로:"
Write-Host "    $installerPath"
Write-Host ""
Write-Host "  ─── 방법 A: 관리자 PowerShell에서 무인 설치 ──────────"
Write-Host ""
if (-not $isAdmin) {
    Write-Host "  1. 시작 메뉴에서 'PowerShell' 검색 → [관리자 권한으로 실행]"
    Write-Host "  2. 아래 명령 실행:"
    Write-Host ""
}
Write-Host "     & '$installerPath' -s $($components -join ' ')"
Write-Host ""
Write-Host "  ─── 방법 B: GUI 전체 설치 (권장, 더 나은 오류 메시지) ─"
Write-Host ""
Write-Host "     & '$installerPath'"
Write-Host ""
Write-Host "  ─── 설치 실패 시 로그 확인 ──────────────────────────"
Write-Host ""
Write-Host "     Get-ChildItem '$cudaLogHint' -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 3"
Write-Host ""
Write-Host "  설치 완료 후 새 PowerShell 창을 열고 다시 실행하세요:"
Write-Host "    npm run build-ort:auto"
Write-Host ""
# buildOrtWithCuda.js 가 파싱하는 마커 (CUDA_HOME 없음 → 수동 필요)
Write-Host "CUDA_INSTALLER=$installerPath"
exit 3  # 3 = 수동 설치 필요 (buildOrtWithCuda.js 가 별도 처리)
