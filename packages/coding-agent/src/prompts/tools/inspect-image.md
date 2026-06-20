Inspects an image file with a vision-capable model and returns compact text analysis.

<instruction>
- Use this for image understanding tasks (OCR, UI/screenshot debugging, scene/object questions)
- Provide `path` as a local image file path, `Image #N` attachment label, or `attachment://N` URI
- Write a specific `question`:
  - what to inspect
  - constraints (for example: "quote visible text verbatim", "only report confirmed findings")
  - desired output format (bullets/table/JSON/short answer)
- Keep `question` grounded in observable evidence and ask for uncertainty when details are unclear
- Use this tool over `read` when the goal is image analysis
</instruction>

<output>
- Returns text-only analysis from the vision model
- No image content blocks are returned in tool output
</output>

<critical>
- If image submission is blocked by settings, the tool will fail with an actionable error
- If configured model does not support image input, configure a vision-capable model role before retrying
</critical>
