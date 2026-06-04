Creates context checkpoint before exploratory work; rewind later, keep only concise report.

Use when Need investigate with many intermediate tool calls (read/search/find/lsp/etc.), want minimize context cost afterward.

Rules:
- MUST call `rewind` before yielding after starting checkpoint.
- MUST provide clear `goal` explaining what investigating.
- NEVER call `checkpoint` while another checkpoint active.
- Not available in subagents.

Typical flow:
1. `checkpoint(goal: …)`
2. Need exploratory work
3. `rewind(report: …)` with concise findings

After rewind, intermediate checkpoint messages removed from active context; replaced by report.
