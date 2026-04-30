//! Shared JSONL shapes, walk helpers, tokenizer, and formatting helpers.

use anyhow::{Context, Result};
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;
use tiktoken_rs::CoreBPE;
use walkdir::WalkDir;

// ---- jsonl shapes ----

#[derive(Deserialize)]
pub struct RawEvent {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub message: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
pub struct Message {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: Option<Box<RawValue>>,
    #[serde(default, rename = "toolName")]
    pub tool_name: String,
    #[serde(default, rename = "toolCallId")]
    pub tool_call_id: String,
}

#[derive(Deserialize)]
pub struct ContentItem {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub thinking: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub arguments: Option<Box<RawValue>>,
}

// ---- session walking ----

pub fn sessions_root() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not resolve home directory")?;
    Ok(home.join(".omp").join("agent").join("sessions"))
}

pub struct WalkOpts {
    /// Keeps only paths containing any of these substrings (e.g. "2026-04-28").
    /// Empty means accept all.
    pub date_filters: Vec<String>,
    /// Keeps only the N most-recently-modified files (after the date filter).
    /// 0 means no limit.
    pub limit_most_recent: usize,
}

/// Walks the sessions root and returns the matching `.jsonl` paths.
/// With `limit_most_recent > 0` the result is sorted by mtime descending and
/// truncated to N entries; otherwise it's lexically sorted.
pub fn collect_sessions(opts: &WalkOpts) -> Result<Vec<PathBuf>> {
    let base = sessions_root()?;
    let need_mtime = opts.limit_most_recent > 0;

    let mut all: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in WalkDir::new(&base).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let path_str = p.to_string_lossy();
        if !match_date(&path_str, &opts.date_filters) {
            continue;
        }
        let mt = if need_mtime {
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        } else {
            SystemTime::UNIX_EPOCH
        };
        all.push((p.to_path_buf(), mt));
    }

    if need_mtime {
        all.sort_by(|a, b| b.1.cmp(&a.1));
        all.truncate(opts.limit_most_recent);
    } else {
        all.sort_by(|a, b| a.0.cmp(&b.0));
    }
    Ok(all.into_iter().map(|(p, _)| p).collect())
}

fn match_date(p: &str, filters: &[String]) -> bool {
    filters.is_empty() || filters.iter().any(|d| p.contains(d))
}

// ---- content helpers ----

pub fn parse_content(raw: &RawValue) -> Vec<ContentItem> {
    serde_json::from_str(raw.get()).unwrap_or_default()
}

/// Concatenates all `text` items in a content array.
pub fn join_text(items: &[ContentItem]) -> String {
    let mut out = String::new();
    for it in items {
        if it.kind == "text" {
            out.push_str(&it.text);
        }
    }
    out
}

// ---- tokenizer (o200k_base) ----

static BPE: LazyLock<CoreBPE> =
    LazyLock::new(|| tiktoken_rs::o200k_base().expect("load o200k_base BPE"));

/// Counts tokens for `s` using the o200k_base BPE (GPT-4o / GPT-5 family).
/// Uses the ordinary encoder so embedded `<|...|>` sequences in tool args do
/// not trigger special-token handling.
pub fn count_tokens(s: &str) -> usize {
    if s.is_empty() {
        return 0;
    }
    BPE.encode_ordinary(s).len()
}

// ---- formatting helpers ----

/// Formats an integer with thousand separators.
pub fn commas(n: i64) -> String {
    let neg = n < 0;
    let mag = if neg { (n as i128).unsigned_abs() } else { n as u128 };
    let s = mag.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(bytes.len() + bytes.len() / 3 + 1);
    if neg {
        out.push('-');
    }
    let pre = bytes.len() % 3;
    if pre > 0 {
        out.push_str(&s[..pre]);
        if bytes.len() > pre {
            out.push(',');
        }
    }
    let mut i = pre;
    while i + 3 <= bytes.len() {
        out.push_str(&s[i..i + 3]);
        if i + 3 < bytes.len() {
            out.push(',');
        }
        i += 3;
    }
    out
}

pub fn pct(a: i64, b: i64) -> f64 {
    if b == 0 {
        0.0
    } else {
        100.0 * a as f64 / b as f64
    }
}

/// Truncates a string to at most `n` chars, replacing newlines with " | ".
/// Adds an ellipsis when truncation occurs.
pub fn truncate_line(s: &str, n: usize) -> String {
    let s = s.replace('\n', " | ");
    if s.chars().count() <= n {
        return s;
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

/// Returns map keys sorted by descending value, ties broken alphabetically.
pub fn sorted_by_count(m: &HashMap<String, i64>) -> Vec<&String> {
    let mut keys: Vec<&String> = m.keys().collect();
    keys.sort_by(|a, b| {
        let av = m.get(a.as_str()).copied().unwrap_or(0);
        let bv = m.get(b.as_str()).copied().unwrap_or(0);
        bv.cmp(&av).then_with(|| a.cmp(b))
    });
    keys
}

pub fn print_sorted(m: &HashMap<String, i64>) {
    print_sorted_indent(m, "  ");
}

pub fn print_sorted_indent(m: &HashMap<String, i64>, indent: &str) {
    for k in sorted_by_count(m) {
        println!("{indent}{k:<25} {}", m[k.as_str()]);
    }
}

// ---- parallel processing ----

/// Runs `handle(path)` in parallel across rayon workers and collects the
/// non-`None` results into a Vec. Logs progress every `progress_every` files
/// (set 0 to silence).
pub fn parallel_collect<R, H>(
    paths: &[PathBuf],
    workers: usize,
    progress_every: u64,
    handle: H,
) -> Vec<R>
where
    R: Send,
    H: Fn(&Path) -> Option<R> + Sync,
{
    let total = paths.len();
    let done = AtomicU64::new(0);

    let pool = {
        let mut b = rayon::ThreadPoolBuilder::new();
        if workers > 0 {
            b = b.num_threads(workers);
        }
        b.build().expect("rayon thread pool")
    };

    pool.install(|| {
        paths
            .par_iter()
            .filter_map(|p| {
                let r = handle(p);
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if progress_every > 0 && n % progress_every == 0 {
                    eprintln!("  processed {n}/{total}");
                }
                r
            })
            .collect()
    })
}
