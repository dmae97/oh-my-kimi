Analyze file at {{file}}.

Goal:
{{#if goal}}
{{goal}}
{{else}}
Summarize purpose and commit-relevant changes.
{{/if}}

Return concise JSON object with:
- summary: one-sentence description of file's role
- highlights: 2-5 bullet points about notable behaviors or changes
- risks: edge cases or risks worth noting (empty array if none)

{{#if related_files}}
## Other Files in This Change
{{related_files}}

Consider how file's changes relate to above files.
{{/if}}

Call yield tool with JSON payload.
