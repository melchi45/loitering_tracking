$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Resolve-Path (Join-Path $scriptDir "..\..")
Set-Location $serverDir

$dotenvPath = Join-Path $serverDir ".env"

function Get-DotEnvValue {
  param([string]$Key)
  if (-not (Test-Path $dotenvPath)) { return $null }
  $line = Select-String -Path $dotenvPath -Pattern "^(?:$([Regex]::Escape($Key)))=(.*)$" -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $line) { return $null }
  $value = ($line.Matches[0].Groups[1].Value).Trim()
  return $value
}

function Normalize-PythonBin {
  param([string]$Candidate)
  if (-not $Candidate -or $Candidate.Trim().Length -eq 0) { return $null }
  $c = $Candidate.Trim()

  # If a directory is provided, try common executable names inside it.
  if (Test-Path $c -PathType Container) {
    foreach ($name in @("python.exe", "python3.exe", "py.exe")) {
      $p = Join-Path $c $name
      if (Test-Path $p -PathType Leaf) { return $p }
    }
    return $null
  }

  # If a file path exists, use it directly.
  if (Test-Path $c -PathType Leaf) { return $c }

  # If it's a command in PATH (python / py / python3), keep as-is.
  if (Get-Command $c -ErrorAction SilentlyContinue) { return $c }

  return $null
}

function Resolve-PythonBin {
  foreach ($candidate in @(
    $env:PYTHON_EXEC,
    $env:PYTHON_EXEC_WINDOWS,
    (Get-DotEnvValue "PYTHON_EXEC"),
    (Get-DotEnvValue "PYTHON_EXEC_WINDOWS"),
    $env:PYTHON,
    "python",
    "py"
  )) {
    $resolved = Normalize-PythonBin $candidate
    if ($resolved) { return $resolved }
  }
  return "python"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js not found. Install Node.js first."
  exit 1
}

Write-Host "[LTS] Windows model download started..."
node src/scripts/downloadModels.js
if ($LASTEXITCODE -ne 0) {
  Write-Error "downloadModels.js failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

if ($env:LTS_SKIP_PYTHON_EXPORT -eq "1") {
  Write-Host "[LTS] Skip Python export: LTS_SKIP_PYTHON_EXPORT=1"
  Write-Host "[LTS] Done."
  exit 0
}

$pythonBin = Resolve-PythonBin
if (-not (Get-Command $pythonBin -ErrorAction SilentlyContinue)) {
  Write-Warning "Python not found ($pythonBin). Skipping PPE/Fire/OpenPAR export."
  Write-Host "[LTS] Done."
  exit 0
}

Write-Host "[LTS] Python export started with: $pythonBin"

$tmpPpeScript = Join-Path $env:TEMP "lts_export_ppe.py"
@'
from ultralytics import YOLO
from huggingface_hub import hf_hub_download
import os, shutil

pt = hf_hub_download(
    repo_id="keremberke/yolov8m-protective-equipment-detection",
    filename="best.pt"
)
YOLO(pt).export(format="onnx", imgsz=640, simplify=True)
onnx = pt.replace(".pt", ".onnx")
dest = os.path.join("models", "yolov8m_ppe.onnx")
os.makedirs(os.path.dirname(dest), exist_ok=True)
shutil.copy(onnx, dest)
print("Saved:", dest)
'@ | Set-Content -Path $tmpPpeScript -Encoding UTF8

$tmpFireScript = Join-Path $env:TEMP "lts_export_fire_smoke.py"
@'
from ultralytics import YOLO
from huggingface_hub import hf_hub_download
import os, shutil

pt = hf_hub_download(
    repo_id="Mehedi-2-96/fire-smoke-detection-yolo",
    filename="fire_smoke_yolov8s_model.pt"
)
YOLO(pt).export(format="onnx", imgsz=640, simplify=True)
onnx = pt.replace(".pt", ".onnx")
dest = os.path.join("models", "yolov8s_fire_smoke.onnx")
os.makedirs(os.path.dirname(dest), exist_ok=True)
shutil.copy(onnx, dest)
print("Saved:", dest)
'@ | Set-Content -Path $tmpFireScript -Encoding UTF8

Write-Host "[LTS] Installing Python deps (ultralytics, huggingface_hub, torch, torchvision, onnx)..."
& $pythonBin -m pip install --upgrade ultralytics huggingface_hub torch torchvision onnx

Write-Host "[LTS] Export: yolov8m_ppe.onnx"
& $pythonBin $tmpPpeScript

Write-Host "[LTS] Export: yolov8s_fire_smoke.onnx"
& $pythonBin $tmpFireScript

Write-Host "[LTS] Export: openpar.onnx"
& $pythonBin src/scripts/exportPAR.py

Remove-Item $tmpPpeScript -ErrorAction SilentlyContinue
Remove-Item $tmpFireScript -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[LTS] Optional Python export (Windows)"
Write-Host "  1) pip install ultralytics huggingface_hub"
Write-Host "  2) python src/scripts/exportPAR.py"
Write-Host ""
Write-Host "[LTS] Done."
