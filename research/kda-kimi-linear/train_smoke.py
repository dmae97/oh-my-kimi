"""Training smoke test — prove KDA/Kimi Linear actually LEARNS (gradients flow end-to-end).

Task: Multi-Query Associative Recall (MQAR), the canonical benchmark for delta-rule linear
attention — it directly tests the associative memory KDA is built to provide. Sequences are
generated FRESH each batch, so high accuracy proves the model learned the recall *algorithm*
(generalization), not memorization of a fixed set.

Layout per example (autoregressive next-token prediction):
    k1 v1 k2 v2 ... kN vN  Q  kq1 ? kq2 ? ...      # ? = the value bound to kqj earlier
Loss/accuracy are measured ONLY on the answer positions (after each query key).

Run: python3 train_smoke.py   (CPU-fine; uses CUDA if present)
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

from hybrid import KimiLinear

torch.manual_seed(0)
DEV = "cuda" if torch.cuda.is_available() else "cpu"

# vocab layout
N_KEYS, N_VALS = 32, 32
PAD, SEP = 0, 1
KEY0 = 2
VAL0 = KEY0 + N_KEYS
QUERY = VAL0 + N_VALS
VOCAB = QUERY + 1


def make_batch(B, n_pairs=8, n_queries=4):
    """Returns ids [B,T], and a boolean answer-mask [B,T] marking supervised positions."""
    T = 2 * n_pairs + 1 + 2 * n_queries
    ids = torch.full((B, T), PAD, dtype=torch.long)
    mask = torch.zeros(B, T, dtype=torch.bool)
    for b in range(B):
        keys = torch.randperm(N_KEYS)[:n_pairs]
        vals = torch.randint(0, N_VALS, (n_pairs,))
        seq = []
        for k, v in zip(keys, vals):
            seq += [KEY0 + k.item(), VAL0 + v.item()]
        seq.append(QUERY)
        qidx = torch.randint(0, n_pairs, (n_queries,))
        answer_pos = []
        for qi in qidx:
            seq.append(KEY0 + keys[qi].item())
            answer_pos.append(len(seq))  # the value is predicted AT the next position
            seq.append(VAL0 + vals[qi].item())
        row = torch.tensor(seq, dtype=torch.long)
        ids[b, : row.numel()] = row
        for p in answer_pos:
            if p < T:
                mask[b, p] = True
    return ids.to(DEV), mask.to(DEV)


def evaluate(model, steps=20, B=64):
    model.eval()
    correct = total = 0
    with torch.no_grad():
        for _ in range(steps):
            ids, mask = make_batch(B)
            logits = model(ids)
            pred = logits[:, :-1].argmax(-1)
            tgt = ids[:, 1:]
            m = mask[:, 1:]
            correct += (pred[m] == tgt[m]).sum().item()
            total += m.sum().item()
    model.train()
    return correct / max(total, 1)


def main():
    model = KimiLinear(vocab=VOCAB, d_model=128, n_layers=4, n_heads=4, ratio=3).to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=1.5e-3, weight_decay=0.01)
    n_params = sum(p.numel() for p in model.parameters())
    print(
        f"device={DEV}  params={n_params / 1e6:.2f}M  layout={model.layout}  vocab={VOCAB}"
    )
    print(f"baseline (random) acc ≈ {1 / N_VALS:.3f}\n")

    steps = 600
    for step in range(1, steps + 1):
        ids, mask = make_batch(B=64)
        logits = model(ids)
        loss = F.cross_entropy(
            logits[:, :-1].reshape(-1, VOCAB)[mask[:, 1:].reshape(-1)],
            ids[:, 1:].reshape(-1)[mask[:, 1:].reshape(-1)],
        )
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % 100 == 0 or step == 1:
            acc = evaluate(model)
            print(f"step {step:4d}  loss {loss.item():.4f}  recall-acc {acc:.3f}")

    final = evaluate(model, steps=40)
    print(f"\nFINAL recall accuracy (fresh sequences): {final:.3f}")
    assert final > 0.90, f"training smoke FAILED: recall acc {final:.3f} <= 0.90"
    print("TRAINING SMOKE PASSED ✓  (gradients flow; associative recall generalizes)")


if __name__ == "__main__":
    main()
