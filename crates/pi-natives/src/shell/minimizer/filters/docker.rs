//! Container and cloud command output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"ps"
				| "images"
				| "logs" | "compose"
				| "build"
				| "pull" | "push"
				| "get" | "describe"
				| "status"
				| "list" | "ls"
				| "install"
				| "upgrade"
				| "template"
				| "lint"
		)
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"docker" => filter_docker(ctx, &cleaned, exit_code),
		"kubectl" => filter_kubectl(ctx, &cleaned, exit_code),
		"helm" => filter_helm(ctx, &cleaned, exit_code),
		_ => head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn filter_docker(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if is_log_command(ctx) {
		return filter_logs(input);
	}
	if is_table_command(ctx) {
		return compact_table(input, 12);
	}
	if exit_code != 0 {
		return head_tail_dedup(input);
	}
	compact_build_or_progress(input)
}

fn filter_kubectl(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	match ctx.subcommand {
		Some("logs") => filter_logs(input),
		Some("get") => compact_table(input, 20),
		Some("describe") => {
			primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
		},
		_ if exit_code != 0 => head_tail_dedup(input),
		_ => compact_build_or_progress(input),
	}
}

fn filter_helm(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	match ctx.subcommand {
		Some("list" | "ls" | "status") => compact_table(input, 20),
		Some("install" | "upgrade" | "template" | "lint") => compact_build_or_progress(input),
		_ if exit_code != 0 => head_tail_dedup(input),
		_ => head_tail_dedup(input),
	}
}

fn is_log_command(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.subcommand == Some("logs") || ctx.command.split_whitespace().any(|part| part == "logs")
}

fn is_table_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("ps" | "images"))
		|| ctx
			.command
			.split_whitespace()
			.any(|part| matches!(part, "ps" | "images"))
}

fn filter_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	let deduped = primitives::dedup_consecutive_lines(&without_empty_runs);
	primitives::head_tail_lines(&deduped, 120, 80)
}

fn compact_table(input: &str, visible_rows: usize) -> String {
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= visible_rows + 1 {
		return input.to_string();
	}

	let mut out = String::new();
	if let Some(header) = lines.first() {
		out.push_str(header.trim_end());
		out.push('\n');
	}
	out.push_str(&(lines.len() - 1).to_string());
	out.push_str(" rows\n");
	for line in lines.iter().skip(1).take(visible_rows) {
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out.push_str("… ");
	out.push_str(&(lines.len() - 1 - visible_rows).to_string());
	out.push_str(" more rows\n");
	out
}

fn compact_build_or_progress(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_progress_line(trimmed) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	head_tail_dedup(&out)
}

fn is_progress_line(line: &str) -> bool {
	line.starts_with("=> ")
		|| line.starts_with('#') && line.contains("DONE")
		|| line.contains("Pulling fs layer")
		|| line.contains("Download complete")
		|| line.contains("Extracting")
		|| line.contains("Waiting")
		|| line.contains("Verifying Checksum")
}

fn drop_repeated_blank_lines(input: &str) -> String {
	let mut out = String::new();
	let mut saw_blank = false;
	for line in input.lines() {
		if line.trim().is_empty() {
			if !saw_blank {
				out.push('\n');
			}
			saw_blank = true;
			continue;
		}
		saw_blank = false;
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn head_tail_dedup(input: &str) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dedups_repeated_log_lines_before_truncation() {
		let input = "api | ready\napi | ready\napi | ready\napi | failed\n";
		let out = filter_logs(input);
		assert!(out.contains("api | ready (×3)"));
		assert!(out.contains("api | failed"));
	}

	#[test]
	fn compacts_large_table_with_header_and_omission_count() {
		let mut input = String::from("ID IMAGE STATUS\n");
		for i in 0..25 {
			input.push_str(&i.to_string());
			input.push_str(" img running\n");
		}
		let out = compact_table(&input, 10);
		assert!(out.contains("25 rows"));
		assert!(out.contains("… 15 more rows"));
	}
}
