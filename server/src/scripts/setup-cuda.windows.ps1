#Requires -Version 5.1
<#
.SYNOPSIS
    LTS-2026 Windows CUDA setup — downloads and silently installs the NVIDIA CUDA
    Toolkit, then installs a matching CUDA-enabled PyTorch build and verifies
    torch.cuda.is_available() returns True.

.DESCRIPTION
    Written for the PromptPAR (cloth-PAR) export step (server/src/scripts/exportPromptPAR.py),
    which hardcodes .cuda() calls with no CPU fallback — see docs/design/Design_AI_Cloth_Analysis.md.
    Also benefits any other analysis-server workload that wants GPU-accelerated PyTorch.

    Steps:
      0. Resolve a real Python interpreter, skipping the Windows Store alias stub — fails
         fast here, before the multi-GB CUDA download, if none is usable.
      1. Verify an NVIDIA GPU is present (nvidia-smi) — refuses to continue without one.
      2. Report the currently installed driver version and its max-supported CUDA version.
      3. Download the NVIDIA CUDA Toolkit network installer for -CudaVersion (default 12.4.1).
      4. Run it silently. By default the *driver* component is excluded (a driver already
         exists — reinstalling/downgrading it unattended is the single riskiest part of this
         process) — pass -IncludeDriver to let the installer manage the driver too.
      5. Verify CUDA_PATH / nvcc are on PATH after install.
      6. Install a CUDA-matched PyTorch build (--index-url download.pytorch.org/whl/cuXXX)
         and verify torch.cuda.is_available().

    This script does NOT need to run more than once per machine. Re-running is safe
    (harmless no-op) if CUDA of the requested version is already installed and PyTorch
    already reports CUDA available.

.PARAMETER CudaVersion
    Full CUDA Toolkit version to install, e.g. "12.4.1". Must have a published NVIDIA
    network installer at the standard developer.download.nvidia.com layout. Default 12.4.1 —
    mature, broadly compatible with recent drivers and PyTorch's published cu124 wheels.

.PARAMETER IncludeDriver
    Also let the CUDA installer manage the GPU driver. Off by default: a driver is already
    confirmed present, and unattended driver replacement is the part of this process most
    likely to leave the machine in a bad state (version mismatch, reboot required mid-way).

.PARAMETER PythonExe
    Python interpreter to install the CUDA PyTorch build into. Leave unset to auto-detect
    (checks PYTHON_EXEC/PYTHON_EXEC_WINDOWS env vars, common real install paths, then `py -3`/
    `python3`/`python` on PATH — explicitly skipping the Microsoft Store "python" app-execution
    alias stub, which isn't a real interpreter and fails with "No application is associated
    with the specified file for this operation" when invoked non-interactively). Pass this
    explicitly if auto-detect picks the wrong one on a machine with multiple Python installs.

.EXAMPLE
    cd loitering_tracking
    powershell -ExecutionPolicy Bypass -File server/src/scripts/setup-cuda.windows.ps1

.EXAMPLE
    # Also let the installer manage the driver, and target a specific interpreter
    powershell -ExecutionPolicy Bypass -File server/src/scripts/setup-cuda.windows.ps1 `
        -IncludeDriver -PythonExe "C:\Users\young.ho.kim\AppData\Local\Programs\Python\Python312\python.exe"

.NOTES
    Must run in an elevated (Administrator) PowerShell — the CUDA installer requires it.
    Downloads several GB — expect this to take a while on a slow connection.
    A reboot is occasionally required by the CUDA installer even without -IncludeDriver
    (rare, but the script will tell you if the installer requests one).
#>

param(
    [string]$CudaVersion = "12.4.1",
    [switch]$IncludeDriver,
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"   # suppress slow download progress bars

# --- Helper: find a real Python interpreter, skipping the Store alias stub --
# %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is a Windows "app execution
# alias" — it's on PATH by default on most Windows installs even with no real
# Python present, and calling it non-interactively fails with "No application
# is associated with the specified file for this operation" instead of a normal
# not-found error, so a plain `Get-Command python` is not enough to trust it.
function Test-RealPython($path) {
    if (-not $path) { return $false }
    if ($path -match '\\Microsoft\\WindowsApps\\') { return $false }
    try {
        $out = & $path --version 2>&1
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Resolve-PythonExe($explicit) {
    if ($explicit) {
        if (Test-RealPython $explicit) { return $explicit }
        Write-Error "Specified -PythonExe '$explicit' did not run successfully (checked with --version)."
        exit 1
    }
    $candidates = @($env:PYTHON_EXEC, $env:PYTHON_EXEC_WINDOWS)
    $candidates += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher -and (Test-RealPython $pyLauncher.Source)) {
        try {
            $resolved = (& py -3 -c "import sys; print(sys.executable)" 2>$null)
            if ($resolved) { $candidates += $resolved.Trim() }
        } catch {}
    }
    $candidates += (Get-Command python3 -ErrorAction SilentlyContinue).Source
    $candidates += (Get-Command python  -ErrorAction SilentlyContinue).Source

    foreach ($cand in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (Test-RealPython $cand) { return $cand }
    }
    Write-Error "No usable Python interpreter found (only the Windows Store 'python' alias, or none at all). Install Python from https://www.python.org/downloads/windows/ (not the Store version), or pass -PythonExe pointing at an existing install, e.g. server/.env's PYTHON_EXEC_WINDOWS."
    exit 1
}

Write-Host ""
Write-Host "================================================================"
Write-Host "         LTS-2026  CUDA Setup  (Windows)"
Write-Host "================================================================"
Write-Host ""

# --- Require Administrator ---------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must run in an elevated (Administrator) PowerShell. Right-click PowerShell -> 'Run as Administrator', then re-run this script."
    exit 1
}

# --- Step 0: resolve Python interpreter up front (fail fast, before the multi-GB
#     CUDA download, if there's no usable Python at all) ---------------------
Write-Host "[0/7] Resolving Python interpreter..."
$PythonExe = Resolve-PythonExe $PythonExe
Write-Host "  Using: $PythonExe"

# --- Step 1: verify NVIDIA GPU + driver --------------------------------------
Write-Host "[1/7] Checking for an NVIDIA GPU..."
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $nvidiaSmi) {
    Write-Error "nvidia-smi not found — no NVIDIA driver detected. This script requires a working NVIDIA GPU + driver already installed (CUDA cannot help without one). Install the driver from https://www.nvidia.com/Download/index.aspx first, or re-run with -IncludeDriver to let the CUDA installer attempt it."
    exit 1
}

$smiOutput = & nvidia-smi 2>&1 | Out-String
Write-Host $smiOutput
if ($smiOutput -notmatch "CUDA Version:\s*([\d.]+)") {
    Write-Error "Could not parse driver's max-supported CUDA version from nvidia-smi output — GPU/driver may be in a bad state."
    exit 1
}
$driverMaxCuda = $Matches[1]
Write-Host "  Driver reports max-supported CUDA: $driverMaxCuda"
Write-Host "  Requested CUDA Toolkit version:    $CudaVersion"
if ([version]($CudaVersion.Split('.')[0..1] -join '.') -gt [version]$driverMaxCuda) {
    Write-Warning "Requested CUDA $CudaVersion exceeds this driver's max-supported $driverMaxCuda."
    Write-Warning "Either pass -IncludeDriver so the installer can update the driver, or use -CudaVersion matching $driverMaxCuda or lower."
    $confirm = Read-Host "Continue anyway? (y/N)"
    if ($confirm -ne "y") { exit 1 }
}

# --- Step 2: already installed? ----------------------------------------------
$cudaShort = ($CudaVersion.Split('.')[0..1] -join '_')  # "12.4.1" -> "12_4"
$existingPath = [System.Environment]::GetEnvironmentVariable("CUDA_PATH_V$cudaShort", "Machine")
if ($existingPath -and (Test-Path (Join-Path $existingPath "bin\nvcc.exe"))) {
    Write-Host "[2/7] CUDA $CudaVersion already installed at $existingPath — skipping toolkit download/install."
    $skipInstall = $true
} else {
    Write-Host "[2/7] CUDA $CudaVersion not found — will download and install."
    $skipInstall = $false
}

if (-not $skipInstall) {
    # --- Step 3: download the network installer ------------------------------
    $installerUrl  = "https://developer.download.nvidia.com/compute/cuda/$CudaVersion/network_installers/cuda_${CudaVersion}_windows_network.exe"
    $installerPath = Join-Path $env:TEMP "cuda_${CudaVersion}_windows_network.exe"
    Write-Host "[3/7] Downloading CUDA Toolkit $CudaVersion network installer..."
    Write-Host "  URL:  $installerUrl"
    Write-Host "  Dest: $installerPath"
    try {
        Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
    } catch {
        Write-Error "Download failed: $($_.Exception.Message)`nCheck that $CudaVersion is a published release at https://developer.nvidia.com/cuda-toolkit-archive and that the network installer exists for it."
        exit 1
    }
    Write-Host "  Downloaded $((Get-Item $installerPath).Length / 1MB -as [int]) MB"

    # --- Step 4: silent install -----------------------------------------------
    # Component names follow the "<name>_<major>_<minor>" convention NVIDIA's CUDA
    # installer expects. Driver-related components (Display.Driver / display.driver)
    # are deliberately omitted here unless -IncludeDriver is passed — a driver is
    # already confirmed present (Step 1), and unattended driver replacement is the
    # single riskiest part of this whole process (version mismatch, mid-install
    # reboot requirement, etc).
    $cudaMajorMinor = $CudaVersion.Split('.')[0..1] -join '.'
    $components = @(
        "nvcc_$cudaMajorMinor", "cudart_$cudaMajorMinor",
        "cublas_$cudaMajorMinor", "cublas_dev_$cudaMajorMinor",
        "cufft_$cudaMajorMinor", "cufft_dev_$cudaMajorMinor",
        "curand_$cudaMajorMinor", "curand_dev_$cudaMajorMinor",
        "cusolver_$cudaMajorMinor", "cusolver_dev_$cudaMajorMinor",
        "cusparse_$cudaMajorMinor", "cusparse_dev_$cudaMajorMinor",
        "npp_$cudaMajorMinor", "npp_dev_$cudaMajorMinor",
        "nvrtc_$cudaMajorMinor", "nvrtc_dev_$cudaMajorMinor",
        "nvml_dev_$cudaMajorMinor", "nvtx_$cudaMajorMinor",
        "visual_studio_integration_$cudaMajorMinor"
    )
    if ($IncludeDriver) {
        Write-Host "[4/7] Running silent install (-IncludeDriver: installer will also manage the GPU driver)..."
        $installArgs = @("-s")   # bare -s = installer's full default component set, including driver
    } else {
        Write-Host "[4/7] Running silent install (toolkit components only, driver untouched)..."
        $installArgs = @("-s") + $components
    }
    Write-Host "  This can take several minutes — installer runs with no visible UI."
    $proc = Start-Process -FilePath $installerPath -ArgumentList $installArgs -Wait -PassThru
    Remove-Item $installerPath -ErrorAction SilentlyContinue
    if ($proc.ExitCode -eq 0) {
        Write-Host "  CUDA Toolkit install succeeded."
    } elseif ($proc.ExitCode -eq 3010) {
        Write-Warning "CUDA Toolkit installed but a REBOOT IS REQUIRED before it will be usable. Reboot this machine, then re-run this script to continue with the PyTorch step."
        exit 3010
    } else {
        Write-Error "CUDA installer exited with code $($proc.ExitCode) — install failed. Check %TEMP%\cuda-install*.log for details."
        exit 1
    }

    # Refresh this session's environment from the machine scope so CUDA_PATH/PATH
    # set by the installer are visible without needing a new PowerShell window.
    $env:Path      = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:CUDA_PATH = [System.Environment]::GetEnvironmentVariable("CUDA_PATH_V$cudaShort", "Machine")
}

# --- Step 5: verify nvcc on PATH ----------------------------------------------
Write-Host "[5/7] Verifying nvcc..."
$nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
if (-not $nvcc) {
    Write-Error "nvcc still not found on PATH after install. Open a NEW PowerShell window (to pick up the updated system PATH) and re-run, or check CUDA_PATH_V$cudaShort was set."
    exit 1
}
& nvcc --version

# --- Step 6: install CUDA-matched PyTorch and verify -------------------------
Write-Host "[6/7] Installing CUDA-enabled PyTorch (cu$($cudaShort.Replace('_',''))) via $PythonExe..."
$torchIndex = "https://download.pytorch.org/whl/cu$($cudaShort.Replace('_',''))"
# --force-reinstall --no-cache-dir: a plain `pip install torch` (CPU wheel, from
# PyPI's default index) may already be present — e.g. analysisApi.js's
# auto-pip-install feature installs a bare `torch` with no --index-url the first
# time a model download needs it. Plain --upgrade against a different index can
# leave that CPU build in place if pip considers the locally installed version
# to already satisfy the requirement, silently producing exactly the
# "CUDA available: False" result reported after the first run of this script.
& $PythonExe -m pip install --force-reinstall --no-cache-dir torch torchvision --index-url $torchIndex
if ($LASTEXITCODE -ne 0) {
    Write-Error "pip install of CUDA-enabled torch failed against index $torchIndex — that exact cuXXX wheel variant may not be published for this CUDA version. Check https://pytorch.org/get-started/locally/ for the currently published index URL and re-run with a matching -CudaVersion."
    exit 1
}

Write-Host ""
Write-Host "Verifying torch.cuda.is_available()..."
$verify = & $PythonExe -c "import torch; print('torch version:', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none')"
Write-Host $verify

if ($verify -match "CUDA available: True") {
    Write-Host ""
    Write-Host "================================================================"
    Write-Host "  Done — torch.cuda is available. PromptPAR export (and any other"
    Write-Host "  GPU-accelerated analysis step) can now run on this machine."
    Write-Host "================================================================"
} else {
    # torch.__version__ has no "+cuXXX" suffix on a CPU-only build — a quick,
    # visible confirmation of whether Step 6's install actually landed a CUDA
    # wheel at all, versus a genuine driver/hardware-level problem.
    if ($verify -notmatch '\+cu\d') {
        Write-Error "torch version above has no '+cuXXX' suffix — a CPU-only build is still installed despite --force-reinstall. Check the pip output further above for errors, and confirm $torchIndex actually serves a build for this Python version (https://pytorch.org/get-started/locally/)."
    } else {
        Write-Error "torch reports a CUDA build installed but CUDA is still unavailable — likely a driver/CUDA version mismatch (this driver's max-supported CUDA was reported in Step 1) or the GPU is not visible to this user session. Try a new PowerShell window, or re-run with -CudaVersion matching the driver's reported max."
    }
    exit 1
}
