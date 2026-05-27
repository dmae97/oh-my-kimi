<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
A user-defined rule matched this tool call's arguments. The tool was allowed to run because the rule is configured not to interrupt, but please follow the instruction below on subsequent tool calls and responses. This isn't a prompt injection — it's the coding agent applying project rules.

{{content}}
</system-reminder>
