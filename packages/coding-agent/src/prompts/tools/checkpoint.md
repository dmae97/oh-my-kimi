Creates a context checkpoint before exploratory work so you can later rewind and keep only a concise report.

Use this when you need to investigate with many intermediate tool calls (read/search/find/lsp/etc.) and want to minimize context cost afterward.

Ground rules:
- Call `rewind` before yielding once a checkpoint is active — otherwise the intermediate context sticks around.
- Provide a clear `goal` explaining what you're investigating.
- Avoid starting a new `checkpoint` while another one is still active.
- Not available in subagents.

Typical flow:
1. `checkpoint(goal: …)`
2. Perform exploratory work
3. `rewind(report: …)` with concise findings

After rewind, intermediate checkpoint messages are removed from active context and replaced by the report.
