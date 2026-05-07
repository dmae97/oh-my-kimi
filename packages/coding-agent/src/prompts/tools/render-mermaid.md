Convert Mermaid graph source into ASCII diagram output.

Parameters:
- `mermaid` (required): Mermaid graph text to render.
- `config` (optional): JSON render configuration (spacing and layout options).
Behavior:
- Returns ASCII diagram text.
- Saves full output to `artifact://<id>` when storage is available.
- Returns error when Mermaid input is invalid or rendering fails.
