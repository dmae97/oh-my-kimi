# Kimi Delta Attention (KDA) + Kimi Linear — faithful implementation

Grounded in **Kimi Linear: An Expressive, Efficient Attention Architecture** (arXiv:2510.26692,
Moonshot AI). Retrieved and verified via the `arxiv-database` skill; the KDA recurrence below is
transcribed from the paper's Eq. 1, and the chunk-parallel kernel is **derived from it and proven
numerically equal** to the exact recurrence (max abs error ~1e-15, machine precision).

## What K3/Kimi uses, implemented here

| technique | file | status |
| --- | --- | --- |
| **KDA** — Kimi Delta Attention (fine-grained per-channel gated delta rule) | `kda.py` | ✅ recurrent + chunk-parallel, proven equal |
| **KDA layer** — short-conv, gates, output norm (drop-in module) | `modules.py` | ✅ |
| **MLA** — Multi-head Latent Attention (low-rank KV cache + decoupled RoPE) | `mla.py` | ✅ −69% KV cache measured |
| **Kimi Linear hybrid** — KDA:MLA interleaved 3:1 | `hybrid.py` | ✅ |

## The formulation (paper Eq. 1)

State `S_t ∈ R^{d_k×d_v}`, per-channel forget gate `α_t ∈ (0,1)^{d_k}`, delta rate `β_t`:

```
S_t = (I − β_t k_t k_tᵀ) · Diag(α_t) · S_{t−1} + β_t k_t v_tᵀ
o_t = S_tᵀ q_t
```

KDA differs from **Gated DeltaNet** (`S_t = α_t(I − β_t k_t k_tᵀ)S_{t−1} + β_t k_t v_tᵀ`, scalar
`α_t`) only in that the forget gate is a **diagonal per-channel** matrix — "finer-grained gating,"
the paper's core contribution.

### Chunk-parallel derivation (in `kda.py` docstring)

With `a_t = ∏_{j≤t} α_j`, `k̂=k/a`, `k̄=k·a`, `q̄=q·a`, and `u_t = v_t − S_{t−1}ᵀ Diag(α_t) k_t`:

```
(I + strict_tril(M)) U = V − K̄·S₀ ,   M[i,l] = β_l (k̄_i · k̂_l)      # UT/WY transform
S_t = Diag(a_t) [ S₀ + Σ_{i≤t} β_i k̂_i u_iᵀ ]
o_t = q̄_tᵀ S₀ + Σ_{i≤t} β_i (q̄_t · k̂_i) u_i
```

This is the specialized **DPLR (Diagonal-Plus-Low-Rank)** form the paper describes — cheaper than
general DPLR, consistent with the classical delta rule.

## Correctness (this is the point)

```
python3 test_kda.py       # chunk == recurrent, causality, gating limits, state carry
python3 test_modules.py   # KDA/MLA/hybrid forward, causality, KV-cache reduction
```

`test_kda.py` proves the parallel kernel equals the exact recurrence for chunk sizes
{1,8,16,32,64} at ~1e-15, on ragged sequence lengths, and across a carried state boundary.

## Usage

```python
import torch
from hybrid import KimiLinear

model = KimiLinear(vocab=32000, d_model=512, n_layers=12, n_heads=8, ratio=3)  # 3:1 KDA:MLA
logits = model(torch.randint(0, 32000, (2, 1024)))   # [2, 1024, 32000]
print(model.layout)   # ['kda','kda','kda','mla', ...]
```

```python
# raw KDA kernel (bring your own q,k,v,alpha,beta)
from kda import kda_chunk, kda_recurrent
o, S = kda_chunk(q, k, v, alpha, beta, chunk_size=64)   # fast path
```

## Notes

- Keys are L2-normalized (delta-rule assumption); `α = exp(−softplus(·))`, `β = sigmoid(·)`.
- The chunk kernel is a correct reference implementation in pure PyTorch (no custom CUDA); it
  demonstrates the algorithm and validates it. Production throughput needs a fused kernel.
- MLA caches only the `(kv_rank + rope_dim)` latent per token → measured −69% vs full-MHA K+V
  cache in `test_modules.py` (paper reports up to −75%).
- Paper PDF cached at `/tmp/kda.pdf`; retrieved via `arxiv-database` skill (id 2510.26692).
