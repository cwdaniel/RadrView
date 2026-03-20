#!/usr/bin/env python3
"""GPU 4x upscale using RRDBNet (Real-ESRGAN architecture) with pure PyTorch.
No basicsr or realesrgan pip packages needed — just torch + model weights."""
import sys, os, cv2, numpy as np, torch, torch.nn as nn, torch.nn.functional as F

class ResidualDenseBlock(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
        self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
        self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
        self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
        self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, True)
    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x

class RRDB(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(nf, gc)
        self.rdb2 = ResidualDenseBlock(nf, gc)
        self.rdb3 = ResidualDenseBlock(nf, gc)
    def forward(self, x):
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x

class RRDBNet(nn.Module):
    def __init__(self, in_nc=3, out_nc=3, nf=64, nb=23, gc=32, scale=4):
        super().__init__()
        self.conv_first = nn.Conv2d(in_nc, nf, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(nf, gc) for _ in range(nb)])
        self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_last = nn.Conv2d(nf, out_nc, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, True)
    def forward(self, x):
        feat = self.conv_first(x)
        body = self.conv_body(self.body(feat))
        feat = feat + body
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))

MODEL_PATH = os.environ.get('MODEL_PATH', '/app/models/RealESRGAN_x4plus.pth')
_model = None

def get_model():
    global _model
    if _model is None:
        _model = RRDBNet(in_nc=3, out_nc=3, nf=64, nb=23, gc=32, scale=4)
        state = torch.load(MODEL_PATH, map_location='cuda', weights_only=True)
        _model.load_state_dict(state.get('params_ema', state.get('params', state)), strict=True)
        _model = _model.half().cuda().eval()
    return _model

def upscale(inp, out):
    img = cv2.imread(inp, cv2.IMREAD_UNCHANGED)
    if img is None:
        sys.exit(1)
    has_alpha = img.shape[2] == 4 if len(img.shape) == 3 else False
    alpha = img[:, :, 3] if has_alpha else None
    rgb = cv2.cvtColor(img[:, :, :3] if has_alpha else img, cv2.COLOR_BGR2RGB)
    t = torch.from_numpy(rgb.astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0).half().cuda()
    with torch.no_grad():
        out_t = get_model()(t).squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().float().numpy()
    result = cv2.cvtColor((out_t * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    if alpha is not None:
        h, w = result.shape[:2]
        a = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LANCZOS4)
        result = np.dstack([result, a])
    cv2.imwrite(out, result)

if __name__ == '__main__':
    upscale(sys.argv[1], sys.argv[2])
