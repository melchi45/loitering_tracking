#!/usr/bin/env python3
"""
LTS-2026 PAR (Pedestrian Attribute Recognition) ONNX Model Export
===================================================================

Creates openpar.onnx using a ResNet50 backbone (ImageNet pretrained)
with a multi-label attribute head for cloth type classification.

Attributes (12 cloth-related labels):
  Upper body  : tshirt / shirt / jacket / hoodie / vest / dress
  Lower body  : pants  / jeans / shorts / skirt
  Sleeve      : short / long

Usage:
  python3 server/src/scripts/exportPAR.py [--output server/models/openpar.onnx]
"""

import sys
import os
import argparse

# ── Argument parsing ──────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument(
    '--output', default=None,
    help='Output ONNX path (default: server/models/openpar.onnx relative to project root)')
args = parser.parse_args()

# Resolve output path relative to project root
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..', '..', '..'))
SERVER_ROOT  = os.path.abspath(os.path.join(SCRIPT_DIR, '..', '..'))
MODELS_DIR   = os.path.join(SERVER_ROOT, 'models')
OUTPUT_PATH  = args.output or os.path.join(MODELS_DIR, 'openpar.onnx')

os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

print('[PAR Export] LTS-2026 Pedestrian Attribute Recognition — ONNX export')
print(f'[PAR Export] Output: {OUTPUT_PATH}')

# ── Imports ───────────────────────────────────────────────────────────────────
try:
    import torch
    import torch.nn as nn
    import torchvision.models as tv_models
    import onnx
    print(f'[PAR Export] torch={torch.__version__}  onnx={onnx.__version__}')
except ImportError as e:
    print(f'[PAR Export] Missing dependency: {e}')
    print('  pip3 install torch torchvision onnx')
    sys.exit(1)

# ── SSL 인증서 검증 우회 (사설망 / 자체 서명 인증서 환경) ─────────────────────
import ssl
import urllib.request
ssl._create_default_https_context = ssl._create_unverified_context

# ── Attribute labels (12 cloth-related attributes) ────────────────────────────
# Ordered: upper×6, lower×4, sleeve×2
ATTR_LABELS = [
    # Upper body clothing type  (index 0–5)
    'upper_tshirt',    # T-shirt / polo shirt
    'upper_shirt',     # formal / dress shirt
    'upper_jacket',    # jacket / blazer / coat
    'upper_hoodie',    # hoodie / sweatshirt
    'upper_vest',      # vest / sleeveless
    'upper_dress',     # dress (visible upper portion)
    # Lower body clothing type  (index 6–9)
    'lower_pants',     # full-length trousers
    'lower_jeans',     # denim jeans
    'lower_shorts',    # shorts (above knee)
    'lower_skirt',     # skirt / dress skirt
    # Sleeve length              (index 10–11)
    'sleeve_short',    # short / no sleeve
    'sleeve_long',     # long sleeve
]
NUM_ATTRS = len(ATTR_LABELS)   # 12

# ── Model definition ──────────────────────────────────────────────────────────
class PARModel(nn.Module):
    """
    ResNet50 backbone + multi-label sigmoid head for cloth attribute recognition.

    Input : [B, 3, 256, 128]  — person crop, normalized (ImageNet mean/std)
    Output: [B, 12]           — per-attribute probability (0–1)
    """
    def __init__(self, num_attrs: int = NUM_ATTRS):
        super().__init__()
        # Backbone: ResNet50 without FC layer
        backbone = tv_models.resnet50(pretrained=True)
        self.backbone = nn.Sequential(*list(backbone.children())[:-1])  # → [B, 2048, 1, 1]
        # Attribute classification head
        self.head = nn.Sequential(
            nn.Dropout(0.5),
            nn.Linear(2048, 512),
            nn.ReLU(inplace=True),
            nn.Linear(512, num_attrs),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feat = self.backbone(x)          # [B, 2048, 1, 1]
        feat = feat.flatten(1)           # [B, 2048]
        return self.head(feat)           # [B, num_attrs]

# ── Build & export ────────────────────────────────────────────────────────────
print('[PAR Export] Building ResNet50-PAR model (ImageNet pretrained backbone)…')
model = PARModel()
model.eval()

# Dummy input: batch=1, RGB, H=256, W=128
dummy = torch.randn(1, 3, 256, 128)

# Verify forward pass
with torch.no_grad():
    out = model(dummy)
print(f'[PAR Export] Forward pass OK — output shape: {tuple(out.shape)}  ({NUM_ATTRS} attributes)')

# ONNX export
print(f'[PAR Export] Exporting to ONNX (opset 12)…')
torch.onnx.export(
    model,
    dummy,
    OUTPUT_PATH,
    input_names=['input'],
    output_names=['attrs'],
    opset_version=12,
    dynamic_axes={
        'input': {0: 'batch'},
        'attrs': {0: 'batch'},
    },
    do_constant_folding=True,
)

# Validate
model_onnx = onnx.load(OUTPUT_PATH)
onnx.checker.check_model(model_onnx)
size_mb = os.path.getsize(OUTPUT_PATH) / 1_048_576
print(f'[PAR Export] ✓ openpar.onnx saved — {size_mb:.1f} MB')

# Write attribute label file so JS can load them without hardcoding
LABELS_PATH = os.path.join(MODELS_DIR, 'openpar_labels.json')
import json
with open(LABELS_PATH, 'w') as f:
    json.dump({'labels': ATTR_LABELS, 'input': [1, 3, 256, 128]}, f, indent=2)
print(f'[PAR Export] ✓ openpar_labels.json saved')

print()
print('[PAR Export] ── Attribute index map ────────────────────────────────')
for i, label in enumerate(ATTR_LABELS):
    print(f'  [{i:2d}] {label}')
print()
print('[PAR Export] ── Next steps ──────────────────────────────────────────')
print('  The backbone uses ImageNet pretrained weights.')
print('  For best accuracy, fine-tune on a PAR dataset (PA-100K / RAPv2 / PETA).')
print('  Reference: https://github.com/Event-AHU/OpenPAR')
print('[PAR Export] Done.')
