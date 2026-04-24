//! Package manager output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"install"
				| "i" | "ci"
				| "add" | "update"
				| "up" | "upgrade"
				| "remove"
				| "rm" | "uninstall"
				| "list" | "ls"
				| "outdated"
				| "sync" | "lock"
				| "run" | "exec"
				| "audit"
				| "check"
				| "show" | "info"
				| "why"
		)
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let stripped = strip_package_noise(ctx.program, &cleaned, exit_code);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	let text = primitives::head_tail_lines(&deduped, 120, 80);

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn strip_package_noise(program: &str, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut previous_blank = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;

		if is_noise_line(program, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn is_noise_line(program: &str, line: &str, exit_code: i32) -> bool {
	if exit_code != 0 && is_error_or_summary(line) {
		return false;
	}

	let lower = line.to_ascii_lowercase();
	is_generic_progress(line, &lower)
		|| is_js_package_noise(program, line, &lower)
		|| is_python_package_noise(program, line, &lower)
		|| is_ruby_php_brew_noise(program, line, &lower)
}

fn is_generic_progress(line: &str, lower: &str) -> bool {
	line.starts_with("Progress:")
		|| line.starts_with("Resolving:")
		|| line.starts_with("Downloading:")
		|| line.starts_with("Downloaded")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("installing dependencies")
		|| lower.starts_with("fetching packages")
		|| lower.contains("spinner")
		|| line
			.chars()
			.all(|ch| matches!(ch, '⠁' | '⠂' | '⠄' | '⡀' | '⢀' | '⠠' | '⠐' | '⠈' | ' '))
}

fn is_js_package_noise(program: &str, line: &str, lower: &str) -> bool {
	if !matches!(program, "npm" | "pnpm" | "yarn" | "bun") {
		return false;
	}
	line.starts_with('>') && line.contains('@')
		|| lower.starts_with("npm notice")
		|| lower.starts_with("npm warn deprecated")
		|| lower.starts_with("npm http fetch")
		|| lower.starts_with("pnpm: progress")
		|| lower.starts_with("packages:")
		|| lower.starts_with("resolved ")
		|| lower.starts_with("reused ")
		|| lower.starts_with("added ") && lower.contains("packages")
		|| lower.starts_with("done in ")
		|| lower.contains("already up-to-date")
}

fn is_python_package_noise(program: &str, _line: &str, lower: &str) -> bool {
	if !matches!(program, "pip" | "uv" | "poetry") {
		return false;
	}
	lower.starts_with("collecting ")
		|| lower.starts_with("using cached ")
		|| lower.starts_with("downloading ")
		|| lower.starts_with("preparing metadata")
		|| lower.starts_with("installing build dependencies")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("writing lock file")
		|| lower.starts_with("package operations:")
}

fn is_ruby_php_brew_noise(program: &str, _line: &str, lower: &str) -> bool {
	if !matches!(program, "bundle" | "brew" | "composer") {
		return false;
	}
	lower.starts_with("fetching ")
		|| lower.starts_with("installing ") && !lower.contains("error")
		|| lower.starts_with("using ")
		|| lower.starts_with("bundle complete")
		|| lower.starts_with("==> downloading")
		|| lower.starts_with("==> pouring")
		|| lower.starts_with("loading composer repositories")
		|| lower.starts_with("generating autoload files")
}

fn is_error_or_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("vulnerab")
		|| lower.contains("audited")
		|| lower.contains("found ")
		|| lower.contains("success")
		|| lower.contains("complete")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strips_progress_but_keeps_package_errors() {
		let input = "Resolving: total 10\nDownloading: left-pad\nERROR failed to install \
		             left-pad\nfound 1 vulnerability\n";
		let out = strip_package_noise("npm", input, 1);
		assert!(!out.contains("Resolving:"));
		assert!(!out.contains("Downloading:"));
		assert!(out.contains("ERROR failed"));
		assert!(out.contains("found 1 vulnerability"));
	}

	#[test]
	fn supports_common_package_subcommands_for_future_dispatch() {
		for subcommand in ["ci", "add", "outdated", "sync", "audit", "why"] {
			assert!(supports(Some(subcommand)), "{subcommand} should be supported");
		}
	}

	#[test]
	fn bun_install_noise_uses_js_package_rules() {
		let input = "Resolving dependencies\nDownloaded foo\nerror: failed\n";
		let out = strip_package_noise("bun", input, 1);
		assert!(!out.contains("Resolving dependencies"));
		assert!(!out.contains("Downloaded foo"));
		assert!(out.contains("error: failed"));
	}
}
