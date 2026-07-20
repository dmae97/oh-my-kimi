<system-notice>
The xd:// device inventory changed.
{{#if added.length}}
These tools became available:
{{#each added}}
- xd://{{this.name}} — {{this.summary}}
{{/each}}
Read `xd://<tool>` for docs + JSON schema before first use; write the JSON args object to `xd://<tool>` to execute.
{{/if}}
{{#if removed.length}}
No longer mounted (writes to these devices will fail):
{{#each removed}}
- xd://{{this.name}}
{{/each}}
{{/if}}
</system-notice>
