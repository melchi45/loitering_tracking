#!/usr/bin/env bash
# shellcheck disable=SC2155
set -euo pipefail

# Build ONNX Runtime from source with CUDA on Linux and wire local onnxruntime-node
# into this server project without changing package.json.
#
# 직접 실행:
#   bash server/src/scripts/build-onnxruntime-source.linux.sh
#
# 환경변수로 제어:
#   ORT_REF, ORT_REPO_DIR, CUDA_HOME, CUDNN_HOME, CUDA_ARCH
#   SKIP_CLONE, SKIP_BUILD, SKIP_NODE_PACKAGE_BUILD, SKIP_PROJECT_INSTALL
#
# 자동 실행기 (권장 — CUDA/cuDNN 경로 자동 감지):
#   npm run build-ort:auto

ORT_REPO_DIR="${ORT_REPO_DIR:-$HOME/source/onnxruntime}"
ORT_REF="${ORT_REF:-v1.26.0}"
# CUDA_HOME: 빈 문자열이면 아래 resolve_cuda_home() 이 자동 감지
CUDA_HOME="${CUDA_HOME:-}"
CUDNN_HOME="${CUDNN_HOME:-}"
CUDA_ARCH="${CUDA_ARCH:-}"

SKIP_CLONE="${SKIP_CLONE:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_NODE_PACKAGE_BUILD="${SKIP_NODE_PACKAGE_BUILD:-0}"
SKIP_PROJECT_INSTALL="${SKIP_PROJECT_INSTALL:-0}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "[ERROR] Required command not found: $1" >&2
        exit 1
    }
}

# ── CUDA_HOME 자동 감지 ──────────────────────────────────────────────────────

resolve_cuda_home() {
    local requested="$1"

    # 명시적으로 지정된 경우
    if [[ -n "${requested}" ]]; then
        if [[ -d "${requested}" ]]; then
            echo "${requested}"
            return
        fi
        echo "[ERROR] CUDA_HOME 경로가 존재하지 않습니다: ${requested}" >&2
        exit 1
    fi

    # 1) 환경변수 CUDA_PATH (nvcc 경로 → 상위 디렉토리)
    if command -v nvcc >/dev/null 2>&1; then
        local nvcc_path
        nvcc_path="$(command -v nvcc)"
        # readlink -f 로 symlink 해소
        nvcc_path="$(readlink -f "${nvcc_path}" 2>/dev/null || echo "${nvcc_path}")"
        local cuda_dir
        cuda_dir="$(dirname "$(dirname "${nvcc_path}")")"
        if [[ -d "${cuda_dir}" ]]; then
            echo "[CUDA] nvcc 에서 자동 감지: ${cuda_dir}" >&2
            echo "${cuda_dir}"
            return
        fi
    fi

    # 2) 버전별 표준 경로 스캔 (최신 버전 우선)
    local CUDA_VERSIONS=(
        12.9 12.8 12.7 12.6 12.5 12.4 12.3 12.2 12.1 12.0
        11.8 11.7 11.6
    )
    for ver in "${CUDA_VERSIONS[@]}"; do
        local try_path="/usr/local/cuda-${ver}"
        if [[ -d "${try_path}" && -f "${try_path}/bin/nvcc" ]]; then
            echo "[CUDA] 자동 감지 (버전별 스캔): ${try_path}" >&2
            echo "${try_path}"
            return
        fi
    done

    # 3) /usr/local/cuda symlink (버전 무관)
    if [[ -d "/usr/local/cuda" && -f "/usr/local/cuda/bin/nvcc" ]]; then
        echo "[CUDA] 자동 감지 (/usr/local/cuda): $(readlink -f /usr/local/cuda 2>/dev/null || echo /usr/local/cuda)" >&2
        echo "/usr/local/cuda"
        return
    fi

    echo "[ERROR] CUDA Toolkit 을 찾을 수 없습니다." >&2
    echo "        설치: https://developer.nvidia.com/cuda-downloads" >&2
    echo "        또는 CUDA_HOME 환경변수로 경로를 지정하세요." >&2
    exit 1
}

# ── CUDNN_HOME 자동 감지 ─────────────────────────────────────────────────────

resolve_cudnn_home() {
    local requested="$1"
    local cuda_home="$2"

    if [[ -n "${requested}" ]]; then
        if [[ -d "${requested}" ]]; then
            echo "${requested}"
            return
        fi
        echo "[ERROR] CUDNN_HOME 경로가 존재하지 않습니다: ${requested}" >&2
        exit 1
    fi

    # 1) CUDA 경로 안에 cuDNN 있는지 확인 (zip 설치 방식)
    local so_names=("libcudnn.so.9" "libcudnn_ops.so.9" "libcudnn.so.8" "libcudnn.so")
    for so in "${so_names[@]}"; do
        if [[ -f "${cuda_home}/lib64/${so}" ]]; then
            echo "[cuDNN] CUDA_HOME 안에서 감지 (zip 방식): ${cuda_home}" >&2
            echo "${cuda_home}"
            return
        fi
    done

    # 2) ldconfig 에서 탐색
    if command -v ldconfig >/dev/null 2>&1; then
        local ldout
        ldout="$(ldconfig -p 2>/dev/null | grep -E 'libcudnn\.so\.(9|8)' | head -1 || true)"
        if [[ -n "${ldout}" ]]; then
            local lib_path
            lib_path="$(echo "${ldout}" | awk -F'=>' '{print $2}' | tr -d ' ')"
            if [[ -f "${lib_path}" ]]; then
                local cudnn_dir
                cudnn_dir="$(dirname "$(dirname "${lib_path}")")"  # /usr/local/cuda-12.x
                echo "[cuDNN] ldconfig 에서 감지: ${cudnn_dir}" >&2
                echo "${cudnn_dir}"
                return
            fi
        fi
    fi

    # 3) 시스템 경로에 있으면 빌드 스크립트가 자동으로 탐색
    local sys_paths=(
        "/usr/lib/x86_64-linux-gnu/libcudnn.so.9"
        "/usr/lib/x86_64-linux-gnu/libcudnn.so.8"
        "/usr/lib/aarch64-linux-gnu/libcudnn.so.9"
        "/usr/lib/aarch64-linux-gnu/libcudnn.so.8"
    )
    for p in "${sys_paths[@]}"; do
        if [[ -f "${p}" ]]; then
            echo "[cuDNN] 시스템 경로 감지 — CUDNN_HOME 생략 (ORT 자동 탐색)" >&2
            echo ""
            return
        fi
    done

    echo "[cuDNN] 미감지 — CUDNN_HOME 없이 빌드합니다" >&2
    echo ""
}

# ── GPU Compute Capability 감지 ──────────────────────────────────────────────

detect_cuda_arch() {
    if command -v nvidia-smi >/dev/null 2>&1; then
        local cap
        cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' \r')"
        if [[ -n "${cap}" ]]; then
            # "8.9" → "89"
            echo "${cap//./}"
            return
        fi
    fi
    echo ""
}

# ── 경로 해석 ────────────────────────────────────────────────────────────────

CUDA_HOME="$(resolve_cuda_home "${CUDA_HOME}")"
CUDNN_HOME="$(resolve_cudnn_home "${CUDNN_HOME}" "${CUDA_HOME}")"

if [[ -z "${CUDA_ARCH}" ]]; then
    CUDA_ARCH="$(detect_cuda_arch)"
    if [[ -n "${CUDA_ARCH}" ]]; then
        echo "[CUDA] GPU compute capability 자동 감지: sm_${CUDA_ARCH}"
    fi
fi

echo ""
echo "================================================================"
echo "   ONNX Runtime Source Build + Local onnxruntime-node Link"
echo "================================================================"
echo "  ServerDir : ${SERVER_DIR}"
echo "  OrtRepo   : ${ORT_REPO_DIR}"
echo "  OrtRef    : ${ORT_REF}"
echo "  CUDA_HOME : ${CUDA_HOME}"
echo "  CUDNN_HOME: ${CUDNN_HOME:-(CUDA_HOME 에서 자동 탐색)}"
echo "  CUDA_ARCH : ${CUDA_ARCH:-(CMake 자동 결정)}"
echo ""

require_cmd git
require_cmd python3
require_cmd cmake
require_cmd node
require_cmd npm

[[ -d "${CUDA_HOME}" ]] || { echo "[ERROR] CUDA_HOME 이 존재하지 않습니다: ${CUDA_HOME}" >&2; exit 1; }
if [[ -n "${CUDNN_HOME}" && ! -d "${CUDNN_HOME}" ]]; then
    echo "[ERROR] CUDNN_HOME 이 존재하지 않습니다: ${CUDNN_HOME}" >&2
    exit 1
fi

if [[ "${SKIP_CLONE}" != "1" ]]; then
    if [[ ! -d "${ORT_REPO_DIR}" ]]; then
        mkdir -p "$(dirname "${ORT_REPO_DIR}")"
        echo "[1/4] Cloning onnxruntime..."
        git clone --recursive https://github.com/microsoft/onnxruntime "${ORT_REPO_DIR}"
    fi

    pushd "${ORT_REPO_DIR}" >/dev/null
    echo "[1/4] Fetching and checking out ${ORT_REF}..."
    git fetch --tags --prune
    git checkout "${ORT_REF}"
    git submodule sync --recursive
    git submodule update --init --recursive
    popd >/dev/null
fi

if [[ "${SKIP_BUILD}" != "1" ]]; then
    BUILD_ARGS=(
        --config Release
        --build_shared_lib
        --use_cuda
        --cuda_home "${CUDA_HOME}"
        --cmake_extra_defines onnxruntime_USE_FLASH_ATTENTION=OFF
    )

    if [[ -n "${CUDNN_HOME}" ]]; then
        BUILD_ARGS+=(--cudnn_home "${CUDNN_HOME}")
    fi

    if [[ -n "${CUDA_ARCH}" ]]; then
        BUILD_ARGS+=(--cmake_extra_defines "CMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH}")
    fi

    echo "[2/4] Building native ONNX Runtime (this can take a long time)..."
    pushd "${ORT_REPO_DIR}" >/dev/null
    ./build.sh "${BUILD_ARGS[@]}"
    popd >/dev/null
fi

if [[ "${SKIP_NODE_PACKAGE_BUILD}" != "1" ]]; then
    NODE_PKG_DIR="${ORT_REPO_DIR}/js/node"
    [[ -d "${NODE_PKG_DIR}" ]] || { echo "[ERROR] Missing dir: ${NODE_PKG_DIR}" >&2; exit 1; }

    echo "[3/4] Building js/node package..."
    pushd "${NODE_PKG_DIR}" >/dev/null
    npm install
    popd >/dev/null
fi

if [[ "${SKIP_PROJECT_INSTALL}" != "1" ]]; then
    NODE_PKG_DIR="${ORT_REPO_DIR}/js/node"

    echo "[4/4] Installing local onnxruntime-node into server project (--no-save)..."
    npm --prefix "${SERVER_DIR}" uninstall onnxruntime-node || true
    npm --prefix "${SERVER_DIR}" install "${NODE_PKG_DIR}" --no-save
fi

echo ""
echo "Done. Verify with:"
echo "  npm --prefix ${SERVER_DIR} run check:gpu"
echo "  npm --prefix ${SERVER_DIR} run restart"
echo ""
