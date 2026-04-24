//! Filesystem listing and search filters.

use std::{collections::BTreeMap, path::Path};

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = if exit_code != 0 {
		cleaned
	} else {
		match ctx.program {
			"grep" | "rg" => compact_grep_output(&cleaned),
			"ls" => compact_ls_output(&cleaned).unwrap_or_else(|| compact_listing_output(&cleaned)),
			"tree" => compact_listing_output(&cleaned),
			"find" => compact_find_output(&cleaned),
			"cat" | "read" => compact_cat_output(ctx, &cleaned),
			"stat" | "du" | "df" | "wc" => compact_summary_output(&cleaned),
			"jq" | "json" => cleaned,
			_ => cleaned,
		}
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn compact_listing_output(input: &str) -> String {
	primitives::compact_listing(input, 80)
}

struct GrepMatch {
	line_no: String,
	text:    String,
}

fn compact_grep_output(input: &str) -> String {
	let mut grouped: BTreeMap<String, Vec<GrepMatch>> = BTreeMap::new();
	let mut ungrouped = Vec::new();

	for line in input.lines() {
		if let Some((file, line_no, text)) = split_grep_line(line) {
			grouped
				.entry(file.to_string())
				.or_default()
				.push(GrepMatch { line_no: line_no.to_string(), text: collapse_match_text(text) });
		} else if !line.trim().is_empty() {
			ungrouped.push(line.to_string());
		}
	}

	let match_count: usize = grouped.values().map(Vec::len).sum();
	if grouped.is_empty() || match_count <= 12 && grouped.len() <= 3 {
		return primitives::group_by_file(input, 12);
	}

	let mut out = format!("grep: {match_count} matches in {} files\n", grouped.len());
	let mut shown_matches = 0usize;
	let mut shown_files = 0usize;
	for (file, matches) in &grouped {
		if shown_files >= 12 {
			break;
		}
		shown_files += 1;
		out.push('\n');
		out.push_str(file);
		out.push_str(":\n");
		for entry in matches.iter().take(4) {
			shown_matches += 1;
			out.push_str("  ");
			out.push_str(&entry.line_no);
			out.push_str(": ");
			out.push_str(&entry.text);
			out.push('\n');
		}
		if matches.len() > 4 {
			out.push_str("  … ");
			out.push_str(&(matches.len() - 4).to_string());
			out.push_str(" more in file\n");
		}
	}

	let omitted_files = grouped.len().saturating_sub(shown_files);
	let omitted_matches = match_count.saturating_sub(shown_matches);
	if omitted_files > 0 || omitted_matches > 0 {
		out.push_str("\n… ");
		out.push_str(&omitted_matches.to_string());
		out.push_str(" matches");
		if omitted_files > 0 {
			out.push_str(" in ");
			out.push_str(&omitted_files.to_string());
			out.push_str(" files");
		}
		out.push_str(" omitted\n");
	}
	for line in ungrouped {
		out.push_str(&line);
		out.push('\n');
	}
	out
}

fn split_grep_line(line: &str) -> Option<(&str, &str, &str)> {
	let (file, rest) = line.split_once(':')?;
	if file.is_empty() || file.starts_with(' ') {
		return None;
	}
	let (line_no, text) = rest.split_once(':')?;
	if !line_no.chars().all(|ch| ch.is_ascii_digit()) {
		return None;
	}
	Some((file, line_no, text.trim_start()))
}

fn collapse_match_text(text: &str) -> String {
	let collapsed = collapse_parenthesized_segment(text, 48);
	primitives::truncate_line(&collapsed, 140)
}

fn collapse_parenthesized_segment(text: &str, min_len: usize) -> String {
	let Some(open) = text.find('(') else {
		return text.to_string();
	};
	let Some(close_rel) = text[open + 1..].find(')') else {
		return text.to_string();
	};
	let close = open + 1 + close_rel;
	if close.saturating_sub(open) < min_len {
		return text.to_string();
	}
	let mut out = String::new();
	out.push_str(&text[..=open]);
	out.push_str("...");
	out.push_str(&text[close..]);
	out
}

fn compact_find_output(input: &str) -> String {
	let paths: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if paths.len() <= 20 {
		return input.to_string();
	}

	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut skipped_noise = 0usize;
	for raw in &paths {
		let normalized = normalize_listing_path(raw);
		if normalized.is_empty() {
			continue;
		}
		if path_has_noise_dir(&normalized) {
			skipped_noise += 1;
			continue;
		}
		let path = Path::new(&normalized);
		let name = path
			.file_name()
			.and_then(|value| value.to_str())
			.map_or_else(|| normalized.clone(), ToString::to_string);
		let dir = path
			.parent()
			.and_then(|value| value.to_str())
			.filter(|value| !value.is_empty())
			.map_or(".", |value| value);
		grouped.entry(dir.to_string()).or_default().push(name);
	}

	if grouped.is_empty() {
		return primitives::compact_listing(input, 80);
	}

	let mut out = format!("find: {} paths in {} dirs\n", paths.len(), grouped.len());
	for (dir, names) in grouped.iter().take(16) {
		out.push('\n');
		out.push_str(dir);
		out.push_str("/ ");
		push_wrapped_names(&mut out, names, 4, 24);
	}
	if grouped.len() > 16 {
		out.push_str("\n… ");
		out.push_str(&(grouped.len() - 16).to_string());
		out.push_str(" dirs omitted\n");
	}
	if skipped_noise > 0 {
		out.push_str("… ");
		out.push_str(&skipped_noise.to_string());
		out.push_str(" noisy paths omitted\n");
	}
	out
}

fn normalize_listing_path(raw: &str) -> String {
	raw.trim()
		.trim_start_matches("./")
		.trim_end_matches('/')
		.to_string()
}

fn path_has_noise_dir(path: &str) -> bool {
	path.split('/').any(|part| {
		matches!(
			part,
			".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo" | ".cache"
		)
	})
}

fn push_wrapped_names(out: &mut String, names: &[String], per_line: usize, max_names: usize) {
	let shown = names.len().min(max_names);
	for (idx, name) in names.iter().take(shown).enumerate() {
		if idx > 0 {
			if idx % per_line == 0 {
				out.push_str("\n  ");
			} else {
				out.push(' ');
			}
		}
		out.push_str(name);
	}
	out.push('\n');
	if names.len() > max_names {
		out.push_str("  … ");
		out.push_str(&(names.len() - max_names).to_string());
		out.push_str(" more\n");
	}
}

struct LsEntry {
	name:    String,
	is_dir:  bool,
	size:    Option<u64>,
	is_file: bool,
}

fn compact_ls_output(input: &str) -> Option<String> {
	let entries: Vec<LsEntry> = input.lines().filter_map(parse_ls_long_line).collect();
	if entries.len() <= 20 {
		return None;
	}

	let dir_count = entries.iter().filter(|entry| entry.is_dir).count();
	let file_count = entries.iter().filter(|entry| entry.is_file).count();
	let mut ext_counts: BTreeMap<String, usize> = BTreeMap::new();
	for entry in entries.iter().filter(|entry| entry.is_file) {
		if let Some(ext) = Path::new(&entry.name)
			.extension()
			.and_then(|value| value.to_str())
		{
			*ext_counts.entry(ext.to_string()).or_default() += 1;
		}
	}

	let mut out = String::new();
	for entry in entries.iter().filter(|entry| entry.is_dir).take(12) {
		out.push_str(&entry.name);
		out.push_str("/\n");
	}
	for entry in entries.iter().filter(|entry| entry.is_file).take(36) {
		out.push_str(&entry.name);
		if let Some(size) = entry.size {
			out.push_str("  ");
			out.push_str(&format_human_size(size));
		}
		out.push('\n');
	}
	let shown = dir_count.min(12) + file_count.min(36);
	if entries.len() > shown {
		out.push_str("… ");
		out.push_str(&(entries.len() - shown).to_string());
		out.push_str(" entries omitted\n");
	}
	out.push('\n');
	out.push_str(&file_count.to_string());
	out.push_str(" files, ");
	out.push_str(&dir_count.to_string());
	out.push_str(" dirs");
	if !ext_counts.is_empty() {
		let ext_summary = ext_counts
			.iter()
			.take(4)
			.map(|(ext, count)| format!("{count} .{ext}"))
			.collect::<Vec<_>>()
			.join(", ");
		out.push_str(" (");
		out.push_str(&ext_summary);
		out.push(')');
	}
	out.push('\n');
	Some(out)
}

fn parse_ls_long_line(line: &str) -> Option<LsEntry> {
	let trimmed = line.trim();
	if trimmed.starts_with("total ") || trimmed.is_empty() {
		return None;
	}
	let kind = trimmed.chars().next()?;
	if !matches!(kind, 'd' | '-' | 'l') {
		return None;
	}
	let parts: Vec<&str> = trimmed.split_whitespace().collect();
	if parts.len() < 9 {
		return None;
	}
	let name = parts[8..].join(" ");
	if matches!(name.as_str(), "." | "..") {
		return None;
	}
	Some(LsEntry {
		name,
		is_dir: kind == 'd',
		size: parts.get(4).and_then(|value| value.parse().ok()),
		is_file: kind == '-',
	})
}

fn format_human_size(size: u64) -> String {
	const KIB: f64 = 1024.0;
	const MIB: f64 = 1024.0 * 1024.0;
	const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
	let value = size as f64;
	if value >= GIB {
		format!("{:.1}G", value / GIB)
	} else if value >= MIB {
		format!("{:.1}M", value / MIB)
	} else if value >= KIB {
		format!("{:.1}K", value / KIB)
	} else {
		format!("{size}B")
	}
}

fn compact_cat_output(ctx: &MinimizerCtx<'_>, input: &str) -> String {
	let Some(path) = extract_single_path_arg(ctx.command, ctx.program) else {
		return input.to_string();
	};
	if let Some(summary) = summarize_manifest(&path, input) {
		return summary;
	}
	if !is_source_path(&path) {
		return input.to_string();
	}
	compact_source_outline(input)
}

fn extract_single_path_arg(command: &str, program: &str) -> Option<String> {
	let mut saw_program = false;
	for raw in command.split_whitespace() {
		let token = raw.trim_matches(|ch| ch == '\'' || ch == '"');
		let normalized = token.rsplit('/').next().unwrap_or(token);
		if !saw_program {
			if normalized == program {
				saw_program = true;
			}
			continue;
		}
		if token.starts_with('-') {
			continue;
		}
		return Some(token.to_string());
	}
	None
}

fn summarize_manifest(path: &str, input: &str) -> Option<String> {
	let name = Path::new(path).file_name()?.to_str()?;
	match name {
		"Cargo.toml" => summarize_cargo_toml(input),
		"package.json" => summarize_package_json(input),
		"go.mod" => summarize_go_mod(input),
		_ => None,
	}
}

fn summarize_cargo_toml(input: &str) -> Option<String> {
	let mut package_name = None;
	let mut dependencies = Vec::new();
	let mut section = "";
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.starts_with('[') && trimmed.ends_with(']') {
			section = trimmed.trim_matches(&['[', ']'][..]);
			continue;
		}
		if section == "package" && trimmed.starts_with("name") && package_name.is_none() {
			package_name = parse_toml_string_value(trimmed);
			continue;
		}
		if matches!(section, "dependencies" | "dev-dependencies" | "build-dependencies")
			&& let Some(dep) = parse_toml_dependency_line(trimmed)
		{
			dependencies.push(dep);
		}
	}
	if dependencies.is_empty() {
		return None;
	}
	let mut out = String::from("Cargo.toml");
	if let Some(name) = package_name {
		out.push_str(": ");
		out.push_str(&name);
	}
	out.push('\n');
	out.push_str("dependencies: ");
	out.push_str(&dependencies.len().to_string());
	out.push('\n');
	for dep in dependencies.iter().take(15) {
		out.push_str("  ");
		out.push_str(dep);
		out.push('\n');
	}
	if dependencies.len() > 15 {
		out.push_str("  … ");
		out.push_str(&(dependencies.len() - 15).to_string());
		out.push_str(" more\n");
	}
	Some(out)
}

fn parse_toml_string_value(line: &str) -> Option<String> {
	let (_, value) = line.split_once('=')?;
	let value = value.trim();
	Some(value.trim_matches('"').to_string())
}

fn parse_toml_dependency_line(line: &str) -> Option<String> {
	if line.is_empty() || line.starts_with('#') {
		return None;
	}
	let (name, value) = line.split_once('=')?;
	let name = name.trim();
	if name.is_empty() {
		return None;
	}
	let version = parse_dependency_version(value.trim());
	Some(match version {
		Some(version) => format!("{name} {version}"),
		None => name.to_string(),
	})
}

fn parse_dependency_version(value: &str) -> Option<String> {
	if value.starts_with('"') {
		return Some(value.trim_matches('"').to_string());
	}
	if let Some(start) = value.find("version") {
		let after = value[start..].split_once('=')?.1.trim();
		if let Some(rest) = after.strip_prefix('"')
			&& let Some(end) = rest.find('"')
		{
			return Some(rest[..end].to_string());
		}
		return after
			.split_whitespace()
			.next()
			.map(|version| version.trim_matches(&[',', '}'][..]).to_string());
	}
	None
}

fn summarize_package_json(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let name = value.get("name").and_then(|value| value.as_str());
	let mut deps = Vec::new();
	for section in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
		let Some(object) = value.get(section).and_then(|value| value.as_object()) else {
			continue;
		};
		for (dep, version) in object {
			let version = version.as_str().unwrap_or("");
			deps.push(if version.is_empty() {
				dep.clone()
			} else {
				format!("{dep} {version}")
			});
		}
	}
	if deps.is_empty() {
		return None;
	}
	let mut out = String::from("package.json");
	if let Some(name) = name {
		out.push_str(": ");
		out.push_str(name);
	}
	out.push('\n');
	out.push_str("dependencies: ");
	out.push_str(&deps.len().to_string());
	out.push('\n');
	for dep in deps.iter().take(15) {
		out.push_str("  ");
		out.push_str(dep);
		out.push('\n');
	}
	if deps.len() > 15 {
		out.push_str("  … ");
		out.push_str(&(deps.len() - 15).to_string());
		out.push_str(" more\n");
	}
	Some(out)
}

fn summarize_go_mod(input: &str) -> Option<String> {
	let mut module = None;
	let mut deps = Vec::new();
	let mut in_require_block = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if let Some(value) = trimmed.strip_prefix("module ") {
			module = Some(value.trim().to_string());
			continue;
		}
		if trimmed == "require (" {
			in_require_block = true;
			continue;
		}
		if in_require_block && trimmed == ")" {
			in_require_block = false;
			continue;
		}
		if let Some(dep) = parse_go_require_line(trimmed, in_require_block) {
			deps.push(dep);
		}
	}
	if deps.is_empty() {
		return None;
	}
	let mut out = String::from("go.mod");
	if let Some(module) = module {
		out.push_str(": ");
		out.push_str(&module);
	}
	out.push('\n');
	out.push_str("dependencies: ");
	out.push_str(&deps.len().to_string());
	out.push('\n');
	for dep in deps.iter().take(15) {
		out.push_str("  ");
		out.push_str(dep);
		out.push('\n');
	}
	if deps.len() > 15 {
		out.push_str("  … ");
		out.push_str(&(deps.len() - 15).to_string());
		out.push_str(" more\n");
	}
	Some(out)
}

fn parse_go_require_line(line: &str, in_block: bool) -> Option<String> {
	let rest = if in_block {
		line
	} else {
		line.strip_prefix("require ")?
	};
	let mut parts = rest.split_whitespace();
	let name = parts.next()?;
	let version = parts.next().unwrap_or("");
	if name.is_empty() || name.starts_with("//") {
		return None;
	}
	Some(if version.is_empty() {
		name.to_string()
	} else {
		format!("{name} {version}")
	})
}

fn is_source_path(path: &str) -> bool {
	let Some(ext) = Path::new(path).extension().and_then(|value| value.to_str()) else {
		return false;
	};
	matches!(
		ext,
		"rs"
			| "ts" | "tsx"
			| "js" | "jsx"
			| "py" | "go"
			| "java"
			| "c" | "cc"
			| "cpp"
			| "h" | "hpp"
			| "swift"
			| "kt" | "rb"
	)
}

fn compact_source_outline(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() < 160 && input.len() < 12_000 {
		return input.to_string();
	}

	let mut out = String::new();
	let mut emitted = 0usize;
	for line in &lines {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with("//") {
			continue;
		}
		if is_source_import_or_module(trimmed) {
			out.push_str(&primitives::truncate_line(trimmed, 140));
			out.push('\n');
			emitted += 1;
			if emitted >= 40 {
				break;
			}
		}
	}

	if has_content(&out) {
		out.push('\n');
	}

	let mut declarations = 0usize;
	for line in &lines {
		if declarations >= 80 {
			break;
		}
		if line.chars().next().is_some_and(char::is_whitespace) {
			continue;
		}
		let trimmed = line.trim();
		if !is_source_declaration(trimmed) {
			continue;
		}
		out.push_str(&render_source_declaration(trimmed));
		out.push('\n');
		declarations += 1;
	}

	if declarations == 0 {
		return primitives::head_tail_lines(input, 60, 30);
	}
	if lines.len() > emitted + declarations {
		out.push_str("… ");
		out.push_str(&lines.len().to_string());
		out.push_str(" lines summarized\n");
	}
	out
}

fn is_source_import_or_module(trimmed: &str) -> bool {
	trimmed.starts_with("use ")
		|| trimmed.starts_with("mod ")
		|| trimmed.starts_with("import ")
		|| trimmed.starts_with("from ")
		|| trimmed.starts_with("package ")
}

fn is_source_declaration(trimmed: &str) -> bool {
	let without_vis = trimmed
		.strip_prefix("pub ")
		.or_else(|| trimmed.strip_prefix("export "))
		.or_else(|| trimmed.strip_prefix("async "))
		.unwrap_or(trimmed);
	without_vis.starts_with("fn ")
		|| without_vis.starts_with("struct ")
		|| without_vis.starts_with("enum ")
		|| without_vis.starts_with("trait ")
		|| without_vis.starts_with("impl ")
		|| without_vis.starts_with("type ")
		|| without_vis.starts_with("class ")
		|| without_vis.starts_with("interface ")
		|| without_vis.starts_with("function ")
		|| without_vis.starts_with("def ")
}

fn render_source_declaration(trimmed: &str) -> String {
	let line = primitives::truncate_line(trimmed, 160);
	if let Some(before) = line.strip_suffix('{') {
		let mut out = before.trim_end().to_string();
		out.push_str(" { ... }");
		return out;
	}
	if let Some(index) = line.find('{') {
		let mut out = line[..index].trim_end().to_string();
		out.push_str(" { ... }");
		return out;
	}
	line
}

fn compact_summary_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 30 {
		return input.to_string();
	}

	let windowed = primitives::head_tail_lines(input, 12, 12);
	let mut out = String::new();
	for line in lines.iter().copied().filter(|line| is_summary_line(line)) {
		if !windowed.lines().any(|existing| existing == line)
			&& !out.lines().any(|existing| existing == line)
		{
			out.push_str(line);
			out.push('\n');
		}
	}
	out.push_str(&windowed);
	out
}

fn is_summary_line(line: &str) -> bool {
	let trimmed = line.trim();
	let lower = trimmed.to_ascii_lowercase();
	trimmed == "total"
		|| lower.starts_with("total ")
		|| lower.ends_with(" total")
		|| lower.starts_with("filesystem")
		|| lower.contains(" mounted on")
		|| lower.contains(" files ")
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, cfg: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command: program, config: cfg }
	}

	fn ctx_command<'a>(
		program: &'a str,
		command: &'a str,
		cfg: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command, config: cfg }
	}

	#[test]
	fn groups_grep_by_file() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("rg", &cfg);
		let out = filter(&ctx, "a.rs:1:foo\na.rs:2:bar\n", 0);
		assert_eq!(out.text, "a.rs:\n  1:foo\n  2:bar\n");
	}

	#[test]
	fn compacts_large_grep_output_with_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("grep", &cfg);
		let mut input = String::new();
		for idx in 0..20 {
			input.push_str("src/file");
			input.push_str(&idx.to_string());
			input.push_str(
				".rs:17:pub fn run(cmd: CargoCommand, args: &[String], verbose: u8) -> Result<()> {\n",
			);
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.starts_with("grep: 20 matches in 20 files"));
		assert!(out.text.contains("17: pub fn run(...) -> Result<()> {"));
		assert!(out.text.contains("matches in 8 files omitted"));
	}

	#[test]
	fn preserves_long_cat_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("cat", &cfg);
		let input = numbered_lines(130);
		let out = filter(&ctx, &input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn summarizes_cargo_manifest_from_cat() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx_command("cat", "cat Cargo.toml", &cfg);
		let input = "[package]\nname = \"rtk\"\n\n[dependencies]\nclap = { version = \"4\", \
		             features = [\"derive\"] }\nanyhow = \"1.0\"\nserde_json = \"1\"\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(
			out.text,
			"Cargo.toml: rtk\ndependencies: 3\n  clap 4\n  anyhow 1.0\n  serde_json 1\n"
		);
	}

	#[test]
	fn outlines_large_source_cat() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx_command("cat", "cat src/main.rs", &cfg);
		let mut input = String::from("use anyhow::Result;\nmod cargo_cmd;\n\nstruct Cli {\n");
		for idx in 0..180 {
			input.push_str("    field_");
			input.push_str(&idx.to_string());
			input.push_str(": String,\n");
		}
		input.push_str("}\nfn main() -> Result<()> {\n    Ok(())\n}\n");
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("use anyhow::Result;"));
		assert!(out.text.contains("mod cargo_cmd;"));
		assert!(out.text.contains("struct Cli { ... }"));
		assert!(out.text.contains("fn main() -> Result<()> { ... }"));
		assert!(out.text.contains("lines summarized"));
		assert!(!out.text.contains("field_179"));
	}

	#[test]
	fn preserves_short_read_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("read", &cfg);
		let input = "alpha\nbravo\ncharlie\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn compacts_find_paths_by_directory_and_skips_noise_dirs() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("find", &cfg);
		let mut input = String::from("./target/debug/build/out/private.rs\n");
		for idx in 0..30 {
			input.push_str("./src/module");
			input.push_str(&(idx / 10).to_string());
			input.push_str("/file");
			input.push_str(&idx.to_string());
			input.push_str(".rs\n");
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.starts_with("find: 31 paths in 3 dirs"));
		assert!(out.text.contains("src/module0/ file0.rs file1.rs"));
		assert!(out.text.contains("1 noisy paths omitted"));
		assert!(!out.text.contains("target/debug"));
	}

	#[test]
	fn compacts_long_ls_listing() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("ls", &cfg);
		let mut input = String::from("total 928\n");
		input.push_str("drwxr-xr-x  6 user staff 192 2 feb 21:35 discover\n");
		input.push_str("drwxr-xr-x  5 user staff 160 2 feb 21:35 parser\n");
		for idx in 0..25 {
			input.push_str("-rw-r--r--  1 user staff ");
			input.push_str(&(1024 * (idx + 1)).to_string());
			input.push_str(" 2 feb 21:35 file");
			input.push_str(&idx.to_string());
			input.push_str(".rs\n");
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("discover/"));
		assert!(out.text.contains("file0.rs  1.0K"));
		assert!(out.text.contains("25 files, 2 dirs (25 .rs)"));
	}

	#[test]
	fn compacts_df_output_without_losing_filesystem_header() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("df", &cfg);
		let mut input = String::from("Filesystem 1K-blocks Used Available Use% Mounted on\n");
		for idx in 0..36 {
			input.push_str("/dev/disk");
			input.push_str(&idx.to_string());
			input.push_str(" 100 50 50 50% /mnt/");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(
			out.text
				.contains("Filesystem 1K-blocks Used Available Use% Mounted on")
		);
		assert!(out.text.contains("… 13 lines omitted …"));
		assert!(out.text.contains("/dev/disk35"));
	}

	#[test]
	fn json_only_strips_ansi_when_short() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("jq", &cfg);
		let out = filter(&ctx, "\u{1b}[32m{\"ok\":true}\u{1b}[0m\n", 0);
		assert_eq!(out.text, "{\"ok\":true}\n");
	}

	#[test]
	fn preserves_long_json_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("jq", &cfg);
		let input = numbered_lines(150);
		let out = filter(&ctx, &input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn preserves_command_error_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("find", &cfg);
		let input = "find: /private/path: Permission \
		             denied\nresource-with-a-very-long-name-that-must-not-be-truncated\n";
		let out = filter(&ctx, input, 1);
		assert_eq!(out.text, input);
	}

	fn numbered_lines(count: usize) -> String {
		let mut out = String::new();
		for idx in 1..=count {
			out.push_str("line ");
			if idx < 10 {
				out.push_str("00");
			} else if idx < 100 {
				out.push('0');
			}
			out.push_str(&idx.to_string());
			out.push('\n');
		}
		out
	}
}
