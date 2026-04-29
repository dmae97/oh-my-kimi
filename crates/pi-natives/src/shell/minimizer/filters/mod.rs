//! Filter dispatch table for built-in minimizer strategies.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput};

pub mod cloud;
pub mod cpp;

pub mod bun;

pub mod cargo;
pub mod docker;

pub mod dotnet;

pub mod generic;
pub mod gh;

pub mod go;
pub mod gt;

pub mod git;

pub mod js_tools;

pub mod lint;
pub mod listing;
pub mod node_tests;
pub mod pkg;

pub mod python;
pub mod ruby;
pub mod system;

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"git" | "yadm" => git::supports(subcommand),
		"gt" => gt::supports(program, subcommand),
		"bun" | "bunx" => bun::supports(program, subcommand),
		"cargo" => cargo::supports(subcommand),
		"go" | "golangci-lint" => go::supports(program, subcommand),
		"cmake" | "ctest" | "ninja" | "gtest" | "gtest-parallel" => {
			cpp::supports(program, subcommand)
		},
		program if cpp::is_gtest_binary_name(program) => cpp::supports(program, subcommand),
		"dotnet" => dotnet::supports(program, subcommand),
		"ls" | "tree" | "find" | "grep" | "rg" | "wc" | "cat" | "read" | "stat" | "du" | "df"
		| "jq" | "json" => true,
		"aws" | "curl" | "wget" | "psql" => cloud::supports(program, subcommand),
		"docker" | "kubectl" | "helm" => docker::supports(subcommand),
		"gh" => gh::supports(subcommand),
		"pytest" | "ruff" | "mypy" | "python" | "python3" | "py" => {
			python::supports(program, subcommand)
		},
		"rspec" | "rake" | "rails" | "rubocop" => ruby::supports(program, subcommand),
		"tsc" | "eslint" | "biome" | "shellcheck" | "markdownlint" | "hadolint" | "yamllint"
		| "oxlint" | "pyright" | "basedpyright" => {
			lint::supports(subcommand) || lint::supports_program(program, subcommand)
		},
		"jest" | "vitest" | "playwright" => true,
		"next" | "prettier" | "prisma" => js_tools::supports(program, subcommand),
		"npx" => {
			matches!(subcommand, Some("tsc" | "eslint" | "biome" | "jest" | "vitest" | "playwright"))
				|| js_tools::supports(program, subcommand)
		},
		"pnpm" if matches!(subcommand, Some("dlx")) => true,
		"npm" | "pnpm" | "yarn" | "pip" | "pip3" | "bundle" | "brew" | "composer" | "uv"
		| "poetry" => pkg::supports(subcommand),
		"env" | "log" | "deps" | "summary" | "err" | "test" | "diff" | "format" | "pipe" | "ps"
		| "ping" | "ssh" | "sops" => system::supports(program),
		_ => false,
	}
}

/// Apply the matching built-in filter.
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let _ = ctx.command;
	let _ = ctx.config.per_command(ctx.program);
	match ctx.program {
		"git" | "yadm" => git::filter(ctx, input, exit_code),
		"gt" => gt::filter(ctx, input, exit_code),
		"bun" | "bunx" => bun::filter(ctx, input, exit_code),
		"cargo" => cargo::filter(ctx, input, exit_code),
		"go" | "golangci-lint" => go::filter(ctx, input, exit_code),
		"dotnet" => dotnet::filter(ctx, input, exit_code),
		"cmake" | "ctest" | "ninja" | "gtest" | "gtest-parallel" => {
			cpp::filter(ctx, input, exit_code)
		},
		program if cpp::is_gtest_binary_name(program) => cpp::filter(ctx, input, exit_code),
		"ls" | "tree" | "find" | "grep" | "rg" | "wc" | "cat" | "read" | "stat" | "du" | "df"
		| "jq" | "json" => listing::filter(ctx, input, exit_code),
		"aws" | "curl" | "wget" | "psql" => cloud::filter(ctx, input, exit_code),
		"docker" | "kubectl" | "helm" => docker::filter(ctx, input, exit_code),
		"gh" => gh::filter(ctx, input, exit_code),
		"pytest" | "ruff" | "mypy" | "python" | "python3" | "py" => {
			python::filter(ctx, input, exit_code)
		},
		"rspec" | "rake" | "rails" | "rubocop" => ruby::filter(ctx, input, exit_code),
		"tsc" | "eslint" | "biome" | "shellcheck" | "markdownlint" | "hadolint" | "yamllint"
		| "oxlint" | "pyright" | "basedpyright" => lint::filter(ctx, input, exit_code),
		"jest" | "vitest" | "playwright" => node_tests::filter(ctx, input, exit_code),
		"next" | "prettier" | "prisma" => js_tools::filter(ctx, input, exit_code),
		"npx" => filter_js_wrapper(ctx, input, exit_code),
		"pnpm" if matches!(ctx.subcommand, Some("dlx")) => filter_js_wrapper(ctx, input, exit_code),
		"npm" | "pnpm" | "yarn" | "pip" | "pip3" | "bundle" | "brew" | "composer" | "uv"
		| "poetry" => pkg::filter(ctx, input, exit_code),
		"env" | "log" | "deps" | "summary" | "err" | "test" | "diff" | "format" | "pipe" | "ps"
		| "ping" | "ssh" | "sops" => system::filter(ctx, input, exit_code),
		_ => generic::filter(ctx, input, exit_code),
	}
}

fn filter_js_wrapper(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if wrapper_invokes(ctx, &["tsc", "eslint", "biome"]) {
		lint::filter(ctx, input, exit_code)
	} else if wrapper_invokes(ctx, &["jest", "vitest", "playwright"]) {
		node_tests::filter(ctx, input, exit_code)
	} else if js_tools::supports(ctx.program, ctx.subcommand) {
		js_tools::filter(ctx, input, exit_code)
	} else {
		MinimizerOutput::passthrough(input)
	}
}

fn wrapper_invokes(ctx: &MinimizerCtx<'_>, tools: &[&str]) -> bool {
	ctx.subcommand
		.is_some_and(|subcommand| tools.contains(&subcommand))
		|| ctx
			.command
			.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
			.any(|token| tools.contains(&token))
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
	fn npx_test_tools_route_to_node_test_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("npx", Some("vitest"), "npx vitest", &config);
		let input = "✓ passes\nFAIL src/example.test.ts\nAssertionError: expected true\nTests: 1 \
		             failed, 1 passed\n";
		let out = filter(&context, input, 1).text;
		assert!(!out.contains("✓ passes"));
		assert!(out.contains("FAIL src/example.test.ts"));
		assert!(out.contains("AssertionError"));
	}

	#[test]
	fn pnpm_dlx_unknown_tool_is_passthrough() {
		let config = MinimizerConfig::default();
		let context = ctx("pnpm", Some("dlx"), "pnpm dlx unknown-tool", &config);
		let input = "line 1\nline 2\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	#[test]
	fn pi_cli_names_are_not_supported() {
		assert!(!supports("rtk", None));
		assert!(!supports("pi", None));
	}
}
