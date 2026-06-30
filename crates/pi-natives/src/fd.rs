//! Fuzzy file path discovery for autocomplete and @-mention resolution.
//!
//! Searches for files and directories whose paths match a query string via
//! subsequence scoring. Uses `pi-walker` for directory traversal and caching.

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{iofs, task};

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:       String,
	/// Directory to search.
	pub path:        String,
	/// Include hidden files (default: false).
	pub hidden:      Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:   Option<bool>,
	/// Enable walker scan caching (default: false).
	pub cache:       Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:  Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

fn normalize_fuzzy_text(value: &str) -> String {
	value
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(|ch| ch.to_lowercase())
		.collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
) -> u32 {
	if query_lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	// Match against the full relative path only when the user typed a path-style
	// query (contains '/'). Plain queries should match by basename only, otherwise
	// '@plan' surfaces every file whose ancestor directories contain 'plan'.
	let query_has_slash = query_lower.contains('/');

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	let lower_file_name = file_name.to_lowercase();

	let mut score = if lower_file_name == query_lower {
		120
	} else if lower_file_name.starts_with(query_lower) {
		100
	} else if lower_file_name.contains(query_lower) {
		80
	} else if !query_has_slash {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = path.to_lowercase();
		if lower_path.contains(query_lower) {
			60
		} else {
			let normalized_file_name = normalize_fuzzy_text(file_name);
			let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let normalized_path = normalize_fuzzy_text(path);
				let path_fuzzy = if normalized_path == normalized_query {
					40
				} else {
					fuzzy_subsequence_score(query_chars, &normalized_path)
				};
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

fn score_entries(
	entries: &[iofs::GlobMatch],
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
	ct: &task::CancelToken,
) -> Result<Vec<FuzzyFindMatch>> {
	let mut scored = Vec::with_capacity(entries.len().min(256));
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type == iofs::FileType::Symlink {
			continue;
		}

		let is_directory = entry.file_type == iofs::FileType::Dir;
		let score =
			score_fuzzy_path(&entry.path, is_directory, query_lower, normalized_query, query_chars);
		if score == 0 {
			continue;
		}

		let mut path = entry.path.clone();
		if is_directory {
			path.push('/');
		}
		scored.push(FuzzyFindMatch { path, is_directory, score });
	}
	Ok(scored)
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	let root = pi_walker::resolve_search_path(&config.path).map_err(iofs::map_walker_error)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query_lower = config.query.trim().to_lowercase();
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let outcome = pi_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(respect_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(pi_walker::FollowLinks::Always)
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(config.cache.unwrap_or(false))
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.collect_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	let entries: Vec<iofs::GlobMatch> = outcome
		.entries
		.into_iter()
		.map(iofs::GlobMatch::from)
		.collect();
	let mut scored = score_entries(&entries, &query_lower, &normalized_query, &query_chars, &ct)?;

	scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
	let total_matches = crate::utils::clamp_u32(scored.len() as u64);
	let matches = scored.into_iter().take(max_results).collect();
	Ok(FuzzyFindResult { matches, total_matches })
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{
		fs,
		os::unix::fs as unix_fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	#[cfg(unix)]
	use super::{FuzzyFindConfig, fuzzy_find_sync};
	#[cfg(unix)]
	use crate::task;

	#[cfg(unix)]
	struct TempDirGuard(PathBuf);

	#[cfg(unix)]
	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time is after UNIX_EPOCH")
				.as_nanos();
			let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
			let pid = std::process::id();
			let path = std::env::temp_dir().join(format!("pi-fd-test-{pid}-{nanos}-{seq}"));
			fs::create_dir_all(&path).expect("create temp test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	#[cfg(unix)]
	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_find_without_cache_follows_symlinked_directories() {
		let root = TempDirGuard::new();
		let real_dir = root.path().join("zz-real-dir");
		let link_dir_name = "aa-linked-dir";
		let link_dir = root.path().join(link_dir_name);
		let file_name = "follow-links-fuzzy-needle.txt";

		fs::create_dir_all(&real_dir).expect("create real directory");
		fs::write(real_dir.join(file_name), "needle\n").expect("write symlink target file");
		unix_fs::symlink(&real_dir, &link_dir).expect("create directory symlink");

		let result = fuzzy_find_sync(
			FuzzyFindConfig {
				query:       file_name.to_string(),
				path:        root.path().to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(4),
				cache:       Some(false),
			},
			task::CancelToken::default(),
		)
		.expect("fuzzy find succeeds");

		assert!(!result.matches.is_empty(), "expected at least one fuzzy find match");
		let expected_path = format!("{link_dir_name}/{file_name}");
		assert!(
			result
				.matches
				.iter()
				.any(|entry| entry.path == expected_path),
			"expected fuzzy find to include symlink traversal path {expected_path:?}, got {:?}",
			result
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>()
		);
	}
}
