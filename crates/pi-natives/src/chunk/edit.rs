use std::{collections::HashMap, path::Path};

use crate::chunk::{
	indent::{
		dedent_python_style, denormalize_from_tabs, detect_file_indent_char, detect_file_indent_step,
		indent_non_empty_lines, normalize_leading_whitespace_char, normalize_to_tabs,
		reindent_inserted_block, strip_content_prefixes,
	},
	kind::ChunkKind,
	resolve::{
		ParsedSelector, chunk_region_range, resolve_chunk_selector,
		resolve_chunk_selector_with_crc_filter, resolve_chunk_with_crc, sanitize_crc,
		split_selector_crc_and_region, verify_any_ancestor_crc_match,
	},
	state::{ChunkState, ChunkStateInner, ConflictMeta},
	types::{
		ChunkAnchorStyle, ChunkEditOp, ChunkFocusMode, ChunkNode, ChunkRegion, EditOperation,
		EditParams, EditResult, FocusedPath, RenderParams,
	},
};

#[derive(Clone)]
struct ScheduledEditOperation {
	operation:          EditOperation,
	original_index:     usize,
	requested_selector: Option<String>,
	supplied_checksum:  Option<String>,
	initial_chunk:      Option<ChunkNode>,
	checksum_validated: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct BatchTargetKey {
	path:     String,
	checksum: String,
}

#[derive(Clone)]
enum CurrentBatchTarget {
	Path(String),
	Missing,
}

#[derive(Clone)]
struct AppliedEditTarget {
	before:             ChunkNode,
	full_chunk_removed: bool,
}

type CurrentBatchTargets = HashMap<BatchTargetKey, CurrentBatchTarget>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum InsertPosition {
	Before,
	After,
	FirstChild,
	LastChild,
}

#[derive(Clone, Copy)]
struct InsertSpacing {
	blank_line_before: bool,
	blank_line_after:  bool,
}

#[derive(Clone)]
struct InsertionPoint {
	offset: usize,
	indent: String,
}

#[derive(Clone)]
struct ResolvedEditTarget {
	chunk:  ChunkNode,
	region: Option<ChunkRegion>,
}

const NORMALIZED_TAB_REPLACEMENT: &str = "    ";
const PRESERVED_TAB_REPLACEMENT: &str = "\t";

const fn operation_requires_checksum(op: ChunkEditOp) -> bool {
	matches!(op, ChunkEditOp::Put | ChunkEditOp::Replace | ChunkEditOp::Delete)
}

fn resolve_initial_edit_chunk<'a>(
	state: &'a ChunkStateInner,
	cleaned_selector: Option<&str>,
	cleaned_crc: Option<&str>,
	lenient_multi_crc: bool,
	warnings: &mut Vec<String>,
) -> Result<(&'a ChunkNode, Option<String>), String> {
	if lenient_multi_crc {
		let chunk = resolve_chunk_selector(state, cleaned_selector, warnings)?;
		return Ok((chunk, cleaned_crc.map(str::to_owned)));
	}

	let mut selector_warnings = Vec::new();
	match resolve_chunk_selector_with_crc_filter(
		state,
		cleaned_selector,
		cleaned_crc,
		&mut selector_warnings,
	) {
		Ok(chunk) => {
			warnings.extend(selector_warnings);
			Ok((chunk, cleaned_crc.map(str::to_owned)))
		},
		Err(selector_error) => {
			let Some(cleaned_crc) = cleaned_crc else {
				warnings.extend(selector_warnings);
				return Err(selector_error);
			};
			if let Ok(resolved) =
				resolve_chunk_with_crc(state, cleaned_selector, Some(cleaned_crc), warnings)
			{
				Ok((resolved.chunk, resolved.crc))
			} else {
				warnings.extend(selector_warnings);
				Err(selector_error)
			}
		},
	}
}

fn schedule_edit_operation(
	state: &ChunkStateInner,
	operation: EditOperation,
	original_index: usize,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
	warnings: &mut Vec<String>,
) -> Result<ScheduledEditOperation, String> {
	let normalized_operation = normalize_operation_literals(&operation);
	let selector = normalized_operation.sel.as_deref().or(default_selector);
	let crc = normalized_operation.crc.as_deref().or_else(|| {
		if normalized_operation.sel.is_none() {
			default_crc
		} else {
			None
		}
	});
	let ParsedSelector {
		selector: cleaned_selector,
		crc: cleaned_crc,
		all_crcs: parsed_crcs,
		has_trailing_crc,
		..
	} = split_selector_crc_and_region(selector, crc, normalized_operation.region)?;
	let lenient_multi_crc = parsed_crcs.len() >= 2 || (!parsed_crcs.is_empty() && !has_trailing_crc);
	let (resolved_chunk, resolved_crc) = resolve_initial_edit_chunk(
		state,
		cleaned_selector.as_deref(),
		cleaned_crc.as_deref(),
		lenient_multi_crc,
		warnings,
	)?;
	let requires_checksum = operation_requires_checksum(normalized_operation.op);
	let checksum_validated = if lenient_multi_crc {
		verify_any_ancestor_crc_match(state, resolved_chunk, &parsed_crcs)?;
		!parsed_crcs.is_empty()
	} else {
		validate_batch_crc(resolved_chunk, resolved_crc.as_deref(), requires_checksum)?;
		resolved_crc.is_some()
	};

	Ok(ScheduledEditOperation {
		operation,
		original_index,
		requested_selector: cleaned_selector,
		supplied_checksum: cleaned_crc,
		initial_chunk: Some(resolved_chunk.clone()),
		checksum_validated,
	})
}

pub fn apply_edits(state: &ChunkState, params: &EditParams) -> Result<EditResult, String> {
	let original_text = normalize_chunk_source(state.inner().source());
	let initial_notebook_ctx = state.inner().notebook.clone();
	let initial_conflict_meta = state.inner().conflict_meta.clone();
	let mut state = rebuild_chunk_state(
		original_text.clone(),
		state.inner().language().to_string(),
		initial_notebook_ctx.clone(),
		initial_conflict_meta.clone(),
	)?;
	let original_state = state.clone();
	let file_indent_step = detect_file_indent_step(&state.source, &state.tree) as usize;
	let file_indent_char = detect_file_indent_char(&state.source, &state.tree);
	let initial_parse_errors = state.tree.parse_errors;
	let initial_chunk_paths: std::collections::HashSet<String> =
		state.tree.chunks.iter().map(|c| c.path.clone()).collect();
	let initial_chunks_by_path: std::collections::HashMap<String, ChunkNode> = state
		.tree
		.chunks
		.iter()
		.map(|chunk| (chunk.path.clone(), chunk.clone()))
		.collect();
	let initial_chunk_checksums: std::collections::HashMap<String, String> = state
		.tree
		.chunks
		.iter()
		.map(|chunk| (chunk.path.clone(), chunk.checksum.clone()))
		.collect();
	let normalize_indent = params.normalize_indent.unwrap_or(true);
	let mut touched_paths = Vec::new();
	let mut warnings = Vec::new();
	let mut last_scheduled: Option<ScheduledEditOperation> = None;
	let initial_default_selector = params.default_selector.clone();
	let initial_default_crc = params.default_crc.clone();

	let mut scheduled_ops = Vec::with_capacity(params.operations.len());
	for (original_index, operation) in params.operations.iter().cloned().enumerate() {
		match schedule_edit_operation(
			&state,
			operation,
			original_index,
			initial_default_selector.as_deref(),
			initial_default_crc.as_deref(),
			&mut warnings,
		) {
			Ok(scheduled) => scheduled_ops.push(scheduled),
			Err(err) => {
				let display_path = display_path_for_file(&params.file_path, &params.cwd);
				let context = render_error_context(
					&state,
					params.operations[original_index]
						.sel
						.as_deref()
						.or(initial_default_selector.as_deref()),
					&display_path,
					params.anchor_style,
					normalize_indent,
				);
				return Err(format!(
					"Edit operation {}/{} failed during initial checksum validation: {}\nNo changes \
					 were saved. Fix the failing operation and retry the entire batch.{context}",
					original_index + 1,
					params.operations.len(),
					err,
				));
			},
		}
	}

	let execution_ops = scheduled_ops;
	let current_default_selector = initial_default_selector.as_deref();
	let mut current_default_crc = initial_default_crc;
	let mut current_batch_targets = CurrentBatchTargets::new();
	let total_ops = params.operations.len();

	for scheduled in execution_ops {
		last_scheduled = Some(scheduled.clone());
		let operation = normalize_operation_literals(&scheduled.operation);
		let result = match operation.op {
			ChunkEditOp::Put => apply_put(
				&mut state,
				&operation,
				&scheduled,
				current_default_selector,
				current_default_crc.as_deref(),
				file_indent_step,
				file_indent_char,
				normalize_indent,
				&mut touched_paths,
				&current_batch_targets,
				&mut warnings,
			),
			ChunkEditOp::Replace => apply_find_replace(
				&mut state,
				&operation,
				&scheduled,
				current_default_selector,
				current_default_crc.as_deref(),
				normalize_indent,
				&mut touched_paths,
				&current_batch_targets,
				&mut warnings,
			),
			ChunkEditOp::Delete => apply_delete(
				&mut state,
				&operation,
				&scheduled,
				current_default_selector,
				current_default_crc.as_deref(),
				&mut touched_paths,
				&current_batch_targets,
				&mut warnings,
			),
			ChunkEditOp::Before | ChunkEditOp::After | ChunkEditOp::Prepend | ChunkEditOp::Append => {
				apply_insert(
					&mut state,
					&operation,
					&scheduled,
					current_default_selector,
					current_default_crc.as_deref(),
					file_indent_step,
					file_indent_char,
					normalize_indent,
					&mut touched_paths,
					&current_batch_targets,
					&mut warnings,
				)
			},
		};

		let applied_target = match result {
			Ok(applied_target) => applied_target,
			Err(err) => {
				let display_path = display_path_for_file(&params.file_path, &params.cwd);
				let sel = operation.sel.as_deref().or(current_default_selector);
				let context = render_error_context(
					&original_state,
					sel,
					&display_path,
					params.anchor_style,
					normalize_indent,
				);
				return Err(format!(
					"Edit operation {}/{} failed ({}): {}\nNo changes were saved. Fix the failing \
					 operation and retry the entire batch.{context}",
					scheduled.original_index + 1,
					total_ops,
					describe_scheduled_operation(&scheduled),
					err,
				));
			},
		};

		state = rebuild_chunk_state(
			state.source.clone(),
			state.language.clone(),
			state.notebook.clone(),
			state.conflict_meta.clone(),
		)?;
		update_current_batch_target(&mut current_batch_targets, &state, &scheduled, &applied_target);
		if operation.sel.is_none() {
			current_default_crc = None;
		}
	}

	let parse_valid = state.tree.parse_errors <= initial_parse_errors;
	if !parse_valid && initial_parse_errors == 0 {
		// Produce per-error-location summaries. Prefer the ChunkKind::Error
		// chunks (which carry signature snippets) if any exist; fall back to
		// the raw tree-sitter error line positions stored in the tree.
		let mut error_summaries = format_parse_error_summaries(&state);
		if error_summaries.is_empty() {
			for &line in &state.tree.parse_error_lines {
				error_summaries.push(format!(
					"L{line} parse error introduced while editing {}",
					last_scheduled
						.as_ref()
						.and_then(|s| s
							.initial_chunk
							.as_ref()
							.map(|c| c.path.as_str())
							.or(s.requested_selector.as_deref()))
						.unwrap_or("<unknown chunk>"),
				));
			}
			if error_summaries.is_empty()
				&& let Some(scheduled) = last_scheduled.as_ref()
			{
				let chunk_label = scheduled
					.initial_chunk
					.as_ref()
					.map(|c| c.path.as_str())
					.or(scheduled.requested_selector.as_deref())
					.unwrap_or("<unknown chunk>");
				error_summaries.push(format!("Parse error introduced while editing {chunk_label}"));
			}
		}
		let details = if error_summaries.is_empty() {
			String::new()
		} else {
			format!(
				"\nParse errors:\n{}",
				error_summaries
					.into_iter()
					.map(|summary| format!("- {summary}"))
					.collect::<Vec<_>>()
					.join("\n")
			)
		};
		let display_path = display_path_for_file(&params.file_path, &params.cwd);
		let sel = last_scheduled
			.as_ref()
			.and_then(|s| s.operation.sel.as_deref())
			.or(initial_default_selector.as_deref());
		let context =
			render_error_context(&state, sel, &display_path, params.anchor_style, normalize_indent);
		return Err(format!(
			"Edit rejected: introduced {} parse error(s). The file was valid before the edit but is \
			 not after. Fix the content and retry.{details}{context}",
			state.tree.parse_errors,
		));
	}
	if !parse_valid {
		warnings.push(format!(
			"Edit introduced {} new parse error(s).",
			state.tree.parse_errors.saturating_sub(initial_parse_errors)
		));
	}

	let display_path = display_path_for_file(&params.file_path, &params.cwd);
	let changed_virtual = original_text != state.source;

	// For notebooks, translate the virtual source back to JSON so the
	// caller sees the actual ipynb file content in `diff_before`/`diff_after`.
	// `initial_notebook_ctx` is the context captured at the very start of
	// this call; it holds the pre-edit cell metadata. We use it to stamp
	// the original JSON for `diff_before` and to produce the new JSON from
	// the mutated virtual source for `diff_after`.
	let (diff_before, diff_after) = if let Some(initial_ctx) = initial_notebook_ctx.as_ref() {
		let before_json = crate::chunk::ast_ipynb::notebook_to_json(&original_text, initial_ctx)
			.map_err(|err| format!("Failed to reconstruct pre-edit notebook JSON: {err}"))?;
		let after_json = crate::chunk::ast_ipynb::notebook_to_json(&state.source, initial_ctx)
			.map_err(|err| format!("Failed to serialize edited notebook JSON: {err}"))?;
		(before_json, after_json)
	} else {
		let diff_before = if initial_conflict_meta.is_empty() {
			original_text
		} else {
			crate::chunk::conflict::reconstruct_markers(&original_text, &initial_conflict_meta)
		};
		let diff_after = if state.conflict_meta.is_empty() {
			state.source.clone()
		} else {
			crate::chunk::conflict::reconstruct_markers(&state.source, &state.conflict_meta)
		};
		(diff_before, diff_after)
	};
	let changed = diff_before != diff_after || changed_virtual;
	if !state.conflict_meta.is_empty() {
		let mut unresolved = state.conflict_meta.keys().cloned().collect::<Vec<_>>();
		unresolved.sort();
		warnings.push(format!(
			"NOTICE: This file still has unresolved conflicts: {}.",
			unresolved.join(", ")
		));
	}
	// Newly-created chunks (e.g. inserted siblings that landed outside the anchor's
	// parent subtree) are not reflected in `touched_paths` yet. Detect any chunk
	// that did not exist in the pre-edit tree and include it so the scoped
	// response tree actually shows the inserted content.
	for chunk in &state.tree.chunks {
		if !initial_chunk_paths.contains(&chunk.path) && !touched_paths.contains(&chunk.path) {
			touched_paths.push(chunk.path.clone());
		}
	}

	let response_text = if changed {
		render_changed_hunks(
			&state,
			&display_path,
			&diff_before,
			&diff_after,
			params.anchor_style,
			&touched_paths,
			&initial_chunk_checksums,
			&initial_chunks_by_path,
			normalize_indent,
		)
	} else {
		render_unchanged_response(&state, &display_path, params.anchor_style, normalize_indent)
	};

	Ok(EditResult {
		state: ChunkState::from_inner(state),
		diff_before,
		diff_after,
		response_text,
		changed,
		parse_valid,
		touched_paths,
		warnings,
	})
}

fn unique_current_chunk_by_initial_checksum<'a>(
	state: &'a ChunkStateInner,
	scheduled: &ScheduledEditOperation,
) -> Option<&'a ChunkNode> {
	if !scheduled.checksum_validated {
		return None;
	}
	let initial_chunk = scheduled.initial_chunk.as_ref()?;
	if initial_chunk.path.is_empty() {
		return state
			.chunk("")
			.filter(|chunk| chunk.checksum == initial_chunk.checksum);
	}

	let scoped_matches = match initial_chunk.parent_path.as_deref() {
		Some(parent_path) => state.chunk(parent_path).map(|parent| {
			parent
				.children
				.iter()
				.filter_map(|child_path| state.chunk(child_path))
				.filter(|chunk| chunk.checksum == initial_chunk.checksum)
				.collect::<Vec<_>>()
		}),
		None => Some(
			state
				.tree
				.root_children
				.iter()
				.filter_map(|child_path| state.chunk(child_path))
				.filter(|chunk| chunk.checksum == initial_chunk.checksum)
				.collect::<Vec<_>>(),
		),
	};
	if let Some(matches) = scoped_matches
		&& matches.len() == 1
	{
		return Some(matches[0]);
	}

	let all_matches = state
		.tree
		.chunks
		.iter()
		.filter(|chunk| chunk.checksum == initial_chunk.checksum)
		.collect::<Vec<_>>();
	if all_matches.len() == 1 {
		Some(all_matches[0])
	} else {
		None
	}
}

fn batch_target_key(chunk: &ChunkNode) -> BatchTargetKey {
	BatchTargetKey { path: chunk.path.clone(), checksum: chunk.checksum.clone() }
}

fn format_batch_target_key(key: &BatchTargetKey) -> String {
	if key.path.is_empty() {
		format!("<root>#{}", key.checksum)
	} else {
		format!("{}#{}", key.path, key.checksum)
	}
}

fn resolve_current_batch_chunk<'a>(
	state: &'a ChunkStateInner,
	cleaned_selector: Option<&str>,
	scheduled: &ScheduledEditOperation,
	current_batch_targets: &CurrentBatchTargets,
	warnings: &mut Vec<String>,
) -> Result<&'a ChunkNode, String> {
	if let Some(initial_chunk) = scheduled.initial_chunk.as_ref() {
		let key = batch_target_key(initial_chunk);
		if let Some(current_target) = current_batch_targets.get(&key) {
			return match current_target {
				CurrentBatchTarget::Path(path) => state.chunk(path.as_str()).ok_or_else(|| {
					format!(
						"Batch target {} was remapped to \"{}\" by an earlier operation, but that chunk \
						 no longer exists after later edits.",
						format_batch_target_key(&key),
						if path.is_empty() {
							"<root>"
						} else {
							path.as_str()
						}
					)
				}),
				CurrentBatchTarget::Missing => Err(format!(
					"Batch target {} was removed or could not be remapped after an earlier operation.",
					format_batch_target_key(&key)
				)),
			};
		}
	}
	if let Some(chunk) = unique_current_chunk_by_initial_checksum(state, scheduled) {
		return Ok(chunk);
	}
	let resolved = resolve_chunk_with_crc(state, cleaned_selector, None, warnings)?;
	Ok(resolved.chunk)
}

fn resolve_edit_target(
	state: &ChunkStateInner,
	operation: &EditOperation,
	scheduled: &ScheduledEditOperation,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
	current_batch_targets: &CurrentBatchTargets,
	warnings: &mut Vec<String>,
) -> Result<ResolvedEditTarget, String> {
	let selector = operation.sel.as_deref().or(default_selector);
	let crc = operation.crc.as_deref().or_else(|| {
		if operation.sel.is_none() {
			default_crc
		} else {
			None
		}
	});
	let ParsedSelector { selector: cleaned_selector, region: parsed_region, .. } =
		split_selector_crc_and_region(selector, crc, operation.region)?;
	let mut region = operation.region.or(parsed_region);
	let chunk = resolve_current_batch_chunk(
		state,
		cleaned_selector.as_deref(),
		scheduled,
		current_batch_targets,
		warnings,
	)?
	.clone();
	let python_leaf_control_flow = state.language == "python"
		&& chunk.leaf
		&& matches!(
			chunk.kind,
			ChunkKind::If
				| ChunkKind::Loop
				| ChunkKind::Try
				| ChunkKind::Block
				| ChunkKind::Match
				| ChunkKind::Elif
				| ChunkKind::Except
		);
	if chunk.prologue_end_byte.is_none()
		|| chunk.epilogue_start_byte.is_none()
		|| python_leaf_control_flow
		|| (chunk.kind == ChunkKind::Section && matches!(operation.op, ChunkEditOp::Put))
	{
		region = None;
	}

	Ok(ResolvedEditTarget { chunk, region })
}

fn find_current_batch_target_after_edit<'a>(
	state: &'a ChunkStateInner,
	before: &ChunkNode,
) -> Option<&'a ChunkNode> {
	if let Some(chunk) = state.chunk(before.path.as_str()) {
		return Some(chunk);
	}
	if before.path.is_empty() {
		return state.chunk("");
	}

	let same_start_same_kind = state
		.tree
		.chunks
		.iter()
		.filter(|chunk| {
			!chunk.path.is_empty()
				&& chunk.start_line == before.start_line
				&& chunk.kind == before.kind
		})
		.collect::<Vec<_>>();
	if same_start_same_kind.len() == 1 {
		return Some(same_start_same_kind[0]);
	}

	let same_start = state
		.tree
		.chunks
		.iter()
		.filter(|chunk| !chunk.path.is_empty() && chunk.start_line == before.start_line)
		.collect::<Vec<_>>();
	if same_start.len() == 1 {
		return Some(same_start[0]);
	}

	None
}

fn update_current_batch_target(
	current_batch_targets: &mut CurrentBatchTargets,
	state: &ChunkStateInner,
	scheduled: &ScheduledEditOperation,
	applied_target: &AppliedEditTarget,
) {
	let Some(initial_chunk) = scheduled.initial_chunk.as_ref() else {
		return;
	};
	let key = batch_target_key(initial_chunk);
	let current_target = if applied_target.full_chunk_removed {
		CurrentBatchTarget::Missing
	} else {
		find_current_batch_target_after_edit(state, &applied_target.before)
			.map_or(CurrentBatchTarget::Missing, |chunk| CurrentBatchTarget::Path(chunk.path.clone()))
	};
	current_batch_targets.insert(key, current_target);
}

/// Re-indent replacement content to match the original matched source's
/// indentation. Detects the base indent of the first line in `original` and
/// applies it to `replacement`.
fn reindent_replacement(original: &str, replacement: &str) -> String {
	let orig_indent = original
		.lines()
		.next()
		.map_or("", |l| &l[..l.len() - l.trim_start().len()]);
	let repl_indent = replacement
		.lines()
		.find(|l| !l.trim().is_empty())
		.map_or("", |l| &l[..l.len() - l.trim_start().len()]);

	if orig_indent == repl_indent {
		return replacement.to_string();
	}

	replacement
		.lines()
		.enumerate()
		.map(|(i, line)| {
			if line.trim().is_empty() {
				line.to_string()
			} else if i == 0 {
				format!("{orig_indent}{}", line.trim_start())
			} else {
				let stripped = line.strip_prefix(repl_indent).unwrap_or(line);
				format!("{orig_indent}{stripped}")
			}
		})
		.collect::<Vec<_>>()
		.join("\n")
}

/// Try to find `needle` in `haystack` by normalizing leading whitespace on each
/// line. Returns `(byte_offset, byte_length)` of the match in `haystack`.
fn find_indent_normalized(haystack: &str, needle: &str) -> Option<(usize, usize)> {
	let needle_trimmed: Vec<&str> = needle.lines().map(|l| l.trim_start()).collect();
	if needle_trimmed.is_empty() {
		return None;
	}
	let haystack_lines: Vec<(usize, &str)> = haystack
		.split('\n')
		.scan(0usize, |offset, line| {
			let start = *offset;
			*offset += line.len() + 1; // +1 for the \n
			Some((start, line))
		})
		.collect();

	let mut matches = Vec::new();
	'outer: for i in 0..haystack_lines.len() {
		if i + needle_trimmed.len() > haystack_lines.len() {
			break;
		}
		for (j, needle_line) in needle_trimmed.iter().enumerate() {
			if haystack_lines[i + j].1.trim_start() != *needle_line {
				continue 'outer;
			}
		}
		let start = haystack_lines[i].0;
		let last_idx = i + needle_trimmed.len() - 1;
		let end = haystack_lines[last_idx].0 + haystack_lines[last_idx].1.len();
		matches.push((start, end - start));
	}
	if matches.len() == 1 {
		Some(matches[0])
	} else {
		None // 0 or ambiguous
	}
}

fn apply_find_replace(
	state: &mut ChunkStateInner,
	operation: &EditOperation,
	scheduled: &ScheduledEditOperation,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
	normalize_indent: bool,
	touched_paths: &mut Vec<String>,
	current_batch_targets: &CurrentBatchTargets,
	warnings: &mut Vec<String>,
) -> Result<AppliedEditTarget, String> {
	let target = resolve_edit_target(
		state,
		operation,
		scheduled,
		default_selector,
		default_crc,
		current_batch_targets,
		warnings,
	)?;
	let anchor = target.chunk;
	let target_before = anchor.clone();

	let (region_start, region_end) = match target.region {
		None => (anchor.start_byte as usize, anchor.end_byte as usize),
		Some(r) => chunk_region_range(&anchor, r),
	};

	let find = operation.find.as_deref().unwrap_or_default();
	if find.is_empty() {
		return Err(format!(
			"replace on {}: 'find' cannot be empty.",
			describe_scheduled_operation(scheduled)
		));
	}

	let chunk_source = &state.source[region_start..region_end];

	// Try exact match first, then fall back to indent-normalized match.
	let (rel_offset, match_len) = if let Some((off, _)) = {
		let mut m = chunk_source.match_indices(find);
		let first = m.next();
		if first.is_some() && m.next().is_some() {
			let total = 2 + chunk_source.match_indices(find).skip(2).count();
			return Err(format!(
				"replace on {}: 'find' is ambiguous ({} matches in chunk). Extend 'find' with \
				 surrounding context so exactly one match remains.",
				anchor.path, total
			));
		}
		first
	} {
		(off, find.len())
	} else if normalize_indent && let Some((off, len)) = find_indent_normalized(chunk_source, find) {
		(off, len)
	} else {
		return Err(format!(
			"replace on {}: 'find' text not found inside chunk. Re-read the file to confirm current \
			 content.",
			anchor.path
		));
	};

	let raw_replacement = operation.content.as_deref().unwrap_or_default();
	let abs_start = region_start + rel_offset;
	let abs_end = abs_start + match_len;

	// Re-indent replacement to match the matched source's indentation when
	// indent normalization is active.
	let matched_source = &state.source[abs_start..abs_end];
	let replacement = if normalize_indent {
		reindent_replacement(matched_source, raw_replacement)
	} else {
		raw_replacement.to_string()
	};

	let mut new_source =
		String::with_capacity(state.source.len() - matched_source.len() + replacement.len());
	new_source.push_str(&state.source[..abs_start]);
	new_source.push_str(&replacement);
	new_source.push_str(&state.source[abs_end..]);
	replace_source_and_adjust_conflicts(state, new_source, warnings);
	touched_paths.push(anchor.path);
	Ok(AppliedEditTarget { before: target_before, full_chunk_removed: false })
}

fn apply_put(
	state: &mut ChunkStateInner,
	operation: &EditOperation,
	scheduled: &ScheduledEditOperation,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
	file_indent_step: usize,
	file_indent_char: char,
	normalize_indent: bool,
	touched_paths: &mut Vec<String>,
	current_batch_targets: &CurrentBatchTargets,
	warnings: &mut Vec<String>,
) -> Result<AppliedEditTarget, String> {
	let target = resolve_edit_target(
		state,
		operation,
		scheduled,
		default_selector,
		default_crc,
		current_batch_targets,
		warnings,
	)?;
	let anchor = target.chunk;
	let target_before = anchor.clone();
	if anchor.kind == ChunkKind::Theirs {
		return Err(
			"Virtual conflict branches cannot be replaced directly. Delete conflict.theirs to accept \
			 ours, delete conflict.ours to accept theirs, or replace the parent conflict chunk for a \
			 manual merge."
				.to_owned(),
		);
	}

	let requested_region = requested_region_for_operation(operation, default_selector, default_crc);

	let initial_target_indent =
		target_indent_for_region(state, &anchor, target.region, file_indent_char, file_indent_step);

	let content = operation.content.as_deref().unwrap_or_default();
	let mut replacement = normalize_inserted_content(
		content,
		&initial_target_indent,
		Some(file_indent_step),
		file_indent_char,
		normalize_indent,
	);

	let effective_region = target.region;
	let full_chunk_removed = effective_region.is_none() && replacement.is_empty();
	if should_preserve_head_for_fallback_body_replace(
		state,
		&anchor,
		requested_region,
		target.region,
		&replacement,
	) && let Some(preserved_replacement) = build_head_preserved_full_replacement(
		state,
		&anchor,
		content,
		file_indent_step,
		file_indent_char,
		normalize_indent,
	) {
		replacement = preserved_replacement;
		warnings.push(format!(
			"Auto-preserved {} head while applying fallback body edit.",
			chunk_path_opt(&anchor)
		));
	}

	let (mut effective_region_start, effective_region_end) = match effective_region {
		None => (anchor.start_byte as usize, anchor.end_byte as usize),
		Some(r) => chunk_region_range(&anchor, r),
	};
	if matches!(effective_region, Some(ChunkRegion::Head)) {
		effective_region_start =
			line_start_offset(&line_offsets(&state.source), anchor.start_line, &state.source);
	}

	if effective_region.is_none() {
		if !replacement.is_empty()
			&& !replacement.ends_with('\n')
			&& anchor.end_line < state.tree.line_count
		{
			replacement.push('\n');
		}
		// If the chunk's range included a trailing blank line (common in
		// markdown lists/paragraphs), preserve it so the replacement doesn't
		// collapse into the next structural element.
		let offsets = line_offsets(&state.source);
		let last_line_text = state
			.source
			.split('\n')
			.nth(anchor.end_line.saturating_sub(1) as usize)
			.unwrap_or("");
		if last_line_text.trim().is_empty()
			&& !replacement.is_empty()
			&& !replacement.ends_with("\n\n")
		{
			if !replacement.ends_with('\n') {
				replacement.push('\n');
			}
			replacement.push('\n');
		}
		let range_start = line_start_offset(&offsets, anchor.start_line, &state.source);
		let mut new_source =
			replace_range_by_lines(&state.source, anchor.start_line, anchor.end_line, &replacement);
		if replacement.is_empty() {
			new_source = cleanup_blank_line_artifacts_at_offset(&new_source, range_start);
		}
		if anchor.kind == ChunkKind::Conflict {
			state.conflict_meta.remove(anchor.path.as_str());
		}
		replace_source_and_adjust_conflicts(state, new_source, warnings);
	} else {
		// Preserve the region's trailing newline boundary so the next line stays
		// structurally separate after a head/body replacement.
		if !replacement.is_empty()
			&& !replacement.ends_with('\n')
			&& state
				.source
				.as_bytes()
				.get(effective_region_end.saturating_sub(1))
				== Some(&b'\n')
		{
			replacement.push('\n');
		}
		let new_source = replace_byte_range(
			&state.source,
			effective_region_start,
			effective_region_end,
			&replacement,
		);
		if anchor.kind == ChunkKind::Conflict {
			state.conflict_meta.remove(anchor.path.as_str());
		}
		replace_source_and_adjust_conflicts(state, new_source, warnings);
	}
	touched_paths.push(anchor.path);
	Ok(AppliedEditTarget { before: target_before, full_chunk_removed })
}

fn requested_region_for_operation(
	operation: &EditOperation,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
) -> Option<ChunkRegion> {
	if operation.region.is_some() {
		return operation.region;
	}
	let selector = operation.sel.as_deref().or(default_selector);
	let crc = operation.crc.as_deref().or(default_crc);
	split_selector_crc_and_region(selector, crc, None)
		.ok()
		.and_then(|parsed| parsed.region)
}

fn collapse_whitespace(text: &str) -> String {
	text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn should_preserve_existing_epilogue(epilogue: &str) -> bool {
	let first_non_empty = epilogue.lines().find(|line| !line.trim().is_empty());
	let Some(first) = first_non_empty.map(str::trim_start) else {
		return false;
	};
	first.starts_with('}')
		|| first.starts_with(']')
		|| first.starts_with(')')
		|| first.starts_with("end")
}

fn should_preserve_head_for_fallback_body_replace(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	requested_region: Option<ChunkRegion>,
	resolved_region: Option<ChunkRegion>,
	replacement: &str,
) -> bool {
	if requested_region != Some(ChunkRegion::Body) || resolved_region.is_some() {
		return false;
	}
	if replacement.trim().is_empty() {
		return false;
	}
	if anchor.prologue_end_byte.is_none() || anchor.epilogue_start_byte.is_none() {
		return false;
	}
	let (head_start, head_end) = chunk_region_range(anchor, ChunkRegion::Head);
	let (body_start, body_end) = chunk_region_range(anchor, ChunkRegion::Body);
	if head_end <= head_start || body_end <= body_start {
		return false;
	}
	let head_text = state.source[head_start..head_end].trim();
	if head_text.is_empty() {
		return false;
	}
	let head_collapsed = collapse_whitespace(head_text);
	if head_collapsed.is_empty() {
		return false;
	}
	let replacement_collapsed = collapse_whitespace(replacement);
	if replacement_collapsed.is_empty() {
		return false;
	}
	!replacement_collapsed.contains(&head_collapsed)
}

fn build_head_preserved_full_replacement(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	content: &str,
	file_indent_step: usize,
	file_indent_char: char,
	normalize_indent: bool,
) -> Option<String> {
	if anchor.prologue_end_byte.is_none() || anchor.epilogue_start_byte.is_none() {
		return None;
	}
	let (_head_start, _head_end) = chunk_region_range(anchor, ChunkRegion::Head);
	let (_body_start, body_end) = chunk_region_range(anchor, ChunkRegion::Body);
	let chunk_start = anchor.start_byte as usize;
	let chunk_end = anchor.end_byte as usize;
	if chunk_end <= chunk_start {
		return None;
	}
	let chunk_text = &state.source[chunk_start..chunk_end];
	let first_line_end = chunk_text
		.find('\n')
		.map_or(chunk_end, |idx| chunk_start + idx + 1);
	let head = &state.source[chunk_start..first_line_end];
	if head.trim().is_empty() {
		return None;
	}
	let inferred_body_end = body_end.min(chunk_end).max(first_line_end);
	let inferred_body_indent = state.source[first_line_end..inferred_body_end]
		.lines()
		.find_map(|line| {
			if line.trim().is_empty() {
				None
			} else {
				Some(
					line
						.chars()
						.take_while(|ch| *ch == ' ' || *ch == '\t')
						.collect::<String>(),
				)
			}
		})
		.unwrap_or_default();
	let normalized_body = normalize_inserted_content(
		content,
		"",
		Some(file_indent_step),
		file_indent_char,
		normalize_indent,
	);
	let mut body = if inferred_body_indent.is_empty() {
		normalized_body
	} else {
		indent_non_empty_lines(&normalized_body, &inferred_body_indent)
	};
	let epilogue_start = body_end.max(first_line_end).min(chunk_end);
	let raw_epilogue = &state.source[epilogue_start..chunk_end];
	let epilogue = if should_preserve_existing_epilogue(raw_epilogue) {
		raw_epilogue
	} else {
		""
	};
	if !body.is_empty() && !body.ends_with('\n') && !epilogue.is_empty() {
		body.push('\n');
	}
	Some(format!("{head}{body}{epilogue}"))
}

fn apply_delete(
	state: &mut ChunkStateInner,
	operation: &EditOperation,
	scheduled: &ScheduledEditOperation,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
	touched_paths: &mut Vec<String>,
	current_batch_targets: &CurrentBatchTargets,
	warnings: &mut Vec<String>,
) -> Result<AppliedEditTarget, String> {
	let target = resolve_edit_target(
		state,
		operation,
		scheduled,
		default_selector,
		default_crc,
		current_batch_targets,
		warnings,
	)?;
	let anchor = target.chunk;
	let target_before = anchor.clone();
	if target.region.is_none() {
		match anchor.kind {
			ChunkKind::Ours => {
				let Some(conflict_path) = anchor.parent_path.as_deref() else {
					return Err("Conflict branch is missing its parent conflict chunk".to_owned());
				};
				let Some(conflict_meta) = state.conflict_meta.remove(conflict_path) else {
					return Err(format!("Conflict metadata missing for {conflict_path}"));
				};
				let new_source = replace_byte_range(
					&state.source,
					conflict_meta.ours_start_byte,
					conflict_meta.ours_end_byte,
					conflict_meta.theirs_content.as_str(),
				);
				replace_source_and_adjust_conflicts(state, new_source, warnings);
				touched_paths.push(conflict_path.to_owned());
				return Ok(AppliedEditTarget {
					before:             target_before,
					full_chunk_removed: true,
				});
			},
			ChunkKind::Theirs => {
				let Some(conflict_path) = anchor.parent_path.as_deref() else {
					return Err("Conflict branch is missing its parent conflict chunk".to_owned());
				};
				state.conflict_meta.remove(conflict_path);
				touched_paths.push(conflict_path.to_owned());
				return Ok(AppliedEditTarget {
					before:             target_before,
					full_chunk_removed: true,
				});
			},
			ChunkKind::Conflict => {
				state.conflict_meta.remove(anchor.path.as_str());
			},
			_ => {},
		}
	}
	if anchor.kind == ChunkKind::Theirs {
		return Err(
			"Virtual conflict branches only support delete. Delete conflict.theirs to accept ours, \
			 delete conflict.ours to accept theirs, or replace the parent conflict chunk for a \
			 manual merge."
				.to_owned(),
		);
	}

	if let Some(r) = target.region {
		let (range_start, range_end) = chunk_region_range(&anchor, r);
		replace_source_and_adjust_conflicts(
			state,
			replace_byte_range(&state.source, range_start, range_end, ""),
			warnings,
		);
	} else {
		let offsets = line_offsets(&state.source);
		let range_start = line_start_offset(&offsets, anchor.start_line, &state.source);
		let new_source = cleanup_blank_line_artifacts_at_offset(
			&replace_range_by_lines(&state.source, anchor.start_line, anchor.end_line, ""),
			range_start,
		);
		replace_source_and_adjust_conflicts(state, new_source, warnings);
	}
	touched_paths.push(anchor.path);
	Ok(AppliedEditTarget {
		before:             target_before,
		full_chunk_removed: target.region.is_none(),
	})
}

fn apply_insert(
	state: &mut ChunkStateInner,
	operation: &EditOperation,
	scheduled: &ScheduledEditOperation,
	default_selector: Option<&str>,
	default_crc: Option<&str>,
	file_indent_step: usize,
	file_indent_char: char,
	normalize_indent: bool,
	touched_paths: &mut Vec<String>,
	current_batch_targets: &CurrentBatchTargets,
	warnings: &mut Vec<String>,
) -> Result<AppliedEditTarget, String> {
	let target = resolve_edit_target(
		state,
		operation,
		scheduled,
		default_selector,
		default_crc,
		current_batch_targets,
		warnings,
	)?;
	let anchor = target.chunk;
	let target_before = anchor.clone();
	if anchor.kind == ChunkKind::Theirs {
		return Err(
			"Virtual conflict branches cannot be edited in place. Delete conflict.theirs to accept \
			 ours, delete conflict.ours to accept theirs, or replace the parent conflict chunk for a \
			 manual merge."
				.to_owned(),
		);
	}
	let (insertion, pos) = resolve_insertion_point(
		state,
		&anchor,
		target.region,
		operation.op,
		operation.content.as_deref(),
		file_indent_char,
		file_indent_step,
	)?;
	let suppress_chunk_adjacency =
		matches!(operation.op, ChunkEditOp::Prepend | ChunkEditOp::Append)
			&& !(matches!(operation.op, ChunkEditOp::Append)
				&& pos == InsertPosition::After
				&& owned_container_end_line(state, &anchor) > anchor.end_line);
	let spacing = compute_insert_spacing(state, &anchor, pos, suppress_chunk_adjacency);
	let content = operation.content.as_deref().unwrap_or_default();
	let mut replacement = normalize_inserted_content(
		content,
		&insertion.indent,
		Some(file_indent_step),
		file_indent_char,
		normalize_indent,
	);
	replacement =
		normalize_insertion_boundary_content(state, insertion.offset, &replacement, spacing);

	if pos == InsertPosition::FirstChild {
		let body = replacement.trim_matches('\n');
		let comment_only =
			!body.is_empty() && body.lines().all(|line| is_comment_only_line(line.trim()));
		if comment_only
			&& anchor.path.is_empty()
			&& anchor.children.iter().any(|child| child == "preamble")
		{
			return Err(
				"Comment-only ~.prepend on root is not allowed when the file has a preamble chunk. \
				 Use replace on the preamble chunk instead."
					.to_owned(),
			);
		}
		if comment_only && !anchor.children.is_empty() {
			warnings.push(
				"Comment-only ~.prepend can merge into the following chunk's first line; it is not a \
				 separate named chunk."
					.to_owned(),
			);
		}
	}

	replace_source_and_adjust_conflicts(
		state,
		insert_at_offset(&state.source, insertion.offset, &replacement),
		warnings,
	);
	touched_paths.push(anchor.path);
	Ok(AppliedEditTarget { before: target_before, full_chunk_removed: false })
}

fn normalize_operation_literals(operation: &EditOperation) -> EditOperation {
	let mut operation = operation.clone();
	if matches!(operation.sel.as_deref(), Some("null" | "undefined")) {
		operation.sel = None;
	}
	if matches!(operation.crc.as_deref(), Some("null" | "undefined")) {
		operation.crc = None;
	}
	operation
}

fn normalize_chunk_source(text: &str) -> String {
	text
		.strip_prefix('\u{feff}')
		.unwrap_or(text)
		.replace("\r\n", "\n")
		.replace('\r', "\n")
}

fn rebuild_chunk_state(
	source: String,
	language: String,
	notebook: Option<crate::chunk::ast_ipynb::SharedNotebookContext>,
	conflict_meta: HashMap<String, ConflictMeta>,
) -> Result<ChunkStateInner, String> {
	let mut tree = if let Some(ctx) = &notebook {
		crate::chunk::ast_ipynb::build_notebook_tree_from_virtual(
			source.as_str(),
			ctx.kernel_language.as_str(),
		)?
	} else {
		crate::chunk::build_chunk_tree(source.as_str(), language.as_str())
			.map_err(|err| err.to_string())?
	};
	let rebuilt_conflicts = if conflict_meta.is_empty() {
		HashMap::new()
	} else {
		crate::chunk::conflict::reinject_conflict_chunks(&mut tree, source.as_str(), &conflict_meta)
	};
	let mut inner = ChunkStateInner::new(source, language, tree);
	inner.notebook = notebook;
	inner.conflict_meta = rebuilt_conflicts;
	Ok(inner)
}

fn validate_batch_crc(chunk: &ChunkNode, crc: Option<&str>, required: bool) -> Result<(), String> {
	if !required && crc.is_none() {
		return Ok(());
	}
	validate_crc(chunk, crc)
}

fn validate_crc(chunk: &ChunkNode, crc: Option<&str>) -> Result<(), String> {
	let cleaned = sanitize_crc(crc).ok_or_else(|| {
		let selector = if chunk.path.is_empty() {
			format!("#{}", chunk.checksum)
		} else {
			format!("{}#{}", chunk.path, chunk.checksum)
		};
		format!(
			"Checksum required for {}. Re-read the chunk to get the current checksum, then include \
			 it in the selector. Hint: use target \"{}\" for container replacement, or append \
			 another region such as ~.",
			chunk_path_opt(chunk),
			selector
		)
	})?;
	if chunk.checksum != cleaned {
		return Err(format!(
			"Checksum mismatch for {}: expected \"{}\", got \"{}\". The chunk content has changed \
			 since you last read it. Use the fresh checksum from the context below to retry.",
			chunk_path_opt(chunk),
			chunk.checksum,
			cleaned
		));
	}
	Ok(())
}

const fn chunk_path_opt(chunk: &ChunkNode) -> &str {
	if chunk.path.is_empty() {
		"root"
	} else {
		chunk.path.as_str()
	}
}

fn describe_scheduled_operation(scheduled: &ScheduledEditOperation) -> String {
	let op = scheduled.operation.op.as_str();
	match (scheduled.requested_selector.as_deref(), scheduled.supplied_checksum.as_deref()) {
		(Some(selector), Some(checksum)) => format!("{op} on \"{selector}#{checksum}\""),
		(Some(selector), None) => format!("{op} on \"{selector}\""),
		(None, Some(checksum)) => format!("{op} on \"#{checksum}\""),
		(None, None) => op.to_owned(),
	}
}

/// Return `true` when `line` (already trimmed) is empty or a line comment in
/// any of the languages this tool edits.
///
/// Distinguishes shell/Python `# comment` (hash followed by whitespace, `!`,
/// or end-of-line) from TS/JS `#private` field declarations and Rust `#[attr]`
/// attributes, which all start with `#` but are not comments.
fn is_comment_only_line(line: &str) -> bool {
	if line.is_empty() {
		return true;
	}
	// C-family single-line and block comments. `//` covers `///` doc comments.
	if line.starts_with("//") || line.starts_with("/*") {
		return true;
	}
	// Hash-family comments (shell, Python, YAML, TOML, Nix, make, ...).
	// A bare `#`, shebang `#!`, or `#` followed by whitespace is a comment.
	// `#[attr]` (Rust), `#![attr]` (Rust inner), and `#foo` (TS private field)
	// are **not** comments.
	if let Some(rest) = line.strip_prefix('#') {
		return rest.is_empty()
			|| rest.starts_with('!') && !rest.starts_with("![")
			|| rest.starts_with(' ')
			|| rest.starts_with('\t');
	}
	false
}

fn replace_byte_range(source: &str, start: usize, end: usize, replacement: &str) -> String {
	let mut new_source = String::with_capacity(
		source
			.len()
			.saturating_sub(end.saturating_sub(start))
			.saturating_add(replacement.len()),
	);
	new_source.push_str(&source[..start]);
	new_source.push_str(replacement);
	new_source.push_str(&source[end..]);
	new_source
}

fn changed_span(before: &str, after: &str) -> (usize, usize, usize) {
	let before_bytes = before.as_bytes();
	let after_bytes = after.as_bytes();
	let mut prefix = 0usize;
	let max_prefix = before_bytes.len().min(after_bytes.len());
	while prefix < max_prefix && before_bytes[prefix] == after_bytes[prefix] {
		prefix += 1;
	}

	let mut before_suffix = before_bytes.len();
	let mut after_suffix = after_bytes.len();
	while before_suffix > prefix && after_suffix > prefix {
		if before_bytes[before_suffix - 1] != after_bytes[after_suffix - 1] {
			break;
		}
		before_suffix -= 1;
		after_suffix -= 1;
	}

	(prefix, before_suffix, after_suffix)
}

const fn adjust_offset(offset: usize, delta: isize) -> usize {
	if delta >= 0 {
		offset.saturating_add(delta as usize)
	} else {
		offset.saturating_sub((-delta) as usize)
	}
}

fn update_conflict_meta_after_source_change(
	conflict_meta: &mut HashMap<String, ConflictMeta>,
	before: &str,
	after: &str,
	warnings: &mut Vec<String>,
) {
	let (change_start, before_end, after_end) = changed_span(before, after);
	if change_start == before_end && change_start == after_end {
		return;
	}

	let delta = (after_end.saturating_sub(change_start) as isize)
		- (before_end.saturating_sub(change_start) as isize);
	let mut removed = Vec::new();

	for (path, meta) in conflict_meta.iter_mut() {
		if before_end <= meta.ours_start_byte {
			meta.ours_start_byte = adjust_offset(meta.ours_start_byte, delta);
			meta.ours_end_byte = adjust_offset(meta.ours_end_byte, delta);
			continue;
		}
		if change_start >= meta.ours_end_byte {
			continue;
		}
		if change_start >= meta.ours_start_byte && before_end <= meta.ours_end_byte {
			meta.ours_end_byte = adjust_offset(meta.ours_end_byte, delta);
			continue;
		}

		removed.push(path.clone());
	}

	for path in removed {
		conflict_meta.remove(path.as_str());
		warnings.push(format!(
			"Conflict {path} no longer maps cleanly after a surrounding edit, so it was marked as \
			 resolved."
		));
	}
}

fn replace_source_and_adjust_conflicts(
	state: &mut ChunkStateInner,
	new_source: String,
	warnings: &mut Vec<String>,
) {
	let before = state.source.clone();
	update_conflict_meta_after_source_change(
		&mut state.conflict_meta,
		before.as_str(),
		new_source.as_str(),
		warnings,
	);
	state.source = new_source;
}

fn target_indent_for_region(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	region: Option<ChunkRegion>,
	file_indent_char: char,
	file_indent_step: usize,
) -> String {
	match region {
		None | Some(ChunkRegion::Head) => anchor.indent_char.repeat(anchor.indent as usize),
		Some(ChunkRegion::Body) => {
			compute_insert_indent(state, anchor, true, file_indent_char, file_indent_step)
		},
	}
}

fn normalize_inserted_content(
	content: &str,
	target_indent: &str,
	file_indent_step: Option<usize>,
	file_indent_char: char,
	normalize_indent: bool,
) -> String {
	let mut normalized = normalize_chunk_source(content);
	normalized = strip_content_prefixes(&normalized);
	if !normalize_indent {
		let dedented = dedent_python_style(&normalized);
		return indent_non_empty_lines(&dedented, target_indent);
	}
	normalized = normalized
		.split('\n')
		.map(|line| denormalize_from_tabs(line, file_indent_char, file_indent_step.unwrap_or(1)))
		.collect::<Vec<_>>()
		.join("\n");
	if target_indent.is_empty() {
		// Even at indent level 0, normalize the content's indent character
		// to match the file's convention (e.g. LLM sends spaces for a tab file).
		normalized =
			normalize_leading_whitespace_char(&normalized, file_indent_char, file_indent_step);
	} else {
		normalized = reindent_inserted_block(&normalized, target_indent, file_indent_step);
	}
	normalized
}

fn line_offsets(text: &str) -> Vec<usize> {
	let mut offsets = vec![0usize];
	for (index, ch) in text.char_indices() {
		if ch == '\n' {
			offsets.push(index + 1);
		}
	}
	offsets
}

fn line_start_offset(offsets: &[usize], line: u32, text: &str) -> usize {
	if line <= 1 {
		0
	} else {
		offsets
			.get((line - 1) as usize)
			.copied()
			.unwrap_or(text.len())
	}
}

fn line_end_offset(offsets: &[usize], line: u32, text: &str) -> usize {
	offsets.get(line as usize).copied().unwrap_or(text.len())
}

fn replace_range_by_lines(text: &str, start_line: u32, end_line: u32, replacement: &str) -> String {
	let offsets = line_offsets(text);
	let start_offset = line_start_offset(&offsets, start_line, text);
	let end_offset = line_end_offset(&offsets, end_line, text);
	format!("{}{}{}", &text[..start_offset], replacement, &text[end_offset..])
}

fn insert_at_offset(text: &str, offset: usize, content: &str) -> String {
	format!("{}{}{}", &text[..offset], content, &text[offset..])
}

fn cleanup_blank_line_artifacts_at_offset(text: &str, offset: usize) -> String {
	let mut run_start = offset.min(text.len());
	while run_start > 0 && text.as_bytes()[run_start - 1] == b'\n' {
		run_start -= 1;
	}

	let mut run_end = offset.min(text.len());
	while run_end < text.len() && text.as_bytes()[run_end] == b'\n' {
		run_end += 1;
	}

	let newline_run = &text[run_start..run_end];
	if !newline_run.contains("\n\n") {
		return text.to_owned();
	}

	let after_run = &text[run_end..];
	let before_run = &text[..run_start];
	let after_starts_with_close = after_run
		.trim_start_matches([' ', '\t'])
		.chars()
		.next()
		.is_some_and(|ch| matches!(ch, '}' | ']' | ')'));

	if after_starts_with_close {
		if newline_run.contains("\n\n\n") {
			return format!("{}{}{}", before_run, collapse_newline_runs(newline_run, 2), after_run);
		}
		// In a deletion context, blank lines before closing delimiters are
		// artifacts of the removed chunk, not intentional formatting.
		return format!("{before_run}\n{after_run}");
	}
	// After deleting a first-child chunk, collapse the blank line between an
	// opening delimiter and the next sibling content.
	let before_ends_with_open = before_run
		.trim_end()
		.chars()
		.last()
		.is_some_and(|ch| matches!(ch, '{' | '[' | '(' | ':'));
	if before_ends_with_open && newline_run.contains("\n\n") && !newline_run.contains("\n\n\n") {
		return format!("{before_run}\n{after_run}");
	}
	if !newline_run.contains("\n\n\n") {
		return text.to_owned();
	}
	format!("{}{}{}", before_run, collapse_newline_runs(newline_run, 2), after_run)
}

fn collapse_newline_runs(run: &str, max_newlines: usize) -> String {
	let mut out = String::with_capacity(run.len());
	let mut newline_count = 0usize;
	for ch in run.chars() {
		if ch == '\n' {
			newline_count += 1;
			if newline_count <= max_newlines {
				out.push(ch);
			}
		} else {
			newline_count = 0;
			out.push(ch);
		}
	}
	out
}

fn chunk_slice(text: &str, chunk: &ChunkNode) -> String {
	if chunk.line_count == 0 {
		return String::new();
	}
	text
		.split('\n')
		.skip(chunk.start_line.saturating_sub(1) as usize)
		.take((chunk.end_line - chunk.start_line + 1) as usize)
		.collect::<Vec<_>>()
		.join("\n")
}

const fn is_container_like_chunk(chunk: &ChunkNode) -> bool {
	let traits = chunk.kind.traits();
	!chunk.leaf
		|| traits.container
		|| traits.has_addressable_members
		|| traits.always_preserve_children
}

fn go_receiver_belongs_to_type(source: &str, chunk: &ChunkNode, type_name: &str) -> bool {
	let header = source[chunk.start_byte as usize..chunk.end_byte as usize]
		.lines()
		.next()
		.unwrap_or_default()
		.trim_start();
	header.starts_with("func ")
		&& (header.contains(&format!(" {type_name})")) || header.contains(&format!("*{type_name})")))
}

fn owned_container_end_line(state: &ChunkStateInner, anchor: &ChunkNode) -> u32 {
	if state.language != "go" || anchor.kind != ChunkKind::Type {
		return anchor.end_line;
	}

	let type_name = anchor
		.identifier
		.as_deref()
		.unwrap_or_else(|| anchor.kind.prefix());
	let mut owned_end_line = anchor.end_line;
	let mut top_level_chunks = state
		.tree
		.chunks
		.iter()
		.filter(|chunk| chunk.parent_path.as_deref() == Some(""))
		.collect::<Vec<_>>();
	top_level_chunks.sort_by_key(|chunk| chunk.start_line);

	let Some(start_index) = top_level_chunks
		.iter()
		.position(|chunk| chunk.path == anchor.path)
	else {
		return anchor.end_line;
	};

	for chunk in top_level_chunks.into_iter().skip(start_index + 1) {
		if chunk.start_line < owned_end_line {
			continue;
		}
		if chunk.kind == ChunkKind::Function
			&& go_receiver_belongs_to_type(&state.source, chunk, type_name)
		{
			owned_end_line = chunk.end_line;
			continue;
		}
		break;
	}

	owned_end_line
}

fn before_chunk_insertion_point(state: &ChunkStateInner, anchor: &ChunkNode) -> InsertionPoint {
	if anchor.path.is_empty() {
		return InsertionPoint { offset: 0, indent: String::new() };
	}
	let offsets = line_offsets(&state.source);
	InsertionPoint {
		offset: line_start_offset(&offsets, anchor.start_line, &state.source),
		indent: anchor.indent_char.repeat(anchor.indent as usize),
	}
}

fn after_chunk_insertion_point(state: &ChunkStateInner, anchor: &ChunkNode) -> InsertionPoint {
	if anchor.path.is_empty() {
		return InsertionPoint { offset: state.source.len(), indent: String::new() };
	}
	let offsets = line_offsets(&state.source);
	let end_line = owned_container_end_line(state, anchor);
	InsertionPoint {
		offset: line_end_offset(&offsets, end_line, &state.source),
		indent: anchor.indent_char.repeat(anchor.indent as usize),
	}
}

fn body_insertion_point(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	at_end: bool,
	file_indent_char: char,
	file_indent_step: usize,
) -> InsertionPoint {
	let offsets = line_offsets(&state.source);
	let indent = compute_insert_indent(state, anchor, true, file_indent_char, file_indent_step);
	if at_end {
		if let Some(last_child_path) = anchor.children.last()
			&& let Some(last_child) = state
				.tree
				.chunks
				.iter()
				.find(|chunk| &chunk.path == last_child_path)
		{
			let child_indent = if last_child.indent_char.is_empty() {
				indent
			} else {
				last_child.indent_char.repeat(last_child.indent as usize)
			};
			return InsertionPoint {
				offset: line_end_offset(&offsets, last_child.end_line, &state.source),
				indent: child_indent,
			};
		}
		let (_, body_end) = chunk_region_range(anchor, ChunkRegion::Body);
		return InsertionPoint { offset: body_end, indent };
	}

	if let Some(first_child_path) = anchor.children.first()
		&& let Some(first_child) = state
			.tree
			.chunks
			.iter()
			.find(|chunk| &chunk.path == first_child_path)
	{
		return InsertionPoint {
			offset: line_start_offset(&offsets, first_child.start_line, &state.source),
			indent,
		};
	}
	let (body_start, _) = chunk_region_range(anchor, ChunkRegion::Body);
	InsertionPoint { offset: body_start, indent }
}

fn resolve_insertion_point(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	region: Option<ChunkRegion>,
	op: ChunkEditOp,
	_file_content: Option<&str>,
	file_indent_char: char,
	file_indent_step: usize,
) -> Result<(InsertionPoint, InsertPosition), String> {
	match (region, op) {
		// Before chunk boundary
		(None, ChunkEditOp::Before | ChunkEditOp::Prepend) => {
			Ok((before_chunk_insertion_point(state, anchor), InsertPosition::Before))
		},
		// After chunk boundary
		(None, ChunkEditOp::After | ChunkEditOp::Append) => {
			Ok((after_chunk_insertion_point(state, anchor), InsertPosition::After))
		},
		// Inner first-child position
		(Some(ChunkRegion::Body), ChunkEditOp::Before | ChunkEditOp::Prepend)
		| (Some(ChunkRegion::Head), ChunkEditOp::After | ChunkEditOp::Append) => Ok((
			body_insertion_point(state, anchor, false, file_indent_char, file_indent_step),
			InsertPosition::FirstChild,
		)),
		// Inner last-child position
		(Some(ChunkRegion::Body), ChunkEditOp::After | ChunkEditOp::Append)
		| (Some(ChunkRegion::Head), ChunkEditOp::Before | ChunkEditOp::Prepend) => Ok((
			body_insertion_point(state, anchor, true, file_indent_char, file_indent_step),
			InsertPosition::LastChild,
		)),
		(_, ChunkEditOp::Put | ChunkEditOp::Replace | ChunkEditOp::Delete) => {
			Err("Internal error: insertion point requested for non-insert op".to_owned())
		},
	}
}

fn indent_prefix_for_level(
	anchor: &ChunkNode,
	file_indent_char: char,
	file_indent_step: usize,
	extra_levels: usize,
) -> String {
	let step = file_indent_step.max(1);
	let indent_char = if matches!(file_indent_char, ' ' | '\t') {
		file_indent_char
	} else {
		anchor.indent_char.chars().next().unwrap_or(' ')
	};
	if indent_char == '\t' {
		return "\t".repeat(anchor.indent as usize + extra_levels);
	}
	let indent_levels = (anchor.indent as usize / step).saturating_add(extra_levels);
	" ".repeat(step * indent_levels)
}

fn compute_insert_indent(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	inside: bool,
	file_indent_char: char,
	file_indent_step: usize,
) -> String {
	if !inside || anchor.path.is_empty() {
		return String::new();
	}
	if let Some(first_child_path) = anchor.children.first()
		&& let Some(first_child) = state
			.tree
			.chunks
			.iter()
			.find(|chunk| &chunk.path == first_child_path)
	{
		let indent_char = if first_child.indent_char.is_empty() {
			if anchor.indent_char.is_empty() {
				"\t"
			} else {
				anchor.indent_char.as_str()
			}
		} else {
			first_child.indent_char.as_str()
		};
		return indent_char.repeat(first_child.indent as usize);
	}

	// Scan only the ~ region (between prologue and epilogue), not the full
	// chunk. This avoids picking up the closing delimiter's indent for
	// empty/sparse bodies.
	let (body_start, body_end) = chunk_region_range(anchor, ChunkRegion::Body);
	if body_start < body_end && body_end <= state.source.len() {
		for line in state.source[body_start..body_end].split('\n') {
			if line.trim().is_empty() {
				continue;
			}
			let prefix_len = line.len() - line.trim_start_matches([' ', '\t']).len();
			if prefix_len > 0 {
				return line[..prefix_len].to_owned();
			}
			break;
		}
	}

	let indent_char = if anchor.indent_char.is_empty() {
		file_indent_char.to_string()
	} else {
		anchor.indent_char.clone()
	};
	if indent_char == "\t" {
		"\t".repeat(anchor.indent as usize + 1)
	} else {
		indent_prefix_for_level(anchor, file_indent_char, file_indent_step, 1)
	}
}

fn sibling_index(state: &ChunkStateInner, anchor: &ChunkNode) -> Option<(usize, usize)> {
	let parent_path = anchor.parent_path.as_deref().unwrap_or("");
	let parent = state
		.tree
		.chunks
		.iter()
		.find(|chunk| chunk.path == parent_path)?;
	let index = parent
		.children
		.iter()
		.position(|child| child == &anchor.path)?;
	Some((index, parent.children.len()))
}

fn has_sibling_before(state: &ChunkStateInner, anchor: &ChunkNode) -> bool {
	sibling_index(state, anchor).is_some_and(|(index, _)| index > 0)
}

fn has_sibling_after(state: &ChunkStateInner, anchor: &ChunkNode) -> bool {
	sibling_index(state, anchor).is_some_and(|(index, total)| index + 1 < total)
}

fn container_has_interior_content(state: &ChunkStateInner, anchor: &ChunkNode) -> bool {
	if !is_container_like_chunk(anchor) {
		return false;
	}
	chunk_slice(&state.source, anchor)
		.split('\n')
		.skip(1)
		.collect::<Vec<_>>()
		.into_iter()
		.rev()
		.skip(1)
		.any(|line| !line.trim().is_empty())
}

fn visible_child_chunks<'a>(
	state: &'a ChunkStateInner,
	anchor: &'a ChunkNode,
) -> Vec<&'a ChunkNode> {
	anchor
		.children
		.iter()
		.filter_map(|child_path| {
			state
				.tree
				.chunks
				.iter()
				.find(|chunk| chunk.path == *child_path)
		})
		.filter(|child| child.kind != ChunkKind::Chunk)
		.collect()
}

fn sibling_gap_has_blank_line(
	state: &ChunkStateInner,
	left: &ChunkNode,
	right: &ChunkNode,
) -> bool {
	right.start_line > owned_container_end_line(state, left) + 1
}

/// Returns true if a container's children should be separated by blank lines.
/// Root-level children (functions, classes) and containers with non-leaf
/// children (methods) want blank line spacing. Containers whose children are
/// all packed declarations (struct fields, enum variants) are tightly packed.
fn children_want_blank_line_spacing(state: &ChunkStateInner, anchor: &ChunkNode) -> bool {
	if anchor.path.is_empty() {
		let root_children = visible_child_chunks(state, anchor);
		if root_children.len() >= 2 {
			return root_children
				.windows(2)
				.any(|pair| sibling_gap_has_blank_line(state, pair[0], pair[1]));
		}
		return true;
	}
	if anchor.children.is_empty() {
		return true;
	}

	let visible_children = visible_child_chunks(state, anchor);
	if visible_children.is_empty() {
		return true;
	}
	if visible_children.len() >= 2 {
		return visible_children
			.windows(2)
			.any(|pair| sibling_gap_has_blank_line(state, pair[0], pair[1]));
	}

	let all_packed = visible_children
		.iter()
		.all(|child| child.kind.traits().packed);
	!all_packed
}

/// Returns true if sibling insertions around `anchor` should have blank line
/// spacing. Checks whether the anchor's parent container uses spaced or packed
/// layout.
fn is_spaced_sibling(state: &ChunkStateInner, anchor: &ChunkNode) -> bool {
	let parent_path = anchor.parent_path.as_deref().unwrap_or("");
	if let Some(parent) = state.tree.chunks.iter().find(|c| c.path == parent_path) {
		children_want_blank_line_spacing(state, parent)
	} else {
		true // Default to spaced if parent not found
	}
}

fn compute_insert_spacing(
	state: &ChunkStateInner,
	anchor: &ChunkNode,
	pos: InsertPosition,
	is_prepend_or_append: bool,
) -> InsertSpacing {
	let has_interior_content = container_has_interior_content(state, anchor);
	let markdown_block_spacing = state.language == "markdown";
	match pos {
		InsertPosition::FirstChild => {
			let spaced = markdown_block_spacing || children_want_blank_line_spacing(state, anchor);
			InsertSpacing {
				blank_line_before: false,
				blank_line_after:  spaced && (!anchor.children.is_empty() || has_interior_content),
			}
		},
		InsertPosition::LastChild => {
			let spaced = markdown_block_spacing || children_want_blank_line_spacing(state, anchor);
			InsertSpacing {
				blank_line_before: spaced && (!anchor.children.is_empty() || has_interior_content),
				blank_line_after:  markdown_block_spacing && has_sibling_after(state, anchor),
			}
		},
		InsertPosition::Before => {
			let spaced = markdown_block_spacing || is_spaced_sibling(state, anchor);
			InsertSpacing {
				blank_line_before: has_sibling_before(state, anchor) && spaced,
				// When the op is `prepend` (container.prepend), omit the trailing
				// blank line so the content stays adjacent to the chunk and gets
				// absorbed as leading trivia on tree rebuild.
				blank_line_after:  !is_prepend_or_append && spaced,
			}
		},
		InsertPosition::After => {
			let spaced = markdown_block_spacing || is_spaced_sibling(state, anchor);
			InsertSpacing {
				// When the op is `append` (container.append), omit the leading
				// blank line so the content stays adjacent to the chunk.
				blank_line_before: !is_prepend_or_append && spaced,
				blank_line_after:  has_sibling_after(state, anchor) && spaced,
			}
		},
	}
}

fn count_trailing_newlines_before_offset(text: &str, offset: usize) -> usize {
	let mut count = 0usize;
	let bytes = text.as_bytes();
	let mut index = offset;
	while index > 0 && bytes[index - 1] == b'\n' {
		count += 1;
		index -= 1;
	}
	count
}

fn count_leading_newlines_after_offset(text: &str, offset: usize) -> usize {
	let mut count = 0usize;
	let bytes = text.as_bytes();
	let mut index = offset;
	while index < bytes.len() && bytes[index] == b'\n' {
		count += 1;
		index += 1;
	}
	count
}

fn normalize_insertion_boundary_content(
	state: &ChunkStateInner,
	offset: usize,
	content: &str,
	spacing: InsertSpacing,
) -> String {
	let trimmed = content.trim_matches('\n');
	if trimmed.is_empty() {
		return content.to_owned();
	}

	let prev_char = if offset > 0 {
		state
			.source
			.as_bytes()
			.get(offset - 1)
			.copied()
			.map(char::from)
	} else {
		None
	};
	let next_char = state.source.as_bytes().get(offset).copied().map(char::from);
	let prefix_newlines = if spacing.blank_line_before {
		2usize.saturating_sub(count_trailing_newlines_before_offset(&state.source, offset))
	} else {
		usize::from(prev_char.is_some() && prev_char != Some('\n'))
	};
	let suffix_newlines = if spacing.blank_line_after {
		2usize.saturating_sub(count_leading_newlines_after_offset(&state.source, offset))
	} else {
		usize::from(next_char.is_some() && next_char != Some('\n'))
	};

	format!("{}{}{}", "\n".repeat(prefix_newlines), trimmed, "\n".repeat(suffix_newlines))
}

fn line_column_at_offset(text: &str, offset: usize) -> (usize, usize) {
	let offsets = line_offsets(text);
	let mut low = 0usize;
	let mut high = offsets.len().saturating_sub(1);
	while low <= high {
		let mid = usize::midpoint(low, high);
		let start = offsets[mid];
		let next = offsets.get(mid + 1).copied().unwrap_or(text.len() + 1);
		if offset < start {
			if mid == 0 {
				break;
			}
			high = mid - 1;
			continue;
		}
		if offset >= next {
			low = mid + 1;
			continue;
		}
		return (mid + 1, offset - start + 1);
	}
	(offsets.len(), 1)
}

fn format_parse_error_summaries(state: &ChunkStateInner) -> Vec<String> {
	state
		.tree
		.chunks
		.iter()
		.filter(|chunk| chunk.error)
		.take(3)
		.map(|chunk| {
			let (line, column) = line_column_at_offset(&state.source, chunk.start_byte as usize);
			match chunk
				.signature
				.as_deref()
				.map(str::trim)
				.filter(|value| !value.is_empty())
			{
				Some(snippet) => format!("L{line}:C{column} unexpected syntax near {snippet:?}"),
				None => format!("L{line}:C{column} unexpected syntax"),
			}
		})
		.collect()
}

fn display_path_for_file(file_path: &str, cwd: &str) -> String {
	let file = Path::new(file_path);
	let cwd = Path::new(cwd);
	match file.strip_prefix(cwd) {
		Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
		Err(_) => file.to_string_lossy().replace('\\', "/"),
	}
}

/// A parsed unified diff hunk.
struct DiffHunk {
	header:    String,
	lines:     Vec<String>,
	old_start: u32,
	old_len:   u32,
	new_start: u32,
}

/// Normalize the content part of a diff hunk line (after the +/-/space prefix)
/// so that its indentation matches the chunk tree display format.
fn render_hunk_line(
	line: &str,
	normalize_indent: bool,
	indent_char: char,
	indent_step: usize,
) -> String {
	if !normalize_indent {
		return line.to_owned();
	}
	if line.is_empty() {
		return line.to_owned();
	}
	let first = line.as_bytes()[0];
	if matches!(first, b'+' | b'-' | b' ') {
		let prefix = &line[..1];
		let content = &line[1..];
		let normalized = normalize_to_tabs(content, indent_char, indent_step);
		format!("{prefix}{normalized}")
	} else {
		line.to_owned()
	}
}

/// Generate unified diff hunks between two texts using the `similar` crate.
fn generate_diff_hunks(before: &str, after: &str, context: usize) -> Vec<DiffHunk> {
	use similar::{ChangeTag, TextDiff};

	let diff = TextDiff::from_lines(before, after);
	let mut hunks = Vec::new();

	for group in diff.grouped_ops(context) {
		let mut hunk_lines = Vec::new();

		let first = &group[0];
		let last = &group[group.len() - 1];
		let old_start = first.old_range().start + 1;
		let old_len = last.old_range().end - first.old_range().start;
		let new_start = first.new_range().start + 1;
		let new_len = last.new_range().end - first.new_range().start;

		let header = format!("@@ -{old_start},{old_len} +{new_start},{new_len} @@");

		for op in &group {
			for change in diff.iter_changes(op) {
				let line = change.value().trim_end_matches('\n');
				match change.tag() {
					ChangeTag::Equal => hunk_lines.push(format!(" {line}")),
					ChangeTag::Delete => hunk_lines.push(format!("-{line}")),
					ChangeTag::Insert => hunk_lines.push(format!("+{line}")),
				}
			}
		}

		hunks.push(DiffHunk {
			header,
			lines: hunk_lines,
			old_start: old_start as u32,
			old_len: old_len as u32,
			new_start: new_start as u32,
		});
	}

	hunks
}

fn deleted_chunk_anchor_label(chunk: &ChunkNode, style: ChunkAnchorStyle) -> String {
	match style {
		ChunkAnchorStyle::Full | ChunkAnchorStyle::FullOmit => chunk.path.clone(),
		ChunkAnchorStyle::Kind
		| ChunkAnchorStyle::KindOmit
		| ChunkAnchorStyle::Bare
		| ChunkAnchorStyle::None => chunk.kind.path_segment(chunk.identifier.as_deref()),
	}
}

fn deleted_chunk_anchor_indent(
	chunk: &ChunkNode,
	normalize_indent: bool,
	file_indent_char: char,
	file_indent_step: usize,
	tab_replacement: &str,
) -> String {
	let indent_char = if chunk.indent_char.is_empty() {
		file_indent_char.to_string()
	} else {
		chunk.indent_char.clone()
	};
	let raw_indent = indent_char.repeat(chunk.indent as usize);
	if normalize_indent {
		normalize_to_tabs(&raw_indent, file_indent_char, file_indent_step)
	} else {
		raw_indent.replace('\t', tab_replacement)
	}
}

fn deleted_hunk_owner<'a>(
	hunk: &DiffHunk,
	before_chunks: &'a HashMap<String, ChunkNode>,
	current_lookup: &HashMap<&str, &ChunkNode>,
	touched_paths: &[String],
) -> Option<&'a ChunkNode> {
	if hunk.old_len == 0 {
		return None;
	}
	let old_end = hunk
		.old_start
		.saturating_add(hunk.old_len.saturating_sub(1));
	touched_paths
		.iter()
		.filter(|path| !current_lookup.contains_key(path.as_str()))
		.filter_map(|path| before_chunks.get(path))
		.filter(|chunk| chunk.start_line <= old_end && hunk.old_start <= chunk.end_line)
		.min_by_key(|chunk| chunk.line_count)
}

/// Render the response text for a changed file, combining the current chunked
/// tree view with inline diff hunks placed inside the owning chunk blocks.
fn render_changed_hunks(
	state: &ChunkStateInner,
	display_path: &str,
	before: &str,
	after: &str,
	anchor_style: Option<ChunkAnchorStyle>,
	touched_paths: &[String],
	before_checksums: &std::collections::HashMap<String, String>,
	before_chunks: &HashMap<String, ChunkNode>,
	normalize_indent: bool,
) -> String {
	use std::collections::{HashMap, HashSet};

	let show_leaf_preview = state.language == "tlaplus";
	let focused_paths = compute_focus(state.tree(), touched_paths);
	let hunks = generate_diff_hunks(before, after, 0);

	let tree = state.tree();
	let tab_replacement = if normalize_indent {
		NORMALIZED_TAB_REPLACEMENT
	} else {
		PRESERVED_TAB_REPLACEMENT
	};
	let file_indent_char = detect_file_indent_char(state.source(), tree);
	let file_indent_step = detect_file_indent_step(state.source(), tree) as usize;
	let lookup: HashMap<&str, &ChunkNode> =
		tree.chunks.iter().map(|c| (c.path.as_str(), c)).collect();
	let render_indent = normalize_indent.then_some((file_indent_char, file_indent_step));
	let mut inline_hunks: HashMap<String, Vec<crate::chunk::render::InlineHunk>> = HashMap::new();
	let mut changed_anchor_paths = HashSet::new();
	let style = anchor_style.unwrap_or_default();

	for hunk in &hunks {
		if let Some(deleted_chunk) = deleted_hunk_owner(hunk, before_chunks, &lookup, touched_paths) {
			let owner_path = deleted_chunk
				.parent_path
				.as_deref()
				.unwrap_or("")
				.to_owned();
			let anchor_indent = deleted_chunk_anchor_indent(
				deleted_chunk,
				normalize_indent,
				file_indent_char,
				file_indent_step,
				tab_replacement,
			);
			let diff_indent = if normalize_indent {
				format!("{anchor_indent}\t")
			} else {
				format!("{anchor_indent}{tab_replacement}")
			};
			let anchor_label = deleted_chunk_anchor_label(deleted_chunk, style);
			let mut lines = Vec::with_capacity(hunk.lines.len() + 2);
			lines.push(crate::chunk::render::InlineHunkLine {
				text:   style.render(
					&anchor_indent,
					anchor_label.as_str(),
					deleted_chunk.checksum.as_str(),
				),
				marker: Some('-'),
			});
			lines.push(crate::chunk::render::InlineHunkLine {
				text:   format!("{diff_indent}{}", hunk.header),
				marker: None,
			});
			for line in &hunk.lines {
				let normalized =
					render_hunk_line(line, normalize_indent, file_indent_char, file_indent_step);
				lines.push(crate::chunk::render::InlineHunkLine {
					text:   format!("{diff_indent}{normalized}"),
					marker: None,
				});
			}
			inline_hunks
				.entry(owner_path)
				.or_default()
				.push(crate::chunk::render::InlineHunk { lines });
			continue;
		}

		let owner_path =
			crate::chunk::render::find_hunk_owner_chunk(tree, &lookup, hunk.new_start).unwrap_or("");
		let indent = if owner_path.is_empty() {
			String::new()
		} else {
			crate::chunk::render::hunk_indent_for_chunk(
				&lookup,
				owner_path,
				state.source(),
				tab_replacement,
				render_indent,
			)
		};
		let mut lines = Vec::with_capacity(hunk.lines.len() + 1);
		lines.push(crate::chunk::render::InlineHunkLine {
			text:   format!("{indent}{}", hunk.header),
			marker: None,
		});
		for line in &hunk.lines {
			let normalized =
				render_hunk_line(line, normalize_indent, file_indent_char, file_indent_step);
			lines.push(crate::chunk::render::InlineHunkLine {
				text:   format!("{indent}{normalized}"),
				marker: None,
			});
		}
		inline_hunks
			.entry(owner_path.to_owned())
			.or_default()
			.push(crate::chunk::render::InlineHunk { lines });
	}

	for path in touched_paths {
		let mut current = Some(path.as_str());
		while let Some(chunk_path) = current {
			if chunk_path.is_empty() {
				break;
			}
			let Some(chunk) = lookup.get(chunk_path) else {
				current = chunk_path.rfind('.').map(|dot| &chunk_path[..dot]);
				continue;
			};
			if before_checksums
				.get(&chunk.path)
				.is_none_or(|previous| previous != &chunk.checksum)
			{
				changed_anchor_paths.insert(chunk.path.clone());
			}
			current = chunk.parent_path.as_deref();
		}
	}

	crate::chunk::render::render_state_with_hunks(
		state,
		&RenderParams {
			chunk_path: Some(String::new()),
			title: display_path.to_owned(),
			language_tag: Some(state.language.clone()),
			visible_range: None,
			render_children_only: true,
			omit_checksum: false,
			anchor_style,
			show_leaf_preview,
			tab_replacement: Some(tab_replacement.to_owned()),
			normalize_indent: Some(normalize_indent),
			focused_paths,
		},
		inline_hunks,
		changed_anchor_paths,
	)
}

/// Build a focus list that includes touched chunks as Expanded and all
/// ancestors as Container.
/// Falls back to no focus (full render) when more than 20 chunks were touched.
fn compute_focus(
	tree: &crate::chunk::types::ChunkTree,
	touched: &[String],
) -> Option<Vec<FocusedPath>> {
	use std::collections::HashMap;

	if touched.is_empty() || touched.len() > 20 {
		return None;
	}

	let lookup: HashMap<&str, &ChunkNode> =
		tree.chunks.iter().map(|c| (c.path.as_str(), c)).collect();
	let mut focus: HashMap<String, ChunkFocusMode> = HashMap::new();

	for path in touched {
		let Some(chunk) = lookup.get(path.as_str()) else {
			// Deleted chunk: derive parent from the path string and mark it
			// Expanded so the diff hunk (owned by the parent) still renders.
			if let Some(dot) = path.rfind('.') {
				let parent_path = &path[..dot];
				focus
					.entry(parent_path.to_string())
					.and_modify(|m| {
						if *m == ChunkFocusMode::Container {
							*m = ChunkFocusMode::Expanded;
						}
					})
					.or_insert(ChunkFocusMode::Expanded);
				// Walk ancestors of the parent upward.
				let mut current = lookup
					.get(parent_path)
					.and_then(|p| p.parent_path.as_deref());
				while let Some(anc) = current {
					focus
						.entry(anc.to_string())
						.or_insert(ChunkFocusMode::Container);
					current = lookup.get(anc).and_then(|p| p.parent_path.as_deref());
				}
			}
			continue;
		};
		focus.insert(path.clone(), ChunkFocusMode::Expanded);

		// Ancestors -> Container (don't downgrade Expanded).
		let mut current = chunk.parent_path.as_deref();
		while let Some(parent_path) = current {
			focus
				.entry(parent_path.to_string())
				.or_insert(ChunkFocusMode::Container);
			current = lookup
				.get(parent_path)
				.and_then(|p| p.parent_path.as_deref());
		}
	}

	// Root chunk must always be Container so the walk starts.
	focus
		.entry(String::new())
		.or_insert(ChunkFocusMode::Container);

	Some(
		focus
			.into_iter()
			.map(|(path, mode)| FocusedPath { path, mode })
			.collect(),
	)
}

/// Render a focused chunk view to append to error messages. Resolves the
/// selector ignoring CRC so the agent sees fresh anchors without a re-read.
fn render_error_context(
	state: &ChunkStateInner,
	selector: Option<&str>,
	display_path: &str,
	anchor_style: Option<ChunkAnchorStyle>,
	normalize_indent: bool,
) -> String {
	// When an edit introduces a parse error we render the full chunk tree
	// (no focus) so the agent can see the failure location and surrounding
	// context in a single response, without a follow-up read. For non-parse
	// failures (a single operation rejected before parse validation) the
	// error is local to the targeted chunk, so we keep a narrow focus.
	let has_parse_errors = !state.tree().parse_error_lines.is_empty();
	let focused_paths = if has_parse_errors {
		None
	} else {
		let Ok(ParsedSelector { selector: clean_path, .. }) =
			split_selector_crc_and_region(selector, None, None)
		else {
			return String::new();
		};
		let mut ignored = Vec::new();
		let Ok(chunk) = resolve_chunk_selector(state, clean_path.as_deref(), &mut ignored) else {
			return String::new();
		};
		compute_focus(state.tree(), std::slice::from_ref(&chunk.path))
	};
	let tab_replacement = if normalize_indent {
		NORMALIZED_TAB_REPLACEMENT
	} else {
		PRESERVED_TAB_REPLACEMENT
	};
	let rendered = crate::chunk::render::render_state(state, &RenderParams {
		chunk_path: Some(String::new()),
		title: display_path.to_owned(),
		language_tag: Some(state.language.clone()),
		visible_range: None,
		render_children_only: true,
		omit_checksum: false,
		anchor_style,
		show_leaf_preview: true,
		tab_replacement: Some(tab_replacement.to_owned()),
		normalize_indent: Some(normalize_indent),
		focused_paths,
	});
	format!("\n\nFresh content:\n{rendered}")
}

fn render_unchanged_response(
	state: &ChunkStateInner,
	display_path: &str,
	anchor_style: Option<ChunkAnchorStyle>,
	normalize_indent: bool,
) -> String {
	let tab_replacement = if normalize_indent {
		NORMALIZED_TAB_REPLACEMENT
	} else {
		PRESERVED_TAB_REPLACEMENT
	};
	crate::chunk::render::render_state(state, &RenderParams {
		chunk_path: Some(String::new()),
		title: display_path.to_owned(),
		language_tag: Some(state.language.clone()),
		visible_range: None,
		render_children_only: true,
		omit_checksum: false,
		anchor_style,
		focused_paths: None,
		show_leaf_preview: true,
		tab_replacement: Some(tab_replacement.to_owned()),
		normalize_indent: Some(normalize_indent),
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::chunk::build_chunk_tree;

	fn state_for(source: &str, language: &str) -> ChunkState {
		let tree = build_chunk_tree(source, language).expect("tree should build");
		ChunkState::from_inner(ChunkStateInner::new(source.to_owned(), language.to_owned(), tree))
	}

	fn parsed_state_for(source: &str, language: &str) -> ChunkState {
		ChunkState::parse(source.to_owned(), language.to_owned()).expect("state should parse")
	}

	fn apply_single_edit(
		state: &ChunkState,
		file_path: &str,
		operation: EditOperation,
	) -> EditResult {
		apply_edits(state, &EditParams {
			operations:       vec![operation],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        file_path.to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply")
	}

	fn edit_params(operations: Vec<EditOperation>) -> EditParams {
		EditParams {
			operations,
			default_selector: None,
			default_crc: None,
			anchor_style: None,
			cwd: ".".to_owned(),
			file_path: "test.ts".to_owned(),
			normalize_indent: None,
		}
	}

	#[test]
	fn root_level_replace_preserves_space_indentation() {
		let source = "fn main() {\n    println!(\"old\");\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("fn_mai".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("fn main() {\n        println!(\"new\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply");

		assert!(
			result.diff_after.contains("println!(\"new\");"),
			"expected updated body text, got {:?}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("\n\tprintln!(\"new\");\n"),
			"expected no tab-indented body, got {:?}",
			result.diff_after
		);
	}

	#[test]
	fn diff_hunks_use_normalized_indentation() {
		// Source uses 4-space indentation with nested children, so the tree
		// can detect indent_char=' ' and indent_step=4. The diff hunk lines
		// in the response should use tab-normalized indentation (matching the
		// read tool's output) instead of the raw file indentation.
		let source = "class Foo {\n    value: number = 0;\n\n    increment(): void {\n        \
		              this.value += 1;\n    }\n\n    decrement(): void {\n        this.value -= \
		              1;\n    }\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("cls_Foo.fn_inc").expect("fn_inc");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("cls_Foo.fn_inc".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  Some(ChunkRegion::Body),
				content: Some("this.value += 2;\n".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply");

		// The response text should contain diff hunks with tab-normalized
		// indentation, not the raw 4-space (two levels = 8-space) indentation.
		assert!(
			result.response_text.contains("-\t\tthis.value += 1;"),
			"diff hunk removed line should use tab-normalized indent. Response:\n{}",
			result.response_text
		);
		assert!(
			result.response_text.contains("+\t\tthis.value += 2;"),
			"diff hunk added line should use tab-normalized indent. Response:\n{}",
			result.response_text
		);
		// Should NOT contain the raw 8-space-indented diff lines.
		assert!(
			!result.response_text.contains("-        this.value += 1;"),
			"should not have raw space-indented diff lines. Response:\n{}",
			result.response_text
		);
	}

	#[test]
	fn whole_chunk_replace_does_not_duplicate_attributes() {
		let source = "#[napi]\nfn close() {\n    old();\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_clo").expect("fn_clo");
		// The chunk range should include the #[napi] attribute.
		assert_eq!(chunk.start_line, 1, "chunk should start at the attribute line");

		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some("fn_clo".to_owned()),
			crc:     Some(chunk.checksum.clone()),
			region:  None,
			content: Some("/// doc\n#[napi]\nfn close() {\n    new();\n}".to_owned()),
			find:    None,
		});

		let occurrences = result.diff_after.matches("#[napi]").count();
		assert_eq!(
			occurrences, 1,
			"expected exactly one #[napi] attribute, got {occurrences}. Full text:\n{}",
			result.diff_after
		);
		assert!(result.diff_after.contains("new()"), "replacement body should be present");
	}

	#[test]
	fn edit_auto_resolves_unique_chunk_paths() {
		let source = "class Worker {\n\trun(): void {\n\t\tconsole.log(this.name);\n\t}\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state
			.inner()
			.chunk("cls_Wor.fn_run")
			.expect("cls_Wor.fn_run should exist");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("run".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("run(): void {\n\tconsole.log(\"resolved\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should resolve a unique fuzzy selector");

		assert!(
			result.diff_after.contains("console.log(\"resolved\");"),
			"expected updated body text, got {:?}",
			result.diff_after
		);
		assert!(
			result
				.warnings
				.iter()
				.any(|warning| warning
					.contains("Auto-resolved chunk selector \"run\" to \"cls_Wor.fn_run#")),
			"expected auto-resolution warning, got {:?}",
			result.warnings
		);
	}

	#[test]
	fn edit_batch_uses_initial_checksum_identity_after_same_file_renumbering() {
		let source = "\
const transportAlpha = 1;

const transportBeta = 2;

const transportGamma = 3;
";
		let state = state_for(source, "typescript");
		let first = state.inner().chunk("var_tra_1").expect("var_tra_1").clone();
		let second = state.inner().chunk("var_tra_2").expect("var_tra_2").clone();

		let result = apply_edits(
			&state,
			&edit_params(vec![
				EditOperation {
					op:      ChunkEditOp::Delete,
					sel:     Some("var_tra_1".to_owned()),
					crc:     Some(first.checksum),
					region:  None,
					content: None,
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some("var_tra_2".to_owned()),
					crc:     Some(second.checksum),
					region:  None,
					content: Some("const transportBeta = 20;".to_owned()),
					find:    None,
				},
			]),
		)
		.expect("same-file batch should keep the original logical target");

		assert!(
			!result.diff_after.contains("transportAlpha"),
			"first sibling should be deleted:\n{}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("const transportBeta = 20;"),
			"renumbered second sibling should be updated:\n{}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("const transportGamma = 3;"),
			"third sibling should not receive the second operation:\n{}",
			result.diff_after
		);
		assert!(
			result
				.warnings
				.iter()
				.all(|warning| !warning.contains("Auto-resolved stale selector")),
			"same-batch renumbering should not emit stale-selector warnings: {:?}",
			result.warnings
		);
	}

	#[test]
	fn edit_batch_rejects_bad_initial_checksum_before_applying_operations() {
		let source = "\
const transportAlpha = 1;

const transportBeta = 2;
";
		let state = state_for(source, "typescript");
		let first = state.inner().chunk("var_tra_1").expect("var_tra_1").clone();

		let err = apply_edits(
			&state,
			&edit_params(vec![
				EditOperation {
					op:      ChunkEditOp::Delete,
					sel:     Some("var_tra_1".to_owned()),
					crc:     Some(first.checksum),
					region:  None,
					content: None,
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some("var_tra_2".to_owned()),
					crc:     Some("0000".to_owned()),
					region:  None,
					content: Some("const transportBeta = 20;".to_owned()),
					find:    None,
				},
			]),
		)
		.err()
		.expect("bad initial checksum should reject the batch");

		assert!(
			err.contains("Edit operation 2/2 failed during initial checksum validation"),
			"error should identify initial validation failure: {err}"
		);
		assert!(
			err.contains("Checksum mismatch for var_tra_2"),
			"error should report the stale checksum target: {err}"
		);
		assert_eq!(state.source(), source, "original state should remain unchanged");
	}

	#[test]
	fn edit_batch_failure_after_recompute_is_atomic_for_original_state() {
		let source = "\
const transportAlpha = 1;

const transportBeta = 2;
";
		let state = state_for(source, "typescript");
		let first = state.inner().chunk("var_tra_1").expect("var_tra_1").clone();
		let second = state.inner().chunk("var_tra_2").expect("var_tra_2").clone();

		let err = apply_edits(
			&state,
			&edit_params(vec![
				EditOperation {
					op:      ChunkEditOp::Delete,
					sel:     Some("var_tra_1".to_owned()),
					crc:     Some(first.checksum),
					region:  None,
					content: None,
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Replace,
					sel:     Some("var_tra_2".to_owned()),
					crc:     Some(second.checksum),
					region:  None,
					content: Some("const transportBeta = 20;".to_owned()),
					find:    Some("not in current chunk".to_owned()),
				},
			]),
		)
		.err()
		.expect("second operation should fail after recompute");

		assert!(
			err.contains("Edit operation 2/2 failed"),
			"error should identify the failing operation: {err}"
		);
		assert!(
			err.contains("'find' text not found inside chunk"),
			"error should preserve the real operation failure: {err}"
		);
		assert_eq!(state.source(), source, "original state should remain unchanged");
	}

	#[test]
	fn edit_batch_failure_context_uses_original_snapshot_after_partial_apply() {
		let source = "\
const alphaValue = 1;

const betaValue = 2;
";
		let state = state_for(source, "typescript");
		let first = state
			.inner()
			.tree()
			.root_children
			.first()
			.and_then(|path| state.inner().chunk(path))
			.expect("first top-level chunk")
			.clone();
		let first_path = first.path.clone();
		let first_checksum = first.checksum;

		let err = apply_edits(
			&state,
			&edit_params(vec![
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some(first_path.clone()),
					crc:     Some(first_checksum.clone()),
					region:  None,
					content: Some("const alphaValue = 10;".to_owned()),
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Replace,
					sel:     Some(first_path),
					crc:     Some(first_checksum),
					region:  None,
					content: Some("replacement".to_owned()),
					find:    Some("not in current file".to_owned()),
				},
			]),
		)
		.err()
		.expect("second operation should fail after the first mutates in-memory state");

		assert!(
			err.contains("No changes were saved"),
			"error should preserve the transactional message: {err}"
		);
		assert!(
			err.contains("const alphaValue = 1;"),
			"fresh content should show the original saved snapshot: {err}"
		);
		assert!(
			!err.contains("const alphaValue = 10;"),
			"fresh content must not show partial in-memory edits: {err}"
		);
	}

	#[test]
	fn edit_batch_maps_reused_checksum_after_target_changes() {
		let source = "\
function target(): void {
\tconsole.log(\"old\");
}

function helper(): void {
\tconsole.log(\"helper\");
}
";
		let state = state_for(source, "typescript");
		let target = state.inner().chunk("fn_tar").expect("fn_tar").clone();

		let result = apply_edits(
			&state,
			&edit_params(vec![
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some(format!("#{}", target.checksum)),
					crc:     None,
					region:  None,
					content: Some("function target(): void {\n\tconsole.log(\"middle\");\n}".to_owned()),
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some(format!("#{}", target.checksum)),
					crc:     None,
					region:  None,
					content: Some("function target(): void {\n\tconsole.log(\"final\");\n}".to_owned()),
					find:    None,
				},
			]),
		)
		.expect("same-batch reused checksum should follow the changed target");

		assert!(
			result.diff_after.contains("console.log(\"final\")"),
			"second edit should apply to the original target:\n{}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("console.log(\"middle\")"),
			"second edit should replace the first edit on the same target:\n{}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("function helper(): void"),
			"reused checksum must not fall back to root replacement:\n{}",
			result.diff_after
		);
	}

	#[test]
	fn edit_accepts_multi_crc_inline_segments() {
		let source = "class Worker {\n\trun(): void {\n\t\tconsole.log(this.name);\n\t}\n}\n";
		let state = state_for(source, "typescript");
		let class_chunk = state.inner().chunk("cls_Wor").expect("cls_Wor").clone();
		let method_chunk = state
			.inner()
			.chunk("cls_Wor.fn_run")
			.expect("fn_run")
			.clone();

		// Both CRCs present and valid – selector carries `#CRC` on every segment.
		let sel = format!(
			"cls_Wor#{parent}.fn_run#{leaf}",
			parent = class_chunk.checksum,
			leaf = method_chunk.checksum,
		);
		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some(sel),
				crc:     None,
				region:  None,
				content: Some("run(): void {\n\tconsole.log(\"multi-crc\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("multi-crc selector with all fresh CRCs should edit successfully");
		assert!(result.diff_after.contains("console.log(\"multi-crc\");"), "{}", result.diff_after);
	}

	#[test]
	fn edit_accepts_multi_crc_selector_when_only_ancestor_crc_matches() {
		let source = "class Worker {\n\trun(): void {\n\t\tconsole.log(this.name);\n\t}\n}\n";
		let state = state_for(source, "typescript");
		let class_chunk = state.inner().chunk("cls_Wor").expect("cls_Wor").clone();

		// Stale leaf CRC but fresh ancestor CRC. Under the new lenient rule,
		// at least one provided CRC matches the ancestor chain, so the edit
		// proceeds.
		let sel = format!("cls_Wor#{parent}.fn_run#ZZZZ", parent = class_chunk.checksum);
		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some(sel),
				crc:     None,
				region:  None,
				content: Some("run(): void {\n\tconsole.log(\"any-match\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should accept a multi-crc path when any crc matches an ancestor");
		assert!(result.diff_after.contains("console.log(\"any-match\");"), "{}", result.diff_after);
	}

	#[test]
	fn edit_rejects_multi_crc_selector_when_all_crcs_stale() {
		let source = "class Worker {\n\trun(): void {\n\t\tconsole.log(this.name);\n\t}\n}\n";
		let state = state_for(source, "typescript");

		let err = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("cls_Wor#XXXX.fn_run#ZZZZ".to_owned()),
				crc:     None,
				region:  None,
				content: Some("run(): void {\n\tconsole.log(\"should-not-apply\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.err()
		.expect("all-stale multi-crc selector should fail");
		assert!(err.contains("None of the provided checksums"), "{err}");
	}

	#[test]
	fn edit_auto_resolves_prefixed_function_names() {
		let source = "function fuzzyMatch(): void {\n\tconsole.log(\"old\");\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("fn_fuz").expect("fn_fuz should exist");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("fuzzyM".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some(
					"function fuzzyMatch(): void {\n\tconsole.log(\"resolved\");\n}".to_owned(),
				),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "box.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should resolve a prefixed bare selector");

		assert!(result.diff_after.contains("console.log(\"resolved\");"), "{}", result.diff_after);
		assert!(result.warnings.iter().any(|warning| {
			warning.contains("Auto-resolved chunk selector \"fuzzyM\" to \"fn_fuz#")
		}));
	}

	#[test]
	fn edit_accepts_file_prefixed_checksum_targets() {
		let source = "function main(): void {\n\tconsole.log(\"old\");\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai should exist");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("box.ts".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("function main(): void {\n\tconsole.log(\"normalized\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "box.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should resolve file-prefixed checksum target");

		assert!(result.diff_after.contains("console.log(\"normalized\");"), "{}", result.diff_after);
	}

	#[test]
	fn line_number_selector_auto_resolves_to_containing_chunk() {
		let source = "function main(): void {\n\tconsole.log(\"old\");\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		// L2 falls inside fn_main — should auto-resolve and apply the edit.
		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some(format!("L2#{}", chunk.checksum)),
				crc:     None,
				region:  None,
				content: Some("function main(): void {\n\tconsole.log(\"new\");\n}".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "box.ts".to_owned(),
			normalize_indent: None,
		});

		let result = result.expect("line-number selector should auto-resolve");
		assert!(
			result
				.warnings
				.iter()
				.any(|w| w.contains("Auto-resolved line target")),
			"should warn about auto-resolution: {:?}",
			result.warnings
		);
		assert!(
			result.diff_after.contains("\"new\""),
			"edit should have applied: {}",
			result.diff_after
		);
	}

	#[test]
	fn line_number_outside_any_chunk_returns_error() {
		let source = "function main(): void {\n\tconsole.log(\"old\");\n}\n";
		let state = state_for(source, "typescript");

		// L999 is way beyond the file — should fail.
		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("L999".to_owned()),
				crc:     None,
				region:  None,
				content: Some("// hello".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "box.ts".to_owned(),
			normalize_indent: None,
		});

		assert!(result.is_err(), "line outside any chunk should fail");
		let err = result.err().unwrap();
		assert!(err.contains("does not fall inside any chunk"), "{err}");
	}

	#[test]
	fn markdown_section_replace_preserves_next_sibling_heading() {
		let source = "# Top\n\n## Building\n\nOld content.\n\n## Code Style\n\n- style one\n";
		let state = state_for(source, "markdown");
		let chunk = state.inner().chunk("sct_Top.sct_Bui").expect("sct_Bui");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("sct_Top.sct_Bui".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("## Building\n\nNew content.\n".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.md".to_owned(),
			normalize_indent: None,
		})
		.expect("replace should succeed");

		assert!(
			result.diff_after.contains("## Code Style"),
			"next sibling heading must survive section replace, got:\n{}",
			result.diff_after,
		);
		assert!(
			result.diff_after.contains("New content."),
			"replacement content must be present, got:\n{}",
			result.diff_after,
		);
	}

	#[test]
	fn find_replace_single_match() {
		let source = "fn main() {\n    println!(\"hello\");\n    println!(\"world\");\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Replace,
				sel:     Some("fn_mai".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("warn!(\"hello\")".to_owned()),
				find:    Some("println!(\"hello\")".to_owned()),
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply");

		assert!(
			result.diff_after.contains("warn!(\"hello\")"),
			"expected replacement, got {:?}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("println!(\"world\")"),
			"non-matched line must survive, got {:?}",
			result.diff_after
		);
	}

	#[test]
	fn find_replace_not_found() {
		let source = "fn main() {\n    println!(\"hello\");\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Replace,
				sel:     Some("fn_mai".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("replacement".to_owned()),
				find:    Some("nonexistent text".to_owned()),
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		});

		assert!(result.is_err(), "expected error for not-found find text");
		assert!(
			result
				.err()
				.expect("err")
				.contains("not found inside chunk"),
			"error should mention not found"
		);
	}

	#[test]
	fn find_replace_ambiguous() {
		let source = "fn main() {\n    let a = 1;\n    let b = 1;\n    let c = 1;\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Replace,
				sel:     Some("fn_mai".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("2".to_owned()),
				find:    Some("= 1".to_owned()),
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		});

		assert!(result.is_err(), "expected error for ambiguous find text");
		let err = result.err().expect("err");
		assert!(err.contains("ambiguous"), "error should mention ambiguous: {err}");
		assert!(err.contains("3 matches"), "error should report count: {err}");
	}

	#[test]
	fn find_replace_empty_find_rejected() {
		let source = "fn main() {\n    println!(\"hello\");\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Replace,
				sel:     Some("fn_mai".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("replacement".to_owned()),
				find:    Some(String::new()),
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		});

		assert!(result.is_err(), "expected error for empty find text");
		assert!(result.err().expect("err").contains("cannot be empty"), "error should mention empty");
	}

	#[test]
	fn find_replace_respects_chunk_bounds() {
		// 'hello' appears in fn_greet but NOT in fn_main. Searching fn_main should
		// fail.
		let source = "fn greet() {\n    println!(\"hello\");\n}\n\nfn main() {\n    greet();\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Replace,
				sel:     Some("fn_mai".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("goodbye".to_owned()),
				find:    Some("hello".to_owned()),
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		});

		assert!(result.is_err(), "find outside target chunk should fail");
		assert!(
			result
				.err()
				.expect("err")
				.contains("not found inside chunk")
		);
	}

	#[test]
	fn focus_emits_only_changed_chain() {
		let source = "const a = 1;\n\nconst b = 2;\n\nconst c = 3;\n\nconst d = 4;\n\nconst e = 5;\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("var_c").expect("var_c");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("var_c".to_owned()),
				crc:     Some(chunk.checksum.clone()),
				region:  None,
				content: Some("const c = 33;".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     Some(ChunkAnchorStyle::Full),
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply");

		// The focused edit view should show only the changed chunk chain, not
		// sibling context blocks.
		let response = &result.response_text;
		assert!(response.contains("var_c"), "touched chunk should appear: {response}");
		assert!(
			response.contains("*@var_c#"),
			"changed chunk should be marked in the gutter: {response}"
		);
		assert!(
			!response.contains("var_b"),
			"prev sibling should not appear in the focused edit view: {response}"
		);
		assert!(
			!response.contains("var_d"),
			"next sibling should not appear in the focused edit view: {response}"
		);
		assert!(
			!response.contains("const a"),
			"distant chunk var_a body should not appear: {response}"
		);
		assert!(
			!response.contains("const e"),
			"distant chunk var_e body should not appear: {response}"
		);
	}

	#[test]
	fn error_context_expands_around_parse_failure_in_other_chunk() {
		// Regression: when an edit introduces a parse error in a chunk other
		// than the edit target, the error-message "Fresh content" view must
		// expand around the error location, not only around the targeted chunk.
		// Previously the focus only covered the targeted chunk, so the parse
		// error could land inside a truncated region and force the agent to
		// do a follow-up read to diagnose the failure.
		//
		// Construct a file with five top-level functions. Edit fn_a's body with
		// unbalanced-brace content so the parser bleeds the error into fn_c's
		// territory. After the fix, the error message must include identifying
		// text from the chunks flagged with parse errors, even though only
		// fn_a was the edit target.
		let source = concat!(
			"fn alpha() {\n    let x = 1;\n}\n\n",
			"fn bravo() {\n    let y = 2;\n}\n\n",
			"fn charlie() {\n    let z = 3;\n}\n\n",
			"fn delta() {\n    let w = 4;\n}\n\n",
			"fn echo() {\n    let v = 5;\n}\n",
		);
		let state = parsed_state_for(source, "rust");
		let alpha = state.inner().chunk("fn_alp").expect("fn_alp");

		let Err(err) = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("fn_alp".to_owned()),
				crc:     Some(alpha.checksum.clone()),
				region:  Some(ChunkRegion::Body),
				// Intentionally broken: dangling `{` consumes subsequent
				// top-level functions until tree-sitter gives up.
				content: Some("let broken = { { {\n".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     Some(ChunkAnchorStyle::Full),
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		}) else {
			panic!("edit should be rejected due to parse error");
		};

		assert!(
			err.contains("Edit rejected: introduced"),
			"should be a parse-error rejection: {err}",
		);
		assert!(err.contains("Fresh content:"), "should include fresh content: {err}");
		// The edit target must always be visible.
		assert!(err.contains("fn_alp"), "target chunk should be in focus: {err}");
		// The fix: at least one of the downstream chunks where the parse error
		// lands should also appear in the focused "Fresh content" view. Without
		// the fix, focus only covers fn_alpha and these downstream anchors are
		// skipped, so the agent cannot see the failure location.
		let downstream_visible = ["fn_bra", "fn_cha", "fn_del", "fn_ech"]
			.iter()
			.any(|name| err.contains(name));
		assert!(
			downstream_visible,
			"error-context focus should include at least one downstream chunk where the parse \
			 failure lands, got: {err}",
		);
	}

	#[test]
	fn append_on_root_stmts_group_inserts_after_grouped_statements() {
		// This fixture exposes the root-level `stmts` group. Appending to that
		// group should place content after the grouped top-level statements.
		// Use plain expression statements (no trailing callback) so they stay
		// as groupable stmts rather than being promoted to named expr chunks.
		let source = "import { foo } from \"bar\";\n\nconsole.log(\"a\");\nconsole.log(\"b\");\n";
		let state = parsed_state_for(source, "typescript");
		let stmts = state.inner().chunk("st").expect("st chunk should exist");
		assert!(stmts.group, "stmts chunk should be marked as group");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some(stmts.path.clone()),
			crc:     None,
			region:  None,
			content: Some("\nconsole.log(\"c\");".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("log(\"c\""),
			"appended content should appear in output, got: {}",
			result.diff_after
		);
		assert!(
			result
				.diff_after
				.contains("log(\"b\");\nconsole.log(\"c\");"),
			"appended statement should land after the grouped top-level statements, got: {}",
			result.diff_after
		);
	}

	#[test]
	fn replace_body_preserves_typescript_closing_brace_indentation() {
		let source = "function main() {\n    work();\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("fn_mai#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\treturn next();\n".to_owned()),
			find:    None,
		});

		assert_eq!(result.diff_after, "function main() {\n    return next();\n}\n");
	}

	#[test]
	fn replace_body_preserves_rust_closing_brace_indentation() {
		let source = "fn main() {\n    println!(\"old\");\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("fn_mai#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\tprintln!(\"new\");\n".to_owned()),
			find:    None,
		});

		assert_eq!(result.diff_after, "fn main() {\n    println!(\"new\");\n}\n");
	}

	#[test]
	fn replace_body_preserves_go_closing_brace_indentation() {
		let source = "func main() {\n    work()\n}\n";
		let state = state_for(source, "go");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_single_edit(&state, "test.go", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("fn_mai#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\treturn\n".to_owned()),
			find:    None,
		});

		assert_eq!(result.diff_after, "func main() {\n    return\n}\n");
	}

	#[test]
	fn three_space_body_replace_denormalizes_tabs_back_to_file_style() {
		let source = "def run():\n   return 1\n";
		let state = state_for(source, "python");
		let chunk = state.inner().chunk("fn_run").expect("fn_run");

		let result = apply_single_edit(&state, "test.py", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("fn_run#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\treturn 2\n".to_owned()),
			find:    None,
		});

		assert_eq!(result.diff_after, "def run():\n   return 2\n");
	}

	#[test]
	fn after_targets_chunk_directly_for_top_level_sibling_insertion() {
		let source = "function alpha(): void {\n\twork();\n}\n";
		let state = state_for(source, "typescript");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::After,
			sel:     Some("fn_alp".to_owned()),
			crc:     None,
			region:  None,
			content: Some("function beta(): void {\n\twork();\n}\n".to_owned()),
			find:    None,
		});

		assert!(result.diff_after.contains("function alpha(): void"), "{}", result.diff_after);
		assert!(result.diff_after.contains("function beta(): void"), "{}", result.diff_after);
		assert!(
			result
				.diff_after
				.find("function alpha(): void")
				.expect("alpha")
				< result
					.diff_after
					.find("function beta(): void")
					.expect("beta")
		);
	}

	#[test]

	fn go_body_and_container_append_are_not_interchangeable() {
		let source = "package main\n\ntype Server struct {\n    Addr string\n}\n\nfunc (s *Server) \
		              Start() {\n    work()\n}\n";

		let body_state = state_for(source, "go");
		let body_result = apply_single_edit(&body_state, "test.go", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some("ty_Ser~".to_owned()),
			crc:     None,
			region:  None,
			content: Some("\tPort int\n".to_owned()),
			find:    None,
		});
		assert!(
			body_result
				.diff_after
				.contains("Addr string\n    Port int\n}"),
			"{}",
			body_result.diff_after
		);
		assert!(
			!body_result.diff_after.contains("func (s *Server) Port"),
			"{}",
			body_result.diff_after
		);

		let container_state = state_for(source, "go");
		let container_result = apply_single_edit(&container_state, "test.go", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some("ty_Ser".to_owned()),
			crc:     None,
			region:  None,
			content: Some("func (s *Server) Stop() {\n\twork()\n}\n".to_owned()),
			find:    None,
		});
		assert!(
			container_result
				.diff_after
				.contains("func (s *Server) Start()"),
			"{}",
			container_result.diff_after
		);
		assert!(
			container_result
				.diff_after
				.contains("func (s *Server) Stop()"),
			"{}",
			container_result.diff_after
		);
		assert!(
			container_result
				.diff_after
				.find("func (s *Server) Stop()")
				.expect("stop")
				< container_result
					.diff_after
					.find("func (s *Server) Start()")
					.expect("start")
		);
	}

	#[test]
	fn go_type_container_append_after_receiver_methods_preserves_sibling_spacing() {
		let source = "package main\n\ntype Server struct {}\n\nfunc (s *Server) Start() {}\nfunc (s \
		              *Server) Stop() {}\n";
		let state = state_for(source, "go");

		let result = apply_single_edit(&state, "test.go", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some("ty_Ser".to_owned()),
			crc:     None,
			region:  None,
			content: Some("func (s *Server) Restart() {}".to_owned()),
			find:    None,
		});

		assert!(
			result
				.diff_after
				.contains("type Server struct {}\nfunc (s *Server) Restart() {}"),
			"{}",
			result.diff_after
		);
	}

	#[test]
	fn packed_toml_table_after_inserts_stay_tightly_packed() {
		let source = "[dependencies]\nanyhow.workspace = true\nbytes.workspace = \
		              true\nserde.workspace = true\nsolar-interface.workspace = \
		              true\nparking_lot.workspace = true\nsolar-sema.workspace = \
		              true\ntokio.workspace = true\ntracing.workspace = true\n";
		let state = state_for(source, "toml");

		let result = apply_single_edit(&state, "Cargo.toml", EditOperation {
			op:      ChunkEditOp::After,
			sel:     Some("tbl_dep.key_par".to_owned()),
			crc:     None,
			region:  None,
			content: Some("rayon.workspace = true\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains(
				"parking_lot.workspace = true\nrayon.workspace = true\nsolar-sema.workspace = true"
			),
			"{}",
			result.diff_after
		);
		assert!(
			!result
				.diff_after
				.contains("parking_lot.workspace = true\n\nrayon.workspace = true"),
			"{}",
			result.diff_after
		);
		assert!(
			!result
				.diff_after
				.contains("rayon.workspace = true\n\nsolar-sema.workspace = true"),
			"{}",
			result.diff_after
		);
	}

	#[test]
	fn packed_top_level_typescript_variables_stay_tightly_packed() {
		let source = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		let state = state_for(source, "typescript");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::After,
			sel:     Some("var_b".to_owned()),
			crc:     None,
			region:  None,
			content: Some("const bb = 22;\n".to_owned()),
			find:    None,
		});

		assert!(
			result
				.diff_after
				.contains("const b = 2;\nconst bb = 22;\nconst c = 3;"),
			"{}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("const b = 2;\n\nconst bb = 22;"),
			"{}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("const bb = 22;\n\nconst c = 3;"),
			"{}",
			result.diff_after
		);
	}

	#[test]
	fn crc_mismatch_error_includes_fresh_chunk_context() {
		let source = "class Foo {\n    bar() {\n        return 1;\n    }\n}\n";
		let state = state_for(source, "typescript");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some("cls_Foo.fn_bar#ZZZZ".to_owned()),
				crc:     None,
				region:  None,
				content: Some("baz() { return 2; }".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     Some(ChunkAnchorStyle::Full),
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		});
		let err = result.err().expect("should fail with stale CRC");

		assert!(err.contains("Fresh content:"), "error should include fresh content: {err}");
		assert!(err.contains("fn_bar"), "error should show the chunk with fresh anchor: {err}");
		assert!(err.contains("cls_Foo"), "error should show ancestor context: {err}");
	}

	#[test]
	fn prologue_replace_preserves_newline_before_body() {
		let source = "/// Old doc.\nfn main() {\n    work();\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("fn_mai#{}^", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("/// New doc.\nfn main() {".to_owned()),
			find:    None,
		});

		// The body should NOT be joined onto the prologue line.
		assert!(
			!result.diff_after.contains("{    work"),
			"prologue replace should not join body onto same line: {}",
			result.diff_after
		);
		assert_eq!(result.diff_after, "/// New doc.\nfn main() {\n    work();\n}\n",);
	}

	#[test]
	fn markdown_table_pipes_preserved_in_replace() {
		let new_table = "| Header A | Header B |\n| --- | --- |\n| cell A | cell B |\n";

		// Simulate what normalize_inserted_content does to table content.
		let result = super::normalize_inserted_content(new_table, "", None, ' ', true);

		assert!(result.contains("| Header A"), "table pipes should not be stripped: {result}");
	}

	#[test]
	fn container_prepend_creates_addressable_chunk() {
		// Prepending without a @region inserts before the chunk. After tree rebuild,
		// the inserted content should be addressable (either absorbed as trivia
		// or as a new preamble/chunk), not orphaned.
		let source = "const a = 1;\n\nstruct Config {\n    host: String,\n}\n";
		let state = state_for(source, "rust");

		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Prepend,
			sel:     Some("stc_Con".to_owned()),
			crc:     None,
			region:  None,
			content: Some("// Config documentation\n".to_owned()),
			find:    None,
		});

		// The comment should exist in the output.
		assert!(
			result.diff_after.contains("// Config documentation"),
			"prepended content should be in the file: {}",
			result.diff_after
		);

		// Re-parse and check that every non-empty line is covered by some chunk.
		let new_state = state_for(&result.diff_after, "rust");
		let tree = new_state.inner().tree();
		let lines: Vec<&str> = result.diff_after.split('\n').collect();
		for (i, line) in lines.iter().enumerate() {
			if line.trim().is_empty() {
				continue;
			}
			let line_num = (i + 1) as u32;
			let covered = tree
				.chunks
				.iter()
				.any(|c| !c.path.is_empty() && c.start_line <= line_num && c.end_line >= line_num);
			assert!(
				covered,
				"line {} ({:?}) should be covered by a chunk, but isn't. Chunks: {:?}",
				line_num,
				line,
				tree
					.chunks
					.iter()
					.filter(|c| !c.path.is_empty())
					.map(|c| format!("{}:L{}-L{}", c.path, c.start_line, c.end_line))
					.collect::<Vec<_>>()
			);
		}
	}

	#[test]
	fn leaf_chunk_supports_body_region_read() {
		// A small method (under LEAF_THRESHOLD) should still have region boundaries
		// if it has a body delimiter.
		let source = "class Foo {\n    bar() {\n        return 1;\n    }\n}\n";
		let state = state_for(source, "typescript");
		let fn_bar = state.inner().chunk("cls_Foo.fn_bar").expect("fn_bar");
		assert!(fn_bar.leaf, "fn_bar should be a leaf chunk");
		assert!(fn_bar.prologue_end_byte.is_some(), "leaf fn_bar should have prologue_end_byte set");
		assert!(
			fn_bar.epilogue_start_byte.is_some(),
			"leaf fn_bar should have epilogue_start_byte set"
		);
	}

	#[test]
	fn nested_body_replace_preserves_correct_indentation_4space() {
		// 4-space file: method body at 2 levels of indent.
		let source = "class Server {\n    start() {\n        work();\n    }\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("cls_Ser.fn_sta").expect("fn_sta");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("cls_Ser.fn_sta#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\treturn 42;\n".to_owned()),
			find:    None,
		});

		assert_eq!(
			result.diff_after, "class Server {\n    start() {\n        return 42;\n    }\n}\n",
			"4-space: nested body replace should produce correct 2-level indent"
		);
	}

	#[test]
	fn nested_body_replace_preserves_correct_indentation_2space() {
		// 2-space file: method body at 2 levels of indent.
		let source = "class Server {\n  start() {\n    work();\n  }\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("cls_Ser.fn_sta").expect("fn_sta");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("cls_Ser.fn_sta#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\treturn 42;\n".to_owned()),
			find:    None,
		});

		assert_eq!(
			result.diff_after, "class Server {\n  start() {\n    return 42;\n  }\n}\n",
			"2-space: nested body replace should produce correct 2-level indent"
		);
	}

	#[test]
	fn nested_body_replace_with_excess_tabs_corrected() {
		// Agent accidentally includes base padding (2 tabs instead of 1).
		// Correction mechanism should strip common indent and produce correct output.
		let source = "class Server {\n  start() {\n    work();\n  }\n}\n";
		let state = state_for(source, "typescript");
		let chunk = state.inner().chunk("cls_Ser.fn_sta").expect("fn_sta");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("cls_Ser.fn_sta#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("\t\tif (x) {\n\t\t\ty();\n\t\t}\n".to_owned()),
			find:    None,
		});

		assert_eq!(
			result.diff_after,
			"class Server {\n  start() {\n    if (x) {\n      y();\n    }\n  }\n}\n",
			"2-space: excess tabs should be corrected via dedent"
		);
	}

	#[test]
	fn body_append_inserts_inside_class() {
		// Appending to ~ of a class should insert inside the body,
		// not after the closing brace.
		let source = "class Foo {\n    bar() {\n        return 1;\n    }\n}\n";
		let state = state_for(source, "typescript");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some("cls_Foo~".to_owned()),
			crc:     None,
			region:  None,
			content: Some("baz() {\n\treturn 2;\n}\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("baz()"),
			"appended method should appear: {}",
			result.diff_after
		);
		// baz should appear BEFORE the final closing brace
		let baz_pos = result.diff_after.find("baz()").unwrap();
		let last_brace = result.diff_after.rfind('}').unwrap();
		assert!(
			baz_pos < last_brace,
			"baz() at {baz_pos} should be before last '}}' at {last_brace}: {}",
			result.diff_after
		);
	}

	#[test]
	fn body_prepend_inserts_after_opening_brace() {
		// Prepending to ~ of an enum should insert after the opening brace,
		// not before doc comments.
		let source = "/** My enum. */\nenum Color {\n    Red,\n    Green,\n    Blue,\n}\n";
		let state = state_for(source, "typescript");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Prepend,
			sel:     Some("en_Col~".to_owned()),
			crc:     None,
			region:  None,
			content: Some("White,\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("White"),
			"prepended variant should appear: {}",
			result.diff_after
		);
		// White should appear AFTER the opening brace, before Red
		let white_pos = result.diff_after.find("White").unwrap();
		let red_pos = result.diff_after.find("Red").unwrap();
		let doc_pos = result.diff_after.find("/** My enum.").unwrap();
		assert!(white_pos > doc_pos, "White should be after doc comment: {}", result.diff_after);
		assert!(white_pos < red_pos, "White should be before Red: {}", result.diff_after);
	}

	#[test]
	fn markdown_list_replace_preserves_trailing_blank_line() {
		let source = "# Title\n\n- item 1\n- item 2\n\n## Next\n";
		let state = state_for(source, "markdown");
		let list = state
			.inner()
			.tree
			.chunks
			.iter()
			.find(|c| {
				c.path
					.rsplit('.')
					.next()
					.is_some_and(|leaf| leaf.starts_with("list"))
			})
			.expect("list chunk");

		let result = apply_single_edit(&state, "test.md", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("{}#{}", list.path, list.checksum)),
			crc:     None,
			region:  None,
			content: Some("- new 1\n- new 2\n".to_owned()),
			find:    None,
		});

		// The blank line between the list and ## Next must be preserved.
		assert!(
			result.diff_after.contains("- new 2\n\n## Next"),
			"blank line between list and heading should be preserved: {:?}",
			result.diff_after
		);
	}

	#[test]
	fn markdown_after_preserves_blank_line_before_next_section() {
		let source = "# Title\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n";
		let state = state_for(source, "markdown");
		let section = state
			.inner()
			.chunk("sct_Tit.sct_Alp")
			.expect("alpha section");

		let result = apply_single_edit(&state, "test.md", EditOperation {
			op:      ChunkEditOp::After,
			sel:     Some(format!("{}#{}", section.path, section.checksum)),
			crc:     None,
			region:  None,
			content: Some("## Inserted\n\ninserted body\n".to_owned()),
			find:    None,
		});

		assert!(
			result
				.diff_after
				.contains("## Inserted\n\ninserted body\n\n## Beta"),
			"blank line between inserted section and next heading should be preserved: {:?}",
			result.diff_after
		);
	}

	#[test]
	fn markdown_body_append_preserves_blank_line_before_next_section() {
		let source = "# Title\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n";
		let state = state_for(source, "markdown");
		let section = state
			.inner()
			.chunk("sct_Tit.sct_Alp")
			.expect("alpha section");

		let result = apply_single_edit(&state, "test.md", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some(format!("{}#{}~", section.path, section.checksum)),
			crc:     None,
			region:  None,
			content: Some("\nextra paragraph\n".to_owned()),
			find:    None,
		});

		assert!(
			result
				.diff_after
				.contains("alpha body\n\n    extra paragraph\n\n## Beta"),
			"blank line between appended body content and next heading should be preserved: {:?}",
			result.diff_after
		);
	}

	#[test]
	fn rust_trait_members_are_addressable() {
		let source = "trait Handler {\n    fn handle(&self, req: &str) -> String;\n    fn \
		              name(&self) -> &str;\n}\n";
		let state = state_for(source, "rust");
		let tree = state.inner().tree();

		let trait_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "tr_Han")
			.expect("tr_Han should exist");

		// Trait members should be listed as children even when they're
		// single-line signatures (not collapsed as trivial).
		assert!(
			!trait_chunk.children.is_empty(),
			"tr_Han should have children, got leaf. Chunks: {:?}",
			tree.chunks.iter().map(|c| &c.path).collect::<Vec<_>>()
		);
	}

	#[test]
	fn python_body_append_preserves_indentation() {
		let source = "class Server:\n    def __init__(self):\n        self.x = 1\n\n    def \
		              start(self):\n        pass\n";
		let state = state_for(source, "python");

		let result = apply_single_edit(&state, "test.py", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some("cls_Ser~".to_owned()),
			crc:     None,
			region:  None,
			content: Some("def stop(self):\n\tpass\n".to_owned()),
			find:    None,
		});

		// The appended method should be at 4-space indent (class member level),
		// with its body at 8-space indent.
		assert!(
			result
				.diff_after
				.contains("    def stop(self):\n        pass"),
			"appended method should have correct Python indentation: {}",
			result.diff_after
		);
	}

	#[test]
	fn body_region_on_leaf_without_delimiters_falls_back_to_full_chunk() {
		let source = "enum LogLevel {\n    Debug,\n    Info,\n    Warn,\n    Fatal,\n}\n";
		let state = state_for(source, "rust");
		let chunk = state
			.inner()
			.chunk("en_Log.vr_Inf")
			.expect("vr_Inf should exist");
		assert!(chunk.prologue_end_byte.is_none(), "leaf variant should not have prologue_end_byte");

		for region_suffix in ["~", "^"] {
			let sel = format!("en_Log.vr_Inf#{}{}", chunk.checksum, region_suffix);
			let result = apply_edits(&state, &EditParams {
				operations:       vec![EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some(sel),
					crc:     None,
					region:  None,
					content: Some("Error,".to_owned()),
					find:    None,
				}],
				default_selector: None,
				default_crc:      None,
				anchor_style:     None,
				cwd:              ".".to_owned(),
				file_path:        "test.rs".to_owned(),
				normalize_indent: None,
			})
			.expect("leaf region should fall back to full chunk");

			assert!(
				result.diff_after.contains("Debug,\n    Error,\n    Warn,"),
				"{region_suffix} should replace the full leaf chunk, got: {}",
				result.diff_after
			);
		}
	}
	#[test]
	fn rust_impl_method_head_replace_no_body_duplication() {
		let source = concat!(
			"struct Server {
",
			"    running: bool,
",
			"}
",
			"
",
			"impl Server {
",
			"    /// Starts the server.
",
			"    pub fn start(&mut self) {
",
			"        self.running = true;
",
			"        println!(\"started\");
",
			"    }
",
			"}
",
		);
		let state = state_for(source, "rust");
		let chunk = state
			.inner()
			.chunk("ipl_Ser.fn_sta")
			.expect("ipl_Ser.fn_sta should exist");
		assert!(
			chunk.prologue_end_byte.is_some(),
			"fn_sta should have prologue_end_byte, got: start_byte={}, end_byte={}, \
			 prologue_end_byte={:?}, epilogue_start_byte={:?}",
			chunk.start_byte,
			chunk.end_byte,
			chunk.prologue_end_byte,
			chunk.epilogue_start_byte,
		);

		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("ipl_Ser.fn_sta#{}^", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some(
				"    /// Initializes and starts the server.\n    pub fn start(&mut self) {".to_owned(),
			),
			find:    None,
		});

		let body_count = result.diff_after.matches("self.running = true;").count();
		assert_eq!(
			body_count, 1,
			"body should appear exactly once after ^ replace, got {} occurrences in:
{}",
			body_count, result.diff_after
		);
		assert!(
			result
				.diff_after
				.contains("/// Initializes and starts the server."),
			"new doc comment should be in output:
{}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("/// Starts the server."),
			"old doc comment should be removed:
{}",
			result.diff_after
		);
	}

	#[test]
	fn typescript_class_method_head_replace_no_body_duplication() {
		let source = concat!(
			"class Server {
",
			"    /** Starts the server. */
",
			"    start() {
",
			"        this.running = true;
",
			"        console.log(\"started\");
",
			"    }
",
			"}
",
		);
		let state = state_for(source, "typescript");
		let chunk = state
			.inner()
			.chunk("cls_Ser.fn_sta")
			.expect("cls_Ser.fn_sta should exist");
		assert!(chunk.prologue_end_byte.is_some(), "fn_sta should have prologue_end_byte");

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("cls_Ser.fn_sta#{}^", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("    /** Initializes the server. */\n    start() {".to_owned()),
			find:    None,
		});

		let body_count = result.diff_after.matches("this.running = true;").count();
		assert_eq!(
			body_count, 1,
			"body should appear exactly once after ^ replace, got {} occurrences in:
{}",
			body_count, result.diff_after
		);
		assert!(
			result.diff_after.contains("/** Initializes the server. */"),
			"new doc comment should be in output:
{}",
			result.diff_after
		);
	}

	#[test]
	fn python_body_replace_does_not_corrupt_surrounding_code() {
		let source =
			"import os\n\ndef main():\n    x = 1\n    print(x)\n\ndef helper():\n    return 42\n";
		let state = state_for(source, "python");
		let chunk = state.inner().chunk("fn_mai").expect("fn_mai");

		let result = apply_single_edit(&state, "test.py", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("fn_mai#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("y = 2\nprint(y)\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("import os"),
			"imports should survive body replace: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("def main"),
			"function head should survive body replace: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("y = 2"),
			"replacement body should appear: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("def helper"),
			"sibling function should survive body replace: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("return 42"),
			"sibling function body should survive: {}",
			result.diff_after
		);
		// Imports should remain at column 0, not indented
		assert!(
			result.diff_after.starts_with("import os"),
			"import should be at column 0: {:?}",
			&result.diff_after[..40.min(result.diff_after.len())]
		);
	}

	#[test]
	fn python_head_replace_does_not_orphan_body() {
		let source = "class Server:\n    def start(self) -> None:\n        self.running = True\n";
		let state = state_for(source, "python");
		let chunk = state.inner().chunk("cls_Ser.fn_sta").expect("fn_sta");

		let result = apply_single_edit(&state, "test.py", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("cls_Ser.fn_sta#{}^", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("def begin(self) -> None:\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("def begin"),
			"replaced head should appear: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("self.running = True"),
			"body should survive head replace: {}",
			result.diff_after
		);
	}

	#[test]
	fn python_body_prepend_has_correct_indentation() {
		let source = "def main():\n    x = 1\n    print(x)\n";
		let state = state_for(source, "python");

		let result = apply_single_edit(&state, "test.py", EditOperation {
			op:      ChunkEditOp::Prepend,
			sel:     Some("fn_mai~".to_owned()),
			crc:     None,
			region:  None,
			content: Some("y = 0\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("y = 0"),
			"prepended content should appear: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("x = 1"),
			"existing body should survive: {}",
			result.diff_after
		);
		// The prepended content should be at the body indent level
		assert!(
			result.diff_after.contains("    y = 0"),
			"prepended content should be at body indent: {}",
			result.diff_after
		);
	}

	#[test]
	fn python_class_body_replace_preserves_structure() {
		let source =
			"class Server:\n    def start(self):\n        pass\n\n    def stop(self):\n        pass\n";
		let state = state_for(source, "python");
		let chunk = state.inner().chunk("cls_Ser").expect("cls_Ser");

		let result = apply_single_edit(&state, "test.py", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("cls_Ser#{}~", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some("def run(self):\n\tpass\n".to_owned()),
			find:    None,
		});

		assert!(
			result.diff_after.contains("class Server:"),
			"class header should survive body replace: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("def run(self)"),
			"replaced body should appear: {}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("def start"),
			"old body should be replaced: {}",
			result.diff_after
		);
	}

	#[test]
	fn whole_chunk_replace_includes_leading_trivia_in_range() {
		// Whole-chunk replace covers the full range including absorbed leading
		// trivia (comments, attributes). If the replacement omits the trivia,
		// it gets dropped — the read output shows the trivia as part of the
		// chunk so the LLM knows to include it.
		let source = "#[cfg(test)]\nmod tests {\n\tuse super::*;\n\n\t#[test]\n\tfn my_test() \
		              {\n\t\told();\n\t}\n}\n";
		let state = state_for(source, "rust");
		let chunk = state
			.inner()
			.chunk("mod_tes.fn_my")
			.expect("mod_tes.fn_my should exist");

		// Verify the chunk absorbs the #[test] attribute as leading trivia.
		assert!(
			chunk.start_byte < chunk.checksum_start_byte,
			"chunk should have absorbed leading trivia (start_byte {} < checksum_start_byte {})",
			chunk.start_byte,
			chunk.checksum_start_byte
		);

		// Replace the function WITHOUT including #[test] in the content.
		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some("mod_tes.fn_my".to_owned()),
			crc:     Some(chunk.checksum.clone()),
			region:  None,
			content: Some("fn my_test() {\n\tnew();\n}".to_owned()),
			find:    None,
		});

		// #[test] is dropped because the replacement didn't include it.
		assert!(
			!result.diff_after.contains("#[test]"),
			"#[test] should be dropped when omitted from replacement. Full text:\n{}",
			result.diff_after
		);

		// Verify the read output shows #[test] as part of the chunk's content
		// so the LLM can see it needs to be included.
		let read_output = crate::chunk::render::render_state(state.inner(), &RenderParams {
			chunk_path:           Some(String::new()),
			title:                "test.rs".to_owned(),
			language_tag:         Some("rust".to_owned()),
			visible_range:        None,
			render_children_only: true,
			omit_checksum:        true,
			anchor_style:         Some(ChunkAnchorStyle::Full),
			show_leaf_preview:    true,
			tab_replacement:      Some("    ".to_owned()),
			normalize_indent:     Some(true),
			focused_paths:        None,
		});
		println!("=== READ OUTPUT ===\n{read_output}\n=== END ===");
		assert!(
			read_output.contains("#[test]"),
			"read output must show #[test] as part of the chunk. Output:\n{read_output}"
		);
	}

	#[test]
	fn whole_chunk_replace_shows_diff_hunks_after_attribute_restoration() {
		// Bug 2: After a first edit drops #[test] (bug 1), a follow-up edit that
		// adds it back should show diff hunks in the response text.
		// Uses a module with multiple functions and a batch of two replacements
		// to match the real-world scenario.
		let source = "\
#[cfg(test)]\nmod tests {\n\tuse super::*;\n\n\tfn test_alpha() {\n\t\told_alpha();\n\t}\n\n\tfn \
		              test_middle() {\n\t\tmiddle();\n\t}\n\n\tfn test_beta() \
		              {\n\t\told_beta();\n\t}\n}\n";
		let state = state_for(source, "rust");
		let chunk_a = state
			.inner()
			.chunk("mod_tes.fn_tes_1")
			.expect("fn_tes_1 should exist");
		let chunk_b = state
			.inner()
			.chunk("mod_tes.fn_tes_3")
			.expect("fn_tes_3 should exist");

		// Batch replace: add #[test] to both functions.
		let result = apply_edits(&state, &EditParams {
			operations:       vec![
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some("mod_tes.fn_tes_1".to_owned()),
					crc:     Some(chunk_a.checksum.clone()),
					region:  None,
					content: Some("#[test]\nfn test_alpha() {\n\tnew_alpha();\n}".to_owned()),
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some("mod_tes.fn_tes_3".to_owned()),
					crc:     Some(chunk_b.checksum.clone()),
					region:  None,
					content: Some("#[test]\nfn test_beta() {\n\tnew_beta();\n}".to_owned()),
					find:    None,
				},
			],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply");

		assert!(result.changed, "edit should be detected as a change");
		assert!(
			result.diff_after.contains("#[test]"),
			"#[test] should be in the result. Full text:\n{}",
			result.diff_after
		);
		// The response text should contain diff hunks (@@) showing the changes.
		assert!(
			result.response_text.contains("@@"),
			"response should include diff hunks showing the changes. Response:\n{}",
			result.response_text
		);
	}

	#[test]
	fn diff_hunks_shown_for_non_leaf_function_replacement() {
		// Bug 2 (realistic): When replacing functions that have children
		// (sub-chunks like stmts, let bindings), the diff hunks should still
		// appear in the response. Mirrors the real-world scenario where only
		// #[test] is added and the function body stays identical.
		let source =
			"\
#[cfg(test)]\nmod tests {\n\tuse super::*;\n\n\tfn test_alpha() {\n\t\tlet mut config = \
			 base_config();\n\t\tconfig.enabled = Some(false);\n\t\tconfig.max_items = \
			 Some(10);\n\n\t\tlet Err(error) = build_options(&config) else {\n\t\t\tpanic!(\"should \
			 fail\");\n\t\t};\n\t\tassert_error_contains(&error, \"cannot be \
			 combined\");\n\t}\n\n\tfn test_middle() {\n\t\tmiddle();\n\t}\n\n\tfn test_beta() \
			 {\n\t\tlet mut config = base_config();\n\t\tconfig.enabled = \
			 Some(true);\n\t\tconfig.max_size = Some(0);\n\n\t\tlet Err(error) = \
			 build_options(&config) else {\n\t\t\tpanic!(\"must be \
			 positive\");\n\t\t};\n\t\tassert_error_contains(&error, \"must be positive\");\n\t}\n}\n";
		let state = state_for(source, "rust");

		// Verify the functions have children (sub-chunks).
		let chunk_a = state
			.inner()
			.chunk("mod_tes.fn_tes_1")
			.expect("fn_tes_1 should exist");
		assert!(
			!chunk_a.children.is_empty(),
			"fn_tes should have children (sub-chunks), got: {:?}",
			chunk_a.children
		);
		let chunk_b = state
			.inner()
			.chunk("mod_tes.fn_tes_3")
			.expect("fn_tes_3 should exist");
		assert!(
			!chunk_b.children.is_empty(),
			"fn_tes should have children (sub-chunks), got: {:?}",
			chunk_b.children
		);

		// Replace both functions: only adding #[test], body is identical.
		let result = apply_edits(&state, &EditParams {
			operations:       vec![
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some("mod_tes.fn_tes_1".to_owned()),
					crc:     Some(chunk_a.checksum.clone()),
					region:  None,
					content: Some(
						"#[test]\nfn test_alpha() {\n\tlet mut config = \
						 base_config();\n\tconfig.enabled = Some(false);\n\tconfig.max_items = \
						 Some(10);\n\n\tlet Err(error) = build_options(&config) else \
						 {\n\t\tpanic!(\"should fail\");\n\t};\n\tassert_error_contains(&error, \
						 \"cannot be combined\");\n}"
							.to_owned(),
					),
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some("mod_tes.fn_tes_3".to_owned()),
					crc:     Some(chunk_b.checksum.clone()),
					region:  None,
					content: Some(
						"#[test]\nfn test_beta() {\n\tlet mut config = base_config();\n\tconfig.enabled \
						 = Some(true);\n\tconfig.max_size = Some(0);\n\n\tlet Err(error) = \
						 build_options(&config) else {\n\t\tpanic!(\"must be \
						 positive\");\n\t};\n\tassert_error_contains(&error, \"must be positive\");\n}"
							.to_owned(),
					),
					find:    None,
				},
			],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.rs".to_owned(),
			normalize_indent: None,
		})
		.expect("edit should apply");

		assert!(result.changed, "edit should be detected as a change");
		assert!(result.diff_before != result.diff_after, "diff_before and diff_after should differ");
		// Count actual diff hunks.
		let hunks = super::generate_diff_hunks(&result.diff_before, &result.diff_after, 0);
		assert!(
			!hunks.is_empty(),
			"generate_diff_hunks should produce non-empty hunks.\ndiff_before:\n{}\ndiff_after:\n{}",
			result.diff_before,
			result.diff_after,
		);
		// The response text should contain diff hunks (@@) showing the changes.
		assert!(
			result.response_text.contains("@@"),
			"response should include diff hunks showing the changes.\nhunks: {}\nResponse:\n{}",
			hunks.len(),
			result.response_text,
		);
	}

	#[test]
	fn conflicted_reads_render_conflict_children_and_both_sides() {
		let source = "\
function foo() {\n<<<<<<< HEAD\n\treturn bar();\n=======\n\treturn baz();\n>>>>>>> topic\n}\n";
		let state = parsed_state_for(source, "typescript");
		assert!(state.has_conflicts());
		assert_eq!(state.conflict_count(), 1);

		let conflict = state
			.inner()
			.chunks()
			.find(|chunk| chunk.kind == ChunkKind::Conflict)
			.expect("conflict chunk should exist")
			.clone();
		let rendered = state
			.render_read(crate::chunk::types::ReadRenderParams {
				read_path:           String::new(),
				display_path:        "test.ts".to_owned(),
				language_tag:        Some("ts".to_owned()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_owned()),
				normalize_indent:    Some(true),
			})
			.expect("render should succeed");

		assert!(rendered.text.contains(conflict.path.as_str()));
		assert!(
			rendered
				.text
				.contains(format!("{}.ours", conflict.path).as_str())
		);
		assert!(
			rendered
				.text
				.contains(format!("{}.theirs", conflict.path).as_str())
		);
		assert!(rendered.text.contains("return bar();"));
		assert!(rendered.text.contains("return baz();"));
	}

	#[test]
	fn delete_ours_accepts_theirs() {
		let source = "\
function foo() {\n<<<<<<< HEAD\n\treturn bar();\n=======\n\treturn baz();\n>>>>>>> topic\n}\n";
		let state = parsed_state_for(source, "typescript");
		let ours = state
			.inner()
			.chunks()
			.find(|chunk| chunk.kind == ChunkKind::Ours)
			.expect("ours chunk should exist")
			.clone();

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Delete,
			sel:     Some(ours.path.clone()),
			crc:     Some(ours.checksum),
			region:  None,
			content: None,
			find:    None,
		});

		assert!(!result.state.has_conflicts());
		assert!(result.diff_before.contains("<<<<<<< HEAD"));
		assert!(result.diff_after.contains("return baz();"));
		assert!(!result.diff_after.contains("<<<<<<<"));
	}

	#[test]
	fn delete_theirs_accepts_ours() {
		let source = "\
function foo() {\n<<<<<<< HEAD\n\treturn bar();\n=======\n\treturn baz();\n>>>>>>> topic\n}\n";
		let state = parsed_state_for(source, "typescript");
		let theirs = state
			.inner()
			.chunks()
			.find(|chunk| chunk.kind == ChunkKind::Theirs)
			.expect("theirs chunk should exist")
			.clone();

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Delete,
			sel:     Some(theirs.path.clone()),
			crc:     Some(theirs.checksum),
			region:  None,
			content: None,
			find:    None,
		});

		assert!(!result.state.has_conflicts());
		assert!(result.diff_after.contains("return bar();"));
		assert!(!result.diff_after.contains("<<<<<<<"));
	}

	#[test]
	fn replace_conflict_manually_merges_and_clears_metadata() {
		let source = "\
function foo() {\n<<<<<<< HEAD\n\treturn bar();\n=======\n\treturn baz();\n>>>>>>> topic\n}\n";
		let state = parsed_state_for(source, "typescript");
		let conflict = state
			.inner()
			.chunks()
			.find(|chunk| chunk.kind == ChunkKind::Conflict)
			.expect("conflict chunk should exist")
			.clone();

		let result = apply_single_edit(&state, "test.ts", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(conflict.path.clone()),
			crc:     Some(conflict.checksum),
			region:  None,
			content: Some("\treturn qux();\n".to_owned()),
			find:    None,
		});

		assert!(!result.state.has_conflicts());
		assert!(result.diff_after.contains("return qux();"));
		assert!(!result.diff_after.contains("<<<<<<<"));
	}

	#[test]
	fn unresolved_conflicts_survive_rebuilds_within_a_batch() {
		let source = "\
function foo() {\n<<<<<<< HEAD\n\treturn bar();\n=======\n\treturn baz();\n>>>>>>> topic\n}\n";
		let state = parsed_state_for(source, "typescript");
		let conflict = state
			.inner()
			.chunks()
			.find(|chunk| chunk.kind == ChunkKind::Conflict)
			.expect("conflict chunk should exist")
			.clone();
		let ours = state
			.inner()
			.chunk(format!("{}.ours", conflict.path).as_str())
			.expect("ours child should exist")
			.clone();
		let theirs = state
			.inner()
			.chunk(format!("{}.theirs", conflict.path).as_str())
			.expect("theirs child should exist")
			.clone();

		let result = apply_edits(&state, &EditParams {
			operations:       vec![
				EditOperation {
					op:      ChunkEditOp::Put,
					sel:     Some(ours.path.clone()),
					crc:     Some(ours.checksum),
					region:  None,
					content: Some("\treturn bar(1);\n".to_owned()),
					find:    None,
				},
				EditOperation {
					op:      ChunkEditOp::Delete,
					sel:     Some(theirs.path.clone()),
					crc:     Some(theirs.checksum),
					region:  None,
					content: None,
					find:    None,
				},
			],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.ts".to_owned(),
			normalize_indent: None,
		})
		.expect("batch edit should apply");

		assert!(!result.state.has_conflicts());
		assert!(result.diff_after.contains("return bar(1);"));
		assert!(!result.diff_after.contains("<<<<<<<"));
	}

	#[test]
	fn exported_decorated_class_is_addressable() {
		let source = concat!(
			"function sealed(target: any) {}\n",
			"\n",
			"@sealed\n",
			"export class Server {\n",
			"    start(): void {\n",
			"        console.log(\"starting\");\n",
			"    }\n",
			"    stop(): void {\n",
			"        console.log(\"stopping\");\n",
			"    }\n",
			"}\n",
			"\n",
			"function formatLog(msg: string): string {\n",
			"    return `[LOG] ${msg}`;\n",
			"}\n",
		);
		let state = state_for(source, "typescript");
		let tree = state.inner().tree();

		let class_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser")
			.unwrap_or_else(|| {
				panic!(
					"cls_Ser should be in the chunk tree. Available chunks: {:?}",
					tree.chunks.iter().map(|c| &c.path).collect::<Vec<_>>()
				)
			});
		assert!(!class_chunk.children.is_empty(), "cls_Ser should have child methods");

		let start = state.inner().chunk("cls_Ser.fn_sta");
		assert!(start.is_some(), "cls_Ser.fn_sta should exist");
		let stop = state.inner().chunk("cls_Ser.fn_sto");
		assert!(stop.is_some(), "cls_Ser.fn_sto should exist");
	}

	#[test]
	fn head_replace_on_nested_rust_fn_uniform_indent() {
		let source = concat!(
			"pub struct Server {\n",
			"\thost: String,\n",
			"\tport: u16,\n",
			"}\n",
			"\n",
			"impl Server {\n",
			"\tpub fn address(&self) -> String {\n",
			"\t\tformat!(\"{}:{}\", self.host, self.port)\n",
			"\t}\n",
			"}\n",
		);
		let state = state_for(source, "rust");
		let chunk = state
			.inner()
			.chunk("ipl_Ser.fn_add")
			.expect("ipl_Ser.fn_add should exist");

		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(format!("ipl_Ser.fn_add#{}^", chunk.checksum)),
			crc:     None,
			region:  None,
			content: Some(
				"/// Returns the server address.\n#[must_use]\npub fn address(&self) -> String {\n"
					.to_owned(),
			),
			find:    None,
		});

		assert!(
			result
				.diff_after
				.contains("\t/// Returns the server address."),
			"doc comment should be at 1-tab indent, got:\n{}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("\t#[must_use]"),
			"attribute should be at 1-tab indent, got:\n{}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("\tpub fn address"),
			"signature should be at 1-tab indent, got:\n{}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("\t\t///"),
			"doc comment must NOT be double-indented, got:\n{}",
			result.diff_after
		);
	}

	#[test]
	fn markdown_append_chunk_preserves_trailing_blank_line() {
		// Two sibling sections separated by a blank line. Appending to the
		// paragraph chunk (leaf) inside the first section must preserve the
		// blank-line gap before the next heading.
		let source = "# Title\n\nSome text.\n\n## Next Section\n\nMore text.\n";
		let state = state_for(source, "markdown");

		// The paragraph "Some text." is sect_Title.chunk_2.
		let para_chunk = state
			.inner()
			.chunk("sct_Tit.ch_2")
			.expect("paragraph chunk should exist");

		let result = apply_single_edit(&state, "test.md", EditOperation {
			op:      ChunkEditOp::Append,
			sel:     Some(para_chunk.path.clone()),
			crc:     None,
			region:  None,
			content: Some("Appended line.\n".to_owned()),
			find:    None,
		});

		// The blank line before ## Next Section should be preserved
		assert!(
			result
				.diff_after
				.contains("Appended line.\n\n## Next Section"),
			"blank line before next section must be preserved after append: {:?}",
			result.diff_after
		);
	}

	#[test]
	fn markdown_after_chunk_preserves_blank_line_separator() {
		// 'after' on a table chunk followed by a blank-line separator and a
		// heading. The blank line must survive the insertion.
		let source = "# Section\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n## Next\n";
		let state = state_for(source, "markdown");

		// The table is sect_Sectio.chunk_2 (L3-L5).
		let table_chunk = state
			.inner()
			.chunk("sct_Sec.ch_2")
			.expect("table chunk should exist");

		let result = apply_single_edit(&state, "test.md", EditOperation {
			op:      ChunkEditOp::After,
			sel:     Some(table_chunk.path.clone()),
			crc:     None,
			region:  None,
			content: Some("Extra paragraph.\n".to_owned()),
			find:    None,
		});

		// Blank line before ## Next must be preserved
		assert!(
			result.diff_after.contains("Extra paragraph.\n\n## Next"),
			"blank line before next heading must be preserved after 'after' insert: {:?}",
			result.diff_after
		);
	}

	#[test]
	fn body_replace_nested_fn_uses_correct_indent() {
		let source = "impl Server {\n    fn is_running(&self) -> bool {\n        true\n    }\n}\n";
		let state = state_for(source, "rust");
		let chunk = state
			.inner()
			.tree
			.chunks
			.iter()
			.find(|c| c.identifier.as_deref() == Some("is") || c.path.contains("fn_is"))
			.expect("is_running chunk");
		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some(chunk.path.clone()),
			crc:     Some(chunk.checksum.clone()),
			region:  Some(ChunkRegion::Body),
			content: Some("false\n".to_owned()),
			find:    None,
		});
		// Body should be at 2 levels of indent (8 spaces), not 1 level (4 spaces)
		let new_source = &result.diff_after;
		assert!(
			new_source.contains("        false"),
			"expected body at 8-space indent (2 levels), got:\n{new_source}"
		);
	}

	#[test]
	fn body_replace_preserves_closing_delimiter_on_own_line() {
		let source = "fn foo() {\n    old_body();\n}\n";
		let state = state_for(source, "rust");
		let chunk = state.inner().chunk("fn_foo").expect("fn_foo");
		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some("fn_foo".to_owned()),
			crc:     Some(chunk.checksum.clone()),
			region:  Some(ChunkRegion::Body),
			content: Some("new_body();".to_owned()), // No trailing newline
			find:    None,
		});
		let new_source = &result.diff_after;
		// Closing } should be on its own line, not merged
		assert!(
			new_source.contains("new_body();\n}"),
			"expected closing brace on own line, got:\n{new_source}"
		);
	}

	#[test]
	fn is_comment_only_line_distinguishes_hash_comment_from_private_field_and_attribute() {
		// Shell/Python-style comments are treated as comments.
		assert!(is_comment_only_line(""));
		assert!(is_comment_only_line("# shell comment"));
		assert!(is_comment_only_line("#\tpython-style tab after hash"));
		assert!(is_comment_only_line("#"));
		assert!(is_comment_only_line("#!/usr/bin/env bash"));
		assert!(is_comment_only_line("// line comment"));
		assert!(is_comment_only_line("/// doc comment"));
		assert!(is_comment_only_line("/* block comment start"));

		// TypeScript / JavaScript private fields are NOT comments.
		assert!(!is_comment_only_line("#config: Config;"));
		assert!(!is_comment_only_line("#running = false;"));
		assert!(!is_comment_only_line("#_internal: number = 0;"));

		// Rust attributes and inner attributes are NOT comments.
		assert!(!is_comment_only_line("#[napi]"));
		assert!(!is_comment_only_line("#[derive(Debug)]"));
		assert!(!is_comment_only_line("#![deny(warnings)]"));

		// Plain code lines are not comments.
		assert!(!is_comment_only_line("let x = 1;"));
		assert!(!is_comment_only_line("return 0;"));
	}

	#[test]
	fn deletion_cleanup_collapses_blank_line_before_closing_delimiter() {
		// Scenario: deleting the last method in a class leaves }\n\n}.
		// The cleanup should collapse to }\n}.
		let text = "class Foo {\n\tmethod() {}\n\n}\n";
		let offset = "class Foo {\n\tmethod() {}\n".len();
		let result = cleanup_blank_line_artifacts_at_offset(text, offset);
		assert!(
			!result.contains("}\n\n}"),
			"should collapse blank line before closing brace, got: {result:?}"
		);
		assert!(
			result.contains("method() {}\n}"),
			"last method should be followed directly by class close, got: {result:?}"
		);
	}

	#[test]
	fn deletion_cleanup_collapses_blank_line_after_opening_delimiter() {
		// Scenario: deleting the first child in a container leaves {\n\n\tcontent.
		// The cleanup should collapse to {\n\tcontent.
		let text = "class Foo {\n\n\tfield: number;\n}\n";
		let offset = "class Foo {\n".len();
		let result = cleanup_blank_line_artifacts_at_offset(text, offset);
		assert!(
			!result.contains("{\n\n\t"),
			"should collapse blank line after opening brace, got: {result:?}"
		);
		assert!(
			result.contains("{\n\tfield"),
			"first child should follow opening brace directly, got: {result:?}"
		);
	}

	#[test]
	fn body_region_on_leaf_if_falls_back_to_whole_chunk_python() {
		// Python `if` inside a function body is a leaf chunk with prologue/epilogue
		// bytes set by the classifier. Using `~` on it should fall back to
		// whole-chunk replacement instead of mangling the guard.
		let source = "def handle(request):\n    x = 1\n    y = 2\n    if request.ok:\n        \
		              return \"yes\"\n    z = 3\n    for item in items:\n        process(item)\n    \
		              return \"no\"\n";
		let state = parsed_state_for(source, "python");
		let if_chunk = state
			.inner()
			.tree
			.chunks
			.iter()
			.find(|c| {
				Path::new(&c.path)
					.extension()
					.is_some_and(|ext| ext.eq_ignore_ascii_case("if"))
			})
			.expect("if chunk should exist");
		assert!(if_chunk.leaf, "if chunk should be leaf");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some(format!("{}~", if_chunk.path)),
				crc:     Some(if_chunk.checksum.clone()),
				region:  None,
				content: Some("if request.ok:\n    return \"forced\"\n".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.py".to_owned(),
			normalize_indent: None,
		})
		.expect("leaf ~ should fall back to whole-chunk, not produce a parse error");

		assert!(result.parse_valid, "edit should produce valid Python");
		assert!(
			result.diff_after.contains("return \"forced\""),
			"replacement content should appear in output, got: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("if request.ok:"),
			"guard should be preserved (whole-chunk replacement), got: {}",
			result.diff_after
		);
	}

	#[test]
	fn body_region_fallback_preserves_head_when_replacement_omits_it_python() {
		let source = "def handle(request):\n    x = 1\n    y = 2\n    if request.ok:\n        \
		              return \"yes\"\n    z = 3\n    for item in items:\n        process(item)\n    \
		              return \"no\"\n";
		let state = parsed_state_for(source, "python");
		let if_chunk = state
			.inner()
			.tree
			.chunks
			.iter()
			.find(|c| c.kind == ChunkKind::If)
			.expect("if chunk should exist");

		let result = apply_edits(&state, &EditParams {
			operations:       vec![EditOperation {
				op:      ChunkEditOp::Put,
				sel:     Some(format!("{}~", if_chunk.path)),
				crc:     Some(if_chunk.checksum.clone()),
				region:  None,
				content: Some("return \"forced\"\n".to_owned()),
				find:    None,
			}],
			default_selector: None,
			default_crc:      None,
			anchor_style:     None,
			cwd:              ".".to_owned(),
			file_path:        "test.py".to_owned(),
			normalize_indent: None,
		})
		.expect("fallback body edit should preserve head and stay parse-valid");

		assert!(result.parse_valid, "edit should remain parse-valid");
		assert!(
			result.diff_after.contains("if request.ok:"),
			"if guard should be preserved, got: {}",
			result.diff_after
		);
		assert!(
			result.diff_after.contains("return \"forced\""),
			"replacement body should appear, got: {}",
			result.diff_after
		);
		assert!(
			!result.diff_after.contains("return \"yes\""),
			"old body should be replaced, got: {}",
			result.diff_after
		);
	}

	#[test]
	fn delete_chunk_produces_removal_diff() {
		let source = "fn foo() {\n    println!(\"a\");\n}\n\nfn bar() {\n    println!(\"b\");\n}\n";
		let state = state_for(source, "rust");
		let foo = state.inner().chunk("fn_foo").expect("fn_foo");
		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some("fn_foo".to_owned()),
			crc:     Some(foo.checksum.clone()),
			region:  None,
			content: Some(String::new()),
			find:    None,
		});

		assert!(result.changed, "deletion should be marked as changed");
		// The response_text should include a diff showing removed lines,
		// not an empty body after the file header.
		assert!(
			result.response_text.contains("fn foo"),
			"deletion response should include a diff showing the removed function: {}",
			result.response_text
		);
	}

	#[test]
	fn delete_first_enum_variant_produces_diff() {
		let source = "enum Level {\n    Debug,\n    Info,\n    Warn,\n}\n";
		let state = state_for(source, "rust");
		let debug = state.inner().chunk("en_Lev.vr_Deb").expect("vr_Deb");
		let result = apply_single_edit(&state, "test.rs", EditOperation {
			op:      ChunkEditOp::Put,
			sel:     Some("en_Lev.vr_Deb".to_owned()),
			crc:     Some(debug.checksum.clone()),
			region:  None,
			content: Some(String::new()),
			find:    None,
		});

		assert!(result.changed, "deletion should be marked as changed");
		// The response should show the removed variant in a diff hunk.
		assert!(
			result.response_text.contains("Debug"),
			"deletion of first enum variant should show a diff with the removed content: {}",
			result.response_text
		);
		assert!(
			result.response_text.contains("@en_Lev.vr_Deb#"),
			"deleted variant should keep its chunk anchor with a deletion marker: {}",
			result.response_text
		);
	}
}
