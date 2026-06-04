<system-notice>
{{#if multiple}}{{jobs.length}} Background jobs done. Resume with results below.

{{else}}Background job {{jobs.[0].jobId}} done. Resume with result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}} ──
{{/if}}{{this.result}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
