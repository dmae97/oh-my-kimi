use std::{cmp::Ordering, collections::BTreeSet};

use crate::chunk::{
	CHUNK_BIGRAMS,
	state::ChunkStateInner,
	types::{ChunkNode, ChunkRegion, ChunkTree},
};

pub struct ResolvedChunk<'a> {
	pub chunk: &'a ChunkNode,
	pub crc:   Option<String>,
}

fn parse_region_name(value: &str) -> Option<ChunkRegion> {
	match value.trim() {
		"^" => Some(ChunkRegion::Head),
		"~" => Some(ChunkRegion::Body),
		_ => None,
	}
}

fn is_known_region_name(value: &str) -> bool {
	matches!(value.trim(), "^" | "~")
}

pub fn split_region_suffix(selector: &str) -> (&str, bool, Option<ChunkRegion>) {
	let Some(suffix) = selector.chars().last() else {
		return (selector, false, None);
	};
	let suffix = suffix.to_string();
	if !is_known_region_name(&suffix) {
		return (selector, false, None);
	}
	let prefix = &selector[..selector.len() - suffix.len()];
	(prefix.trim_end(), true, parse_region_name(&suffix))
}

pub struct ParsedSelector {
	pub selector:         Option<String>,
	pub crc:              Option<String>,
	pub region:           Option<ChunkRegion>,
	/// All checksum tokens discovered in the selector (trailing and
	/// per-segment), in the order they appeared. Used for lenient multi-CRC
	/// matching where at least one CRC in the resolved ancestor chain must
	/// match.
	pub all_crcs:         Vec<String>,
	/// `true` when the resolved primary CRC targets the trailing (leaf)
	/// segment — either because the last path segment had `#XXXX` or the
	/// caller passed `crc` explicitly. `false` when CRCs only appeared on
	/// intermediate ancestor segments.
	pub has_trailing_crc: bool,
}

pub fn split_selector_crc_and_region(
	selector: Option<&str>,
	crc: Option<&str>,
	region: Option<ChunkRegion>,
) -> Result<ParsedSelector, String> {
	let mut raw = selector
		.map(str::trim)
		.filter(|value| !matches!(*value, "" | "null" | "undefined"))
		.unwrap_or_default()
		.to_owned();
	if let Some(index) = chunk_read_path_separator_index(&raw) {
		raw = raw[index + 1..].to_owned();
	}

	let (without_region, parsed_region) = if raw.is_empty() {
		(raw.as_str(), None)
	} else {
		let (prefix, found, parsed_region) = split_region_suffix(raw.as_str());
		if found {
			(prefix, parsed_region)
		} else if let Some((_, suffix)) = raw.rsplit_once('@') {
			return Err(format!(
				"Unknown chunk region \"{}\". Valid regions: ^, ~ (or omit for the full chunk).",
				suffix.trim()
			));
		} else {
			(raw.as_str(), None)
		}
	};

	let mut selector_part = without_region.trim().to_owned();
	let mut collected_crcs: Vec<String> = Vec::new();
	let mut has_trailing_crc = false;

	// Whole-selector bare-CRC forms ("#XXXX" or "XXXX") take precedence so
	// the rest of the logic can treat the selector as a dotted name path.
	if let Some(suffix) = selector_part.strip_prefix('#')
		&& is_checksum_token(suffix.trim())
	{
		if let Some(c) = sanitize_crc(Some(suffix)) {
			collected_crcs.push(c);
		}
		selector_part.clear();
		has_trailing_crc = true;
	} else if is_checksum_token(selector_part.as_str()) {
		if let Some(c) = sanitize_crc(Some(selector_part.as_str())) {
			collected_crcs.push(c);
		}
		selector_part.clear();
		has_trailing_crc = true;
	} else if !selector_part.is_empty() {
		// Strip per-segment `#XXXX` checksums while traversing. Record whether
		// the trailing (last) segment carried its own CRC so callers can keep
		// legacy strict-matching behavior for `name#CRC` forms.
		let segments: Vec<&str> = selector_part.split('.').collect();
		let last_idx = segments.len().saturating_sub(1);
		let cleaned_segments: Vec<String> = segments
			.iter()
			.enumerate()
			.map(|(idx, seg)| {
				let seg = seg.trim();
				if let Some((prefix, suffix)) = seg.rsplit_once('#')
					&& is_checksum_token(suffix.trim())
				{
					if let Some(c) = sanitize_crc(Some(suffix)) {
						collected_crcs.push(c);
					}
					if idx == last_idx {
						has_trailing_crc = true;
					}
					prefix.trim_end().to_owned()
				} else {
					seg.to_owned()
				}
			})
			.collect();
		selector_part = cleaned_segments.join(".");
	}

	let cleaned_selector = if selector_part.is_empty() {
		None
	} else {
		Some(selector_part)
	};
	let explicit_crc = sanitize_crc(crc);
	if let Some(explicit) = explicit_crc.as_deref() {
		if !collected_crcs.iter().any(|c| c == explicit) {
			collected_crcs.push(explicit.to_owned());
		}
		// An explicit `crc` parameter always targets the resolved chunk (the
		// leaf), so it counts as a trailing CRC for legacy matching purposes.
		has_trailing_crc = true;
	}
	let cleaned_crc = explicit_crc.or_else(|| {
		if has_trailing_crc {
			collected_crcs.last().cloned()
		} else {
			None
		}
	});
	let region = region.or(parsed_region);

	if let Some(cleaned_selector) = cleaned_selector.as_deref()
		&& cleaned_crc.is_some()
		&& looks_like_file_target(cleaned_selector)
	{
		return Ok(ParsedSelector {
			selector: None,
			crc: cleaned_crc,
			region,
			all_crcs: collected_crcs,
			has_trailing_crc,
		});
	}

	Ok(ParsedSelector {
		selector: cleaned_selector,
		crc: cleaned_crc,
		region,
		all_crcs: collected_crcs,
		has_trailing_crc,
	})
}

pub fn sanitize_chunk_selector(selector: Option<&str>) -> Option<String> {
	split_selector_crc_and_region(selector, None, None)
		.ok()
		.and_then(|parsed| parsed.selector)
}

pub fn sanitize_crc(crc: Option<&str>) -> Option<String> {
	let value = crc?.trim();
	if matches!(value, "" | "null" | "undefined") {
		None
	} else {
		Some(value.to_ascii_lowercase())
	}
}

pub fn resolve_chunk_selector<'a>(
	state: &'a ChunkStateInner,
	selector: Option<&str>,
	warnings: &mut Vec<String>,
) -> Result<&'a ChunkNode, String> {
	let ParsedSelector { crc: cleaned_crc, .. } =
		split_selector_crc_and_region(selector, None, None)?;
	let cleaned_selector = sanitize_chunk_selector(selector);
	resolve_chunk_selector_impl(state, cleaned_selector.as_deref(), cleaned_crc.as_deref(), warnings)
}

pub fn resolve_chunk_selector_with_crc_filter<'a>(
	state: &'a ChunkStateInner,
	selector: Option<&str>,
	crc: Option<&str>,
	warnings: &mut Vec<String>,
) -> Result<&'a ChunkNode, String> {
	let ParsedSelector { selector: cleaned_selector, .. } =
		split_selector_crc_and_region(selector, None, None)?;
	let cleaned_crc = sanitize_crc(crc);
	if cleaned_selector.is_none()
		&& let Some(cleaned_crc) = cleaned_crc.as_deref()
	{
		return resolve_chunk_by_checksum(state, cleaned_crc);
	}
	resolve_chunk_selector_impl(state, cleaned_selector.as_deref(), cleaned_crc.as_deref(), warnings)
}

pub fn resolve_chunk_with_crc<'a>(
	state: &'a ChunkStateInner,
	selector: Option<&str>,
	crc: Option<&str>,
	warnings: &mut Vec<String>,
) -> Result<ResolvedChunk<'a>, String> {
	let ParsedSelector { selector: cleaned_selector, crc: cleaned_crc, .. } =
		split_selector_crc_and_region(selector, crc, None)?;

	if cleaned_selector.is_none()
		&& let Some(cleaned_crc) = cleaned_crc.clone()
	{
		let chunk = resolve_chunk_by_checksum(state, &cleaned_crc)?;
		return Ok(ResolvedChunk { chunk, crc: Some(cleaned_crc) });
	}

	if let (Some(cleaned_selector), Some(cleaned_crc)) =
		(cleaned_selector.as_deref(), cleaned_crc.as_deref())
		&& state.chunk(cleaned_selector).is_none()
		&& let Some(chunk) =
			resolve_same_parent_crc_fallback(state, cleaned_selector, cleaned_crc, warnings)?
	{
		return Ok(ResolvedChunk { chunk, crc: Some(cleaned_crc.to_owned()) });
	}

	let chunk = resolve_chunk_selector_impl(state, cleaned_selector.as_deref(), None, warnings)?;
	Ok(ResolvedChunk { chunk, crc: cleaned_crc })
}

/// Return `Ok(Some(matching_crc))` when at least one of `provided_crcs`
/// equals the checksum of `chunk` or any of its ancestors (including the
/// root). Return `Ok(None)` when `provided_crcs` is empty (nothing to
/// verify). Return an error listing the fresh ancestor CRCs when
/// `provided_crcs` is non-empty but none match.
pub fn verify_any_ancestor_crc_match(
	state: &ChunkStateInner,
	chunk: &ChunkNode,
	provided_crcs: &[String],
) -> Result<Option<String>, String> {
	if provided_crcs.is_empty() {
		return Ok(None);
	}
	let mut ancestors: Vec<&ChunkNode> = Vec::new();
	let mut cursor: Option<&ChunkNode> = Some(chunk);
	while let Some(node) = cursor {
		ancestors.push(node);
		cursor = match node.parent_path.as_deref() {
			Some(parent_path) => state.chunk(parent_path),
			None => None,
		};
	}
	for ancestor in &ancestors {
		for crc in provided_crcs {
			if ancestor.checksum.as_str() == crc.as_str() {
				return Ok(Some(crc.clone()));
			}
		}
	}
	let fresh = ancestors
		.iter()
		.map(|node| format_node_ref(node))
		.collect::<Vec<_>>()
		.join(", ");
	Err(format!(
		"None of the provided checksums [{}] match any ancestor of \"{}\". Fresh chain: {fresh}. \
		 Re-read the file to get current checksums.",
		provided_crcs.join(", "),
		if chunk.path.is_empty() {
			"<root>"
		} else {
			chunk.path.as_str()
		},
	))
}

fn resolve_same_parent_crc_fallback<'a>(
	state: &'a ChunkStateInner,
	selector: &str,
	crc: &str,
	warnings: &mut Vec<String>,
) -> Result<Option<&'a ChunkNode>, String> {
	let (parent_path, requested_leaf) = split_parent_selector(selector);
	let child_paths = match parent_path {
		Some(parent_path) => {
			let Some(parent_chunk) = state.chunk(parent_path) else {
				return Ok(None);
			};
			parent_chunk.children.as_slice()
		},
		None => state.tree().root_children.as_slice(),
	};
	let matches = collect_unique_matches(
		child_paths
			.iter()
			.filter_map(|child_path| state.chunk(child_path))
			.filter(|chunk| chunk.checksum == crc),
	);
	if matches.is_empty() {
		return Ok(None);
	}

	let resolved = if matches.len() == 1 {
		matches[0]
	} else if let Some(candidate) = choose_named_crc_match(matches.as_slice(), requested_leaf) {
		candidate
	} else {
		let scope = parent_path.unwrap_or("<root>");
		return Err(format!(
			"Ambiguous stale selector \"{selector}#{crc}\" under \"{scope}\" matches {} siblings: \
			 {}. Re-read the file to get the current selector.",
			matches.len(),
			matches
				.iter()
				.map(|chunk| format_node_ref(chunk))
				.collect::<Vec<_>>()
				.join(", "),
		));
	};

	warnings.push(format!(
		"Auto-resolved stale selector \"{selector}#{crc}\" to sibling \"{}\". Use the fresh \
		 selector from read output.",
		format_node_ref(resolved)
	));
	Ok(Some(resolved))
}

fn split_parent_selector(selector: &str) -> (Option<&str>, &str) {
	match selector.rsplit_once('.') {
		Some((parent_path, leaf)) if !parent_path.is_empty() => (Some(parent_path), leaf),
		_ => (None, selector),
	}
}

fn choose_named_crc_match<'a>(
	matches: &[&'a ChunkNode],
	requested_leaf: &str,
) -> Option<&'a ChunkNode> {
	let mut best_match = None;
	let mut best_score = 0;
	let mut tied = false;

	for candidate in matches {
		let candidate_leaf = candidate
			.path
			.rsplit('.')
			.next()
			.unwrap_or(candidate.path.as_str());
		let score = leaf_name_similarity(requested_leaf, candidate_leaf);
		if score > best_score {
			best_match = Some(*candidate);
			best_score = score;
			tied = false;
		} else if score > 0 && score == best_score {
			tied = true;
		}
	}

	if tied || best_score == 0 {
		None
	} else {
		best_match
	}
}

fn leaf_name_similarity(requested_leaf: &str, candidate_leaf: &str) -> usize {
	if candidate_leaf == requested_leaf {
		return 4;
	}
	if normalize_leaf_name(candidate_leaf) == normalize_leaf_name(requested_leaf) {
		return 3;
	}
	if candidate_leaf.contains(requested_leaf) || requested_leaf.contains(candidate_leaf) {
		return 2;
	}
	if chunk_path_similarity(requested_leaf, candidate_leaf) > 0.5 {
		return 1;
	}
	0
}

fn normalize_leaf_name(name: &str) -> &str {
	match name.rsplit_once('_') {
		Some((prefix, suffix))
			if !prefix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit()) =>
		{
			prefix
		},
		_ => name,
	}
}

pub fn resolve_chunk_by_checksum<'a>(
	state: &'a ChunkStateInner,
	crc: &str,
) -> Result<&'a ChunkNode, String> {
	let cleaned_crc = sanitize_crc(Some(crc)).ok_or_else(|| "Checksum is required".to_owned())?;
	let matches = state.chunks_by_checksum(&cleaned_crc);
	match matches.len() {
		0 => Err(format!(
			"Checksum \"{cleaned_crc}\" did not match any chunk. Re-read the file to get current \
			 checksums."
		)),
		1 => Ok(matches[0]),
		_ => Err(format!(
			"Ambiguous checksum \"{cleaned_crc}\" matches {} chunks: {}. Provide sel to disambiguate.",
			matches.len(),
			matches
				.iter()
				.map(|chunk| format_node_ref(chunk))
				.collect::<Vec<_>>()
				.join(", "),
		)),
	}
}

fn root_chunk(state: &ChunkStateInner) -> Result<&ChunkNode, String> {
	state
		.chunk("")
		.ok_or_else(|| "Chunk tree is missing the root chunk".to_owned())
}

pub fn chunk_region_range(chunk: &ChunkNode, region: ChunkRegion) -> (usize, usize) {
	let start = chunk.start_byte as usize;
	let end = chunk.end_byte as usize;
	let pro_end = chunk
		.prologue_end_byte
		.map_or(start, |b| (b as usize).clamp(start, end));
	let epi_start = chunk
		.epilogue_start_byte
		.map_or(end, |b| (b as usize).clamp(pro_end, end));
	match region {
		ChunkRegion::Head => (start, pro_end),
		ChunkRegion::Body => (pro_end, epi_start),
	}
}

pub fn format_region_ref(chunk: &ChunkNode, region: Option<ChunkRegion>) -> String {
	let suffix = region.map_or(String::new(), |r| r.as_str().to_owned());
	if chunk.path.is_empty() {
		format!("<root>#{}{suffix}", chunk.checksum)
	} else {
		format!("{}#{}{suffix}", chunk.path, chunk.checksum)
	}
}

fn resolve_chunk_selector_impl<'a>(
	state: &'a ChunkStateInner,
	selector: Option<&str>,
	crc: Option<&str>,
	warnings: &mut Vec<String>,
) -> Result<&'a ChunkNode, String> {
	let Some(cleaned) = selector else {
		return root_chunk(state);
	};

	if is_line_number_selector(cleaned) {
		if let Some(line) = parse_line_number(cleaned)
			&& let Some(chunk_path) = crate::chunk::line_to_chunk_path(state.tree(), line)
		{
			warnings
				.push(format!("Auto-resolved line target \"{cleaned}\" to chunk \"{chunk_path}\"."));
			return resolve_chunk_selector_impl(state, Some(&chunk_path), crc, warnings);
		}
		return Err(format!(
			"Line target \"{cleaned}\" does not fall inside any chunk. Use chunk paths like \
			 fn_foo#thth instead, or run read(sel=\"?\") to list available chunks."
		));
	}

	if let Some(chunk) = state.chunk(cleaned) {
		return match_crc_filter(cleaned, vec![chunk], crc);
	}

	if is_checksum_token(cleaned) {
		let matches = state.chunks_by_checksum(cleaned);
		if !matches.is_empty() {
			return resolve_matches(
				matches,
				cleaned,
				crc,
				warnings,
				"checksum selector",
				"Auto-resolved checksum selector",
			);
		}
	}

	let suffix_matches = state.chunks_by_suffix(cleaned);
	if !suffix_matches.is_empty() {
		return resolve_matches(
			suffix_matches,
			cleaned,
			crc,
			warnings,
			"chunk selector",
			"Auto-resolved chunk selector",
		);
	}

	if !cleaned.contains('.') {
		let prefixed_matches = collect_unique_matches(state.tree.chunks.iter().filter(|chunk| {
			if chunk.path.is_empty() {
				return false;
			}
			let leaf = chunk.path.rsplit('.').next().unwrap_or(chunk.path.as_str());
			let expected = chunk.kind.path_segment(Some(cleaned));
			path_segment_matches_requested(leaf, &expected)
				|| path_segment_matches_requested(leaf, cleaned)
		}));
		if !prefixed_matches.is_empty() {
			return resolve_matches(
				prefixed_matches,
				cleaned,
				crc,
				warnings,
				"chunk selector",
				"Auto-resolved chunk selector",
			);
		}
	}

	let kind_segments = cleaned.split('.').collect::<Vec<_>>();
	let kind_candidates = collect_unique_matches(
		state
			.chunks_by_leaf(kind_segments.last().copied().unwrap_or(cleaned))
			.into_iter()
			.filter(|candidate| kind_path_matches(candidate, &kind_segments)),
	);
	let full_path_candidates = if kind_candidates.is_empty() {
		collect_unique_matches(
			state
				.tree
				.chunks
				.iter()
				.filter(|candidate| kind_path_matches(candidate, &kind_segments)),
		)
	} else {
		Vec::new()
	};
	if !kind_candidates.is_empty() {
		return resolve_matches(
			kind_candidates,
			cleaned,
			crc,
			warnings,
			"kind selector",
			"Auto-resolved kind selector",
		);
	}
	if !full_path_candidates.is_empty() {
		return resolve_matches(
			full_path_candidates,
			cleaned,
			crc,
			warnings,
			"full-path selector",
			"Auto-resolved full-path selector",
		);
	}

	Err(build_not_found_error(state.tree(), cleaned))
}

fn match_crc_filter<'a>(
	cleaned: &str,
	matches: Vec<&'a ChunkNode>,
	crc: Option<&str>,
) -> Result<&'a ChunkNode, String> {
	let Some(cleaned_crc) = crc else {
		return Ok(matches[0]);
	};
	let filtered = filter_by_crc(&matches, cleaned_crc);
	match filtered.len() {
		1 => Ok(filtered[0]),
		0 => {
			let actual = matches
				.iter()
				.map(|chunk| format_node_ref(chunk))
				.collect::<Vec<_>>()
				.join(", ");
			Err(format!("Stale checksum \"{cleaned_crc}\" for \"{cleaned}\". Current: {actual}."))
		},
		_ => Err(format!(
			"Ambiguous chunk selector \"{cleaned}\" with checksum \"{cleaned_crc}\" matches {} \
			 chunks: {}. Use the full path from read output.",
			filtered.len(),
			filtered
				.iter()
				.map(|chunk| format_node_ref(chunk))
				.collect::<Vec<_>>()
				.join(", "),
		)),
	}
}

fn resolve_matches<'a>(
	matches: Vec<&'a ChunkNode>,
	cleaned: &str,
	crc: Option<&str>,
	warnings: &mut Vec<String>,
	selector_label: &str,
	warning_label: &str,
) -> Result<&'a ChunkNode, String> {
	let matches = if let Some(cleaned_crc) = crc {
		let filtered = filter_by_crc(&matches, cleaned_crc);
		if filtered.is_empty() {
			let actual = matches
				.iter()
				.map(|chunk| format_node_ref(chunk))
				.collect::<Vec<_>>()
				.join(", ");
			return Err(format!(
				"Stale checksum \"{cleaned_crc}\" for {selector_label} \"{cleaned}\". Current: \
				 {actual}."
			));
		}
		filtered
	} else {
		matches
	};
	let outermost = retain_outermost_matches(matches);
	resolve_unique_chunks(outermost, cleaned, warnings, selector_label, warning_label)?.ok_or_else(
		|| {
			format!(
				"{selector_label} \"{cleaned}\" did not match any chunk. Re-read the file to see \
				 available chunk paths."
			)
		},
	)
}

fn filter_by_crc<'a>(matches: &[&'a ChunkNode], crc: &str) -> Vec<&'a ChunkNode> {
	matches
		.iter()
		.filter(|chunk| chunk.checksum == crc)
		.copied()
		.collect()
}

fn collect_unique_matches<'a>(
	matches: impl IntoIterator<Item = &'a ChunkNode>,
) -> Vec<&'a ChunkNode> {
	let mut seen = BTreeSet::new();
	let mut out = Vec::new();
	for chunk in matches {
		if chunk.path.is_empty() || !seen.insert(chunk.path.as_str()) {
			continue;
		}
		out.push(chunk);
	}
	out
}

fn retain_outermost_matches(matches: Vec<&ChunkNode>) -> Vec<&ChunkNode> {
	let Some(min_depth) = matches
		.iter()
		.map(|chunk| chunk.path.split('.').count())
		.min()
	else {
		return matches;
	};
	matches
		.into_iter()
		.filter(|chunk| chunk.path.split('.').count() == min_depth)
		.collect()
}

fn resolve_unique_chunks<'a>(
	matches: Vec<&'a ChunkNode>,
	cleaned: &str,
	warnings: &mut Vec<String>,
	selector_label: &str,
	warning_label: &str,
) -> Result<Option<&'a ChunkNode>, String> {
	match matches.len() {
		0 => Ok(None),
		1 => {
			warnings.push(format!(
				"{warning_label} \"{cleaned}\" to \"{}\". Use the full path from read output.",
				format_node_ref(matches[0])
			));
			Ok(Some(matches[0]))
		},
		_ => Err(format!(
			"Ambiguous {selector_label} \"{cleaned}\" matches {} chunks: {}. Use the full path from \
			 read output.",
			matches.len(),
			matches
				.iter()
				.map(|chunk| format_node_ref(chunk))
				.collect::<Vec<_>>()
				.join(", "),
		)),
	}
}

fn kind_path_matches(candidate: &ChunkNode, kind_segments: &[&str]) -> bool {
	if candidate.path.is_empty() {
		return false;
	}
	let path_segments = candidate.path.split('.').collect::<Vec<_>>();
	path_segments.len() == kind_segments.len()
		&& kind_segments
			.iter()
			.zip(path_segments)
			.all(|(requested, candidate_segment)| {
				path_segment_matches_requested(candidate_segment, requested)
			})
}

fn path_segment_matches_requested(candidate_segment: &str, requested_segment: &str) -> bool {
	if candidate_segment == requested_segment {
		return true;
	}

	let normalized_candidate = normalize_leaf_name(candidate_segment);
	if normalized_candidate == requested_segment {
		return true;
	}

	let (candidate_kind, candidate_identifier) = split_path_segment(normalized_candidate);
	let (requested_kind, requested_identifier) = split_path_segment(requested_segment);
	match (candidate_identifier, requested_identifier) {
		(Some(candidate_identifier), Some(requested_identifier)) => {
			candidate_kind == requested_kind && requested_identifier.starts_with(candidate_identifier)
		},
		(Some(candidate_identifier), None) => {
			requested_segment == candidate_identifier
				|| requested_segment.starts_with(candidate_identifier)
		},
		(None, Some(_)) => false,
		(None, None) => false,
	}
}

fn split_path_segment(segment: &str) -> (&str, Option<&str>) {
	match segment.split_once('_') {
		Some((kind, identifier)) if !identifier.is_empty() => (kind, Some(identifier)),
		_ => (segment, None),
	}
}

/// Format a `ChunkNode` as `path#CRC`.
fn format_node_ref(chunk: &ChunkNode) -> String {
	if chunk.path.is_empty() {
		format!("<root>#{}", chunk.checksum)
	} else {
		format!("{}#{}", chunk.path, chunk.checksum)
	}
}

pub fn format_selector_tree(
	tree: &ChunkTree,
	children: &[String],
	leading_dot_on_first_level: bool,
) -> Vec<String> {
	fn emit_children(
		tree: &ChunkTree,
		children: &[String],
		prefix: &str,
		depth: usize,
		leading_dot_on_first_level: bool,
		lines: &mut Vec<String>,
	) {
		let count = children.len();
		for (index, child_path) in children.iter().enumerate() {
			let Some(child) = find_chunk_by_path(tree, child_path) else {
				continue;
			};
			let is_last = index + 1 == count;
			let connector = if is_last { "└── " } else { "├── " };
			let leaf = child.path.rsplit('.').next().unwrap_or(child.path.as_str());
			let dot = if depth > 0 || leading_dot_on_first_level {
				"."
			} else {
				""
			};
			lines.push(format!(
				"{prefix}{connector}{dot}{leaf}#{}  L{}-L{}",
				child.checksum, child.start_line, child.end_line,
			));
			let continuation = if is_last { "    " } else { "│   " };
			if let Some(signature) = child.signature.as_deref() {
				lines.push(format!("{prefix}{continuation}  {signature}"));
			}
			if !child.children.is_empty() {
				let next_prefix = format!("{prefix}{continuation}");
				emit_children(tree, &child.children, next_prefix.as_str(), depth + 1, false, lines);
			}
		}
	}

	let mut lines = Vec::new();
	emit_children(tree, children, "", 0, leading_dot_on_first_level, &mut lines);
	lines
}

fn build_not_found_error(tree: &ChunkTree, cleaned: &str) -> String {
	let (direct_children_parent, direct_children, matched_empty_prefix) =
		matching_prefix_context(tree, cleaned);
	let similarity = suggest_chunk_paths(tree, cleaned, 8);

	let hint = if let Some(parent) = direct_children_parent {
		let tree_lines = format_selector_tree(tree, &direct_children, true);
		if tree_lines.is_empty() {
			format!(" Direct children of \"{parent}\": none.")
		} else {
			format!(" Direct children of \"{parent}\":\n{}", tree_lines.join("\n"))
		}
	} else if let Some(prefix) = matched_empty_prefix {
		if similarity.is_empty() {
			format!(" The prefix \"{prefix}\" exists but has no child chunks.")
		} else {
			format!(
				" The prefix \"{prefix}\" exists but has no child chunks. Similar paths: {}.",
				similarity.join(", ")
			)
		}
	} else if !similarity.is_empty() {
		format!(" Similar paths: {}.", similarity.join(", "))
	} else {
		let tree_lines = format_selector_tree(tree, &tree.root_children, false);
		if tree_lines.is_empty() {
			" Use sel=\"?\" to see available chunk paths.".to_owned()
		} else {
			format!(" Available top-level chunks:\n{}", tree_lines.join("\n"))
		}
	};

	if hint.contains('\n') {
		format!(
			"Chunk path not found: \"{cleaned}\".{hint}\nUse sel=\"?\" if you need the full chunk \
			 tree with paths and checksums."
		)
	} else {
		format!(
			"Chunk path not found: \"{cleaned}\".{hint} Use sel=\"?\" if you need the full chunk \
			 tree with paths and checksums."
		)
	}
}

fn matching_prefix_context(
	tree: &ChunkTree,
	cleaned: &str,
) -> (Option<String>, Vec<String>, Option<String>) {
	let mut direct_children = None;
	let mut direct_children_parent = None;
	let mut matched_empty_prefix = None;

	if cleaned.contains('.') {
		let parts = cleaned.split('.').collect::<Vec<_>>();
		for index in (1..parts.len()).rev() {
			let prefix = parts[..index].join(".");
			let Some(parent) = find_chunk_by_path(tree, &prefix) else {
				continue;
			};
			if !parent.children.is_empty() {
				let mut children = parent.children.clone();
				children.sort();
				direct_children_parent = Some(prefix);
				direct_children = Some(children);
				break;
			}
			if matched_empty_prefix.is_none() {
				matched_empty_prefix = Some(prefix);
			}
		}
	}

	(direct_children_parent, direct_children.unwrap_or_default(), matched_empty_prefix)
}

fn suggest_chunk_paths(tree: &ChunkTree, query: &str, limit: usize) -> Vec<String> {
	let mut scored = tree
		.chunks
		.iter()
		.filter(|chunk| !chunk.path.is_empty())
		.map(|chunk| (&chunk.path, &chunk.checksum, chunk_path_similarity(query, &chunk.path)))
		.filter(|(_, _, score)| *score > 0.1)
		.collect::<Vec<_>>();
	scored.sort_by(|left, right| {
		right
			.2
			.partial_cmp(&left.2)
			.unwrap_or(Ordering::Equal)
			.then_with(|| left.0.cmp(right.0))
	});
	scored
		.into_iter()
		.take(limit)
		.map(|(path, checksum, _)| format!("{path}#{checksum}"))
		.collect()
}

fn chunk_path_similarity(query: &str, candidate: &str) -> f64 {
	if candidate.ends_with(query) || candidate.ends_with(&format!(".{query}")) {
		return 0.9;
	}

	let query_leaf = query.rsplit('.').next().unwrap_or(query);
	let candidate_leaf = candidate.rsplit('.').next().unwrap_or(candidate);
	if query_leaf == candidate_leaf {
		return 0.85;
	}

	if candidate.contains(query) || query.contains(candidate) {
		return 0.6;
	}

	let query_parts = query.split('.').collect::<BTreeSet<_>>();
	let overlap = candidate
		.split('.')
		.filter(|part| query_parts.contains(part))
		.count();
	if overlap > 0 {
		0.1f64.mul_add(overlap as f64, 0.3)
	} else {
		0.0
	}
}

fn looks_like_file_target(selector: &str) -> bool {
	if selector.contains('/') || selector.contains('\\') {
		return true;
	}

	let Some((base, ext)) = selector.rsplit_once('.') else {
		return false;
	};
	!base.is_empty() && !ext.is_empty() && ext.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn is_line_number_selector(selector: &str) -> bool {
	let Some(rest) = selector.strip_prefix('L') else {
		return false;
	};
	let Some((start, end)) = rest.split_once('-') else {
		return !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit());
	};
	if start.is_empty() || !start.chars().all(|ch| ch.is_ascii_digit()) {
		return false;
	}
	let end = end.strip_prefix('L').unwrap_or(end);
	!end.is_empty() && end.chars().all(|ch| ch.is_ascii_digit())
}

/// Extract the start line number from a line selector like `L89` or `L24-L27`.
fn parse_line_number(selector: &str) -> Option<u32> {
	let rest = selector.strip_prefix('L')?;
	let digits = rest.split('-').next().unwrap_or(rest);
	digits.parse::<u32>().ok()
}

fn is_checksum_token(value: &str) -> bool {
	if value.len() != 4 || !value.is_ascii() {
		return false;
	}
	let lower = value.to_ascii_lowercase();
	CHUNK_BIGRAMS.contains(&&lower[..2]) && CHUNK_BIGRAMS.contains(&&lower[2..4])
}

fn find_chunk_by_path<'a>(tree: &'a ChunkTree, path: &str) -> Option<&'a ChunkNode> {
	tree.chunks.iter().find(|chunk| chunk.path == path)
}

/// Find the `:` separating a file path from a chunk selector in
/// `file.ts:chunk_path`. Skips Windows `C:\` / `C:/` drive prefixes.
fn chunk_read_path_separator_index(value: &str) -> Option<usize> {
	let bytes = value.as_bytes();
	// Skip Windows drive prefix: `C:\` or `C:/`
	let start = if bytes.len() >= 3
		&& bytes[0].is_ascii_alphabetic()
		&& bytes[1] == b':'
		&& matches!(bytes[2], b'/' | b'\\')
	{
		value[2..].find(':').map(|i| i + 2)?
	} else {
		value.find(':')?
	};
	Some(start)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::chunk::kind::ChunkKind;

	fn chunk(
		path: &str,
		checksum: &str,
		parent_path: Option<&str>,
		children: Vec<&str>,
	) -> ChunkNode {
		let leaf = path.rsplit('.').next().unwrap_or(path);
		let kind = match leaf.split_once('_').map_or(leaf, |(prefix, _)| prefix) {
			"fn" => ChunkKind::Function,
			"class" => ChunkKind::Class,
			"try" => ChunkKind::Try,
			_ => ChunkKind::Chunk,
		};
		ChunkNode {
			path: path.to_owned(),
			identifier: leaf
				.split_once('_')
				.and_then(|(_, identifier)| (!identifier.is_empty()).then_some(identifier.to_owned())),
			kind,
			leaf: children.is_empty(),
			virtual_content: None,
			parent_path: parent_path.map(str::to_owned),
			children: children.into_iter().map(str::to_owned).collect(),
			signature: None,
			start_line: 1,
			end_line: 1,
			line_count: 1,
			start_byte: 0,
			end_byte: 0,
			checksum_start_byte: 0,
			prologue_end_byte: None,
			epilogue_start_byte: None,
			checksum: checksum.to_owned(),
			error: false,
			indent: 0,
			indent_char: " ".to_owned(),
			group: false,
		}
	}

	fn state_for_resolution() -> ChunkStateInner {
		ChunkStateInner::new(String::new(), "typescript".to_owned(), ChunkTree {
			language:          "typescript".to_owned(),
			checksum:          "ROOT".to_owned(),
			line_count:        1,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["fn_han".to_owned()],
			chunks:            vec![
				chunk("", "ROOT", None, vec!["fn_han"]),
				chunk("fn_han", "seas", Some(""), vec!["fn_han.try"]),
				chunk("fn_han.try", "tete", Some("fn_han"), vec!["fn_han.try.if_2"]),
				chunk("fn_han.try.if_2", "roro", Some("fn_han.try"), vec!["fn_han.try.if_2.loop"]),
				chunk("fn_han.try.if_2.loop", "coco", Some("fn_han.try.if_2"), vec![
					"fn_han.try.if_2.loop.if_2",
				]),
				chunk("fn_han.try.if_2.loop.if_2", "nene", Some("fn_han.try.if_2.loop"), vec![]),
			],
		})
	}

	#[test]
	fn resolves_requested_chunk_selector_forms() {
		let state = state_for_resolution();
		let selectors = [
			"fn_han.try.if_2#roro",
			"fn_han.try.if_2",
			"handleTerraform.try.if_2",
			"if_2",
			"if_2#roro",
			"#roro",
			"roro",
		];

		for selector in selectors {
			let mut warnings = Vec::new();
			let resolved = resolve_chunk_with_crc(&state, Some(selector), None, &mut warnings)
				.unwrap_or_else(|err| panic!("selector {selector} should resolve: {err}"));
			assert_eq!(resolved.chunk.path, "fn_han.try.if_2");
		}
	}

	#[test]
	fn resolves_stale_selector_by_same_parent_checksum() {
		let state = ChunkStateInner::new(String::new(), "typescript".to_owned(), ChunkTree {
			language:          "typescript".to_owned(),
			checksum:          "ROOT".to_owned(),
			line_count:        1,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["fn_run".to_owned()],
			chunks:            vec![
				chunk("", "ROOT", None, vec!["fn_run"]),
				chunk("fn_run", "riri", Some(""), vec!["fn_run.var_eff_1", "fn_run.var_eff_2"]),
				chunk("fn_run.var_eff_1", "anan", Some("fn_run"), vec![]),
				chunk("fn_run.var_eff_2", "enen", Some("fn_run"), vec![]),
			],
		});
		let mut warnings = Vec::new();
		let resolved =
			resolve_chunk_with_crc(&state, Some("fn_run.var_eff"), Some("enen"), &mut warnings)
				.expect("stale selector should resolve to same-parent checksum match");
		assert_eq!(resolved.chunk.path, "fn_run.var_eff_2");
		assert!(
			warnings
				.iter()
				.any(|warning| warning.contains("Auto-resolved stale selector"))
		);
	}

	#[test]
	fn stale_selector_prefers_best_leaf_name_when_crc_matches_multiple_siblings() {
		let state = ChunkStateInner::new(String::new(), "typescript".to_owned(), ChunkTree {
			language:          "typescript".to_owned(),
			checksum:          "ROOT".to_owned(),
			line_count:        1,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["fn_run".to_owned()],
			chunks:            vec![
				chunk("", "ROOT", None, vec!["fn_run"]),
				chunk("fn_run", "riri", Some(""), vec!["fn_run.var_oth", "fn_run.var_eff_1"]),
				chunk("fn_run.var_oth", "enen", Some("fn_run"), vec![]),
				chunk("fn_run.var_eff_1", "enen", Some("fn_run"), vec![]),
			],
		});
		let mut warnings = Vec::new();
		let resolved =
			resolve_chunk_with_crc(&state, Some("fn_run.var_eff"), Some("enen"), &mut warnings)
				.expect("best name match should disambiguate same-parent checksum siblings");
		assert_eq!(resolved.chunk.path, "fn_run.var_eff_1");
	}

	#[test]
	fn stale_selector_fails_closed_when_same_parent_crc_matches_are_ambiguous() {
		let state = ChunkStateInner::new(String::new(), "typescript".to_owned(), ChunkTree {
			language:          "typescript".to_owned(),
			checksum:          "ROOT".to_owned(),
			line_count:        1,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["fn_run".to_owned()],
			chunks:            vec![
				chunk("", "ROOT", None, vec!["fn_run"]),
				chunk("fn_run", "riri", Some(""), vec!["fn_run.var_eff_1", "fn_run.var_eff_2"]),
				chunk("fn_run.var_eff_1", "enen", Some("fn_run"), vec![]),
				chunk("fn_run.var_eff_2", "enen", Some("fn_run"), vec![]),
			],
		});
		let mut warnings = Vec::new();
		let Err(err) =
			resolve_chunk_with_crc(&state, Some("fn_run.var_eff"), Some("enen"), &mut warnings)
		else {
			panic!("ambiguous stale selector should fail closed");
		};
		assert!(err.contains("Ambiguous stale selector"), "{err}");
	}

	#[test]
	fn resolves_full_untruncated_identifier_paths() {
		let state = ChunkStateInner::new(String::new(), "typescript".to_owned(), ChunkTree {
			language:          "typescript".to_owned(),
			checksum:          "ROOT".to_owned(),
			line_count:        1,
			parse_errors:      0,
			parse_error_lines: Vec::new(),
			fallback:          false,
			root_path:         String::new(),
			root_children:     vec!["cls_Ser".to_owned()],
			chunks:            vec![
				chunk("", "ROOT", None, vec!["cls_Ser"]),
				chunk("cls_Ser", "lele", Some(""), vec!["cls_Ser.fn_han"]),
				chunk("cls_Ser.fn_han", "eaea", Some("cls_Ser"), vec![]),
			],
		});
		let mut warnings = Vec::new();
		let resolved = resolve_chunk_with_crc(
			&state,
			Some("cls_Server.fn_handleRequest"),
			Some("eaea"),
			&mut warnings,
		)
		.expect("full untruncated selector should resolve to truncated chunk path");
		assert_eq!(resolved.chunk.path, "cls_Ser.fn_han");
		assert!(
			warnings
				.iter()
				.any(|warning| warning.contains("Auto-resolved"))
		);
	}

	#[test]
	fn split_selector_strips_inline_per_segment_crcs() {
		let parsed =
			split_selector_crc_and_region(Some("fn_han#seas.try#tete.if_2"), None, None).unwrap();
		assert_eq!(parsed.selector.as_deref(), Some("fn_han.try.if_2"));
		assert_eq!(parsed.all_crcs, vec!["seas".to_owned(), "tete".to_owned()]);
		assert!(!parsed.has_trailing_crc);
		// No trailing CRC → primary crc field stays empty so legacy strict
		// matching doesn't fire on an ancestor CRC.
		assert!(parsed.crc.is_none());
	}

	#[test]
	fn split_selector_retains_trailing_crc_as_primary() {
		let parsed =
			split_selector_crc_and_region(Some("fn_han#seas.try.if_2#roro"), None, None).unwrap();
		assert_eq!(parsed.selector.as_deref(), Some("fn_han.try.if_2"));
		assert_eq!(parsed.all_crcs, vec!["seas".to_owned(), "roro".to_owned()]);
		assert_eq!(parsed.crc.as_deref(), Some("roro"));
		assert!(parsed.has_trailing_crc);
	}

	#[test]
	fn verify_any_ancestor_crc_match_accepts_single_fresh() {
		let state = state_for_resolution();
		let chunk = state.chunk("fn_han.try.if_2").unwrap();
		let stale_and_fresh = vec!["WRONG".to_owned(), "seas".to_owned()];
		let matched = verify_any_ancestor_crc_match(&state, chunk, &stale_and_fresh).unwrap();
		assert_eq!(matched.as_deref(), Some("seas"));
	}

	#[test]
	fn verify_any_ancestor_crc_match_rejects_all_stale() {
		let state = state_for_resolution();
		let chunk = state.chunk("fn_han.try.if_2").unwrap();
		let all_stale = vec!["WRONG".to_owned(), "BADB".to_owned()];
		let err = verify_any_ancestor_crc_match(&state, chunk, &all_stale).unwrap_err();
		assert!(err.contains("None of the provided checksums"), "{err}");
		assert!(err.contains("seas") || err.contains("tete") || err.contains("roro"), "{err}");
	}

	#[test]
	fn verify_any_ancestor_crc_match_no_crcs_is_noop() {
		let state = state_for_resolution();
		let chunk = state.chunk("fn_han.try.if_2").unwrap();
		let matched = verify_any_ancestor_crc_match(&state, chunk, &[]).unwrap();
		assert!(matched.is_none());
	}
}
