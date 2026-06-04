#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "${SERVER_DIR}"

resolve_python_bin() {
  if [[ -n "${PYTHON_EXEC:-}" ]]; then
    echo "${PYTHON_EXEC}"
    return
  fi
  if [[ -n "${PYTHON_EXEC_LINUX:-}" ]]; then
    echo "${PYTHON_EXEC_LINUX}"
    return
  fi
  if [[ -n "${PYTHON:-}" ]]; then
    echo "${PYTHON}"
    return
  fi
  echo "python3"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js first." >&2
  exit 1
fi

echo "[LTS] Linux model download started..."
node src/scripts/downloadModels.js

if [[ "${LTS_SKIP_PYTHON_EXPORT:-0}" == "1" ]]; then
  echo "[LTS] Skip Python export: LTS_SKIP_PYTHON_EXPORT=1"
  echo "[LTS] Done."
  exit 0
fi

PYTHON_BIN="$(resolve_python_bin)"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "Python not found (${PYTHON_BIN}). Skipping PPE/Fire/OpenPAR export." >&2
  echo "[LTS] Done."
  exit 0
fi

echo "[LTS] Python export started with: ${PYTHON_BIN}"
TMP_PPE_SCRIPT="$(mktemp)"
TMP_FIRE_SCRIPT="$(mktemp)"
trap 'rm -f "${TMP_PPE_SCRIPT}" "${TMP_FIRE_SCRIPT}"' EXIT

cat > "${TMP_PPE_SCRIPT}" << 'PYEOF'
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
PYEOF

cat > "${TMP_FIRE_SCRIPT}" << 'PYEOF'
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
PYEOF

echo "[LTS] Installing Python deps (ultralytics, huggingface_hub, torch, torchvision, onnx)..."
"${PYTHON_BIN}" -m pip install --upgrade ultralytics huggingface_hub torch torchvision onnx

echo "[LTS] Export: yolov8m_ppe.onnx"
"${PYTHON_BIN}" "${TMP_PPE_SCRIPT}"

echo "[LTS] Export: yolov8s_fire_smoke.onnx"
"${PYTHON_BIN}" "${TMP_FIRE_SCRIPT}"

echo "[LTS] Export: openpar.onnx"
"${PYTHON_BIN}" src/scripts/exportPAR.py

echo
echo "[LTS] Optional Python export (Linux)"
echo "  1) pip3 install ultralytics huggingface_hub"
echo "  2) python3 src/scripts/exportPAR.py"
echo
echo "[LTS] Done."
