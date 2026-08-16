# `omk-protocol`

Canonical contracts and pure reducers for the OMK Run Protocol.

```text
TaskSpec -> ExecutionAttempt -> Observation -> EvaluationResult -> RuntimeDecision
```

## API

- `PROTOCOL_VERSION` (`omk.run.v1`)
- `TaskSpec`, `ExecutionAttempt`, `Observation`, `ClaimPredicate`
- `ClaimEvaluation`, `EvaluationResult`, `RuntimeDecision`, `WaiverRecord`
- Runtime parsers for every top-level record
- `evaluateTask()` and `reduceRuntimeDecision()`

The package does not execute tools, persist records, schedule work, choose providers, or infer topology. Retry and failover counts are derived from attempt records rather than stored counters.

See [OMK Run Protocol v1](https://github.com/dmae97/omk/blob/main/packages/coding-agent/docs/run-protocol.md) for evaluation rules, receipt bridging, migration status, and authority boundaries.
