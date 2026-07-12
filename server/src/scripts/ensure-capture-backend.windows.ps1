#Requires -Version 5.1
<#
.SYNOPSIS
  Ensure CAPTURE_BACKEND runtime prerequisites on Windows.

.DESCRIPTION
  - Reads CAPTURE_BACKEND from server/.env (unless -Backend is provided).
  - Valid values: ffmpeg, gstreamer, pyav, ingest-daemon (ingest-daemon shares pyav's prerequisites).
  - Checks required executable/dependencies and attempts install when missing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File src/scripts/ensure-capture-backend.windows.ps1
  powershell -ExecutionPolicy Bypass -File src/scripts/ensure-capture-backend.windows.ps1 -Backend pyav
#>

param(
    [string]$Backend = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$EnvFile = Join-Path $ServerDir ".env"

function Update-SessionPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Find-CommandPath([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-EnvValue([string]$filePath, [string]$key) {
    if (-not (Test-Path $filePath -PathType Leaf)) { return "" }
    $line = Get-Content $filePath | Where-Object { $_ -match "^$([regex]::Escape($key))=" } | Select-Object -First 1
    if (-not $line) { return "" }
    return ($line -replace "^$([regex]::Escape($key))=", "").Trim()
}

function Install-Via-Winget([string]$id, [string]$label) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Warning "winget is not available. Install $label manually."
        return $false
    }
    Write-Host "  [Install] $label ($id)"
    winget install "$id" --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        Write-Warning "winget returned exit code $LASTEXITCODE for $label"
    }
    Update-SessionPath
    return $true
}

function Resolve-Backend {
    if ($Backend -and $Backend.Trim()) {
        return $Backend.Trim().ToLowerInvariant()
    }

    $fromEnv = Get-EnvValue $EnvFile "CAPTURE_BACKEND"
    if ($fromEnv -and $fromEnv.Trim()) {
        return $fromEnv.Trim().ToLowerInvariant()
    }

    return "ffmpeg"
}

function Resolve-PythonBin {
    # OS-specific keys take priority over the generic ones — server/.env commonly sets
    # both a Linux-oriented generic value and a _WINDOWS override for cross-platform use.
    $candidates = @(
        (Get-EnvValue $EnvFile "PYAV_PYTHON_BIN_WINDOWS"),
        (Get-EnvValue $EnvFile "PYAV_PYTHON_BIN"),
        (Get-EnvValue $EnvFile "PYTHON_EXEC_WINDOWS"),
        (Get-EnvValue $EnvFile "PYTHON_EXEC"),
        $env:PYTHON,
        "python"
    )

    foreach ($c in $candidates) {
        if (-not $c) { continue }
        $v = $c.Trim()
        if (-not $v) { continue }

        if (Test-Path $v -PathType Leaf) {
            return (Resolve-Path $v).Path
        }

        $resolved = Find-CommandPath $v
        if ($resolved) { return $resolved }
    }

    return ""
}

function Install-Via-Chocolatey([string]$package, [string]$label) {
    if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
        return $false
    }
    Write-Host "  [Install] $label via Chocolatey ($package)"
    choco install "$package" -y 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Chocolatey install failed for $label"
        return $false
    }
    Update-SessionPath
    return $true
}

function Install-Via-Scoop([string]$package, [string]$label) {
    if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) {
        return $false
    }
    Write-Host "  [Install] $label via Scoop ($package)"
    scoop install "$package" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Scoop install failed for $label"
        return $false
    }
    return $true
}

function Ensure-Ffmpeg {
    Write-Host "-- Checking ffmpeg backend prerequisites"
    $ffmpegPath = Find-CommandPath "ffmpeg"
    if (-not $ffmpegPath) {
        Write-Host "  ffmpeg not found. Attempting install..."
        Install-Via-Winget "Gyan.FFmpeg" "FFmpeg" | Out-Null
        $ffmpegPath = Find-CommandPath "ffmpeg"
    }
    if (-not $ffmpegPath) {
        throw "ffmpeg is still missing. Install manually and retry."
    }
    Write-Host "  OK ffmpeg: $ffmpegPath"
}

function Ensure-Gstreamer {
    Write-Host "-- Checking gstreamer backend prerequisites"
    $gstLaunch = Find-CommandPath "gst-launch-1.0"
    $gstInspect = Find-CommandPath "gst-inspect-1.0"

    if (-not $gstLaunch -or -not $gstInspect) {
        Write-Host "  gstreamer tools not found. Attempting install..."
        
        # Try winget first
        $success = Install-Via-Winget "GStreamer.GStreamer" "GStreamer"
        if ($success) {
            $gstLaunch = Find-CommandPath "gst-launch-1.0"
            $gstInspect = Find-CommandPath "gst-inspect-1.0"
        }

        # Try Chocolatey if winget failed
        if (-not $gstLaunch -or -not $gstInspect) {
            Write-Host "  Winget failed or unavailable. Trying Chocolatey..."
            $success = Install-Via-Chocolatey "gstreamer" "GStreamer"
            if ($success) {
                $gstLaunch = Find-CommandPath "gst-launch-1.0"
                $gstInspect = Find-CommandPath "gst-inspect-1.0"
            }
        }

        # Try Scoop if both failed
        if (-not $gstLaunch -or -not $gstInspect) {
            Write-Host "  Chocolatey failed or unavailable. Trying Scoop..."
            $success = Install-Via-Scoop "gstreamer" "GStreamer"
            if ($success) {
                $gstLaunch = Find-CommandPath "gst-launch-1.0"
                $gstInspect = Find-CommandPath "gst-inspect-1.0"
            }
        }
    }

    if (-not $gstLaunch -or -not $gstInspect) {
        Write-Host ""
        Write-Host "ERROR: GStreamer installation failed via all automated methods."
        Write-Host ""
        Write-Host "Install GStreamer manually using one of the following methods:"
        Write-Host ""
        Write-Host "  Option 1: Chocolatey (simplest)"
        Write-Host "    choco install gstreamer -y"
        Write-Host ""
        Write-Host "  Option 2: Scoop"
        Write-Host "    scoop install gstreamer"
        Write-Host ""
        Write-Host "  Option 3: Direct binary download (recommended)"
        Write-Host "    1. Visit: https://gstreamer.freedesktop.org/download/#windows"
        Write-Host "    2. Download: GStreamer 1.24.x (MSVC installer) for Windows"
        Write-Host "    3. Run installer with default settings"
        Write-Host "    4. Verify: gst-launch-1.0 --version"
        Write-Host ""
        Write-Host "  Option 4: vcpkg (requires Visual Studio)"
        Write-Host "    vcpkg install gstreamer:x64-windows"
        Write-Host ""
        Write-Host "After manual installation, re-run this script."
        Write-Host ""
        Write-Host "Alternatively, switch to a simpler backend:"
        Write-Host "  1. Edit server/.env"
        Write-Host "  2. Change: CAPTURE_BACKEND=ffmpeg   (or CAPTURE_BACKEND=pyav)"
        Write-Host "  3. Re-run: npm run check-capture-backend:windows"
        Write-Host ""
        throw "GStreamer is required for CAPTURE_BACKEND=gstreamer. Install manually or switch backend."
    }

    Write-Host "  OK gst-launch-1.0: $gstLaunch"
    Write-Host "  OK gst-inspect-1.0: $gstInspect"
}

function Ensure-Pyav {
    Write-Host "-- Checking pyav backend prerequisites"

    $pythonBin = Resolve-PythonBin
    if (-not $pythonBin) {
        Write-Host "  Python not found. Attempting install..."
        Install-Via-Winget "Python.Python.3.12" "Python 3.12" | Out-Null
        $pythonBin = Resolve-PythonBin
    }

    if (-not $pythonBin) {
        throw "Python 3 is missing. Install Python and retry."
    }

    Write-Host "  Python: $pythonBin"

    # These probes are expected to fail (non-zero exit + stderr) when deps are missing.
    # Under $ErrorActionPreference = "Stop", a native command's stderr output is promoted
    # to a terminating error even when we only care about $LASTEXITCODE — wrap in try/catch
    # so the expected failure doesn't abort the whole script.
    try { & $pythonBin -c "import av, PIL, numpy; print('ok')" 2>$null | Out-Null } catch {}
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  PyAV/Pillow/numpy missing. Installing via pip..."
        & $pythonBin -m pip install --upgrade pip
        & $pythonBin -m pip install av Pillow numpy
        try { & $pythonBin -c "import av, PIL, numpy; print('ok')" 2>$null | Out-Null } catch {}
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to import av/PIL/numpy after installation. Check Python environment and retry."
        }
    }

    Write-Host "  OK python deps: av, Pillow, numpy"
}

Write-Host ""
Write-Host "================================================================"
Write-Host "  Ensure Capture Backend Prerequisites (Windows)"
Write-Host "================================================================"
Write-Host "  server/.env : $EnvFile"

$selected = Resolve-Backend
Write-Host "  CAPTURE_BACKEND: $selected"

switch ($selected) {
    "ffmpeg" { Ensure-Ffmpeg }
    "gstreamer" { Ensure-Gstreamer }
    "pyav" { Ensure-Pyav }
    "ingest-daemon" { Ensure-Pyav }
    default { throw "Unsupported CAPTURE_BACKEND: $selected (allowed: ffmpeg, gstreamer, pyav, ingest-daemon)" }
}

Write-Host ""
Write-Host "Done. Backend prerequisites are satisfied for: $selected"
