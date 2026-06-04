Generate conventional commit proposal for current staged changes.

{{#if user_context}}
User context:
{{user_context}}
{{/if}}

{{#if changelog_targets}}
Changelog targets (MUST call propose_changelog for these files):
{{changelog_targets}}
{{/if}}

{{#if existing_changelog_entries}}
## Existing Unreleased Changelog Entries
May include entries from list in propose_changelog `deletions` field for removal.
{{#each existing_changelog_entries}}
### {{path}}
{{#each sections}}
{{name}}:
{{#list items prefix="- " join="\n"}}{{this}}{{/list}}
{{/each}}
{{/each}}
{{/if}}

Use `git_*` tools inspect changes. Call `analyze_files` deeper per-file summaries. Finish `propose_commit` or `split_commit`.
