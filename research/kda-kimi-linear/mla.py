"""Multi-head Latent Attention (MLA) + Kimi Linear hybrid stack (KDA:MLA = 3:1).

MLA (DeepSeek-V2 style, used as Kimi Linear's periodic full-attention layer) compresses K/V
into a low-rank latent that is the only thing cached — this is the up-to-75% KV-cache reduction
the paper reports. A decoupled RoPE branch carries positional information.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from modules import RMSNorm


def rope(x, cos, sin):  # x [B,H,T,D], cos/sin [1,1,T,D] (rotate_half)
    x1, x2 = x.chunk(2, dim=-1)
    rot = torch.cat([-x2, x1], dim=-1)
    return x * cos + rot * sin


class Rotary(nn.Module):
    def __init__(self, dim, base=10000.0):
        super().__init__()
        self.dim = dim
        self.base = base

    def forward(self, T, device, dtype):
        inv = 1.0 / (
            self.base
            ** (
                torch.arange(0, self.dim, 2, device=device, dtype=torch.float32)
                / self.dim
            )
        )
        t = torch.arange(T, device=device, dtype=torch.float32)
        f = torch.outer(t, inv)
        emb = torch.cat([f, f], dim=-1)
        return emb.cos().to(dtype)[None, None], emb.sin().to(dtype)[None, None]


class MultiHeadLatentAttention(nn.Module):
    def __init__(
        self, d_model, n_heads, d_head=None, kv_rank=None, q_rank=None, rope_dim=None
    ):
        super().__init__()
        self.h = n_heads
        self.dh = d_head or (d_model // n_heads)
        self.rope_dim = rope_dim or (self.dh // 2)
        self.nope = self.dh - self.rope_dim
        self.kv_rank = kv_rank or (2 * self.dh)
        self.q_rank = q_rank or (3 * self.dh)
        # queries: low-rank down/up + a decoupled rope query
        self.q_down = nn.Linear(d_model, self.q_rank, bias=False)
        self.q_norm = RMSNorm(self.q_rank)
        self.q_up = nn.Linear(
            self.q_rank, self.h * self.dh, bias=False
        )  # nope+rope split
        # keys/values: shared latent (cached) + a shared decoupled rope key
        self.kv_down = nn.Linear(d_model, self.kv_rank + self.rope_dim, bias=False)
        self.kv_norm = RMSNorm(self.kv_rank)
        self.kv_up = nn.Linear(
            self.kv_rank, self.h * (self.nope + self.dh), bias=False
        )  # k_nope + v
        self.rot = Rotary(self.rope_dim)
        self.o = nn.Linear(self.h * self.dh, d_model, bias=False)

    def forward(self, x):
        B, T, _ = x.shape
        H, dh, nope, rd = self.h, self.dh, self.nope, self.rope_dim
        q = self.q_up(self.q_norm(self.q_down(x))).view(B, T, H, dh).transpose(1, 2)
        q_nope, q_rope = q.split([nope, rd], dim=-1)
        kv_c, k_rope = self.kv_down(x).split([self.kv_rank, rd], dim=-1)
        kv = self.kv_up(self.kv_norm(kv_c)).view(B, T, H, nope + dh).transpose(1, 2)
        k_nope, v = kv.split([nope, dh], dim=-1)
        k_rope = k_rope.view(B, T, 1, rd).transpose(1, 2)  # shared across heads
        cos, sin = self.rot(T, x.device, x.dtype)
        q_rope = rope(q_rope, cos, sin)
        k_rope = rope(k_rope, cos, sin).expand(B, H, T, rd)
        q = torch.cat([q_nope, q_rope], dim=-1)
        k = torch.cat([k_nope, k_rope], dim=-1)
        o = F.scaled_dot_product_attention(q, k, v, is_causal=True)  # [B,H,T,dh]
        return self.o(o.transpose(1, 2).reshape(B, T, H * dh))

    def kv_cache_bytes_per_token(self, dtype_bytes=2):
        """Latent-only cache: (kv_rank + rope_dim) vs a full MHA cache of 2*H*dh."""
        return (self.kv_rank + self.rope_dim) * dtype_bytes
