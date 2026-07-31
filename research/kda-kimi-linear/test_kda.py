"""Correctness proof for KDA: the chunk-parallel form must equal the exact recurrence.

Run: python3 test_kda.py   (or pytest). Uses float64 for tight numerical equivalence.
"""

from __future__ import annotations

import torch

from kda import kda_chunk, kda_recurrent

torch.manual_seed(0)
DT = torch.float64


def _rand(B=2, H=3, T=100, dk=16, dv=24, gate_lo=0.90, gate_hi=1.0):
    q = torch.randn(B, H, T, dk, dtype=DT)
    k = torch.randn(B, H, T, dk, dtype=DT)
    v = torch.randn(B, H, T, dv, dtype=DT)
    # L2-normalize keys (delta rule assumes unit keys) and alpha in (gate_lo, gate_hi)
    k = torch.nn.functional.normalize(k, dim=-1)
    alpha = gate_lo + (gate_hi - gate_lo) * torch.rand(B, H, T, dk, dtype=DT)
    beta = torch.rand(B, H, T, dtype=DT)  # (0,1)
    return q, k, v, alpha, beta


def test_chunk_equals_recurrent():
    q, k, v, alpha, beta = _rand()
    o_ref, S_ref = kda_recurrent(q, k, v, alpha, beta)
    for C in (1, 8, 16, 32, 64):
        o_c, S_c = kda_chunk(q, k, v, alpha, beta, chunk_size=C)
        eo = (o_c - o_ref).abs().max().item()
        es = (S_c - S_ref).abs().max().item()
        assert eo < 1e-8, f"C={C} output mismatch {eo}"
        assert es < 1e-8, f"C={C} state mismatch {es}"
        print(f"  chunk_size={C:3d}  max|Δo|={eo:.2e}  max|ΔS|={es:.2e}  OK")


def test_seqlen_not_multiple_of_chunk():
    q, k, v, alpha, beta = _rand(T=77)  # 77 not divisible by 16/32/64
    o_ref, _ = kda_recurrent(q, k, v, alpha, beta)
    o_c, _ = kda_chunk(q, k, v, alpha, beta, chunk_size=32)
    e = (o_c - o_ref).abs().max().item()
    assert e < 1e-8, f"ragged seq mismatch {e}"
    print(f"  ragged T=77 chunk=32  max|Δo|={e:.2e}  OK")


def test_causality():
    """Output at t must not depend on inputs after t."""
    q, k, v, alpha, beta = _rand(T=40)
    o1, _ = kda_chunk(q, k, v, alpha, beta, chunk_size=16)
    t = 20
    v2 = v.clone()
    v2[:, :, t + 1 :, :] += torch.randn_like(v2[:, :, t + 1 :, :])  # perturb the future
    o2, _ = kda_chunk(q, k, v2, alpha, beta, chunk_size=16)
    past = (o1[:, :, : t + 1] - o2[:, :, : t + 1]).abs().max().item()
    future = (o1[:, :, t + 1 :] - o2[:, :, t + 1 :]).abs().max().item()
    assert past < 1e-10, f"causality violated: past changed {past}"
    assert future > 1e-6, "future should change when future inputs change"
    print(f"  causality: past Δ={past:.2e} (≈0)  future Δ={future:.2e} (>0)  OK")


def test_gating_limits():
    """alpha->1 recovers ungated DeltaNet; state stays finite; beta->0 => pure decay read."""
    q, k, v, alpha, beta = _rand(T=30)
    a1 = torch.ones_like(alpha)  # no forgetting
    o_ung, _ = kda_chunk(q, k, v, a1, beta, chunk_size=16)
    o_ung_r, _ = kda_recurrent(q, k, v, a1, beta)
    e = (o_ung - o_ung_r).abs().max().item()
    assert e < 1e-8, f"alpha=1 mismatch {e}"
    # beta=0 => S_t = Diag(alpha) S_{t-1}; starting from 0 => outputs all 0
    b0 = torch.zeros_like(beta)
    o0, S0f = kda_chunk(q, k, v, alpha, b0, chunk_size=16)
    assert o0.abs().max().item() < 1e-10 and S0f.abs().max().item() < 1e-10, (
        "beta=0 should give zero"
    )
    print(f"  gating limits: alpha=1 Δ={e:.2e}  beta=0 → zero state  OK")


def test_state_carry():
    """Passing S0 across two calls == one call over the concatenation."""
    q, k, v, alpha, beta = _rand(T=64)
    o_full, S_full = kda_chunk(q, k, v, alpha, beta, chunk_size=16)
    o_a, S_a = kda_chunk(
        q[:, :, :32],
        k[:, :, :32],
        v[:, :, :32],
        alpha[:, :, :32],
        beta[:, :, :32],
        chunk_size=16,
    )
    o_b, S_b = kda_chunk(
        q[:, :, 32:],
        k[:, :, 32:],
        v[:, :, 32:],
        alpha[:, :, 32:],
        beta[:, :, 32:],
        S0=S_a,
        chunk_size=16,
    )
    e = (torch.cat([o_a, o_b], dim=2) - o_full).abs().max().item()
    assert e < 1e-8, f"state-carry mismatch {e}"
    print(f"  state carry across calls: Δ={e:.2e}  OK")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(f"{name}:")
            fn()
    print("\nALL KDA CORRECTNESS TESTS PASSED ✓")
