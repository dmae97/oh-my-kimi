//! `edits` subcommand — audits how agents have used the edit / ast_edit /
//! write tools across session jsonl files.
//!
//! For every edit-family toolCall we record:
//!   - which argument-schema family is in use (the edit tool has shipped many
//!     shapes over time: oldText/newText, op+pos+end+lines, loc+content,
//!     loc+splice/pre/post/sed, etc.);
//!   - the locator shape and verb combination (for the current
//!     loc+splice/pre/post/sed schema);
//! then pair the call with its toolResult and classify success / failure
//! category (anchor-stale, no-match, parse, etc.).
//!
//! Output: markdown-ish report on stdout plus a per-call CSV at
//! `$EDIT_ANALYSIS_CSV` (default `./edit-analysis.csv`).

use crate::common::*;
use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::LazyLock;

#[derive(Default, Clone)]
struct EditEntry {
    file: String,
    call_id: String,
    tool_name: String,
    num_edits: i64,
    /// splice/pre/post/sed per sub-edit
    verbs: Vec<String>,
    /// bare-anchor / bracket-(body) / ...
    loc_shapes: Vec<String>,
    /// edit-tool argument schema family
    format: String,
    result_raw: String,
    /// "success" / "fail:..." / etc.
    status: String,
}

#[derive(Deserialize, Default)]
struct EditOp {
    #[serde(default)]
    loc: String,
    #[serde(default)]
    splice: Option<Box<RawValue>>,
    #[serde(default)]
    pre: Option<Box<RawValue>>,
    #[serde(default)]
    post: Option<Box<RawValue>>,
    #[serde(default)]
    sed: Option<Box<RawValue>>,
}

#[derive(Deserialize, Default)]
struct EditArgs {
    #[serde(default)]
    edits: Vec<EditOp>,
    #[serde(default)]
    ops: Vec<Box<RawValue>>,
}

pub fn run(args: Vec<String>) -> Result<()> {
    let mut limit: usize = 1_000;
    let mut workers: usize = 0;
    let mut date_filters: Vec<String> = Vec::new();

    let mut iter = args.into_iter();
    while let Some(a) = iter.next() {
        match a.as_str() {
            "-n" => {
                limit = iter
                    .next()
                    .context("-n requires a value")?
                    .parse()
                    .context("-n value")?;
            }
            "-j" => {
                workers = iter
                    .next()
                    .context("-j requires a value")?
                    .parse()
                    .context("-j value")?;
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: session-stats edits [-n N] [-j workers] [date prefix ...]"
                );
                return Ok(());
            }
            other if other.starts_with('-') => bail!("unknown flag: {other}"),
            other => date_filters.push(other.to_string()),
        }
    }

    let files = collect_sessions(&WalkOpts {
        date_filters,
        limit_most_recent: limit,
    })?;
    eprintln!("scanning {} session files", files.len());

    let mut entries: Vec<EditEntry> = parallel_collect(&files, workers, 5_000, |p| {
        Some(process_file(p))
    })
    .into_iter()
    .flatten()
    .collect();

    // Stable ordering for sample output.
    entries.sort_by(|a, b| a.file.cmp(&b.file));

    report_edits(&entries);
    write_csv(&entries)?;
    Ok(())
}

fn process_file(path: &Path) -> Vec<EditEntry> {
    let f = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("open {}: {e}", path.display());
            return Vec::new();
        }
    };
    let reader = BufReader::with_capacity(64 * 1024, f);
    let path_str = path.to_string_lossy().into_owned();

    let mut calls: HashMap<String, EditEntry> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<RawEvent>(&line) else {
            continue;
        };
        if ev.kind != "message" {
            continue;
        }
        let Some(msg_raw) = ev.message else { continue };
        let Ok(m) = serde_json::from_str::<Message>(msg_raw.get()) else {
            continue;
        };
        let Some(content_raw) = m.content else { continue };
        let items = parse_content(&content_raw);

        match m.role.as_str() {
            "assistant" => {
                for it in items {
                    if it.kind != "toolCall" || !is_edit_tool(&it.name) {
                        continue;
                    }
                    let raw = it.arguments.as_deref();
                    let mut e = classify_edit_args(&it.name, raw);
                    e.file.clone_from(&path_str);
                    e.call_id.clone_from(&it.id);
                    e.tool_name.clone_from(&it.name);
                    let id = it.id.clone();
                    calls.insert(id.clone(), e);
                    order.push(id);
                }
            }
            "toolResult" => {
                if !is_edit_tool(&m.tool_name) {
                    continue;
                }
                let Some(e) = calls.get_mut(&m.tool_call_id) else {
                    continue;
                };
                let text = join_text(&items);
                e.status = classify_edit_result(&text);
                e.result_raw = text;
            }
            _ => {}
        }
    }

    let mut out: Vec<EditEntry> = Vec::with_capacity(order.len());
    for id in order {
        if let Some(e) = calls.remove(&id) {
            out.push(e);
        }
    }
    out
}

fn is_edit_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "edit" | "ast_edit" | "write"
    )
}

// ---- argument classification ----

static ANCHOR_BARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z]?[0-9]+[a-z]{2}$").expect("anchor_bare"));

fn classify_edit_args(name: &str, raw: Option<&RawValue>) -> EditEntry {
    let mut e = EditEntry {
        format: detect_edit_format(name, raw),
        ..EditEntry::default()
    };
    let lname = name.to_ascii_lowercase();
    match lname.as_str() {
        "edit" => {
            let a: EditArgs = raw
                .and_then(|r| serde_json::from_str(r.get()).ok())
                .unwrap_or_default();
            e.num_edits = a.edits.len() as i64;
            for op in &a.edits {
                e.loc_shapes.push(loc_shape(&op.loc));
                let mut verbs: Vec<&str> = Vec::new();
                if !is_null_or_empty(op.splice.as_deref()) {
                    verbs.push("splice");
                }
                if !is_null_or_empty(op.pre.as_deref()) {
                    verbs.push("pre");
                }
                if !is_null_or_empty(op.post.as_deref()) {
                    verbs.push("post");
                }
                if !is_null_or_empty(op.sed.as_deref()) {
                    verbs.push("sed");
                }
                if verbs.is_empty() {
                    verbs.push("none");
                }
                e.verbs.push(verbs.join("+"));
            }
        }
        "ast_edit" => {
            let a: EditArgs = raw
                .and_then(|r| serde_json::from_str(r.get()).ok())
                .unwrap_or_default();
            e.num_edits = a.ops.len() as i64;
        }
        "write" => {
            e.num_edits = 1;
            e.verbs.push("write".to_string());
        }
        _ => {}
    }
    e
}

/// Looks at top-level argument keys (and the first sub-edit for the `edit`
/// tool) to identify which schema is in use. Older sessions used many
/// incompatible schemas.
fn detect_edit_format(name: &str, raw: Option<&RawValue>) -> String {
    match name.to_ascii_lowercase().as_str() {
        "write" => return "write".to_string(),
        "ast_edit" => return "ast_edit".to_string(),
        _ => {}
    }
    let Some(raw) = raw else {
        return "unknown".to_string();
    };
    let top: HashMap<String, Value> = match serde_json::from_str(raw.get()) {
        Ok(v) => v,
        Err(_) => return "unknown".to_string(),
    };
    let has = |k: &str| top.contains_key(k);

    if has("oldText") && has("newText") {
        return "oldText/newText".to_string();
    }
    if has("old_text") && has("new_text") {
        return "old_text/new_text".to_string();
    }
    if has("diff") && has("op") {
        return "diff+op".to_string();
    }
    if has("diff") && has("operation") {
        return "diff+operation".to_string();
    }
    if has("diff") {
        return "diff".to_string();
    }
    if has("replace") || has("insert") {
        return "replace/insert".to_string();
    }

    if let Some(edits_val) = top.get("edits")
        && let Some(arr) = edits_val.as_array()
        && let Some(first) = arr.first().and_then(Value::as_object)
    {
        let fh = |k: &str| first.contains_key(k);
        if fh("loc") && (fh("splice") || fh("pre") || fh("post") || fh("sed")) {
            return "loc+splice/pre/post/sed".to_string();
        }
        if fh("loc") && fh("content") {
            return "loc+content".to_string();
        }
        if fh("set_line") {
            return "set_line".to_string();
        }
        if fh("insert_after") {
            return "insert_after".to_string();
        }
        if fh("op") && fh("pos") && fh("end") && fh("lines") {
            return "op+pos+end+lines".to_string();
        }
        if fh("op") && fh("pos") && fh("lines") {
            return "op+pos+lines".to_string();
        }
        if fh("op") && fh("sel") && fh("content") {
            return "op+sel+content".to_string();
        }
        if fh("all") && (fh("new_text") || fh("old_text")) {
            return "per-edit:old_text/new_text".to_string();
        }
        let mut keys: Vec<&str> = first.keys().map(String::as_str).collect();
        keys.sort_unstable();
        return format!("edits[{}]", keys.join(","));
    }

    let mut keys: Vec<&str> = top.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys.join(",")
}

fn is_null_or_empty(b: Option<&RawValue>) -> bool {
    let Some(b) = b else { return true };
    let s = b.get().trim();
    s.is_empty() || s == "null"
}

fn loc_shape(loc: &str) -> String {
    if loc.is_empty() {
        return "empty".to_string();
    }
    if loc == "$" {
        return "$file".to_string();
    }
    let rest = if let Some(i) = loc.rfind(':')
        && !loc.starts_with('$')
    {
        &loc[i + 1..]
    } else {
        loc
    };
    if rest.starts_with('(') && rest.ends_with(')') {
        return "bracket-(body)".to_string();
    }
    if rest.starts_with('[') && rest.ends_with(']') {
        return "bracket-[block]".to_string();
    }
    if rest.starts_with('(') || rest.starts_with('[') {
        return "bracket-tail".to_string();
    }
    if rest.ends_with(')') || rest.ends_with(']') {
        return "bracket-head".to_string();
    }
    if ANCHOR_BARE.is_match(rest) {
        return "bare-anchor".to_string();
    }
    "other".to_string()
}

// ---- result classification ----

macro_rules! re {
    ($pat:expr) => {
        LazyLock::new(|| Regex::new($pat).expect("compile result regex"))
    };
}

static RE_ANCHOR_STALE: LazyLock<Regex> = re!(
    r"(?i)(Edit rejected:.*line[s]? .* changed since the last read|line[s]? ha(s|ve) changed since last read)"
);
static RE_ANCHOR_MISSING: LazyLock<Regex> =
    re!(r"(?i)anchor .* (not found|unknown|missing)|loc requires the full anchor");
static RE_NO_ENCLOSING: LazyLock<Regex> = re!(r"(?i)No enclosing .* block");
static RE_PARSE_ERROR: LazyLock<Regex> =
    re!(r"(?i)parse|syntax error|unbalanced|unexpected token");
static RE_SSR_NO_MATCH: LazyLock<Regex> = re!(
    r"(?i)0 matches|no replacements|no match found|No replacements made|Failed to find expected lines"
);
static RE_FILE_NOT_READ: LazyLock<Regex> =
    re!(r"(?i)must be read first|has not been read|not yet read");
static RE_FILE_CHANGED: LazyLock<Regex> =
    re!(r"(?i)file has been (modified|changed) externally");
static RE_PERM_DENIED: LazyLock<Regex> = re!(r"(?i)permission denied|not allowed");
static RE_GENERIC_REJECTED: LazyLock<Regex> =
    re!(r"(?i)\b(rejected|failed|error|invalid)\b");
static RE_TRUNCATED: LazyLock<Regex> = re!(r"(?i)\[Output truncated");
static RE_ABORTED: LazyLock<Regex> = re!(
    r"(?i)Tool execution was aborted|Request was aborted|cancelled|canceled by user"
);
static RE_SUCCESS: LazyLock<Regex> = re!(
    r"(?i)^(Updated|Successfully (wrote|replaced|edited|deleted|inserted)|Replaced|Applied|Deleted|Created|Wrote|edit applied|Edited|Inserted|OK\b)"
);

fn classify_edit_result(text: &str) -> String {
    let t = text.trim();
    if t.is_empty() {
        return "empty".to_string();
    }
    let first = t.split_once('\n').map_or(t, |(a, _)| a);

    if RE_TRUNCATED.is_match(first) {
        return "truncated".to_string();
    }
    if RE_ABORTED.is_match(t) {
        return "aborted".to_string();
    }
    if RE_SUCCESS.is_match(first) {
        return "success".to_string();
    }
    if RE_ANCHOR_STALE.is_match(t) {
        return "fail:anchor-stale".to_string();
    }
    if RE_NO_ENCLOSING.is_match(t) {
        return "fail:no-enclosing-block".to_string();
    }
    if RE_ANCHOR_MISSING.is_match(t) {
        return "fail:anchor-missing".to_string();
    }
    if RE_PARSE_ERROR.is_match(t) {
        return "fail:parse".to_string();
    }
    if RE_SSR_NO_MATCH.is_match(t) {
        return "fail:no-match".to_string();
    }
    if RE_FILE_NOT_READ.is_match(t) {
        return "fail:file-not-read".to_string();
    }
    if RE_FILE_CHANGED.is_match(t) {
        return "fail:file-changed".to_string();
    }
    if RE_PERM_DENIED.is_match(t) {
        return "fail:perm".to_string();
    }
    if RE_GENERIC_REJECTED.is_match(first) {
        return "fail:other".to_string();
    }
    "unknown".to_string()
}

// ---- reporting ----

fn report_edits(entries: &[EditEntry]) {
    if entries.is_empty() {
        println!("no edit-family tool calls found in matched sessions");
        return;
    }

    let mut by_tool: HashMap<String, i64> = HashMap::new();
    let mut by_format: HashMap<String, i64> = HashMap::new();
    let mut status_by_format: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut status_by_tool: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut verb_count: HashMap<String, i64> = HashMap::new();
    let mut loc_count: HashMap<String, i64> = HashMap::new();
    let mut fails_by_verb: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut fails_by_loc: HashMap<String, HashMap<String, i64>> = HashMap::new();

    for e in entries {
        *by_tool.entry(e.tool_name.clone()).or_insert(0) += 1;
        *status_by_tool
            .entry(e.tool_name.clone())
            .or_default()
            .entry(e.status.clone())
            .or_insert(0) += 1;
        *by_format.entry(e.format.clone()).or_insert(0) += 1;
        *status_by_format
            .entry(e.format.clone())
            .or_default()
            .entry(e.status.clone())
            .or_insert(0) += 1;
        for v in &e.verbs {
            *verb_count.entry(v.clone()).or_insert(0) += 1;
            *fails_by_verb
                .entry(v.clone())
                .or_default()
                .entry(e.status.clone())
                .or_insert(0) += 1;
        }
        for l in &e.loc_shapes {
            *loc_count.entry(l.clone()).or_insert(0) += 1;
            *fails_by_loc
                .entry(l.clone())
                .or_default()
                .entry(e.status.clone())
                .or_insert(0) += 1;
        }
    }

    println!("# Edit-tool usage");
    println!(
        "\nTotal tool calls: {} (across {} sessions)",
        entries.len(),
        count_edit_sessions(entries)
    );

    println!("\n## By tool");
    print_sorted(&by_tool);

    println!("\n## Outcome by tool");
    let mut tools: Vec<&String> = by_tool.keys().collect();
    tools.sort();
    for t in tools {
        println!("\n  {t} ({} calls):", by_tool[t.as_str()]);
        if let Some(m) = status_by_tool.get(t.as_str()) {
            print_sorted_indent(m, "    ");
        }
    }

    println!("\n## edit verb distribution (per sub-edit)");
    print_sorted(&verb_count);

    println!("\n## edit locator shape distribution");
    print_sorted(&loc_count);

    println!("\n## Failure rate per verb shape");
    for v in sorted_by_count(&verb_count) {
        let (total, failed) = fail_totals(fails_by_verb.get(v.as_str()));
        println!(
            "  {v:<20} {failed}/{total} failed ({:.0}%)",
            pct(failed, total)
        );
    }

    println!("\n## Failure rate per locator shape");
    for l in sorted_by_count(&loc_count) {
        let (total, failed) = fail_totals(fails_by_loc.get(l.as_str()));
        println!(
            "  {l:<20} {failed}/{total} failed ({:.0}%)",
            pct(failed, total)
        );
    }

    println!("\n## edit-tool argument-format usage");
    print_sorted(&by_format);

    println!("\n## Failure rate per argument format");
    for fname in sorted_by_count(&by_format) {
        let (total, failed) = fail_totals(status_by_format.get(fname.as_str()));
        println!(
            "  {fname:<32} {failed:>6}/{total:<6} failed ({:.0}%)",
            pct(failed, total)
        );
    }

    println!("\n## Failure breakdown per top format");
    for fname in sorted_by_count(&by_format).into_iter().take(8) {
        println!("\n  {fname} ({} total)", by_format[fname.as_str()]);
        if let Some(m) = status_by_format.get(fname.as_str()) {
            print_sorted_indent(m, "    ");
        }
    }

    println!("\n## Sample failed edits");
    let mut shown = 0;
    for e in entries {
        if !e.status.starts_with("fail") {
            continue;
        }
        let first = e
            .result_raw
            .split_once("\n\n")
            .map_or(e.result_raw.as_str(), |(a, _)| a);
        println!(
            "\n— {} [{}] verbs={:?} loc={:?}\n  result: {}",
            e.tool_name,
            e.status,
            e.verbs,
            e.loc_shapes,
            truncate_line(first, 220)
        );
        shown += 1;
        if shown >= 8 {
            break;
        }
    }
}

fn fail_totals(m: Option<&HashMap<String, i64>>) -> (i64, i64) {
    let Some(m) = m else { return (0, 0) };
    let mut total = 0i64;
    let mut failed = 0i64;
    for (status, n) in m {
        total += n;
        if status.starts_with("fail") {
            failed += n;
        }
    }
    (total, failed)
}

fn count_edit_sessions(entries: &[EditEntry]) -> usize {
    let mut s: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for e in entries {
        s.insert(&e.file);
    }
    s.len()
}

fn write_csv(entries: &[EditEntry]) -> Result<()> {
    let path = std::env::var("EDIT_ANALYSIS_CSV").unwrap_or_else(|_| "edit-analysis.csv".to_string());
    let f = File::create(&path).with_context(|| format!("create {path}"))?;
    let mut w = csv::Writer::from_writer(f);
    w.write_record([
        "session",
        "tool",
        "status",
        "num_edits",
        "verbs",
        "loc_shapes",
        "result_first_line",
    ])?;
    for e in entries {
        let first = e
            .result_raw
            .split_once('\n')
            .map_or(e.result_raw.as_str(), |(a, _)| a);
        let session = Path::new(&e.file)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&e.file);
        w.write_record([
            session,
            &e.tool_name,
            &e.status,
            &e.num_edits.to_string(),
            &e.verbs.join(","),
            &e.loc_shapes.join(","),
            &truncate_line(first, 200),
        ])?;
    }
    w.flush()?;
    Ok(())
}
