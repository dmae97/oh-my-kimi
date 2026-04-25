use crate::chunk::{HASHLINE_BIGRAMS, types::ChunkTree};

const DEFAULT_SPACE_INDENT_STEP: usize = 4;
const MAX_REASONABLE_INDENT_STEP: usize = 8;

pub fn dedent_python_style(text: &str) -> String {
	let mut margin: Option<&str> = None;
	for line in text.split('\n') {
		if line.trim().is_empty() {
			continue;
		}
		let indent = leading_whitespace(line);
		margin = Some(match margin {
			None => indent,
			Some(current) if indent.starts_with(current) => current,
			Some(current) if current.starts_with(indent) => indent,
			Some(current) => common_prefix(current, indent),
		});
	}

	let Some(margin) = margin else {
		return text.to_owned();
	};
	if margin.is_empty() {
		return text.to_owned();
	}

	text
		.split('\n')
		.map(|line| line.strip_prefix(margin).unwrap_or(line))
		.collect::<Vec<_>>()
		.join("\n")
}

pub fn indent_non_empty_lines(text: &str, prefix: &str) -> String {
	if prefix.is_empty() {
		return text.to_owned();
	}
	text
		.split('\n')
		.map(|line| {
			if line.trim().is_empty() {
				line.to_owned()
			} else {
				format!("{prefix}{line}")
			}
		})
		.collect::<Vec<_>>()
		.join("\n")
}

pub fn detect_space_indent_step(text: &str) -> usize {
	let mut min = usize::MAX;
	for line in text.split('\n') {
		if line.trim().is_empty() {
			continue;
		}
		let count = line.chars().take_while(|ch| *ch == ' ').count();
		if count > 0 {
			min = min.min(count);
		}
	}
	if min == usize::MAX || min == 0 || min > MAX_REASONABLE_INDENT_STEP {
		DEFAULT_SPACE_INDENT_STEP
	} else {
		min
	}
}

pub fn count_indent_columns(whitespace: &str, space_step: usize) -> usize {
	whitespace
		.chars()
		.map(|ch| if ch == '\t' { space_step } else { 1 })
		.sum()
}

pub fn normalize_to_tabs(line: &str, indent_char: char, indent_step: usize) -> String {
	if indent_char == '\t' {
		return line.to_owned();
	}

	let whitespace = leading_whitespace(line);
	if whitespace.is_empty() {
		return line.to_owned();
	}

	let step = indent_step.max(1);
	let total_columns = count_indent_columns(whitespace, step);
	let tabs = total_columns / step;
	let remainder = total_columns % step;
	format!("{}{}{}", "\t".repeat(tabs), " ".repeat(remainder), &line[whitespace.len()..])
}

pub fn denormalize_from_tabs(
	line: &str,
	file_indent_char: char,
	file_indent_step: usize,
) -> String {
	if file_indent_char != ' ' && file_indent_char != '\t' {
		return line.to_owned();
	}

	let whitespace = leading_whitespace(line);
	if whitespace.is_empty() {
		return line.to_owned();
	}

	let step = file_indent_step.max(1);
	let mut converted = String::with_capacity(whitespace.len() * step.max(1));
	for ch in whitespace.chars() {
		match ch {
			'\t' if file_indent_char == '\t' => converted.push('\t'),
			'\t' => converted.push_str(&file_indent_char.to_string().repeat(step)),
			' ' => converted.push(' '),
			_ => converted.push(ch),
		}
	}
	format!("{converted}{}", &line[whitespace.len()..])
}

pub fn normalize_target_indent(target_indent: &str, sample_text: &str) -> String {
	if target_indent.is_empty() {
		return String::new();
	}
	let has_tabs = target_indent.contains('\t');
	let has_spaces = target_indent.contains(' ');
	if !has_tabs || !has_spaces {
		return target_indent.to_owned();
	}

	let space_step = detect_space_indent_step(sample_text);
	let total_columns = count_indent_columns(target_indent, space_step);
	let normalized_levels = round_to_nearest_step(total_columns, space_step) / space_step;
	if normalized_levels == 0 {
		return String::new();
	}

	match target_indent.chars().next().unwrap_or(' ') {
		'\t' => "\t".repeat(normalized_levels),
		_ => " ".repeat(normalized_levels * space_step),
	}
}

pub fn normalize_leading_whitespace_char(
	text: &str,
	target_char: char,
	file_indent_step: Option<usize>,
) -> String {
	if target_char != ' ' && target_char != '\t' {
		return text.to_owned();
	}

	let other_char = if target_char == ' ' { '\t' } else { ' ' };
	let mut needs_conversion = false;
	for line in text.split('\n') {
		if line.trim().is_empty() {
			continue;
		}
		let ws = leading_whitespace(line);
		if ws.is_empty() {
			continue;
		}
		needs_conversion |= ws.contains(other_char);
	}

	if !needs_conversion {
		return text.to_owned();
	}

	let space_step = if target_char == ' ' {
		file_indent_step
			.filter(|step| *step > 1)
			.unwrap_or_else(|| detect_space_indent_step(text))
	} else {
		file_indent_step.unwrap_or_else(|| detect_space_indent_step(text))
	};

	text
		.split('\n')
		.map(|line| {
			let ws = leading_whitespace(line);
			if ws.is_empty() {
				return line.to_owned();
			}
			let rest = &line[ws.len()..];
			let total_spaces = count_indent_columns(ws, space_step);
			if target_char == ' ' {
				format!("{}{}", " ".repeat(total_spaces), rest)
			} else {
				let tabs = total_spaces / space_step;
				let remainder = total_spaces % space_step;
				format!("{}{}{}", "\t".repeat(tabs), " ".repeat(remainder), rest)
			}
		})
		.collect::<Vec<_>>()
		.join("\n")
}

pub fn reindent_inserted_block(
	content: &str,
	target_indent: &str,
	file_indent_step: Option<usize>,
) -> String {
	if content.is_empty() {
		return String::new();
	}

	let normalized_target_indent = normalize_target_indent(target_indent, content);
	let mut dedented = dedent_python_style(content);

	if let Some(target_char) = normalized_target_indent.chars().next() {
		let target_step = if target_char == ' ' {
			file_indent_step.unwrap_or_else(|| normalized_target_indent.chars().count())
		} else {
			file_indent_step.unwrap_or_else(|| detect_space_indent_step(&dedented))
		};
		dedented = normalize_leading_whitespace_char(&dedented, target_char, Some(target_step));
	}

	indent_non_empty_lines(&dedented, &normalized_target_indent)
}

/// Detect the file's indent character.
/// Prefer chunk metadata, then fall back to scanning source lines.
/// Returns `' '` when the file provides no indentation signal.
pub fn detect_file_indent_char(source: &str, tree: &ChunkTree) -> char {
	for chunk in &tree.chunks {
		if chunk.indent > 0 && !chunk.indent_char.is_empty() {
			return chunk.indent_char.chars().next().unwrap_or(' ');
		}
	}

	for line in source.split('\n') {
		if line.trim().is_empty() {
			continue;
		}
		if let Some(ch) = leading_whitespace(line).chars().next()
			&& matches!(ch, ' ' | '\t')
		{
			return ch;
		}
	}

	' '
}

/// Detect spaces-per-indent-level from parent→child indent differences.
/// Falls back to scanning `source` for the minimum indented-line width,
/// then to `DEFAULT_SPACE_INDENT_STEP` when neither gives a signal.
pub fn detect_file_indent_step(source: &str, tree: &ChunkTree) -> u32 {
	for chunk in &tree.chunks {
		if chunk.children.is_empty() {
			continue;
		}
		for child_path in &chunk.children {
			let Some(child) = tree
				.chunks
				.iter()
				.find(|candidate| &candidate.path == child_path)
			else {
				continue;
			};
			if child.indent <= chunk.indent || child.indent_char != " " {
				continue;
			}
			let step = child.indent - chunk.indent;
			if step > 0 && step <= MAX_REASONABLE_INDENT_STEP as u32 {
				return step;
			}
		}
	}
	detect_space_indent_step(source) as u32
}

pub fn strip_content_prefixes(content: &str) -> String {
	let lines = content.split('\n').collect::<Vec<_>>();
	let mut line_num_count = 0usize;
	let mut non_empty = 0usize;
	for line in &lines {
		if line.trim().is_empty() {
			continue;
		}
		non_empty += 1;
		if parse_chunk_gutter_code_row(line).is_some() {
			line_num_count += 1;
		}
	}

	if non_empty == 0 {
		return content.to_owned();
	}

	let without_line_numbers = if line_num_count * 10 > non_empty * 6 {
		lines
			.iter()
			.map(|line| strip_chunk_gutter_line(line))
			.collect::<Vec<_>>()
	} else {
		lines
			.iter()
			.map(|line| (*line).to_owned())
			.collect::<Vec<_>>()
	};

	strip_new_line_prefixes(&without_line_numbers).join("\n")
}

fn leading_whitespace(line: &str) -> &str {
	let end = line
		.char_indices()
		.find_map(|(index, ch)| (!matches!(ch, ' ' | '\t')).then_some(index))
		.unwrap_or(line.len());
	&line[..end]
}

fn common_prefix<'a>(left: &'a str, right: &'a str) -> &'a str {
	let mut matched = 0usize;
	for ((left_index, left_char), (_, right_char)) in left.char_indices().zip(right.char_indices()) {
		if left_char != right_char {
			break;
		}
		matched = left_index + left_char.len_utf8();
	}
	&left[..matched]
}

const fn round_to_nearest_step(value: usize, step: usize) -> usize {
	if step == 0 {
		return value;
	}
	((value + (step / 2)) / step) * step
}

fn parse_chunk_gutter_code_row(line: &str) -> Option<&str> {
	let trimmed = line.trim_start_matches([' ', '\t']);
	let digits = trimmed.chars().take_while(|ch| ch.is_ascii_digit()).count();
	if digits == 0 {
		return None;
	}
	let after_digits = &trimmed[digits..];
	let after_spaces = after_digits.trim_start_matches([' ', '\t']);
	let after_pipe = after_spaces
		.strip_prefix('|')
		.or_else(|| after_spaces.strip_prefix('│'))?;
	Some(
		after_pipe
			.strip_prefix(' ')
			.or_else(|| after_pipe.strip_prefix('\t'))
			.unwrap_or(after_pipe),
	)
}

fn strip_chunk_gutter_line(line: &str) -> String {
	if let Some(rest) = parse_chunk_gutter_code_row(line) {
		return rest.to_owned();
	}
	let trimmed = line.trim_start_matches([' ', '\t']);
	if trimmed.starts_with('|') || trimmed.starts_with('│') {
		return String::new();
	}
	line.to_owned()
}

fn strip_new_line_prefixes(lines: &[String]) -> Vec<String> {
	let non_empty = lines.iter().filter(|line| !line.trim().is_empty()).count();
	if non_empty == 0 {
		return lines.to_vec();
	}

	let hash_prefixed = lines
		.iter()
		.filter(|line| !line.trim().is_empty())
		.filter(|line| hashline_prefix_len(line).is_some())
		.count();
	if hash_prefixed == non_empty {
		return lines
			.iter()
			.map(|line| match hashline_prefix_len(line) {
				Some(prefix_len) => line[prefix_len..].to_owned(),
				None => line.clone(),
			})
			.collect();
	}

	lines.to_vec()
}

fn hashline_prefix_len(line: &str) -> Option<usize> {
	let mut offset = line.len() - line.trim_start_matches([' ', '\t']).len();
	let mut remainder = &line[offset..];

	if let Some(stripped) = remainder.strip_prefix(">>>") {
		offset += 3;
		remainder = stripped;
	} else if let Some(stripped) = remainder.strip_prefix(">>") {
		offset += 2;
		remainder = stripped;
	}

	let ws = remainder.len() - remainder.trim_start_matches([' ', '\t']).len();
	offset += ws;
	remainder = &remainder[ws..];

	if let Some(stripped) = remainder.strip_prefix('+') {
		offset += 1;
		remainder = stripped;
		let inner_ws = remainder.len() - remainder.trim_start_matches([' ', '\t']).len();
		offset += inner_ws;
		remainder = &remainder[inner_ws..];
	}

	let digits = remainder
		.chars()
		.take_while(|ch| ch.is_ascii_digit())
		.count();
	if digits > 0 {
		offset += digits;
		remainder = &remainder[digits..];
		let ws = remainder.len() - remainder.trim_start_matches([' ', '\t']).len();
		offset += ws;
		remainder = &remainder[ws..];
	}

	if let Some(stripped) = remainder.strip_prefix('#') {
		offset += 1;
		remainder = stripped;
		let ws = remainder.len() - remainder.trim_start_matches([' ', '\t']).len();
		offset += ws;
		remainder = &remainder[ws..];
	} else if digits == 0 {
		return None;
	}

	// Match exactly one BPE bigram (2 ASCII chars) from HASHLINE_BIGRAMS.
	// Use char-boundary-safe slicing to avoid panicking on multi-byte content.
	let bigram_end = 2;
	if remainder.len() < bigram_end || !remainder.is_char_boundary(bigram_end) {
		return None;
	}
	let bigram = &remainder[..bigram_end];
	if !bigram.is_ascii() || !HASHLINE_BIGRAMS.contains(&bigram) {
		return None;
	}
	offset += bigram_end;
	remainder = &remainder[bigram_end..];

	remainder.strip_prefix(':').map(|_| offset + 1)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::chunk::{kind::ChunkKind, types::ChunkNode};

	fn chunk(
		path: &str,
		parent_path: Option<&str>,
		children: &[&str],
		indent: u32,
		indent_char: &str,
	) -> ChunkNode {
		let kind = match path.split_once('_').map_or(path, |(prefix, _)| prefix) {
			"fn" => ChunkKind::Function,
			"class" => ChunkKind::Class,
			"stmts" => ChunkKind::Statements,
			_ => ChunkKind::Chunk,
		};
		ChunkNode {
			path: path.to_owned(),
			identifier: path
				.split_once('_')
				.and_then(|(_, identifier)| (!identifier.is_empty()).then_some(identifier.to_owned())),
			kind,
			leaf: children.is_empty(),
			virtual_content: None,
			parent_path: parent_path.map(str::to_owned),
			children: children.iter().map(|child| (*child).to_owned()).collect(),
			signature: None,
			start_line: 1,
			end_line: 1,
			line_count: 1,
			start_byte: 0,
			end_byte: 0,
			checksum_start_byte: 0,
			prologue_end_byte: None,
			epilogue_start_byte: None,
			checksum: "ABCD".to_owned(),
			error: false,
			indent,
			indent_char: indent_char.to_owned(),
			group: false,
		}
	}

	#[test]
	fn dedent_preserves_mixed_common_margin() {
		let input = "\t  foo\n\t    bar\n\t  baz";
		assert_eq!(dedent_python_style(input), "foo\n  bar\nbaz");
	}

	#[test]
	fn normalize_leading_whitespace_char_uses_file_step() {
		let input = "\t  alpha\n\t    beta";
		assert_eq!(
			normalize_leading_whitespace_char(input, ' ', Some(4)),
			"      alpha\n        beta"
		);
	}

	#[test]
	fn canonical_indent_round_trips_common_profiles() {
		let cases = [
			("    value()", ' ', 4, "\tvalue()", "    value()"),
			("      value()", ' ', 3, "\t\tvalue()", "      value()"),
			("  value()", ' ', 2, "\tvalue()", "  value()"),
			("\tvalue()", '\t', 4, "\tvalue()", "\tvalue()"),
			(" \t  value()", ' ', 4, "\t   value()", "       value()"),
		];

		for (input, indent_char, indent_step, canonical, restored) in cases {
			let normalized = normalize_to_tabs(input, indent_char, indent_step);
			assert_eq!(normalized, canonical, "unexpected canonical indent for {input:?}");
			assert_eq!(
				denormalize_from_tabs(&normalized, indent_char, indent_step),
				restored,
				"unexpected restored indent for {input:?}"
			);
		}
	}

	#[test]
	fn reindent_inserted_block_preserves_relative_indentation() {
		// Agent sends tab-based content: call(\n\talpha,\n\tbeta,\n)
		// After denormalize_from_tabs (4 spaces/tab): call(\n    alpha,\n    beta,\n)
		// Should add target indent to all lines, preserving relative offsets.
		let input = "call(\n    alpha,\n    beta,\n)";
		assert_eq!(
			reindent_inserted_block(input, "    ", Some(4)),
			"    call(\n        alpha,\n        beta,\n    )"
		);
	}

	#[test]
	fn strip_content_prefixes_removes_gutter_and_meta_rows() {
		let input = "10 | fn main() {\n   │ <.fn_main#ABCD>\n11 |     println!(\"hi\");\n12 | }";
		assert_eq!(strip_content_prefixes(input), "fn main() {\n\n    println!(\"hi\");\n}");
	}

	#[test]
	fn detect_file_indent_step_prefers_space_children() {
		let tree = ChunkTree {
			language:          "rust".to_owned(),
			checksum:          "ABCD".to_owned(),
			line_count:        1,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["cls_A".to_owned()],
			chunks:            vec![
				chunk("cls_A", Some(""), &["fn_b"], 0, " "),
				chunk("fn_b", Some("cls_A"), &[], 2, " "),
			],
		};
		assert_eq!(detect_file_indent_step("", &tree), 2);
	}

	#[test]
	fn detect_file_indent_step_falls_back_to_source_scan() {
		// When the chunk tree has no parent->child pairs (all leaves),
		// fall back to scanning source lines for the minimum indent width.
		let tree = ChunkTree {
			language:          "yaml".to_owned(),
			checksum:          "ABCD".to_owned(),
			line_count:        3,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["key_ser".to_owned()],
			chunks:            vec![chunk("key_ser", Some(""), &[], 0, " ")],
		};
		let source = "server:\n  host: localhost\n  port: 5432\n";
		assert_eq!(detect_file_indent_step(source, &tree), 2);
	}

	#[test]
	fn detect_file_indent_char_falls_back_to_source_lines() {
		let tree = ChunkTree {
			language:          "rust".to_owned(),
			checksum:          "ABCD".to_owned(),
			line_count:        3,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["fn_mai".to_owned()],
			chunks:            vec![chunk("fn_mai", Some(""), &[], 0, "")],
		};

		let source = "fn main() {\n    println!(\"hi\");\n}\n";
		assert_eq!(detect_file_indent_char(source, &tree), ' ');
	}

	#[test]
	fn detect_file_indent_char_defaults_to_spaces_without_signal() {
		let tree = ChunkTree {
			language:          "rust".to_owned(),
			checksum:          "ABCD".to_owned(),
			line_count:        0,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     Vec::new(),
			chunks:            Vec::new(),
		};

		assert_eq!(detect_file_indent_char("", &tree), ' ');
	}
}
