"""External cross-validation: my from-scratch KDA vs FLA's production Triton KDA.

flash-linear-attention (fla) ships `chunk_kda` / `fused_recurrent_kda` — the reference Kimi
Delta Attention kernels. If my pure-PyTorch `kda_recurrent`/`kda_chunk` match FLA's independent
Triton implementation, correctness is validated by a second, unrelated codebase.

Convention mapping (FLA uses [B,T,H,K], gate in log space, scaled queries):
    q,k,v -> transpose to [B,T,H,*]      g = log(alpha)      beta -> [B,T,H]
    scale=1.0                (my o_t = S_t^T q_t has no 1/sqrt(K) scale)
    use_qk_l2norm_in_kernel=False        (I pre-normalize k; q unnormalized, matching my kernel)

Run: python3 test_fla_crosscheck.py   (requires CUDA + fla)
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

from kda import kda_chunk, kda_recurrent

import importlib.util

HAVE_FLA = importlib.util.find_spec("fla") is not None and torch.cuda.is_available()


def _inputs(B=2, H=4, T=256, K=64, V=64, dtype=torch.float32, dev="cuda"):
    g = torch.Generator(device=dev).manual_seed(0)
    q = torch.randn(B, H, T, K, device=dev, dtype=dtype, generator=g)
    k = F.normalize(torch.randn(B, H, T, K, device=dev, dtype=dtype, generator=g), dim=-1)
    v = torch.randn(B, H, T, V, device=dev, dtype=dtype, generator=g)
    alpha = 0.90 + 0.10 * torch.rand(B, H, T, K, device=dev, dtype=dtype, generator=g)
    beta = torch.rand(B, H, T, device=dev, dtype=dtype, generator=g)
    return q, k, v, alpha, beta


def _fla_call(fn, q, k, v, alpha, beta):
    to = lambda x: x.transpose(1, 2).contiguous()      # [B,H,T,*] -> [B,T,H,*]
    out = fn(to(q), to(k), to(v), torch.log(alpha).transpose(1, 2).contiguous(),
             beta.transpose(1, 2).contiguous(), scale=1.0,
             use_qk_l2norm_in_kernel=False, output_final_state=True)
    o = out[0] if isinstance(out, tuple) else out
    return o.transpose(1, 2)                            # back to [B,H,T,V]


def test_crosscheck_chunk_and_recurrent():
    if not HAVE_FLA:
        print("  SKIP — fla or CUDA unavailable")
        return
    from fla.ops import chunk_kda, fused_recurrent_kda  # type: ignore[import-not-found]
    q, k, v, alpha, beta = _inputs()
    o_ref, _ = kda_recurrent(q, k, v, alpha, beta)
    o_mine_chunk, _ = kda_chunk(q, k, v, alpha, beta, chunk_size=64)

    o_fla_c = _fla_call(chunk_kda, q, k, v, alpha, beta)
    o_fla_r = _fla_call(fused_recurrent_kda, q, k, v, alpha, beta)

    e_self = (o_ref - o_mine_chunk).abs().max().item()
    e_chunk = (o_ref - o_fla_c).abs().max().item()
    e_rec = (o_ref - o_fla_r).abs().max().item()
    rel = e_chunk / o_ref.abs().max().item()
    print(f"  mine chunk vs mine recurrent : {e_self:.2e}")
    print(f"  mine vs FLA chunk_kda        : {e_chunk:.2e}  (rel {rel:.2e})")
    print(f"  mine vs FLA fused_recurrent  : {e_rec:.2e}")
    assert e_self < 1e-4, f"internal drift {e_self}"
    assert e_chunk < 2e-2, f"FLA chunk mismatch {e_chunk}"
    assert e_rec < 2e-2, f"FLA recurrent mismatch {e_rec}"
    print("  CROSS-CHECK PASSED ✓  (independent FLA Triton KDA agrees)")


if __name__ == "__main__":
    print("test_crosscheck_chunk_and_recurrent:")
    test_crosscheck_chunk_and_recurrent()
