"""Kimi Delta Attention (KDA) — faithful implementation grounded in Kimi Linear (arXiv:2510.26692).

Exact recurrence (paper Eq. 1), state S_t in R^{d_k x d_v}:

    S_t = (I - beta_t k_t k_t^T) Diag(alpha_t) S_{t-1} + beta_t k_t v_t^T
    o_t = S_t^T q_t

where alpha_t in (0,1)^{d_k} is the FINE-GRAINED (per-channel) forget gate that distinguishes
KDA from Gated DeltaNet's scalar gate, and beta_t in (0,~2) is the delta write rate.

This module provides:
  * kda_recurrent : the exact O(T) reference (ground truth for correctness).
  * kda_chunk     : a chunk-parallel form derived from Eq. 1 (WY/UT transform + cumulative
                    diagonal gating). Validated numerically equal to kda_recurrent.

Derivation (chunk of length C, start-state S0):  let a_t = prod_{j<=t} alpha_j (per channel),
k_hat = k / a, k_bar = k * a, q_bar = q * a.  Writing u_t = v_t - S_{t-1}^T Diag(alpha_t) k_t
gives  S_t = Diag(a_t)[S0 + sum_{i<=t} beta_i k_hat_i u_i^T]  and the intra-chunk value system
    (I + strict_tril(M)) U = V - K_bar S0 ,   M[i,l] = beta_l (k_bar_i . k_hat_l),
    o_t = q_bar_t^T S0 + sum_{i<=t} beta_i (q_bar_t . k_hat_i) u_i .
"""
from __future__ import annotations

import torch
import torch.nn.functional as F


def kda_recurrent(q, k, v, alpha, beta, S0=None):
    """Exact KDA recurrence (paper Eq. 1). Ground-truth reference.

    Shapes: q,k,alpha [B,H,T,dk]; v [B,H,T,dv]; beta [B,H,T]; S0 [B,H,dk,dv] or None.
    Returns: o [B,H,T,dv], S_final [B,H,dk,dv].
    """
    B, H, T, dk = k.shape
    dv = v.shape[-1]
    S = torch.zeros(B, H, dk, dv, dtype=v.dtype, device=v.device) if S0 is None else S0.clone()
    out = torch.empty(B, H, T, dv, dtype=v.dtype, device=v.device)
    for t in range(T):
        a_t = alpha[:, :, t, :]                      # [B,H,dk]
        k_t = k[:, :, t, :]                          # [B,H,dk]
        q_t = q[:, :, t, :]                          # [B,H,dk]
        b_t = beta[:, :, t].unsqueeze(-1)            # [B,H,1]
        DS = a_t.unsqueeze(-1) * S                   # Diag(alpha_t) S_{t-1}  [B,H,dk,dv]
        # u_t = v_t - (DS)^T k_t
        u = v[:, :, t, :] - (k_t.unsqueeze(-1) * DS).sum(dim=2)          # [B,H,dv]
        # S_t = DS + beta_t k_t u_t^T
        S = DS + b_t.unsqueeze(-1) * (k_t.unsqueeze(-1) * u.unsqueeze(2))
        # o_t = S_t^T q_t
        out[:, :, t, :] = (q_t.unsqueeze(-1) * S).sum(dim=2)
    return out, S


def _pad_chunks(x, C, dim, value=0.0):
    # Pad the time dim up to a multiple of C. Padded tokens must be a no-op in the recurrence:
    # alpha->1 (no decay) and beta->0 (no write), so the carried state is unaffected.
    T = x.shape[dim]
    rem = (-T) % C
    if rem:
        pad = [0, 0] * (x.dim())
        pad[2 * (x.dim() - 1 - dim) + 1] = rem
        x = F.pad(x, pad, value=value)
    return x, rem


def kda_chunk(q, k, v, alpha, beta, S0=None, chunk_size=64, eps=1e-12):
    """Chunk-parallel KDA, numerically equal to kda_recurrent (see module docstring derivation).

    Same signature as kda_recurrent. Sequential over chunks only; O(C^2) work is parallel.
    """
    B, H, T, dk = k.shape
    dv = v.shape[-1]
    C = chunk_size
    q, _ = _pad_chunks(q, C, 2)
    k, _ = _pad_chunks(k, C, 2)
    v, _ = _pad_chunks(v, C, 2)
    alpha, _ = _pad_chunks(alpha, C, 2, value=1.0)    # no decay on padded tokens
    beta, _ = _pad_chunks(beta.unsqueeze(-1), C, 2)   # no write (value 0)  [B,H,Tp,1]
    Tp = k.shape[2]
    NC = Tp // C

    def cw(x):  # [B,H,Tp,D] -> [B,H,NC,C,D]
        return x.reshape(B, H, NC, C, x.shape[-1])

    q, k, v, alpha, beta = map(cw, (q, k, v, alpha, beta))
    beta = beta.squeeze(-1)                                          # [B,H,NC,C]

    log_a = torch.cumsum(torch.log(alpha.clamp_min(eps)), dim=3)     # [B,H,NC,C,dk]
    a = torch.exp(log_a)
    k_hat = k * torch.exp(-log_a)                                    # k / a
    k_bar = k * a
    q_bar = q * a
    a_last = a[:, :, :, -1, :]                                       # [B,H,NC,dk] full-chunk cumprod

    idx = torch.arange(C, device=k.device)
    strict_lower = (idx.unsqueeze(1) > idx.unsqueeze(0))            # [C,C] i>l
    incl_lower = (idx.unsqueeze(1) >= idx.unsqueeze(0))

    # M[i,l] = beta_l (k_bar_i . k_hat_l), strictly lower
    A_kk = torch.einsum("bhncd,bhnld->bhncl", k_bar, k_hat)          # [.,C,C]  (rows i, cols l)
    M = A_kk * beta.unsqueeze(-2)                                    # weight columns by beta_l
    M = M * strict_lower

    eye = torch.eye(C, dtype=k.dtype, device=k.device)
    T_mat = eye + M                                                  # unit lower-triangular

    S = torch.zeros(B, H, dk, dv, dtype=v.dtype, device=v.device) if S0 is None else S0.clone()
    outs = []
    for c in range(NC):
        kb, kh, qb = k_bar[:, :, c], k_hat[:, :, c], q_bar[:, :, c]   # [B,H,C,dk]
        vc, bc = v[:, :, c], beta[:, :, c]                            # [B,H,C,dv],[B,H,C]
        rhs = vc - torch.einsum("bhcd,bhde->bhce", kb, S)            # V - K_bar S0  [B,H,C,dv]
        U = torch.linalg.solve_triangular(T_mat[:, :, c], rhs, upper=False, unitriangular=True)
        BU = bc.unsqueeze(-1) * U                                    # beta_i u_i  [B,H,C,dv]
        # output: inter (from S) + intra (masked qk)
        o_inter = torch.einsum("bhcd,bhde->bhce", qb, S)            # q_bar S0
        A_qk = torch.einsum("bhcd,bhkd->bhck", qb, kh) * incl_lower  # (q_bar_t . k_hat_i), i<=t
        o_intra = torch.einsum("bhck,bhke->bhce", A_qk, BU)
        outs.append(o_inter + o_intra)
        # state carry: S_next = Diag(a_last)[S + sum_i k_hat_i (beta_i u_i)^T]
        S = a_last[:, :, c].unsqueeze(-1) * (S + torch.einsum("bhcd,bhce->bhde", kh, BU))

    out = torch.cat(outs, dim=2).reshape(B, H, Tp, dv)[:, :, :T, :]
    return out, S
