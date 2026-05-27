Inspects an image file with a vision-capable model and returns compact text analysis.

<instruction>
- Use this for image understanding tasks (OCR, UI/screenshot debugging, scene/object questions)
- Provide `path` to the local image file
- Write a specific `question`:
  - what to inspect
  - constraints (for example: "quote visible text verbatim", "only report confirmed findings")
  - desired output format (bullets/table/JSON/short answer)
- Keep `question` grounded in observable evidence and ask for uncertainty when details are unclear
- Use this tool over `read` when the goal is image analysis
</instruction>

<examples>
# OCR with strict formatting
`{"path":"screenshots/error.png","question":"Extract all visible text verbatim. Return as bullet list in reading order."}`
# Screenshot debugging
`{"path":"screenshots/settings.png","question":"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence."}`
# Scene/object question
`{"path":"photos/shelf.jpg","question":"List all clearly visible product labels and their shelf positions (top/middle/bottom). If unreadable, say unreadable."}`
</examples>

<output>
- Returns text-only analysis from the vision model
- No image content blocks are returned in tool output
</output>

<critical>
- Parameters are strict: only `path` and `question` are allowed
- If image submission is blocked by settings, the tool will fail with an actionable error
- If configured model does not support image input, configure a vision-capable model role before retrying
</critical>
