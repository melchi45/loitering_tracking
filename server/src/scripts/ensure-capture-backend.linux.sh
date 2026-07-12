#!/usr/bin/env bash
# Ensure CAPTURE_BACKEND runtime prerequisites on Linux/macOS.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SERVER_DIR}/.env"
BACKEND="${1:-}"

get_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || { echo ""; return 0; }
  grep -E "^${key}=" "$file" | head -n1 | sed -E "s/^${key}=//" || true
}

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo "apt"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf"
  elif command -v yum >/dev/null 2>&1; then echo "yum"
  elif command -v pacman >/dev/null 2>&1; then echo "pacman"
  elif command -v brew >/dev/null 2>&1; then echo "brew"
  else echo "unknown"; fi
}

PKG_MGR="$(detect_pkg_manager)"

install_pkg() {
  local label="$1"; shift
  local pkgs=("$@")
  echo "  [Install] ${label} via ${PKG_MGR}..."
  case "${PKG_MGR}" in
    apt) sudo apt-get update -y; sudo apt-get install -y --no-install-recommends "${pkgs[@]}" ;;
    dnf) sudo dnf install -y "${pkgs[@]}" ;;
    yum) sudo yum install -y "${pkgs[@]}" ;;
    pacman) sudo pacman -Sy --noconfirm "${pkgs[@]}" ;;
    brew) brew install "${pkgs[@]}" ;;
    *)
      echo "  [WARN] unknown package manager; install manually: ${pkgs[*]}" >&2
      return 1
      ;;
  esac
}

resolve_backend() {
  if [[ -n "${BACKEND}" ]]; then
    echo "${BACKEND,,}"
    return 0
  fi
  local from_env
  from_env="$(get_env_value "${ENV_FILE}" "CAPTURE_BACKEND")"
  if [[ -n "${from_env}" ]]; then
    echo "${from_env,,}"
    return 0
  fi
  echo "ffmpeg"
}

resolve_python_bin() {
  # OS-specific keys take priority over the generic ones — server/.env commonly sets
  # both a Windows-oriented generic value and a _LINUX override for cross-platform use.
  local candidates=(
    "$(get_env_value "${ENV_FILE}" "PYAV_PYTHON_BIN_LINUX")"
    "$(get_env_value "${ENV_FILE}" "PYAV_PYTHON_BIN")"
    "$(get_env_value "${ENV_FILE}" "PYTHON_EXEC_LINUX")"
    "$(get_env_value "${ENV_FILE}" "PYTHON_EXEC")"
    "${PYTHON:-}"
    "python3"
    "python"
  )

  local c
  for c in "${candidates[@]}"; do
    [[ -n "${c}" ]] || continue
    if [[ -x "${c}" ]]; then
      echo "${c}"
      return 0
    fi
    if command -v "${c}" >/dev/null 2>&1; then
      command -v "${c}"
      return 0
    fi
  done
  echo ""
}

ensure_ffmpeg() {
  echo "-- Checking ffmpeg backend prerequisites"
  if ! command -v ffmpeg >/dev/null 2>&1; then
    case "${PKG_MGR}" in
      apt|dnf|yum|pacman|brew) install_pkg "FFmpeg" ffmpeg || true ;;
      *) true ;;
    esac
  fi

  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ffmpeg is still missing. Install manually and retry." >&2
    exit 1
  fi
  echo "  OK ffmpeg: $(command -v ffmpeg)"
}

ensure_gstreamer() {
  echo "-- Checking gstreamer backend prerequisites"
  local ok=1
  command -v gst-launch-1.0 >/dev/null 2>&1 || ok=0
  command -v gst-inspect-1.0 >/dev/null 2>&1 || ok=0

  if [[ "${ok}" -eq 0 ]]; then
    case "${PKG_MGR}" in
      apt)
        install_pkg "GStreamer" gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad || true
        ;;
      dnf|yum)
        install_pkg "GStreamer" gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free || true
        ;;
      pacman)
        install_pkg "GStreamer" gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav || true
        ;;
      brew)
        install_pkg "GStreamer" gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad || true
        ;;
      *) true ;;
    esac
  fi

  if ! command -v gst-launch-1.0 >/dev/null 2>&1 || ! command -v gst-inspect-1.0 >/dev/null 2>&1; then
    echo ""
    echo "ERROR: GStreamer tools (gst-launch-1.0 / gst-inspect-1.0) not found."
    echo ""
    echo "Install GStreamer using your package manager:"
    echo ""
    echo "  Ubuntu/Debian:"
    echo "    sudo apt-get install gstreamer1.0-tools gstreamer1.0-plugins-base"
    echo "    sudo apt-get install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad"
    echo ""
    echo "  Fedora/RHEL:"
    echo "    sudo dnf install gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good"
    echo "    sudo dnf install gstreamer1-plugins-bad-free gstreamer1-plugins-ugly-free"
    echo ""
    echo "  Arch:"
    echo "    sudo pacman -Sy gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav"
    echo ""
    echo "  macOS:"
    echo "    brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad"
    echo ""
    echo "After installation, re-run this script."
    echo ""
    echo "Alternatively, switch to a simpler backend:"
    echo "  1. Edit server/.env"
    echo "  2. Change: CAPTURE_BACKEND=ffmpeg   (or CAPTURE_BACKEND=pyav)"
    echo "  3. Re-run: bash server/src/scripts/ensure-capture-backend.linux.sh"
    echo ""
    exit 1
  fi

  echo "  OK gst-launch-1.0: $(command -v gst-launch-1.0)"
  echo "  OK gst-inspect-1.0: $(command -v gst-inspect-1.0)"
}

ensure_pyav() {
  echo "-- Checking pyav backend prerequisites"
  local py
  py="$(resolve_python_bin)"

  if [[ -z "${py}" ]]; then
    case "${PKG_MGR}" in
      apt) install_pkg "Python 3" python3 python3-pip || true ;;
      dnf|yum) install_pkg "Python 3" python3 python3-pip || true ;;
      pacman) install_pkg "Python 3" python python-pip || true ;;
      brew) install_pkg "Python 3" python || true ;;
      *) true ;;
    esac
    py="$(resolve_python_bin)"
  fi

  if [[ -z "${py}" ]]; then
    echo "python3 is missing. Install Python and retry." >&2
    exit 1
  fi

  echo "  Python: ${py}"
  if ! "${py}" -c "import av, PIL, numpy; print('ok')" >/dev/null 2>&1; then
    echo "  PyAV/Pillow/numpy missing. Installing via pip..."
    if command -v pip3 >/dev/null 2>&1; then
      pip3 install --upgrade pip
      pip3 install av Pillow numpy
    else
      "${py}" -m pip install --upgrade pip
      "${py}" -m pip install av Pillow numpy
    fi
  fi

  if ! "${py}" -c "import av, PIL, numpy; print('ok')" >/dev/null 2>&1; then
    echo "Failed to import av/PIL/numpy after installation." >&2
    exit 1
  fi

  echo "  OK python deps: av, Pillow, numpy"
}

echo ""
echo "================================================================"
echo "  Ensure Capture Backend Prerequisites (Linux/macOS)"
echo "================================================================"
echo "  server/.env : ${ENV_FILE}"

SELECTED="$(resolve_backend)"
echo "  CAPTURE_BACKEND: ${SELECTED}"

case "${SELECTED}" in
  ffmpeg) ensure_ffmpeg ;;
  gstreamer) ensure_gstreamer ;;
  pyav) ensure_pyav ;;
  ingest-daemon) ensure_pyav ;;
  *)
    echo "Unsupported CAPTURE_BACKEND: ${SELECTED} (allowed: ffmpeg, gstreamer, pyav, ingest-daemon)" >&2
    exit 1
    ;;
esac

echo ""
echo "Done. Backend prerequisites are satisfied for: ${SELECTED}"
