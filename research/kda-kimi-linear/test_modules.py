"""Smoke + property tests for the KDA/MLA/hybrid modules (shapes, causality, KV-cache win)."""
from __future__ import annotations

import torch

from hybrid import KimiLinear
from mla import MultiHeadLatentAttention
from modules import KimiDeltaAttention


def test_kda_layer_forward_and_causal():
    torch.manual_seed(0)
    m = KimiDeltaAttention(d_model=64, n_heads=4, chunk_size=16).eval()
    x = torch.randn(2, 40, 64)
    with torch.no_grad():
        y, S = m(x)
        assert y.shape == x.shape and S.shape[0] == 2
        x2 = x.clone(); x2[:, 25:] += torch.randn_like(x2[:, 25:])
        y2, _ = m(x2)
    past = (y[:, :25] - y2[:, :25]).abs().max().item()
    assert past < 1e-5, f"KDA layer not causal: {past}"
    print(f"  KDA layer: out {tuple(y.shape)}  causal past Δ={past:.2e}  OK")


def test_mla_forward_and_kv_cache():
    torch.manual_seed(0)
    d_model, H, dh = 64, 4, 16
    m = MultiHeadLatentAttention(d_model, H, d_head=dh).eval()
    x = torch.randn(2, 32, d_model)
    with torch.no_grad():
        y = m(x)
    assert y.shape == x.shape
    latent = m.kv_cache_bytes_per_token()
    full = 2 * H * dh * 2                     # full MHA K+V cache, fp16
    print(f"  MLA: out {tuple(y.shape)}  latent cache {latent}B/tok vs full {full}B/tok "
          f"(−{100 * (1 - latent / full):.0f}%)  OK")
    assert latent < full


def test_hybrid_layout_and_forward():
    torch.manual_seed(0)
    model = KimiLinear(vocab=256, d_model=128, n_layers=8, n_heads=4, ratio=3).eval()
    assert model.layout == ["kda", "kda", "kda", "mla"] * 2, model.layout
    ids = torch.randint(0, 256, (2, 48))
    with torch.no_grad():
        logits = model(ids)
    assert logits.shape == (2, 48, 256)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"  hybrid layout {model.layout}")
    print(f"  logits {tuple(logits.shape)}  params {n_params / 1e6:.2f}M  OK")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(f"{name}:")
            fn()
    print("\nALL MODULE TESTS PASSED ✓")
