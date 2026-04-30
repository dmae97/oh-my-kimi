//! session-stats: ad-hoc analyses over the local agent session corpus
//! (`~/.omp/agent/sessions/`).
//!
//! Subcommands:
//!
//!   edits [-n N] [date ...]   audit edit/ast_edit/write tool usage by argument schema
//!   tools [-n N]              per-tool token totals across the most-recent N sessions
//!
//! Run with no subcommand for help.

mod cmd_edits;
mod cmd_tools;
mod common;

use std::process::ExitCode;

fn usage() {
    eprintln!(
        "usage: session-stats <subcommand> [args...]

  edits [-n N] [date prefix ...]
                             audit edit-tool usage across N most-recent
                             sessions (default 1000). Optional date filters
                             (e.g. 2026-04-28) further narrow the set.
  tools [-n N]               per-tool token totals across the N most-recent
                             session jsonl files (default 1000).

Token counting uses the o200k_base tokenizer (the GPT-4o / Claude-adjacent BPE).
Walk root: ~/.omp/agent/sessions/"
    );
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(cmd) = args.next() else {
        usage();
        return ExitCode::from(2);
    };
    let rest: Vec<String> = args.collect();
    let result = match cmd.as_str() {
        "edits" => cmd_edits::run(rest),
        "tools" => cmd_tools::run(rest),
        "-h" | "--help" | "help" => {
            usage();
            return ExitCode::SUCCESS;
        }
        other => {
            eprintln!("unknown subcommand {other:?}\n");
            usage();
            return ExitCode::from(2);
        }
    };
    if let Err(err) = result {
        eprintln!("fatal: {err:#}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
