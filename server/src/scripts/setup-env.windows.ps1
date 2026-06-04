#Requires -Version 5.1
<#
.SYNOPSIS
    LTS-2026 Windows environment setup - detects / installs Node.js, Python, FFmpeg
    and generates server/.env from server/.env.example.

.DESCRIPTION
    1. Detects Node.js, Python 3, FFmpeg.
    2. If any tool is missing, attempts to install it via winget (Windows Package Manager).
    3. Resolves the actual binary paths after install.
    4. Copies .env.example → .env (if .env does not already exist).
    5. Patches OS-specific path variables in the generated .env.

.EXAMPLE
    cd loitering_tracking
    powershell -ExecutionPolicy Bypass -File server/src/scripts/setup-env.windows.ps1

.NOTES
    Requires Windows 10 1809+ or Windows 11 (winget comes pre-installed).
    Run from the project root or the server directory.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"   # suppress slow download bars in winget

# --- Resolve paths -----------------------------------------------------------
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$SERVER_DIR = (Resolve-Path (Join-Path $SCRIPT_DIR "..\..")).Path
$PROJECT_DIR = (Resolve-Path (Join-Path $SERVER_DIR "..")).Path

Write-Host ""
Write-Host "================================================================"
Write-Host "         LTS-2026  Environment Setup  (Windows)"
Write-Host "================================================================"
Write-Host ""
Write-Host "  Server dir  : $SERVER_DIR"
Write-Host "  Project dir : $PROJECT_DIR"
Write-Host ""

# --- Helper: check command ---------------------------------------------------
function Find-Command($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source } else { return $null }
}

# --- Helper: refresh PATH from registry (picks up winget installs) ----------
function Update-SessionPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

# --- Helper: install via winget ----------------------------------------------
function Install-Via-Winget($id, $label) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Warning "winget not found - cannot auto-install $label."
        Write-Warning "Install manually from https://learn.microsoft.com/windows/package-manager/winget/"
        return $false
    }
    Write-Host "  [Install] Installing $label via winget (id=$id)..."
    winget install "$id" --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        Write-Warning "winget returned exit code $LASTEXITCODE for $label — continuing."
    }
    Update-SessionPath
    return $true
}

# --- 1. Node.js --------------------------------------------------------------
Write-Host "-- [1/3] Node.js"
$nodePath = Find-Command "node"
if (-not $nodePath) {
    Write-Host "  Node.js not found. Attempting install..."
    Install-Via-Winget "OpenJS.NodeJS.LTS" "Node.js LTS" | Out-Null
    Update-SessionPath
    $nodePath = Find-Command "node"
}
if (-not $nodePath) {
    Write-Error "Node.js could not be installed automatically.`nVisit https://nodejs.org/ and install Node.js 18 LTS, then re-run this script."
}
$nodeVersion = & node -v 2>&1
Write-Host "  OK  node   : $nodePath  ($nodeVersion)"

# --- 2. Python ---------------------------------------------------------------
Write-Host ""
Write-Host "-- [2/3] Python"
$pythonPath = $null
foreach ($candidate in @("python", "python3", "py")) {
    $found = Find-Command $candidate
    if ($found) {
        # Exclude Windows Store stub / broken Cygwin links (may throw on invocation)
        try {
            $ver = & $candidate --version 2>&1
            if ("$ver" -match "Python 3\.") {
                $pythonPath    = $found
                $pythonExe     = $candidate
                $pythonVersion = "$ver"
                break
            }
        } catch {
            # candidate exists but is not a working Python 3 — try next
        }
    }
}
if (-not $pythonPath) {
    Write-Host "  Python 3 not found. Attempting install..."
    Install-Via-Winget "Python.Python.3.12" "Python 3.12" | Out-Null
    Update-SessionPath
    foreach ($candidate in @("python", "python3", "py")) {
        $found = Find-Command $candidate
        if ($found) {
            try {
                $ver = & $candidate --version 2>&1
                if ("$ver" -match "Python 3\.") {
                    $pythonPath    = $found
                    $pythonExe     = $candidate
                    $pythonVersion = "$ver"
                    break
                }
            } catch { }
        }
    }
}

# If launcher 'py.exe' was selected, resolve concrete interpreter path.
if ($pythonExe -eq "py") {
    try {
        $resolvedPy = (& py -3 -c "import sys; print(sys.executable)" 2>&1 | Select-Object -First 1).ToString().Trim()
        if ($resolvedPy -and (Test-Path $resolvedPy -PathType Leaf)) {
            $pythonPath = $resolvedPy
        }
    } catch {
        # Keep existing $pythonPath when resolution fails.
    }
}

if (-not $pythonPath) {
    Write-Warning "Python 3 could not be installed automatically."
    Write-Warning "Visit https://www.python.org/ — install Python 3.12, enable 'Add to PATH', then re-run."
    $pythonPath    = "python"
    $pythonExe     = "python"
    $pythonVersion = "(not detected)"
}
Write-Host "  OK  python : $pythonPath  ($pythonVersion)"

# --- 3. FFmpeg ---------------------------------------------------------------
Write-Host ""
Write-Host "-- [3/3] FFmpeg"
$ffmpegPath = Find-Command "ffmpeg"
if (-not $ffmpegPath) {
    Write-Host "  FFmpeg not found. Attempting install..."
    Install-Via-Winget "Gyan.FFmpeg" "FFmpeg" | Out-Null
    Update-SessionPath
    $ffmpegPath = Find-Command "ffmpeg"
}
if (-not $ffmpegPath) {
    Write-Warning "FFmpeg could not be installed automatically."
    Write-Warning "Install via: winget install Gyan.FFmpeg  — or download from https://ffmpeg.org/"
    $ffmpegPath   = "ffmpeg"
    $ffmpegDir    = ""
    $ffmpegVersion = "(not detected)"
} else {
    $ffmpegDir     = Split-Path $ffmpegPath
    $ffmpegVersion = (& ffmpeg -version 2>&1 | Select-Object -First 1)
}
Write-Host "  OK  ffmpeg : $ffmpegPath  ($ffmpegVersion)"

# --- 4. yt-dlp ---------------------------------------------------------------
Write-Host ""
Write-Host "-- [4/5] yt-dlp"
$ytdlpPath = Find-Command "yt-dlp"
if (-not $ytdlpPath) {
    Write-Host "  yt-dlp not found. Attempting install..."
    Install-Via-Winget "yt-dlp.yt-dlp" "yt-dlp" | Out-Null
    Update-SessionPath
    $ytdlpPath = Find-Command "yt-dlp"
}
if (-not $ytdlpPath) {
    Write-Warning "yt-dlp could not be installed automatically."
    Write-Warning "Install via: winget install yt-dlp.yt-dlp  — or see https://github.com/yt-dlp/yt-dlp"
    $ytdlpPath    = "yt-dlp"
    $ytdlpVersion = "(not detected)"
} else {
    try { $ytdlpVersion = (& yt-dlp --version 2>&1) } catch { $ytdlpVersion = "(unknown)" }
}
Write-Host "  OK  yt-dlp : $ytdlpPath  ($ytdlpVersion)"

# --- 5. Generate .env --------------------------------------------------------
Write-Host ""
Write-Host "-- [5/5] Generating server/.env"

$envExample = Join-Path $SERVER_DIR ".env.example"
$envTarget  = Join-Path $SERVER_DIR ".env"

if (-not (Test-Path $envExample)) {
    Write-Error ".env.example not found at $envExample"
}

if (Test-Path $envTarget) {
    Write-Host "  .env already exists — updating OS-specific path variables only."
    $content = Get-Content $envTarget -Raw
} else {
    Write-Host "  Creating .env from .env.example..."
    $content = Get-Content $envExample -Raw
}

# Patch function: replaces or appends KEY=value in .env content
function Set-EnvValue($content, $key, $value) {
    $escaped = [Regex]::Escape($key)
    if ($content -match "(?m)^${escaped}=") {
        $content = $content -replace "(?m)^${escaped}=.*", "${key}=${value}"
    } else {
        $content = $content.TrimEnd() + "`r`n${key}=${value}`r`n"
    }
    return $content
}

# Apply detected paths
$content = Set-EnvValue $content "SERVER_RUNTIME_OS"  "windows"
$content = Set-EnvValue $content "NODE_EXEC_WINDOWS"  $nodePath
$content = Set-EnvValue $content "PYTHON_EXEC_WINDOWS" $pythonPath
$content = Set-EnvValue $content "PYAV_PYTHON_BIN_WINDOWS" $pythonPath
if ($ffmpegDir -and $ffmpegDir -ne "") {
    $content = Set-EnvValue $content "FFMPEG_BIN_DIR_WINDOWS" $ffmpegDir
}
if ($ytdlpPath -and $ytdlpPath -ne "yt-dlp") {
    $content = Set-EnvValue $content "YTDLP_BIN_WINDOWS" $ytdlpPath
}

$content | Set-Content $envTarget -Encoding UTF8 -NoNewline
Write-Host "  Saved : $envTarget"

# --- Summary -----------------------------------------------------------------
Write-Host ""
Write-Host "================================================================"
Write-Host "  Setup complete"
Write-Host "================================================================"
Write-Host ("  node    : " + $nodePath)
Write-Host ("  python  : " + $pythonPath)
Write-Host ("  ffmpeg  : " + ($ffmpegPath -replace "^$","(not found)"))
Write-Host ("  yt-dlp  : " + ($ytdlpPath -replace "^$","(not found)"))
Write-Host ("  .env    : " + $envTarget)
Write-Host "----------------------------------------------------------------"
Write-Host "  Next steps:"
Write-Host "    cd server"
Write-Host "    npm install"
Write-Host "    npm run download-models:windows"
Write-Host "    npm run start"
Write-Host "================================================================"
Write-Host ""
