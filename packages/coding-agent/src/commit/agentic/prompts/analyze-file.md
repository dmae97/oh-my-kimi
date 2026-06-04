Analyze file at {{file}}.

Goal:
{{#if goal}}
{{goal}}
{{else}}
Summarize purpose and commit-relevant changes.
{{/if}}

Return concise JSON object with:
- summary: one-sentence role of file
- highlights: 2-5 bullets on notable behaviors or changes
- risks: edge cases or risks worth noting (empty array if none)

{{#if related_files}}
## Other Files in This Change
{{related_files}}

Check how file changes relate to above files.
{{/if}}

yield tool with JSON payload.
