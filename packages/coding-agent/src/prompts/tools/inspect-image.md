Inspects image file with vision-capable model; returns compact text analysis.

<instruction>
- Use for image understanding tasks (OCR, UI/screenshot debugging, scene/object questions)
- Provide `path` to local image file
- Write a specific `question`:
  - what inspect
  - constraints (example: "quote visible text verbatim", "only report confirmed findings")
  - desired output format (bullets/table/JSON/short answer)
- Keep `question` grounded in observable evidence; ask for uncertainty when details unclear
- Use this tool over `read` when goal is image analysis
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
- Returns text-only analysis from vision model
- No image content blocks returned in tool output
</output>

<critical>
- Parameters strict: only `path` and `question` allowed
- If image submission blocked by settings, tool fails with actionable error
- If configured model does not support image input, configure vision-capable model role before retry
</critical>
