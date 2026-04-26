<system-reminder>
You stopped without calling yield. This is reminder {{retryCount}} of {{maxRetries}}.

You **MUST** call yield as your only action now. Choose one:
- If task is complete: call yield with your result in `result.data`
- If task failed: call yield with `result.error` describing what happened

You **MUST NOT** give up if you can still complete the task through exploration (using available tools or repo context). If you submit an error, you **MUST** include what you tried and the exact blocker.

You **MUST NOT** output text without a tool call. You **MUST** call yield to finish.
</system-reminder>
