Generate a concise git commit message from the provided diff.

Use conventional commit format: `type(scope): description`. Type is one of feat/fix/refactor/chore/test/docs. Scope is optional. The description MUST be lowercase, imperative mood, no trailing period. Keep the message under 72 characters.

You MUST output ONLY the commit message, nothing else.

Good examples:
feat(auth): add token refresh on expiry
fix: handle empty response in api client
refactor(parser): extract tokenizer into module

Bad (capitalized, past tense): Fix: Handled empty response
Bad (trailing period): fix: handle empty response.
Bad (extra prose): Here is the commit message: fix: handle empty response
