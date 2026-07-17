import "../../src/eval/js/process-entry";

process.stdout.write(process.env.OMP_PROCESS_ENTRY_ENV_PROBE ?? "");
