"""KDA as an nn.Module + short-conv + gates, ready to drop into a Transformer block.

Follows Kimi Linear (arXiv:2510.26692): per-head q/k/v, L2-normalized keys (delta rule),
a per-channel forget gate alpha = exp(-softplus(.)) in (0,1), a scalar delta rate
beta = sigmoid(.), a short depthwise causal conv for local mixing, and an output RMSNorm gate.
The recurrence is computed by the validated chunk-parallel kernel `kda_chunk`.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

from kda import kda_chunk


class RMSNorm(nn.Module):
    def __init__(self, d, eps=1e-6):
        super().__init__()
        self.w = nn.Parameter(torch.ones(d))
        self.eps = eps

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.w


class ShortConv(nn.Module):
    """Depthwise causal 1D conv over time (local token mixing), kernel K."""

    def __init__(self, d, k=4):
        super().__init__()
        self.k = k
        self.conv = nn.Conv1d(d, d, k, groups=d, padding=0, bias=True)

    def forward(self, x):  # [B,T,D]
        B, T, D = x.shape
        xt = x.transpose(1, 2)  # [B,D,T]
        xt = F.pad(xt, (self.k - 1, 0))  # left pad -> causal
        return F.silu(self.conv(xt)).transpose(1, 2)


class KimiDeltaAttention(nn.Module):
    def __init__(
        self, d_model, n_heads, d_head=None, conv_size=4, chunk_size=64, gate_bias=-3.5
    ):
        super().__init__()
        self.h = n_heads
        self.dh = d_head or (d_model // n_heads)
        self.inner = self.h * self.dh
        self.chunk = chunk_size
        self.q = nn.Linear(d_model, self.inner, bias=False)
        self.k = nn.Linear(d_model, self.inner, bias=False)
        self.v = nn.Linear(d_model, self.inner, bias=False)
        self.a = nn.Linear(
            d_model, self.inner, bias=True
        )  # per-channel forget-gate logits
        self.b = nn.Linear(d_model, self.h, bias=True)  # delta rate (per head)
        self.qc, self.kc, self.vc = (ShortConv(self.inner, conv_size) for _ in range(3))
        self.g = nn.Linear(d_model, self.inner, bias=False)  # output gate
        self.onorm = RMSNorm(self.dh)
        self.o = nn.Linear(self.inner, d_model, bias=False)
        # alpha = exp(-softplus(bias+proj)); bias=-3.5 -> alpha≈0.97 (long memory, chunk-stable).
        # Small weight init so the gate is bias-driven at init, avoiding tiny-alpha underflow in k/a.
        nn.init.constant_(self.a.bias, gate_bias)
        nn.init.normal_(self.a.weight, std=1e-3)

    def _heads(self, x):  # [B,T,inner]->[B,h,T,dh]
        B, T, _ = x.shape
        return x.view(B, T, self.h, self.dh).transpose(1, 2)

    def forward(self, x, state=None):
        B, T, _ = x.shape
        q = self._heads(self.qc(self.q(x)))
        k = self._heads(self.kc(self.k(x)))
        v = self._heads(self.vc(self.v(x)))
        k = F.normalize(k, dim=-1)  # unit keys (delta rule)
        alpha = torch.exp(
            -F.softplus(self._heads(self.a(x)))
        )  # per-channel gate in (0,1)
        beta = torch.sigmoid(self.b(x)).transpose(1, 2)  # [B,h,T]
        o, S = kda_chunk(q, k, v, alpha, beta, S0=state, chunk_size=self.chunk)
        o = self.onorm(o).transpose(1, 2).reshape(B, T, self.inner)
        o = o * F.silu(self.g(x))  # output gating
        return self.o(o), S
