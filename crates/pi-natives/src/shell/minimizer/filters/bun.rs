//! Bun package-manager, test-runner, and tool output filters.

use super::{cpp, generic, js_tools, lint, node_tests, pkg};
use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const BUN_PACKAGE_SUBCOMMANDS: &[&str] = &[
	"install", "i", "add", "update", "up", "upgrade", "remove", "rm", "outdated", "pm", "audit",
	"run", "exec",
];
const BUN_TEST_SUBCOMMANDS: &[&str] = &["test"];
const BUN_BUILD_SUBCOMMANDS: &[&str] = &["build"];
const BUN_TOOL_SUBCOMMANDS: &[&str] =
	&["tsc", "eslint", "biome", "next", "prettier", "prisma", "jest", "vitest", "playwright"];
const BUN_CPP_TOOL_SUBCOMMANDS: &[&str] = &["cmake", "ctest", "ninja", "gtest", "gtest-parallel"];

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"bun" => subcommand.is_some_and(|subcommand| {
			BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand)
				|| BUN_TEST_SUBCOMMANDS.contains(&subcommand)
				|| BUN_BUILD_SUBCOMMANDS.contains(&subcommand)
				|| BUN_TOOL_SUBCOMMANDS.contains(&subcommand)
				|| BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand)
		}),
		"bunx" => subcommand.is_some_and(|subcommand| {
			BUN_TOOL_SUBCOMMANDS.contains(&subcommand)
				|| BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand)
		}),
		_ => false,
	}
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let subcommand = ctx.subcommand;
	if matches!((ctx.program, subcommand), ("bun", Some(subcommand)) if is_non_exec_package_subcommand(subcommand))
	{
		return pkg::filter(ctx, input, exit_code);
	}
	if is_test_invocation(ctx.program, subcommand, ctx.command) {
		return node_tests::filter(ctx, input, exit_code);
	}
	if is_lint_invocation(ctx.program, subcommand, ctx.command) {
		return lint::filter(ctx, input, exit_code);
	}
	if is_cpp_invocation(ctx.program, subcommand, ctx.command) {
		return cpp::filter(ctx, input, exit_code);
	}
	if is_js_tool_invocation(ctx.program, subcommand, ctx.command) {
		return js_tools::filter(ctx, input, exit_code);
	}
	match (ctx.program, subcommand) {
		("bun", Some(subcommand)) if BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand) => {
			pkg::filter(ctx, input, exit_code)
		},
		("bun", Some("build")) => filter_bun_build(input, exit_code),
		_ => generic::filter(ctx, input, exit_code),
	}
}

fn is_non_exec_package_subcommand(subcommand: &str) -> bool {
	BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand) && !matches!(subcommand, "run" | "exec")
}

fn is_test_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!(
		(program, subcommand),
		("bun", Some("test")) | ("bunx", Some("jest" | "vitest" | "playwright"))
	) || is_exec_package_subcommand(program, subcommand)
		&& command_contains_tool(command, &["jest", "vitest", "playwright"])
}

fn is_exec_package_subcommand(program: &str, subcommand: Option<&str>) -> bool {
	matches!((program, subcommand), ("bun", Some("run" | "exec")))
}

fn is_lint_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bun" | "bunx", Some("tsc" | "eslint" | "biome")))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_contains_tool(command, &["tsc", "eslint", "biome"])
}

fn is_js_tool_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bun" | "bunx", Some("next" | "prettier" | "prisma")))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_contains_tool(command, &["next", "prettier", "prisma"])
}
fn is_cpp_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bunx", Some(subcommand)) if BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand))
		|| is_exec_package_subcommand(program, subcommand) && cpp::supports_invocation(command)
}

fn command_contains_tool(command: &str, tools: &[&str]) -> bool {
	command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.any(|token| tools.contains(&token))
}

fn filter_bun_build(input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let mut out = String::new();
	for line in cleaned.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_bun_build_noise(trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	let text = if out.trim().is_empty() {
		primitives::head_tail_lines(&cleaned, 120, 80)
	} else {
		primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 120, 80)
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_bun_build_noise(line: &str, exit_code: i32) -> bool {
	if exit_code != 0 && is_important(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	lower.starts_with("bun build ")
		|| lower.starts_with("bundled ") && lower.contains(" in ")
		|| lower.starts_with("transpiled ")
		|| lower.starts_with("resolving ")
		|| lower.starts_with("installing ")
		|| lower.starts_with("saved lockfile")
}

fn is_important(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("panic")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config }
	}

	#[test]
	fn supports_bun_package_test_and_tool_subcommands() {
		for subcommand in ["install", "add", "run", "test", "build", "tsc", "next", "ctest"] {
			assert!(supports("bun", Some(subcommand)), "{subcommand} should be supported");
		}
		assert!(supports("bunx", Some("vitest")));
		assert!(supports("bunx", Some("cmake")));
		assert!(!supports("bun", Some("unknown")));
	}

	#[test]
	fn bun_install_uses_package_noise_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("install"), "bun install", &cfg);
		let out = filter(&ctx, "Resolving dependencies\nDownloaded left-pad\nerror: failed\n", 1);
		assert!(!out.text.contains("Resolving dependencies"));
		assert!(out.text.contains("error: failed"));
	}

	#[test]
	fn bun_add_known_tool_package_names_use_package_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for package in ["eslint", "prettier", "jest"] {
			let command = format!("bun add {package}");
			let ctx = ctx("bun", Some("add"), &command, &cfg);
			let input = format!("Resolving dependencies\nDownloaded {package}\nerror: failed\n");
			let out = filter(&ctx, &input, 1);
			assert!(
				!out.text.contains("Resolving dependencies"),
				"{package} should use package filtering"
			);
			assert!(!out.text.contains("Downloaded"), "{package} should strip package download noise");
			assert!(out.text.contains("error: failed"));
		}
	}

	#[test]
	fn bun_next_build_uses_next_route_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for (subcommand, command) in
			[(Some("next"), "bun next build"), (Some("run"), "bun run next build")]
		{
			let ctx = ctx("bun", subcommand, command, &cfg);
			let out = filter(
				&ctx,
				"   ▲ Next.js 15.2.0\nCreating an optimized production build ...\nRoute (app)                    Size     First Load JS\n┌ ○ /                          1.2 kB        132 kB\n✓ Built in 34.2s\n",
				0,
			);
			assert!(out.text.contains("Route (app)"));
			assert!(out.text.contains('/'));
			assert!(out.text.contains("Built in 34.2s"));
			assert!(!out.text.contains("Creating an optimized"));
		}
	}

	#[test]
	fn bun_test_uses_test_failure_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("test"), "bun test", &cfg);
		let out = filter(&ctx, "✓ ok\nFAIL app.test.ts\nError: nope\nTests 1 failed\n", 1);
		assert!(!out.text.contains("✓ ok"));
		assert!(out.text.contains("FAIL app.test.ts"));
		assert!(out.text.contains("Tests 1 failed"));
	}

	#[test]
	fn bun_run_cpp_tool_uses_cpp_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run ctest --output-on-failure", &cfg);
		let out = filter(
			&ctx,
			"Test project /tmp/build\n    Start 1: ok\n1/2 Test #1: ok ........   Passed    0.01 \
			 sec\n2/2 Test #2: bad .......***Failed    0.02 sec\nThe following tests FAILED:\n\t  2 \
			 - bad (Failed)\n",
			8,
		);
		assert!(!out.text.contains("Test #1"));
		assert!(out.text.contains("Test #2: bad"));
		assert!(out.text.contains("The following tests FAILED"));
	}

	#[test]
	fn bun_build_strips_success_noise_but_keeps_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("build"), "bun build src/index.ts", &cfg);
		let out = filter(
			&ctx,
			"bun build src/index.ts\nBundled 12 modules in 20ms\nerror: missing export\n",
			1,
		);
		assert!(!out.text.contains("Bundled 12 modules"));
		assert!(out.text.contains("error: missing export"));
	}
}
