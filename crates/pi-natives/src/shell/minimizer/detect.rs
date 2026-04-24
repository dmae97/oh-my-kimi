//! Best-effort command detection for minimizer dispatch.

/// Parsed command identity used for filter dispatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandIdentity {
	pub program:    String,
	pub subcommand: Option<String>,
}

/// Extract the executable and the relevant subcommand from a shell command.
///
/// The detector intentionally handles the common interactive subset instead
/// of emulating a full shell parser. Ambiguous commands return `None` and are
/// left streaming unchanged.
pub fn detect(command: &str) -> Option<CommandIdentity> {
	let tokens = tokenize(command);
	let tokens = strip_launch_prefix(&tokens)?;
	let (program, rest) = tokens.split_first()?;
	let normalized = normalize_program(program)?;
	let subcommand = detect_subcommand(&normalized, rest);
	Some(CommandIdentity { program: normalized, subcommand })
}

fn strip_launch_prefix(tokens: &[String]) -> Option<&[String]> {
	let mut index = 0;

	loop {
		let before = index;
		while tokens
			.get(index)
			.is_some_and(|token| is_env_assignment(token))
		{
			index += 1;
		}

		let token = tokens.get(index)?;

		match token.as_str() {
			"env" => {
				index = skip_env_options(tokens, index + 1)?;
			},
			"sudo" => {
				index = skip_sudo_options(tokens, index + 1)?;
			},
			"command" => {
				index = skip_command_options(tokens, index + 1)?;
			},
			"builtin" | "noglob" => {
				index += 1;
			},
			"exec" => {
				index = skip_exec_options(tokens, index + 1)?;
			},
			"time" => {
				index = skip_time_options(tokens, index + 1)?;
			},
			_ => {},
		}

		if index == before {
			break;
		}
	}

	Some(&tokens[index..])
}

fn is_env_assignment(token: &str) -> bool {
	let Some((name, _)) = token.split_once('=') else {
		return false;
	};
	let mut chars = name.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	(first == '_' || first.is_ascii_alphabetic())
		&& chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn normalize_program(program: &str) -> Option<String> {
	let name = program.rsplit('/').next()?;
	if name.is_empty() {
		return None;
	}
	Some(name.to_lowercase())
}

fn skip_env_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-S" | "--split-string" => return None,
			"-i" | "-" | "--ignore-environment" => index += 1,
			"-u" | "--unset" | "-C" | "--chdir" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with("--unset=") || token.starts_with("--chdir=") => index += 1,
			_ if is_env_assignment(token) => index += 1,
			_ => break,
		}
	}
	Some(index)
}

fn skip_sudo_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-E" | "-H" | "-n" | "-S" | "-k" | "-K" | "-b" => index += 1,
			"-u" | "--user" | "-g" | "--group" | "-h" | "--host" | "-p" | "--prompt" | "-C"
			| "--close-from" | "-T" | "--command-timeout" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with("--user=")
				|| token.starts_with("--group=")
				|| token.starts_with("--host=")
				|| token.starts_with("--prompt=")
				|| token.starts_with("--close-from=")
				|| token.starts_with("--command-timeout=") =>
			{
				index += 1;
			},
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_command_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-p" => index += 1,
			"-v" | "-V" => return None,
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_exec_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-c" | "-l" => index += 1,
			"-a" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_time_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-p" | "--portability" | "-v" | "--verbose" => index += 1,
			"-f" | "--format" | "-o" | "--output" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with("--format=") || token.starts_with("--output=") => index += 1,
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_option_value(tokens: &[String], index: usize) -> Option<usize> {
	let token = tokens.get(index)?;
	if token.starts_with("--") && token.contains('=') {
		return Some(index + 1);
	}
	if token.starts_with('-') && !token.starts_with("--") && token.len() > 2 {
		return Some(index + 1);
	}
	tokens.get(index + 1).map(|_| index + 2)
}

fn detect_subcommand(program: &str, args: &[String]) -> Option<String> {
	match program {
		"git" | "yadm" => first_non_global_arg(
			args,
			&["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--html-path"],
			&[
				"--bare",
				"--no-pager",
				"--paginate",
				"--no-optional-locks",
				"--literal-pathspecs",
				"--glob-pathspecs",
				"--noglob-pathspecs",
				"--icase-pathspecs",
				"--no-replace-objects",
			],
			&[],
		),
		"cargo" => first_non_global_arg(
			args,
			&["--manifest-path", "--target-dir", "--config", "-Z", "--color", "--jobs", "-j"],
			&[
				"--locked",
				"--offline",
				"--frozen",
				"--workspace",
				"--all",
				"--verbose",
				"-v",
				"--quiet",
				"-q",
			],
			&["+"],
		),
		"docker" => first_non_global_arg(
			args,
			&[
				"--config",
				"--context",
				"-c",
				"--host",
				"-H",
				"--log-level",
				"--tlscacert",
				"--tlscert",
				"--tlskey",
			],
			&["--debug", "-D", "--tls", "--tlsverify"],
			&[],
		),
		"gh" => first_non_global_arg(
			args,
			&["--repo", "-R", "--hostname", "--jq", "--template"],
			&["--paginate", "--slurp", "--verbose"],
			&[],
		),
		"gt" => first_non_global_arg(
			args,
			&["--repo", "--cwd", "--config", "--debug-context"],
			&["--no-interactive", "--interactive", "--version", "--help"],
			&[],
		),
		"npm" => first_non_global_arg(
			args,
			&["--prefix", "-C", "--workspace", "-w", "--userconfig", "--cache", "--registry"],
			&[
				"--global",
				"-g",
				"--workspaces",
				"--include-workspace-root",
				"--offline",
				"--prefer-offline",
			],
			&[],
		),
		"pnpm" => first_non_global_arg(
			args,
			&["--dir", "-C", "--filter", "-F", "--workspace", "--config", "--store-dir"],
			&["--global", "-g", "--workspace-root", "-w", "--offline", "--recursive", "-r"],
			&[],
		),
		"yarn" => first_non_global_arg(
			args,
			&["--cwd", "--cache-folder", "--global-folder", "--modules-folder", "--mutex"],
			&["--offline", "--silent", "--verbose"],
			&[],
		),
		"bun" => first_non_global_arg(
			args,
			&["--cwd", "-C", "--config", "--registry", "--cache-dir"],
			&["--bun", "--silent", "--verbose", "--watch", "--hot", "--no-clear-screen"],
			&[],
		),
		"pip" | "pip3" => first_non_global_arg(
			args,
			&[
				"--python",
				"--cache-dir",
				"--proxy",
				"--timeout",
				"--trusted-host",
				"--cert",
				"--client-cert",
			],
			&["--isolated", "--require-virtualenv", "--no-cache-dir", "--disable-pip-version-check"],
			&[],
		),
		"bundle" => first_non_global_arg(
			args,
			&["--gemfile", "--path", "--jobs", "--retry"],
			&["--verbose", "--quiet", "--no-color"],
			&[],
		),
		"jest" | "vitest" => first_non_global_arg(args, &[], &[], &[]),
		_ => args
			.iter()
			.find(|arg| !arg.starts_with('-'))
			.map(|arg| arg.to_lowercase()),
	}
}

fn first_non_global_arg(
	args: &[String],
	flags_with_values: &[&str],
	flag_only: &[&str],
	bare_prefixes: &[&str],
) -> Option<String> {
	let mut index = 0;
	while let Some(arg) = args.get(index) {
		if arg == "--" {
			return args.get(index + 1).map(|value| value.to_lowercase());
		}
		if bare_prefixes.iter().any(|prefix| arg.starts_with(prefix)) {
			index += 1;
			continue;
		}
		if flag_only.contains(&arg.as_str()) {
			index += 1;
			continue;
		}
		if option_consumes_value(arg, flags_with_values) {
			index += if option_has_inline_value(arg, flags_with_values) {
				1
			} else {
				2
			};
			continue;
		}
		if arg.starts_with('-') {
			index += 1;
			continue;
		}
		return Some(arg.to_lowercase());
	}
	None
}

fn option_consumes_value(arg: &str, flags_with_values: &[&str]) -> bool {
	flags_with_values.iter().any(|flag| {
		arg == *flag
			|| (flag.starts_with("--") && arg.starts_with(&format!("{flag}=")))
			|| (!flag.starts_with("--") && arg.starts_with(flag) && arg.len() > flag.len())
	})
}

fn option_has_inline_value(arg: &str, flags_with_values: &[&str]) -> bool {
	flags_with_values.iter().any(|flag| {
		(flag.starts_with("--") && arg.starts_with(&format!("{flag}=")))
			|| (!flag.starts_with("--") && arg.starts_with(flag) && arg.len() > flag.len())
	})
}

fn tokenize(command: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	let mut current = String::new();
	let mut chars = command.chars();
	let mut quote: Option<char> = None;
	while let Some(ch) = chars.next() {
		match (quote, ch) {
			(None, '\'' | '"') => quote = Some(ch),
			(Some(q), c) if c == q => quote = None,
			(None, '\\') => {
				if let Some(next) = chars.next() {
					current.push(next);
				}
			},
			(None, c) if c.is_whitespace() => {
				if !current.is_empty() {
					tokens.push(std::mem::take(&mut current));
				}
			},
			(None, ';' | '|' | '&') => break,
			(_, c) => current.push(c),
		}
	}
	if !current.is_empty() {
		tokens.push(current);
	}
	tokens
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn detects_basic_program_and_subcommand() {
		let command = detect("git status --short").expect("git command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn skips_env_prefix_and_git_globals() {
		let command = detect("FOO=1 git -C repo -c color.ui=false status")
			.expect("git command after env assignment is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn handles_quoted_program_args() {
		let command = detect("env FOO=bar cargo --manifest-path 'a b/Cargo.toml' test")
			.expect("cargo command is detected");
		assert_eq!(command.program, "cargo");
		assert_eq!(command.subcommand.as_deref(), Some("test"));
	}

	#[test]
	fn normalizes_env_and_executable_path() {
		let command = detect("env FOO=1 /usr/bin/git status").expect("path command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn skips_shell_launch_wrappers() {
		let command = detect("sudo -E command -p /usr/bin/git --no-pager status")
			.expect("wrapped command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn skips_cargo_toolchain_and_globals() {
		let command = detect("cargo +nightly --manifest-path path/Cargo.toml clippy")
			.expect("cargo command is detected");
		assert_eq!(command.program, "cargo");
		assert_eq!(command.subcommand.as_deref(), Some("clippy"));
	}

	#[test]
	fn skips_package_manager_globals() {
		let command = detect("pnpm --filter @app/web install").expect("pnpm command is detected");
		assert_eq!(command.program, "pnpm");
		assert_eq!(command.subcommand.as_deref(), Some("install"));
	}

	#[test]
	fn stops_at_compound_command_boundary() {
		let command = detect("git -C repo status | cat").expect("first command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn returns_none_for_non_launching_wrappers() {
		assert!(detect("command -v git").is_none());
		assert!(detect("env -S 'git status'").is_none());
	}

	#[test]
	fn detects_gt_through_wrappers_and_globals() {
		let command = detect("env GRAPHITE_TOKEN=x command gt --repo owner/repo submit --stack")
			.expect("gt command is detected");
		assert_eq!(command.program, "gt");
		assert_eq!(command.subcommand.as_deref(), Some("submit"));
	}

	#[test]
	fn detects_gt_inline_global_value() {
		let command = detect("gt --repo=owner/repo sync").expect("gt command is detected");
		assert_eq!(command.program, "gt");
		assert_eq!(command.subcommand.as_deref(), Some("sync"));
	}
}

#[test]
fn detects_bun_globals_and_subcommands() {
	let command = detect("bun --cwd packages/app install").expect("bun command is detected");
	assert_eq!(command.program, "bun");
	assert_eq!(command.subcommand.as_deref(), Some("install"));

	let command = detect("env CI=1 /usr/local/bin/bun test").expect("bun test is detected");
	assert_eq!(command.program, "bun");
	assert_eq!(command.subcommand.as_deref(), Some("test"));
}
