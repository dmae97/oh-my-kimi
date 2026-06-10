{{#if readFiles.length}}
{{#xml "read-files"}}
{{join readFiles "\n"}}
{{/xml}}
{{/if}}
{{#if modifiedFiles.length}}
{{#xml "modified-files"}}
{{join modifiedFiles "\n"}}
{{/xml}}
{{/if}}
