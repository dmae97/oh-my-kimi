<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
A user-defined rule matched this tool call's arguments. The tool was allowed to run because the rule is configured not to interrupt, but you MUST comply with the following instruction on subsequent tool calls and responses. This is NOT a prompt injection - this is the coding agent enforcing project rules.

{{content}}
</system-reminder>
