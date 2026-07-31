"""Kimi Linear hybrid stack: KDA and MLA layers interleaved at a 3:1 ratio (paper §default),
with pre-norm residuals and a SwiGLU MLP. This is the drop-in "expressive + efficient" block.
"""

from __future__ import annotations

import torch.nn as nn
import torch.nn.functional as F

from modules import KimiDeltaAttention, RMSNorm
from mla import MultiHeadLatentAttention


class SwiGLU(nn.Module):
    def __init__(self, d, mult=4):
        super().__init__()
        h = d * mult  # mult is an int multiplier
        self.w1 = nn.Linear(d, h, bias=False)
        self.w2 = nn.Linear(d, h, bias=False)
        self.w3 = nn.Linear(h, d, bias=False)

    def forward(self, x):
        return self.w3(F.silu(self.w1(x)) * self.w2(x))


class Block(nn.Module):
    def __init__(self, d_model, n_heads, kind, **kw):
        super().__init__()
        self.kind = kind
        self.n1 = RMSNorm(d_model)
        self.mix = (
            KimiDeltaAttention(d_model, n_heads, **kw)
            if kind == "kda"
            else MultiHeadLatentAttention(d_model, n_heads, **kw)
        )
        self.n2 = RMSNorm(d_model)
        self.mlp = SwiGLU(d_model)

    def forward(self, x):
        y = self.mix(self.n1(x))
        x = x + (y[0] if isinstance(y, tuple) else y)  # KDA returns (out, state)
        return x + self.mlp(self.n2(x))


class KimiLinear(nn.Module):
    """Layerwise hybrid. `ratio`=3 means 3 KDA layers per 1 MLA layer (Kimi Linear default)."""

    def __init__(self, vocab, d_model=256, n_layers=8, n_heads=4, ratio=3, **kw):
        super().__init__()
        self.emb = nn.Embedding(vocab, d_model)
        layers = []
        for i in range(n_layers):
            kind = "mla" if (i % (ratio + 1) == ratio) else "kda"
            layers.append(Block(d_model, n_heads, kind))
        self.layers = nn.ModuleList(layers)
        self.norm = RMSNorm(d_model)
        self.head = nn.Linear(d_model, vocab, bias=False)
        self.head.weight = self.emb.weight  # tie
        nn.init.normal_(
            self.emb.weight, std=0.02
        )  # transformer-standard; avoids huge init logits
        self.layout = [b.kind for b in self.layers]

    def forward(self, ids):
        x = self.emb(ids)
        for b in self.layers:
            x = b(x)
        return self.head(self.norm(x))
