{{#if context_files}}
<project-context>
{{#each context_files}}
<file path="{{ path }}">
{{ content }}
</file>
{{/each}}
</project-context>
{{/if}}
{{#if user_context}}
<user-context>
{{ user_context }}
</user-context>
{{/if}}
{{#if types_description}}
<commit-types>
{{ types_description }}
</commit-types>
{{/if}}
<diff-statistics>
{{ stat }}
</diff-statistics>
<scope-candidates>
{{ scope_candidates }}
</scope-candidates>
{{#if common_scopes}}
<common-scopes>
{{ common_scopes }}
</common-scopes>
{{/if}}
{{#if recent_commits}}
<style-patterns>
{{ recent_commits }}
</style-patterns>
{{/if}}
<diff>
{{ diff }}
</diff>
