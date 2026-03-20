#!/usr/bin/env python3
"""GPU upscale a single tile using Real-ESRGAN with PyTorch CUDA."""
import sys
import torch
from realesrgan import RealESRGANer
from basicsr.archs.rrdbnet_arch import RRDBNet
from PIL import Image
import numpy as np

def upscale(input_path: str, output_path: str, scale: int = 4):
    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=scale)
    upsampler = RealESRGANer(
        scale=scale,
        model_path=None,  # Uses default weights
        dni_weight=None,
        model=model,
        tile=0,
        tile_pad=10,
        pre_pad=0,
        half=True,  # FP16 for speed on RTX
        gpu_id=0,
    )

    img = Image.open(input_path).convert('RGBA')
    # Split alpha channel
    rgb = np.array(img.convert('RGB'))
    alpha = np.array(img.split()[-1])

    # Upscale RGB
    output, _ = upsampler.enhance(rgb, outscale=scale)

    # Upscale alpha with simple resize
    alpha_pil = Image.fromarray(alpha).resize((output.shape[1], output.shape[0]), Image.LANCZOS)
    alpha_up = np.array(alpha_pil)

    # Combine
    result = Image.fromarray(output)
    result.putalpha(Image.fromarray(alpha_up))
    result.save(output_path)

if __name__ == '__main__':
    upscale(sys.argv[1], sys.argv[2])
