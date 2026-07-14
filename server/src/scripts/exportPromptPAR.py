#!/usr/bin/env python3
"""
LTS-2026 PromptPAR (PA100k) ONNX Export — automated download + conversion
===========================================================================

Produces server/models/openpar_pa100k.onnx (catalog id 'openpar-pa100k') by:
  1. Cloning Event-AHU/OpenPAR (shallow) to reuse its actual PromptPAR model
     code (CLIP ViT-L backbone + fusion classifier) instead of reimplementing
     it — the architecture is bespoke research code, not something a generic
     "any .pt -> onnx" converter (like ultralytics export) understands.
  2. Downloading the pretrained ViT-B/16 backbone PromptPAR initializes from
     (a stable HuggingFace/rwightman timm release asset).
  3. Downloading the released PA100k PromptPAR checkpoint from the OpenPAR
     authors' Google Drive folder (via `gdown` — plain HTTP can't handle
     Google Drive's virus-scan/confirm-token dance for large files).
  4. Building the model, loading the checkpoint, and exporting a wrapped
     forward pass (image-only input; the 26 PA100k attribute text prompts
     are CLIP-encoded once and baked into the graph as frozen weights,
     since they don't depend on the input image).
  5. Verifying the ONNX output against the PyTorch reference.

Prerequisites (NOT installed by this script — see error messages if missing):
  - A CUDA-capable GPU. OpenPAR's PromptPAR code hardcodes `.cuda()` calls;
    there is no CPU code path in their model construction. This is a one-time
    *export* step — the resulting ONNX still runs fine on CPU at inference
    time in colorClothService.js (forceCpu: true), only the export itself
    needs a GPU.
  - `git` on PATH (to clone the model-code repository).
  - Python packages: torch, torchvision, onnx, onnxruntime, gdown, ftfy, regex
    (`pip install torch torchvision onnx onnxruntime gdown ftfy regex`).
  - Network access to github.com and drive.google.com.

Usage:
  python3 server/src/scripts/exportPromptPAR.py [--output PATH] [--work-dir DIR]
                                                 [--keep-work-dir] [--skip-verify]

Environment variables (all optional, defaults verified against the real
Event-AHU/OpenPAR repository as of 2026-07):
  PROMPTPAR_REPO_URL                  default: https://github.com/Event-AHU/OpenPAR.git
  PROMPTPAR_REPO_REF                  default: main
  PROMPTPAR_GDRIVE_FOLDER_ID          default: 1GkpaMjJjRDDRnLABK08uoNsOsKXN-nD5
                                       (the OpenPAR authors' shared "PromptPAR_ckpt" folder;
                                       contains PA100k_Checkpoint.pth, PETA_Checkpoint.pth, RAP1.pth)
  PROMPTPAR_CHECKPOINT_FILENAME       default: PA100k_Checkpoint.pth
  PROMPTPAR_CHECKPOINT_GDRIVE_FILE_ID default: (empty) — if set, downloads this single file
                                       directly instead of the whole folder (much faster;
                                       set it once you know the individual file's Drive ID)
  PROMPTPAR_VIT_BACKBONE_URL          default: https://github.com/huggingface/pytorch-image-models/
                                       releases/download/v0.1-vitjx/jx_vit_base_p16_224-80ecf9dd.pth
  PROMPTPAR_INSECURE_SSL              default: 0 — set to 1 only if Stage 4's drive.google.com
                                       download fails with "SSLCertVerificationError: self-signed
                                       certificate in certificate chain". That error means a
                                       corporate TLS-inspecting proxy is re-signing HTTPS traffic
                                       with its own root CA, which Python's certifi bundle doesn't
                                       trust — it is not a bug in this script or gdown. The correct
                                       fix is adding that corporate root CA to REQUESTS_CA_BUNDLE;
                                       this flag is the pragmatic escape hatch when that isn't
                                       practical, and only disables verification for the Google
                                       Drive checkpoint download, not the whole process.

Called automatically by POST /api/analysis/models/download { modelId: 'openpar-pa100k' }
via the `pyExport` catalog source strategy in server/src/routes/analysisApi.js — this
script can also be run manually/offline and the resulting file copied into server/models/.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

# ── Argument parsing ──────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument('--output', default=None,
    help='Output ONNX path (default: server/models/openpar_pa100k.onnx relative to project root)')
parser.add_argument('--work-dir', default=None,
    help='Working directory for the repo clone + downloaded checkpoints (default: a temp dir)')
parser.add_argument('--keep-work-dir', action='store_true',
    help='Do not delete the working directory on exit (useful for debugging / re-runs)')
parser.add_argument('--skip-verify', action='store_true',
    help='Skip the PyTorch-vs-ONNX numerical verification step')
args = parser.parse_args()

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
SERVER_ROOT  = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
MODELS_DIR   = os.path.join(SERVER_ROOT, 'models')
OUTPUT_PATH  = os.path.abspath(args.output) if args.output else os.path.join(MODELS_DIR, 'openpar_pa100k.onnx')

REPO_URL              = os.environ.get('PROMPTPAR_REPO_URL', 'https://github.com/Event-AHU/OpenPAR.git')
REPO_REF               = os.environ.get('PROMPTPAR_REPO_REF', 'main')
GDRIVE_FOLDER_ID       = os.environ.get('PROMPTPAR_GDRIVE_FOLDER_ID', '1GkpaMjJjRDDRnLABK08uoNsOsKXN-nD5')
CHECKPOINT_FILENAME    = os.environ.get('PROMPTPAR_CHECKPOINT_FILENAME', 'PA100k_Checkpoint.pth')
CHECKPOINT_FILE_ID     = os.environ.get('PROMPTPAR_CHECKPOINT_GDRIVE_FILE_ID', '').strip()
VIT_BACKBONE_URL       = os.environ.get(
    'PROMPTPAR_VIT_BACKBONE_URL',
    'https://github.com/huggingface/pytorch-image-models/releases/download/'
    'v0.1-vitjx/jx_vit_base_p16_224-80ecf9dd.pth',
)
INSECURE_SSL           = os.environ.get('PROMPTPAR_INSECURE_SSL', '').strip().lower() in ('1', 'true')

TOTAL_STAGES = 7


def stage(n, msg):
    print(f'[PromptPAR Export] Stage {n}/{TOTAL_STAGES}: {msg}', flush=True)


# PA100k's standard 26-attribute order, used verbatim as the CLIP text prompts.
# MUST stay in sync with PA100K_ATTR_WORDS in
# server/src/services/colorClothService.js — index position determines which
# output logit corresponds to which attribute; changing the order here without
# changing it there (or vice versa) silently mislabels every attribute.
PA100K_ATTR_WORDS = [
    'female',
    'age over 60', 'age 18 to 60', 'age less 18',
    'front', 'side', 'back',
    'hat', 'glasses',
    'hand bag', 'shoulder bag', 'backpack', 'hold objects in front',
    'short sleeve', 'long sleeve', 'upper stride', 'upper logo', 'upper plaid', 'upper splice',
    'lower stripe', 'lower pattern', 'long coat', 'trousers', 'shorts', 'skirt and dress', 'boots',
]
assert len(PA100K_ATTR_WORDS) == 26, 'PA100K_ATTR_WORDS must have exactly 26 entries'


def die(msg, hint=None):
    print(f'[PromptPAR Export] ERROR: {msg}', file=sys.stderr)
    if hint:
        print(f'[PromptPAR Export]   -> {hint}', file=sys.stderr)
    sys.exit(1)


# ── Stage 1: dependency checks ─────────────────────────────────────────────────
stage(1, 'checking dependencies (torch, torchvision, onnx, onnxruntime, gdown, git, CUDA)')

try:
    import torch
    import torchvision  # noqa: F401 — imported for side effects some CLIP code relies on
    import onnx
    import onnxruntime
except ImportError as e:
    die(f'missing Python dependency: {e}',
        'pip install torch torchvision onnx onnxruntime gdown ftfy regex')

try:
    import gdown
except ImportError:
    die('missing Python dependency: gdown', 'pip install gdown')

if shutil.which('git') is None:
    die('git not found on PATH', 'install git — required to clone the OpenPAR model-code repository')

if not torch.cuda.is_available():
    die(
        'no CUDA device available',
        "OpenPAR's PromptPAR model construction hardcodes .cuda() calls with no CPU path — "
        'this export step requires a CUDA-capable GPU (a one-time cost; the resulting ONNX '
        'runs fine on CPU at inference time). Run this script on a GPU machine, then copy the '
        f'resulting {os.path.basename(OUTPUT_PATH)} into server/models/ on the target server.'
    )

print(f'[PromptPAR Export] torch={torch.__version__}  onnx={onnx.__version__}  '
      f'cuda={torch.cuda.get_device_name(0)}', flush=True)

work_dir = args.work_dir or tempfile.mkdtemp(prefix='promptpar_export_')
os.makedirs(work_dir, exist_ok=True)
print(f'[PromptPAR Export] Working directory: {work_dir}', flush=True)


def cleanup():
    if not args.keep_work_dir:
        shutil.rmtree(work_dir, ignore_errors=True)


try:
    # ── Stage 2: clone OpenPAR (shallow) for the actual model code ─────────────
    repo_dir = os.path.join(work_dir, 'OpenPAR')
    if not os.path.isdir(repo_dir):
        stage(2, f'cloning {REPO_URL} ({REPO_REF}, shallow)')
        subprocess.run(
            ['git', 'clone', '--depth', '1', '--branch', REPO_REF, REPO_URL, repo_dir],
            check=True, timeout=300,
        )
    else:
        stage(2, 'OpenPAR already cloned in working directory, reusing')

    promptpar_dir = os.path.join(repo_dir, 'PromptPAR')
    if not os.path.isdir(promptpar_dir):
        die(f'expected PromptPAR/ subdirectory not found in cloned repo: {promptpar_dir}',
            'the OpenPAR repository layout may have changed — check '
            'https://github.com/Event-AHU/OpenPAR for the current PromptPAR/ path')
    sys.path.insert(0, promptpar_dir)

    # ── Stage 3: download the pretrained ViT-B/16 backbone PromptPAR initializes from ──
    stage(3, 'downloading ViT-B/16 backbone checkpoint')
    vit_backbone_path = os.path.join(work_dir, 'jx_vit_base_p16_224-80ecf9dd.pth')
    if not os.path.exists(vit_backbone_path):
        torch.hub.download_url_to_file(VIT_BACKBONE_URL, vit_backbone_path)
    print(f'[PromptPAR Export] ViT backbone: {vit_backbone_path}', flush=True)

    # ── Stage 4: get the PA100k PromptPAR checkpoint ────────────────────────────
    stage(4, 'downloading PA100k PromptPAR checkpoint (Google Drive)')
    checkpoint_dir = os.path.join(work_dir, 'checkpoints')
    os.makedirs(checkpoint_dir, exist_ok=True)
    checkpoint_path = os.path.join(checkpoint_dir, CHECKPOINT_FILENAME)

    # Manual-placement escape hatch: if drive.google.com is unreachable at all
    # (corporate firewall blocking the host outright, not just a TLS/cert issue —
    # PROMPTPAR_INSECURE_SSL only helps the latter), let the operator download the
    # checkpoint themselves in a browser and drop it in server/models/ instead of
    # work_dir — work_dir is a fresh temp directory every run, so anything placed
    # there would just be deleted before the operator could reuse it. Checked
    # first, unconditionally, so it also just works as a faster path even without
    # any failure (no network round-trip at all).
    manual_checkpoint_path = os.path.join(MODELS_DIR, CHECKPOINT_FILENAME)
    drive_url = (f'https://drive.google.com/uc?id={CHECKPOINT_FILE_ID}' if CHECKPOINT_FILE_ID
                 else f'https://drive.google.com/drive/folders/{GDRIVE_FOLDER_ID}')

    if os.path.exists(manual_checkpoint_path):
        print(f'[PromptPAR Export] Found manually-placed checkpoint at {manual_checkpoint_path} '
              '— skipping Google Drive download.', flush=True)
        checkpoint_path = manual_checkpoint_path
    elif not os.path.exists(checkpoint_path):
        if INSECURE_SSL:
            print('[PromptPAR Export] PROMPTPAR_INSECURE_SSL=1 — skipping TLS certificate '
                  'verification for the Google Drive download only.', flush=True)

        manual_hint = (
            f'Cannot reach Google Drive from this machine (network/firewall/SSL issue). To proceed manually instead:\n'
            f'  1. Open this URL in a browser (on any machine with internet access): {drive_url}\n'
            f'  2. Download the file named "{CHECKPOINT_FILENAME}"\n'
            f'  3. Copy it to: {manual_checkpoint_path}\n'
            f'  4. Re-run this export — it will detect the file there and skip the download entirely.'
        )

        try:
            if CHECKPOINT_FILE_ID:
                # Fast path: caller supplied the individual file's Drive ID directly.
                gdown.download(id=CHECKPOINT_FILE_ID, output=checkpoint_path, quiet=False, verify=not INSECURE_SSL)
            else:
                # Slow path: the checkpoint is published inside a shared Drive *folder*
                # (drive.google.com/drive/folders/<id>), not as a single direct-download
                # link, so there is no individual file ID to target without either
                # (a) the Google Drive API + credentials, or (b) downloading the whole
                # folder and picking the file out. gdown's folder download handles the
                # confirm-token/virus-scan dance for every file in the folder.
                gdown.download_folder(id=GDRIVE_FOLDER_ID, output=checkpoint_dir, quiet=False,
                                       use_cookies=False, verify=not INSECURE_SSL)
        except Exception as exc:
            if 'CERTIFICATE_VERIFY_FAILED' in str(exc) and not INSECURE_SSL:
                die(
                    f'Google Drive download failed: {exc}',
                    'this is a TLS certificate verification failure, not a bug in this script — '
                    '"self-signed certificate in certificate chain" means a corporate TLS-inspecting '
                    'proxy is re-signing HTTPS traffic with its own root CA that Python\'s certifi '
                    'bundle does not trust. Set PROMPTPAR_INSECURE_SSL=1 to work around it (disables '
                    'verification for this download only), or use the manual path instead:\n' + manual_hint
                )
            die(f'Google Drive download failed: {exc}', manual_hint)

        if not CHECKPOINT_FILE_ID:
            if not os.path.exists(checkpoint_path):
                found = None
                for root, _dirs, files in os.walk(checkpoint_dir):
                    if CHECKPOINT_FILENAME in files:
                        found = os.path.join(root, CHECKPOINT_FILENAME)
                        break
                if not found:
                    die(
                        f'{CHECKPOINT_FILENAME} not found after downloading the shared folder',
                        'the folder contents may have changed — browse '
                        f'{drive_url} manually, grab the PA100k checkpoint\'s file ID from its '
                        'share link, and set PROMPTPAR_CHECKPOINT_GDRIVE_FILE_ID to skip folder '
                        f'enumeration entirely. Or place the file directly at {manual_checkpoint_path}.'
                    )
                checkpoint_path = found
    print(f'[PromptPAR Export] Checkpoint: {checkpoint_path}', flush=True)

    # ── Stage 5: build the model from OpenPAR's own code + load the checkpoint ──
    stage(5, 'building CLIP + PromptPAR classifier and loading checkpoint weights')
    from clip.clip import build_model         # noqa: E402 — path only valid after sys.path insert above
    from models.base_block import TransformerClassifier  # noqa: E402

    checkpoint = torch.load(checkpoint_path, map_location='cpu')
    if 'ViT_model' not in checkpoint or 'model_state_dict' not in checkpoint:
        die(f"checkpoint missing expected keys — found: {list(checkpoint.keys())}",
            "expected 'ViT_model' and 'model_state_dict' — OpenPAR's checkpoint format may have changed")

    clip_model = build_model(checkpoint['ViT_model'])
    model = TransformerClassifier(
        clip_model, attr_num=len(PA100K_ATTR_WORDS), attributes=PA100K_ATTR_WORDS,
        pretrain_path=vit_backbone_path,
    )
    # OpenPAR's checkpoint key names don't exactly match this repo's module names
    # (their `vis_embed.` submodule is named `visual_embed.` here) — remap before load.
    state_dict = {k.replace('vis_embed.', 'visual_embed.'): v
                  for k, v in checkpoint['model_state_dict'].items()}
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    if len(missing) > len(state_dict) // 2:
        die(f'too many missing keys when loading checkpoint ({len(missing)} missing) — '
            'the model code and checkpoint format are likely out of sync')

    model = model.cuda().eval()
    clip_model = clip_model.cuda().eval()

    # ── Stage 6: export ─────────────────────────────────────────────────────────
    stage(6, 'exporting to ONNX (image-only input, text embeddings frozen)')

    class _ExportWrapper(torch.nn.Module):
        """Bakes clip_model + the 26 frozen attribute text embeddings into the
        traced graph so the exported ONNX only exposes an image tensor input —
        matching colorClothService.js's _runPAR(), which passes only `input`."""
        def __init__(self, classifier, clip_model):
            super().__init__()
            self.classifier = classifier
            self.clip_model = clip_model

        def forward(self, imgs):
            bn_logits, _final_similarity = self.classifier(imgs, self.clip_model)
            return bn_logits

    wrapper = _ExportWrapper(model, clip_model).cuda().eval()
    dummy_input = torch.randn(1, 3, 224, 224, device='cuda')

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    tmp_output = OUTPUT_PATH + '.tmp'
    with torch.no_grad():
        torch.onnx.export(
            wrapper, dummy_input, tmp_output,
            input_names=['input'], output_names=['attrs'],
            opset_version=11, dynamic_axes=None,
        )

    # ── Stage 7: verify against the PyTorch reference ──────────────────────────
    if args.skip_verify:
        stage(7, 'skipping verification (--skip-verify)')
    else:
        stage(7, 'verifying ONNX output against PyTorch reference')
        with torch.no_grad():
            torch_out = wrapper(dummy_input).cpu().numpy()
        session = onnxruntime.InferenceSession(tmp_output, providers=['CPUExecutionProvider'])
        onnx_out = session.run(['attrs'], {'input': dummy_input.cpu().numpy()})[0]
        max_abs_diff = float(abs(torch_out - onnx_out).max())
        print(f'[PromptPAR Export] Max abs diff (PyTorch vs ONNX): {max_abs_diff:.2e}', flush=True)
        if max_abs_diff > 1e-2:
            die(f'ONNX output diverges from PyTorch reference (max abs diff {max_abs_diff:.2e} > 1e-2)',
                'the exported graph is likely wrong — do not ship this file')

    if os.path.exists(OUTPUT_PATH):
        os.remove(OUTPUT_PATH)
    os.rename(tmp_output, OUTPUT_PATH)

    size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    print(f'[PromptPAR Export] Done: {OUTPUT_PATH} ({size_mb:.0f} MB)', flush=True)

finally:
    cleanup()
