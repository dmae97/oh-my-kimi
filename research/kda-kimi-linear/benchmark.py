"""Scaling benchmark — show KDA is O(T) linear while full attention is O(T^2).

Measures forward latency and peak memory for a KDA layer, an MLA layer, and a vanilla causal
full-attention layer, across growing sequence lengths at fixed model width. Linear vs quadratic
growth should be visible in both time and (for full attention) memory.

Run: python3 benchmark.py
"""

from __future__ import annotations

import math
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

from mla import MultiHeadLatentAttention
from modules import KimiDeltaAttention

DEV = "cuda" if torch.cuda.is_available() else "cpu"


class FullAttention(nn.Module):
    """Vanilla causal multi-head attention (O(T^2)), for contrast."""

    def __init__(self, d_model, n_heads):
        super().__init__()
        self.h = n_heads
        self.dh = d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.o = nn.Linear(d_model, d_model, bias=False)

    def forward(self, x):
        B, T, D = x.shape
        q, k, v = self.qkv(x).view(B, T, 3, self.h, self.dh).permute(2, 0, 3, 1, 4)
        o = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.o(o.transpose(1, 2).reshape(B, T, D))


def bench(layer, T, B=4, d_model=512, iters=10, warmup=3):
    x = torch.randn(B, T, d_model, device=DEV)
    layer = layer.to(DEV).eval()
    for _ in range(warmup):
        with torch.no_grad():
            layer(x)
    if DEV == "cuda":
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    for _ in range(iters):
        with torch.no_grad():
            layer(x)
    if DEV == "cuda":
        torch.cuda.synchronize()
    ms = (time.perf_counter() - t0) / iters * 1e3
    mem = torch.cuda.max_memory_allocated() / 1e6 if DEV == "cuda" else 0.0
    return ms, mem


def _loglog_slope(xs, ys):
    """Least-squares exponent p in y ~ T^p (slope of log y vs log T)."""
    n = len(xs)
    lx = [math.log(x) for x in xs]
    ly = [math.log(y) for y in ys]
    mx = sum(lx) / n
    my = sum(ly) / n
    num = sum((a - mx) * (b - my) for a, b in zip(lx, ly))
    den = sum((a - mx) ** 2 for a in lx)
    return num / den if den > 0 else float("nan")


def main():
    d_model, H = 512, 8
    lengths = [128, 256, 512, 1024, 2048, 4096, 8192, 16384]
    fit_from = 1024  # ignore the kernel-launch-bound regime when fitting the exponent
    layers = {
        "KDA (linear)": KimiDeltaAttention(d_model, H, chunk_size=64),
        "MLA (flash)": MultiHeadLatentAttention(d_model, H),
        "FullAttn (O(T^2))": FullAttention(d_model, H),
    }
    print(f"device={DEV}  d_model={d_model}  heads={H}  batch=4\n")
    print(f"{'seq_len':>8} | " + " | ".join(f"{n:>22}" for n in layers))
    print("-" * (11 + 25 * len(layers)))
    prev = {}
    series: dict[str, list[tuple[int, float]]] = {n: [] for n in layers}
    for T in lengths:
        cells = []
        for name, layer in layers.items():
            try:
                ms, mem = bench(layer, T)
                growth = f" x{ms / prev[name]:.1f}" if name in prev else "     "
                prev[name] = ms
                series[name].append((T, ms))
                cells.append(f"{ms:6.1f}ms {mem:5.0f}MB{growth}")
            except RuntimeError as e:
                cells.append(f"OOM/{str(e)[:8]}")
        print(f"{T:>8} | " + " | ".join(f"{c:>22}" for c in cells))

    # Fitted complexity exponent — robust to the per-doubling ratio noise above.
    print(f"\nfitted time ~ T^p  (least squares, T >= {fit_from}):")
    for name, pts in series.items():
        pts = [(t, ms) for t, ms in pts if t >= fit_from]
        if len(pts) >= 3:
            p = _loglog_slope([t for t, _ in pts], [ms for _, ms in pts])
            print(f"  {name:<20} p = {p:.2f}")

    # Crossover: constant factors favour fused SDPA early, asymptotics favour KDA.
    kda = dict(series["KDA (linear)"])
    full = dict(series["FullAttn (O(T^2))"])
    shared = sorted(set(kda) & set(full))
    if shared:
        print("\nKDA vs FullAttn wall-clock ratio (<1.0 = KDA faster):")
        print("  " + "  ".join(f"{t}:{kda[t] / full[t]:.2f}" for t in shared))
        winner = next((t for t in shared if kda[t] < full[t]), None)
        print(
            f"  crossover at T = {winner}"
            if winner
            else "  no crossover in range (pure-PyTorch KDA vs fused flash SDPA)"
        )


if __name__ == "__main__":
    main()
