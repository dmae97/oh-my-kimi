# OMK landing (Codex-style product page)

Static product landing inspired by modern coding-agent marketing pages (Codex / agent IDE home):

- dark canvas, serif hero, mono meta
- sticky top nav + install CTA
- live-looking CONTROL workspace mock
- feature bento with existing `readmeasset` demos
- install panel + FAQ

## Local preview

```bash
python3 -m http.server 4173 --directory landing
# open http://127.0.0.1:4173/
```

Assets are vendored under `landing/assets/` (from `readmeasset/`).

## Notes

- Not wired into npm package publish surface.
- Copy tracks root README positioning for v0.95.1.
