#!/usr/bin/env bash
# ============================================================================
#  LTS-2026  Environment Setup — Linux / macOS
#
#  Usage:
#    cd loitering_tracking
#    bash server/src/scripts/setup-env.linux.sh
#
#  What it does:
#    1. Detects Node.js, Python 3, FFmpeg in PATH.
#    2. If any tool is missing, installs it via the system package manager
#       (apt-get on Debian/Ubuntu, dnf on RHEL/Fedora, brew on macOS).
#    3. Resolves the concrete binary paths after install.
#    4. Copies .env.example → .env (if .env does not already exist).
#    5. Patches OS-specific path variables in the generated .env.
# ============================================================================
set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         LTS-2026  Environment Setup  (Linux / macOS)        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Server dir  : ${SERVER_DIR}"
echo ""

# ── Helper: detect OS / package manager ──────────────────────────────────────
detect_pkg_manager() {
    if command -v apt-get >/dev/null 2>&1; then echo "apt"
    elif command -v dnf    >/dev/null 2>&1; then echo "dnf"
    elif command -v yum    >/dev/null 2>&1; then echo "yum"
    elif command -v pacman >/dev/null 2>&1; then echo "pacman"
    elif command -v brew   >/dev/null 2>&1; then echo "brew"
    else echo "unknown"; fi
}

PKG_MGR="$(detect_pkg_manager)"

install_pkg() {
    local label="$1"; shift   # friendly name
    local packages=("$@")
    echo "  [Install] $label via ${PKG_MGR}..."
    case "${PKG_MGR}" in
        apt)    sudo apt-get install -y --no-install-recommends "${packages[@]}" ;;
        dnf)    sudo dnf install -y "${packages[@]}" ;;
        yum)    sudo yum install -y "${packages[@]}" ;;
        pacman) sudo pacman -S --noconfirm "${packages[@]}" ;;
        brew)   brew install "${packages[@]}" ;;
        *)
            echo "  [WARN] Unknown package manager — skipping auto-install for $label." >&2
            echo "  [WARN] Install manually: ${packages[*]}" >&2
            return 1
            ;;
    esac
}

# ── Helper: patch (or append) a KEY=value line in a file ─────────────────────
set_env_value() {
    local file="$1" key="$2" value="$3"
    if grep -qE "^${key}=" "${file}" 2>/dev/null; then
        # BSD sed (macOS) needs '' after -i
        if sed --version >/dev/null 2>&1; then
            sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
        else
            sed -i '' "s|^${key}=.*|${key}=${value}|" "${file}"
        fi
    else
        echo "${key}=${value}" >> "${file}"
    fi
}

# ── 1. Node.js ────────────────────────────────────────────────────────────────
echo "── [1/3] Node.js ─────────────────────────────────────────────"
NODE_PATH=""
if command -v node >/dev/null 2>&1; then
    NODE_PATH="$(command -v node)"
else
    echo "  Node.js not found. Attempting install..."
    case "${PKG_MGR}" in
        apt)
            # Use NodeSource 20.x LTS
            if command -v curl >/dev/null 2>&1; then
                curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null || true
            fi
            install_pkg "Node.js 20 LTS" nodejs || true
            ;;
        dnf|yum)
            if command -v curl >/dev/null 2>&1; then
                curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null || true
            fi
            install_pkg "Node.js 20 LTS" nodejs || true
            ;;
        brew)
            install_pkg "Node.js LTS" node@20 || true
            brew link --overwrite node@20 >/dev/null 2>&1 || true
            ;;
        *)
            install_pkg "Node.js" nodejs || true
            ;;
    esac
    command -v node >/dev/null 2>&1 && NODE_PATH="$(command -v node)"
fi
if [[ -z "${NODE_PATH}" ]]; then
    echo "  [ERROR] Node.js could not be installed automatically." >&2
    echo "  Visit https://nodejs.org/ — install Node.js 18+ LTS, then re-run." >&2
    exit 1
fi
NODE_VERSION="$(node -v 2>&1)"
echo "  OK  node   : ${NODE_PATH}  (${NODE_VERSION})"

# ── 2. Python ─────────────────────────────────────────────────────────────────
echo ""
echo "── [2/3] Python ──────────────────────────────────────────────"
PYTHON_PATH=""
PYTHON_EXE=""
for candidate in python3 python python3.12 python3.11 python3.10; do
    if command -v "${candidate}" >/dev/null 2>&1; then
        ver="$(${candidate} --version 2>&1)"
        if echo "${ver}" | grep -qE "Python 3\."; then
            PYTHON_PATH="$(command -v ${candidate})"
            PYTHON_EXE="${candidate}"
            PYTHON_VERSION="${ver}"
            break
        fi
    fi
done
if [[ -z "${PYTHON_PATH}" ]]; then
    echo "  Python 3 not found. Attempting install..."
    case "${PKG_MGR}" in
        apt)    install_pkg "Python 3" python3 python3-pip || true ;;
        dnf|yum)install_pkg "Python 3" python3 python3-pip || true ;;
        pacman) install_pkg "Python 3" python python-pip   || true ;;
        brew)   install_pkg "Python 3" python              || true ;;
        *)      echo "  [WARN] Cannot auto-install Python." >&2 ;;
    esac
    for candidate in python3 python; do
        if command -v "${candidate}" >/dev/null 2>&1; then
            ver="$(${candidate} --version 2>&1)"
            if echo "${ver}" | grep -qE "Python 3\."; then
                PYTHON_PATH="$(command -v ${candidate})"
                PYTHON_EXE="${candidate}"
                PYTHON_VERSION="${ver}"
                break
            fi
        fi
    done
fi
if [[ -z "${PYTHON_PATH}" ]]; then
    echo "  [WARN] Python 3 could not be installed automatically." >&2
    echo "  Visit https://www.python.org/ — install Python 3.12, then re-run." >&2
    PYTHON_PATH="/usr/bin/python3"
    PYTHON_EXE="python3"
    PYTHON_VERSION="(not detected)"
fi
echo "  OK  python : ${PYTHON_PATH}  (${PYTHON_VERSION})"

# ── 3. FFmpeg ─────────────────────────────────────────────────────────────────
echo ""
echo "── [3/3] FFmpeg ──────────────────────────────────────────────"
FFMPEG_PATH=""
if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_PATH="$(command -v ffmpeg)"
else
    echo "  FFmpeg not found. Attempting install..."
    case "${PKG_MGR}" in
        apt)    install_pkg "FFmpeg" ffmpeg || true ;;
        dnf)    install_pkg "FFmpeg" ffmpeg || true ;;
        yum)    install_pkg "FFmpeg" ffmpeg || true ;;
        pacman) install_pkg "FFmpeg" ffmpeg || true ;;
        brew)   install_pkg "FFmpeg" ffmpeg || true ;;
        *)      echo "  [WARN] Cannot auto-install FFmpeg." >&2 ;;
    esac
    command -v ffmpeg >/dev/null 2>&1 && FFMPEG_PATH="$(command -v ffmpeg)"
fi
if [[ -z "${FFMPEG_PATH}" ]]; then
    echo "  [WARN] FFmpeg could not be installed automatically." >&2
    echo "  Install manually: sudo apt install ffmpeg  (or brew install ffmpeg)" >&2
    FFMPEG_PATH="ffmpeg"
    FFMPEG_VERSION="(not detected)"
else
    FFMPEG_DIR="$(dirname "${FFMPEG_PATH}")"
    FFMPEG_VERSION="$(ffmpeg -version 2>&1 | head -1)"
fi
echo "  OK  ffmpeg : ${FFMPEG_PATH}  (${FFMPEG_VERSION:-})"

# -- 4. yt-dlp ----------------------------------------------------------------
echo ""
echo "-- [4/5] yt-dlp ---------------------------------------------"
YTDLP_PATH=""
if command -v yt-dlp >/dev/null 2>&1; then
    YTDLP_PATH="$(command -v yt-dlp)"
else
    echo "  yt-dlp not found. Attempting install..."
    # Prefer pip install (works everywhere), fall back to binary download
    if [[ -n "${PYTHON_PATH}" ]] && command -v pip3 >/dev/null 2>&1; then
        pip3 install -q --upgrade yt-dlp 2>/dev/null || true
    elif [[ -n "${PYTHON_PATH}" ]]; then
        "${PYTHON_EXE}" -m pip install -q --upgrade yt-dlp 2>/dev/null || true
    fi
    # Try system package manager as fallback
    if ! command -v yt-dlp >/dev/null 2>&1; then
        case "${PKG_MGR}" in
            apt)    sudo apt-get install -y yt-dlp 2>/dev/null || true ;;
            dnf)    sudo dnf install -y yt-dlp 2>/dev/null || true ;;
            yum)    sudo yum install -y yt-dlp 2>/dev/null || true ;;
            pacman) sudo pacman -S --noconfirm yt-dlp 2>/dev/null || true ;;
            brew)   brew install yt-dlp 2>/dev/null || true ;;
            *) true ;;
        esac
    fi
    # Final fallback: download standalone binary from GitHub
    if ! command -v yt-dlp >/dev/null 2>&1; then
        echo "  Downloading yt-dlp standalone binary..."
        YT_BIN_DIR="${HOME}/.local/bin"
        mkdir -p "${YT_BIN_DIR}"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
                -o "${YT_BIN_DIR}/yt-dlp" && chmod +x "${YT_BIN_DIR}/yt-dlp" || true
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${YT_BIN_DIR}/yt-dlp" \
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" && \
                chmod +x "${YT_BIN_DIR}/yt-dlp" || true
        fi
        export PATH="${YT_BIN_DIR}:${PATH}"
    fi
    command -v yt-dlp >/dev/null 2>&1 && YTDLP_PATH="$(command -v yt-dlp)"
fi
if [[ -z "${YTDLP_PATH}" ]]; then
    echo "  [WARN] yt-dlp could not be installed automatically." >&2
    echo "  Install manually: pip install yt-dlp  or  see https://github.com/yt-dlp/yt-dlp" >&2
    YTDLP_PATH="yt-dlp"
    YTDLP_VERSION="(not detected)"
else
    YTDLP_VERSION="$(yt-dlp --version 2>&1 | head -1)"
fi
echo "  OK  yt-dlp : ${YTDLP_PATH}  (${YTDLP_VERSION})"

# -- 5. Generate .env ---------------------------------------------------------
echo ""
echo "-- [5/5] Generating server/.env -----------------------------"

ENV_EXAMPLE="${SERVER_DIR}/.env.example"
ENV_TARGET="${SERVER_DIR}/.env"

if [[ ! -f "${ENV_EXAMPLE}" ]]; then
    echo "[ERROR] .env.example not found at ${ENV_EXAMPLE}" >&2
    exit 1
fi

if [[ -f "${ENV_TARGET}" ]]; then
    echo "  .env already exists — updating OS-specific path variables only."
else
    echo "  Creating .env from .env.example..."
    cp "${ENV_EXAMPLE}" "${ENV_TARGET}"
fi

# Apply detected paths
set_env_value "${ENV_TARGET}" "SERVER_RUNTIME_OS"     "linux"
set_env_value "${ENV_TARGET}" "NODE_EXEC_LINUX"       "${NODE_PATH}"
set_env_value "${ENV_TARGET}" "PYTHON_EXEC_LINUX"     "${PYTHON_PATH}"
set_env_value "${ENV_TARGET}" "PYAV_PYTHON_BIN_LINUX" "${PYTHON_PATH}"
if [[ -n "${FFMPEG_DIR:-}" ]]; then
    set_env_value "${ENV_TARGET}" "FFMPEG_BIN_DIR_LINUX" "${FFMPEG_DIR}"
fi
if [[ -n "${YTDLP_PATH}" && "${YTDLP_PATH}" != "yt-dlp" ]]; then
    set_env_value "${ENV_TARGET}" "YTDLP_BIN_LINUX" "${YTDLP_PATH}"
fi

echo "  Saved : ${ENV_TARGET}"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Setup complete                                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf  "║  node    : %-50s║\n" "${NODE_PATH}"
printf  "║  python  : %-50s║\n" "${PYTHON_PATH}"
printf  "║  ffmpeg  : %-50s║\n" "${FFMPEG_PATH:-"(not found)"}"
printf  "║  yt-dlp  : %-50s║\n" "${YTDLP_PATH:-"(not found)"}"
printf  "║  .env    : %-50s║\n" "${ENV_TARGET}"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Next steps:                                                 ║"
echo "║    cd server                                                 ║"
echo "║    npm install                                               ║"
echo "║    npm run download-models:linux                             ║"
echo "║    npm run start                                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
