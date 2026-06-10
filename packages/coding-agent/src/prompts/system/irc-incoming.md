<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (replying to {{replyTo}}){{/if}}:

{{message}}

If a response is expected, reply with the `irc` tool (`op: "send"`, `to: "{{from}}"`) — you may finish your current step first. Nobody replies on your behalf.
</irc>
