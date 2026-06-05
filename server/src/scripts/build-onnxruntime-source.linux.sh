#!/usr/bin/env bash
set -euo pipefail

# Build ONNX Runtime from source with CUDA on Linux and wire local onnxruntime-node
# into this server project without changing package.json.

ORT_REPO_DIR="${ORT_REPO_DIR:-$HOME/source/onnxruntime}"
ORT_REF="${ORT_REF:-v1.26.0}"
CUDA_HOME="${CUDA_HOME:-/usr/local/cuda-13.3}"
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

echo ""
echo "================================================================"
echo "   ONNX Runtime Source Build + Local onnxruntime-node Link"
echo "================================================================"
echo "  ServerDir : ${SERVER_DIR}"
echo "  OrtRepo   : ${ORT_REPO_DIR}"
echo "  OrtRef    : ${ORT_REF}"
echo "  CUDA_HOME : ${CUDA_HOME}"
echo "  CUDNN_HOME: ${CUDNN_HOME}"
echo ""

require_cmd git
require_cmd python3
require_cmd cmake
require_cmd node
require_cmd npm

[[ -d "${CUDA_HOME}" ]] || { echo "[ERROR] CUDA_HOME does not exist: ${CUDA_HOME}" >&2; exit 1; }
if [[ -n "${CUDNN_HOME}" && ! -d "${CUDNN_HOME}" ]]; then
    echo "[ERROR] CUDNN_HOME does not exist: ${CUDNN_HOME}" >&2
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
echo "  npm --prefix ${SERVER_DIR} run restart"
echo ""
