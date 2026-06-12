<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (replying to {{replyTo}}){{/if}}:

{{message}}

{{#if autoReplied}}You are mid-task, so a side-channel auto-reply was generated from your context and delivered to `{{from}}` on your behalf (recorded after this message). Follow up with the `irc` tool (`op: "send"`, `to: "{{from}}"`) only if that auto-reply needs correcting.{{else}}If a response is expected, reply with the `irc` tool (`op: "send"`, `to: "{{from}}"`) — you may finish your current step first. Nobody replies on your behalf.{{/if}}
</irc>
