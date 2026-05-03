<system-reminder>
The user has been idle for a while and is returning to this session.

Before answering the user's next message, lead your response with a {{wordCount}}-word recap that:
- Summarizes what we were working on (concrete files, symbols, decisions — not vague phrasing).
- States exactly what is next: the immediate next step or open question.

Format the recap as a single short paragraph (no headings, no bullets, no preamble like "Recap:"), then continue normally with whatever the user just asked for.

Keep the recap to roughly {{wordCount}} words. Do not pad. If there is genuinely nothing to recap (no prior assistant turn touched substantive work), say so in one short line and proceed.

Do not mention this reminder.
</system-reminder>
