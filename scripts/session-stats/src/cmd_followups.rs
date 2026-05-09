//! `followups` subcommand — heuristic for buggy hashline edits.
//!
//! Premise: when a hashline `edit` introduces a duplicate `}`, drops a line,
//! or otherwise breaks adjacent context, the next thing the agent does is
//! usually a tiny corrective edit on the same file. So we flag, per session,
//! pairs of edits where:
//!
//!   - both are hashline `edit` toolCalls (input begins with a `@PATH`),
//!   - both target the same file,
//!   - the FIRST edit succeeded,
//!   - the SECOND edit is small (<= --max-fix lines changed, default 2),
//!   - the second edit is the next edit (in the same session) on that file,
//!     and there is no other edit in between (so retries-after-failure are
//!     not counted).
//!
//! For each hit we classify the small follow-up's pattern: adds a single
//! closing brace/paren/bracket, removes one (likely duplicate), pure single
//! insert, pure single delete, or one-line tweak.

use crate::common::*;
use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::LazyLock;

// ---- parsed shapes --------------------------------------------------------

#[derive(Clone, Default)]
struct EditSection {
    file: String,
    payload_lines: Vec<String>,
    /// Payload lines grouped by op. Each inner vec is one op's payload (`+`,
    /// `<`, or `=` followed by `~TEXT` lines), in source order. Used to detect
    /// intra-block self-similarity (model duplicating an N-line chunk).
    payload_blocks: Vec<Vec<String>>,
    /// Raw anchor refs (`123ab`) from ops in this section, in source order.
    /// Used to detect the same anchor being referenced by multiple ops in the
    /// same call.
    op_anchors: Vec<String>,
    /// Total line count covered by `- A..B` and `= A..B` ranges (range size).
    deleted_lines: i64,
    op_count: i64,
    /// Min/max anchor line touched by ops in this section. `None` for a
    /// section whose only ops target BOF/EOF (no concrete line).
    min_line: Option<i64>,
    max_line: Option<i64>,
}

impl EditSection {
    fn change_size(&self) -> i64 {
        self.payload_lines.len() as i64 + self.deleted_lines
    }
    fn touch(&mut self, line: i64) {
        self.min_line = Some(self.min_line.map_or(line, |m| m.min(line)));
        self.max_line = Some(self.max_line.map_or(line, |m| m.max(line)));
    }
}

#[derive(Clone)]
struct EditCall {
    ts: i64,
    call_id: String,
    sections: Vec<EditSection>,
    success: bool,
    raw_input_len: usize,
    /// Tool-emitted warnings extracted from a successful result text. Each
    /// entry is one of `auto-rebased` / `auto-absorbed` / `auto-dropped`.
    warnings: Vec<&'static str>,
}

#[derive(Deserialize, Default)]
struct EditArgs {
    #[serde(default)]
    input: Option<String>,
}

// ---- per-section parsing --------------------------------------------------

// Op headers. We parse loosely: anything that doesn't match a known op or a
// `~` payload line is ignored (blank line, comment, etc.).
//
// Range sizes: `LINEhash..LINEhash` -> end_line - start_line + 1 (clamped to
// >= 1). For single-anchor `- A` we count 1.
static RANGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)[a-z*]+(?:\.\.(\d+)[a-z*]+)?\s*$").expect("RANGE_RE"));
static SINGLE_ANCHOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)[a-z*]+\s*$").expect("SINGLE_ANCHOR_RE"));

/// Returns (range_size, optional (start_line, end_line)). Size is at least 1.
fn parse_range(raw: &str) -> (i64, Option<(i64, i64)>) {
    let Some(caps) = RANGE_RE.captures(raw.trim()) else {
        return (1, None);
    };
    let start: i64 = caps.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    let end: i64 = caps
        .get(2)
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(start);
    let size = (end - start + 1).max(1);
    let lines = if start > 0 { Some((start, end.max(start))) } else { None };
    (size, lines)
}

fn parse_anchor_line(raw: &str) -> Option<i64> {
    let caps = SINGLE_ANCHOR_RE.captures(raw.trim())?;
    caps.get(1)?.as_str().parse().ok()
}

/// Parses a single hashline `input` arg into per-file sections. Returns an
/// empty vec if the input doesn't begin with `@PATH` (vim-mode edits etc.).
fn parse_hashline_input(input: &str) -> Vec<EditSection> {
    let mut sections: Vec<EditSection> = Vec::new();
    let mut cur: Option<EditSection> = None;
    // Index of the currently-open payload block in cur.payload_blocks, or
    // `None` if no op is awaiting payload.
    let mut open_block: Option<usize> = None;

    fn open_new_block(s: &mut EditSection, open_block: &mut Option<usize>) {
        s.payload_blocks.push(Vec::new());
        *open_block = Some(s.payload_blocks.len() - 1);
    }
    fn close_block(open_block: &mut Option<usize>) {
        *open_block = None;
    }

    for raw_line in input.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        // File header: `@<path>`. Always starts a new section.
        if let Some(rest) = line.strip_prefix('@') {
            if let Some(s) = cur.take() {
                sections.push(s);
            }
            cur = Some(EditSection { file: rest.trim().to_string(), ..Default::default() });
            open_block = None;
            continue;
        }

        let Some(s) = cur.as_mut() else {
            // Stray content before any `@PATH` — not a hashline input.
            continue;
        };

        // Payload lines (`~...`) belong to whatever op was last opened.
        if let Some(payload) = line.strip_prefix('~') {
            s.payload_lines.push(payload.to_string());
            if open_block.is_none() {
                open_new_block(s, &mut open_block);
            }
            if let Some(idx) = open_block {
                s.payload_blocks[idx].push(payload.to_string());
            }
            continue;
        }

        let trimmed = line.trim_start();
        let op_byte = trimmed.as_bytes().first().copied();
        match op_byte {
            Some(b'+') | Some(b'<') => {
                let body = trimmed[1..].trim_start();
                let (anchor_part, tail) = match body.split_once('~') {
                    Some((a, t)) => (a, Some(t)),
                    None => (body, None),
                };
                let anchor_trimmed = anchor_part.trim();
                if !anchor_trimmed.is_empty() && anchor_trimmed != "BOF" && anchor_trimmed != "EOF" {
                    s.op_anchors.push(anchor_trimmed.to_string());
                }
                if let Some(line) = parse_anchor_line(anchor_part) {
                    s.touch(line);
                }
                if let Some(tail) = tail {
                    // Inline `+ ANCHOR~text`: replaces a single line; not a
                    // payload-collecting op.
                    s.payload_lines.push(tail.to_string());
                    s.deleted_lines += 1;
                    close_block(&mut open_block);
                } else {
                    open_new_block(s, &mut open_block);
                }
                s.op_count += 1;
            }
            Some(b'-') | Some(b'=') => {
                let body = trimmed[1..].trim_start();
                let (size, lines) = parse_range(body);
                s.deleted_lines += size;
                if let Some((lo, hi)) = lines {
                    s.touch(lo);
                    s.touch(hi);
                }
                // Collect raw anchor refs (`A` or `A..B`) for dup detection.
                for part in body.trim().split("..") {
                    let t = part.trim();
                    if !t.is_empty() {
                        s.op_anchors.push(t.to_string());
                    }
                }
                s.op_count += 1;
                if op_byte == Some(b'=') {
                    open_new_block(s, &mut open_block);
                } else {
                    close_block(&mut open_block);
                }
            }
            _ => {
                // blank / unrecognized — leave payload state alone.
            }
        }
    }

    if let Some(s) = cur.take() {
        sections.push(s);
    }
    sections
}

// ---- success classification ----------------------------------------------

static RE_FAILURE_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(edit rejected|error\b|failed\b|invalid\b|unrecognized\b|cannot\b|no enclosing|file has been (modified|changed)|file has not been read|permission denied|tool execution was aborted|request was aborted|cancelled|canceled|line \d+:|expected|unexpected|patch failed|no replacements|0 matches)",
    )
    .expect("RE_FAILURE_HEAD")
});

fn looks_successful(text: &str) -> bool {
    let head = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    if head.is_empty() {
        return false;
    }
    !RE_FAILURE_HEAD.is_match(head.trim_start())
}

fn extract_warnings(text: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("Auto-rebased anchor") {
            out.push("auto-rebased");
        } else if t.starts_with("Auto-absorbed") {
            out.push("auto-absorbed");
        } else if t.starts_with("Auto-dropped") {
            out.push("auto-dropped");
        }
    }
    out
}

// ---- followup pattern classification -------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum FixPattern {
    AddSingleCloser,    // payload contains exactly one line that's pure }/]/)
    RemoveSingleCloser, // single delete of a pure }/]/) line
    PureInsertOneLine,
    PureDeleteOneLine,
    OneLineModify,
    SmallOther,
}

impl FixPattern {
    fn label(&self) -> &'static str {
        match self {
            FixPattern::AddSingleCloser => "add-single-closer",
            FixPattern::RemoveSingleCloser => "remove-single-closer",
            FixPattern::PureInsertOneLine => "pure-insert-1",
            FixPattern::PureDeleteOneLine => "pure-delete-1",
            FixPattern::OneLineModify => "one-line-modify",
            FixPattern::SmallOther => "small-other",
        }
    }
}

fn pattern_priority(p: FixPattern) -> u8 {
    match p {
        FixPattern::RemoveSingleCloser => 0,
        FixPattern::AddSingleCloser => 1,
        FixPattern::OneLineModify => 2,
        FixPattern::PureDeleteOneLine => 3,
        FixPattern::PureInsertOneLine => 4,
        FixPattern::SmallOther => 5,
    }
}

static CLOSER_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[\])}]+[;,]?\s*$").expect("CLOSER_LINE_RE"));

fn classify_fix(section: &EditSection) -> FixPattern {
    let payload = &section.payload_lines;
    let deleted = section.deleted_lines;
    let payload_is_one_closer = payload.len() == 1 && CLOSER_LINE_RE.is_match(&payload[0]);

    if deleted == 0 && payload_is_one_closer {
        return FixPattern::AddSingleCloser;
    }
    if deleted == 1 && payload.is_empty() {
        // We don't have the deleted line text, but a single-line delete on a
        // sub-1KB follow-up is overwhelmingly the "drop duplicate brace" case
        // when paired with the immediately-prior big edit. Mark it so;
        // false-positives are easy to triage by hand.
        return FixPattern::RemoveSingleCloser;
    }
    if deleted == 0 && payload.len() == 1 {
        return FixPattern::PureInsertOneLine;
    }
    if deleted == 1 && payload.len() == 1 {
        return FixPattern::OneLineModify;
    }
    if deleted >= 1 && payload.is_empty() {
        return FixPattern::PureDeleteOneLine;
    }
    FixPattern::SmallOther
}

// ---- per-file scanning ---------------------------------------------------

#[derive(Clone)]
struct Hit {
    session: String,
    file: String,
    first_call_id: String,
    second_call_id: String,
    first_size: i64,
    first_input_len: usize,
    second_size: i64,
    pattern: FixPattern,
    second_summary: String,
    gap_secs: i64,
}

/// A successful edit whose result text contained a tool self-correction.
#[derive(Clone)]
struct WarningHit {
    session: String,
    call_id: String,
    kind: &'static str, // auto-rebased / auto-absorbed / auto-dropped
    files: String,      // comma-joined section files
    input_len: usize,
}

/// Two consecutive successful edits on the same file whose anchor line
/// ranges overlap (or one is contained in the other). Catches "agent
/// re-edited the same locus" cases that the small-fix detector misses.
#[derive(Clone)]
struct LocusHit {
    session: String,
    file: String,
    first_call_id: String,
    second_call_id: String,
    first_range: (i64, i64),
    second_range: (i64, i64),
    first_size: i64,
    second_size: i64,
    gap_secs: i64,
}

/// A single hashline edit whose payload contains a contiguous N-line sequence
/// that repeats inside the same payload block. Strong signal of "model pasted
/// the same chunk twice" when N is large.
#[derive(Clone)]
struct PayloadDupHit {
    session: String,
    call_id: String,
    file: String,
    block_len: usize,
    repeat_len: usize,
    sample: String,
}

/// A single hashline edit that referenced the same anchor (e.g. `123ab`) from
/// two or more distinct ops. Often benign (insert before + insert after at
/// the same line), occasionally indicates a duplicated op in the input.
#[derive(Clone)]
struct AnchorDupHit {
    session: String,
    call_id: String,
    files: String,
    anchor: String,
    count: usize,
}

#[derive(Default)]
struct FileReport {
    fix_hits: Vec<Hit>,
    warning_hits: Vec<WarningHit>,
    locus_hits: Vec<LocusHit>,
    payload_dups: Vec<PayloadDupHit>,
    anchor_dups: Vec<AnchorDupHit>,
    /// Total number of successful hashline edits scanned.
    total_successful_edits: i64,
}

/// Find the longest contiguous N-line sequence in `block` that occurs at two
/// distinct positions. Returns `(first_index, repeat_len)` if a match of at
/// least `min_len` lines exists with at least half its lines being
/// non-trivial (>= 4 chars after trim) — this filters out e.g. five repeated
/// `}` lines as boilerplate.
fn find_longest_repeat(block: &[String], min_len: usize) -> Option<(usize, usize)> {
    let n = block.len();
    if n < 2 * min_len {
        return None;
    }
    let mut best: Option<(usize, usize)> = None;
    for i in 0..n.saturating_sub(min_len) {
        for j in (i + min_len)..=n.saturating_sub(min_len) {
            let mut k = 0;
            while i + k < j && j + k < n && block[i + k] == block[j + k] {
                k += 1;
            }
            if k < min_len {
                continue;
            }
            let meaningful = block[i..i + k]
                .iter()
                .filter(|s| s.trim().len() >= 4)
                .count();
            if meaningful < (k.div_ceil(2)).max(2) {
                continue;
            }
            if best.is_none_or(|(_, bk)| k > bk) {
                best = Some((i, k));
            }
        }
    }
    best
}

/// Returns the set of `(anchor, count, file)` pairs where the same raw
/// anchor was referenced by `count >= 2` distinct ops within ONE section
/// (i.e. on one file). Two files happening to have the same `LINE+hash`
/// anchor is a coincidence (2-char hashes collide), not a duplicate op.
/// Skips `BOF` / `EOF` and any anchor with a `*` interior-hash.
fn duplicated_anchors(sections: &[EditSection]) -> Vec<(String, usize, String)> {
    let mut out: Vec<(String, usize, String)> = Vec::new();
    for sec in sections {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for a in &sec.op_anchors {
            if a == "BOF" || a == "EOF" || a.contains('*') {
                continue;
            }
            *counts.entry(a.as_str()).or_default() += 1;
        }
        for (anchor, c) in counts {
            if c >= 2 {
                out.push((anchor.to_string(), c, sec.file.clone()));
            }
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

fn process_file(path: &Path, max_fix: i64) -> FileReport {
    let f = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("open {}: {e}", path.display());
            return FileReport::default();
        }
    };
    let reader = BufReader::with_capacity(64 * 1024, f);
    let session = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // Walk message events in order. For each toolCall name=="edit", parse the
    // input. Pair with its toolResult by callId. Keep the chronological list
    // of EditCall records.
    let mut pending: HashMap<String, EditCall> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut calls: HashMap<String, EditCall> = HashMap::new();

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
                    if it.kind != "toolCall" || it.name != "edit" {
                        continue;
                    }
                    let raw = it.arguments.as_deref();
                    let Some(raw) = raw else { continue };
                    let Ok(args) = serde_json::from_str::<EditArgs>(raw.get()) else {
                        continue;
                    };
                    let Some(input) = args.input else { continue };
                    if !input.trim_start().starts_with('@') {
                        // Vim-mode edit or other shape — skip.
                        continue;
                    }
                    let sections = parse_hashline_input(&input);
                    if sections.is_empty() {
                        continue;
                    }
                    let call = EditCall {
                        ts: parse_ts(&ev.timestamp),
                        call_id: it.id.clone(),
                        sections,
                        success: false, // filled in by toolResult
                        raw_input_len: input.len(),
                        warnings: Vec::new(),
                    };
                    pending.insert(it.id.clone(), call);
                }
            }
            "toolResult" => {
                if m.tool_name != "edit" {
                    continue;
                }
                let Some(mut call) = pending.remove(&m.tool_call_id) else {
                    continue;
                };
                let text = join_text(&items);
                call.success = looks_successful(&text);
                if call.success {
                    call.warnings = extract_warnings(&text);
                }
                let id = call.call_id.clone();
                calls.insert(id.clone(), call);
                order.push(id);
            }
            _ => {}
        }
    }

    // Build per-file edit sequences. A single call can touch multiple files
    // (multi-section input); we record an entry per (call, section).
    struct Entry<'a> {
        section: &'a EditSection,
        call: &'a EditCall,
    }
    let mut by_file: HashMap<&str, Vec<Entry>> = HashMap::new();
    for id in &order {
        let Some(call) = calls.get(id) else { continue };
        for sec in &call.sections {
            by_file
                .entry(sec.file.as_str())
                .or_default()
                .push(Entry { section: sec, call });
        }
    }

    let mut report = FileReport::default();
    for call in calls.values() {
        if call.success {
            report.total_successful_edits += 1;
        }
        if !call.warnings.is_empty() {
            // Dedup per kind so a call with two `Auto-rebased` lines counts once.
            let mut seen: Vec<&'static str> = Vec::new();
            for w in &call.warnings {
                if !seen.contains(w) {
                    seen.push(*w);
                }
            }
            let files: Vec<String> = call.sections.iter().map(|s| s.file.clone()).collect();
            for kind in seen {
                report.warning_hits.push(WarningHit {
                    session: session.clone(),
                    call_id: call.call_id.clone(),
                    kind,
                    files: files.join(","),
                    input_len: call.raw_input_len,
                });
            }
        }

        // Only flag detectors on edits that actually applied. Failed edits
        // are handled separately and their input is moot.
        if call.success {
            // Payload self-dup: per section, per block. Threshold is
            // intentionally permissive (>=4) — caller filters by repeat_len.
            for sec in &call.sections {
                for block in &sec.payload_blocks {
                    if let Some((start, len)) = find_longest_repeat(block, 4) {
                        let sample = truncate_line(block.get(start).map(String::as_str).unwrap_or(""), 80);
                        report.payload_dups.push(PayloadDupHit {
                            session: session.clone(),
                            call_id: call.call_id.clone(),
                            file: sec.file.clone(),
                            block_len: block.len(),
                            repeat_len: len,
                            sample,
                        });
                    }
                }
            }

            // Anchor dup within a single section's ops.
            for (anchor, count, file) in duplicated_anchors(&call.sections) {
                report.anchor_dups.push(AnchorDupHit {
                    session: session.clone(),
                    call_id: call.call_id.clone(),
                    files: file,
                    anchor,
                    count,
                });
            }
        }
    }

    for (file, entries) in by_file {
        for window in entries.windows(2) {
            let a = &window[0];
            let b = &window[1];
            if !a.call.success || !b.call.success {
                continue;
            }
            if a.call.call_id == b.call.call_id {
                continue;
            }
            let first_size = a.section.change_size();
            let second_size = b.section.change_size();
            let gap = (b.call.ts - a.call.ts).max(0);

            // (1) Small-fix follow-up.
            if second_size > 0 && second_size <= max_fix && first_size > 2 {
                let pattern = classify_fix(b.section);
                let summary = render_section_summary(b.section);
                report.fix_hits.push(Hit {
                    session: session.clone(),
                    file: file.to_string(),
                    first_call_id: a.call.call_id.clone(),
                    second_call_id: b.call.call_id.clone(),
                    first_size,
                    first_input_len: a.call.raw_input_len,
                    second_size,
                    pattern,
                    second_summary: summary,
                    gap_secs: gap,
                });
            }

            // (2) Same-locus re-edit. Skip when both are tiny (those are
            // already noisy) and skip when the small-fix branch already
            // fired (we don't want to double-count).
            if first_size > 2 && second_size > max_fix {
                if let (Some(a_lo), Some(a_hi), Some(b_lo), Some(b_hi)) = (
                    a.section.min_line,
                    a.section.max_line,
                    b.section.min_line,
                    b.section.max_line,
                ) {
                    let overlap_lo = a_lo.max(b_lo);
                    let overlap_hi = a_hi.min(b_hi);
                    if overlap_lo <= overlap_hi {
                        report.locus_hits.push(LocusHit {
                            session: session.clone(),
                            file: file.to_string(),
                            first_call_id: a.call.call_id.clone(),
                            second_call_id: b.call.call_id.clone(),
                            first_range: (a_lo, a_hi),
                            second_range: (b_lo, b_hi),
                            first_size,
                            second_size,
                            gap_secs: gap,
                        });
                    }
                }
            }
        }
    }
    report
}

fn render_section_summary(section: &EditSection) -> String {
    let mut bits: Vec<String> = Vec::new();
    if section.deleted_lines > 0 {
        bits.push(format!("-{}", section.deleted_lines));
    }
    if !section.payload_lines.is_empty() {
        bits.push(format!("+{}", section.payload_lines.len()));
    }
    let mut out = bits.join(" / ");
    if !section.payload_lines.is_empty() {
        let preview = truncate_line(&section.payload_lines[0], 80);
        out.push_str(&format!("  | {preview}"));
    }
    out
}

// ---- entry point ---------------------------------------------------------

pub fn run(args: Vec<String>) -> Result<()> {
    let mut limit: usize = 200;
    let mut workers: usize = 0;
    let mut max_fix: i64 = 2;
    let mut show: usize = 60;
    let mut max_gap: i64 = 0;
    let mut pattern_filter: Option<String> = None;
    let mut min_dup: usize = 8;

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
            "--max-fix" => {
                max_fix = iter
                    .next()
                    .context("--max-fix requires a value")?
                    .parse()
                    .context("--max-fix value")?;
            }
            "--show" => {
                show = iter
                    .next()
                    .context("--show requires a value")?
                    .parse()
                    .context("--show value")?;
            }
            "--max-gap" => {
                max_gap = iter
                    .next()
                    .context("--max-gap requires seconds")?
                    .parse()
                    .context("--max-gap value")?;
            }
            "--pattern" => {
                pattern_filter = Some(iter.next().context("--pattern requires a name")?);
            }
            "--min-dup" => {
                min_dup = iter
                    .next()
                    .context("--min-dup requires a value")?
                    .parse()
                    .context("--min-dup value")?;
            }
            "-h" | "--help" => {
                eprintln!(
                    "usage: session-stats followups [-n N] [-j workers] [--max-fix N] [--max-gap S]
                                [--min-dup K] [--pattern NAME] [--show N]

Five detectors over hashline `edit` calls in the most-recent N sessions:

  1. small-fix follow-ups
     consecutive successful edits on the same file where the follow-up
     changes <= --max-fix lines (default 2). The first edit must be > 2
     lines. Brace-related patterns surface first (remove-single-closer,
     add-single-closer). --max-gap caps elapsed seconds between the pair.

  2. tool self-corrections
     warning lines emitted by the tool on otherwise-successful edits:
     auto-rebased, auto-absorbed, auto-dropped. These are direct evidence
     of the model writing stale anchors or duplicating adjacent context.

  3. same-locus re-edits
     two consecutive edits on the same file whose anchor line ranges
     overlap, where both edits are > --max-fix lines (so they're not
     already in (1)).

  4. payload self-duplication
     within one payload block, a contiguous K-line sequence appears at two
     positions. K threshold via --min-dup (default 8).

  5. same-anchor reuse
     two or more ops in the same section reference the same `LINE+hash`
     anchor.

--pattern NAME filters (1) to a single FixPattern label."
                );
                return Ok(());
            }
            other => bail!("unknown flag: {other}"),
        }
    }

    let files = collect_sessions(&WalkOpts {
        date_filters: Vec::new(),
        limit_most_recent: limit,
    })?;
    eprintln!("scanning {} session files", files.len());

    let max_fix_local = max_fix;
    let reports: Vec<FileReport> = parallel_collect(&files, workers, 5_000, |p| {
        let r = process_file(p, max_fix_local);
        let empty = r.fix_hits.is_empty() && r.warning_hits.is_empty() && r.locus_hits.is_empty()
            && r.total_successful_edits == 0;
        if empty { None } else { Some(r) }
    });

    let mut hits: Vec<Hit> = Vec::new();
    let mut warning_hits: Vec<WarningHit> = Vec::new();
    let mut locus_hits: Vec<LocusHit> = Vec::new();
    let mut payload_dups: Vec<PayloadDupHit> = Vec::new();
    let mut anchor_dups: Vec<AnchorDupHit> = Vec::new();
    let mut total_successful_edits: i64 = 0;
    for r in reports {
        hits.extend(r.fix_hits);
        warning_hits.extend(r.warning_hits);
        locus_hits.extend(r.locus_hits);
        payload_dups.extend(r.payload_dups);
        anchor_dups.extend(r.anchor_dups);
        total_successful_edits += r.total_successful_edits;
    }

    if max_gap > 0 {
        hits.retain(|h| h.gap_secs <= max_gap);
        locus_hits.retain(|h| h.gap_secs <= max_gap);
    }
    if let Some(ref name) = pattern_filter {
        hits.retain(|h| h.pattern.label() == name);
    }
    hits.sort_by(|a, b| {
        pattern_priority(a.pattern)
            .cmp(&pattern_priority(b.pattern))
            .then_with(|| b.first_input_len.cmp(&a.first_input_len))
    });
    locus_hits.sort_by(|a, b| b.first_size.cmp(&a.first_size));

    let mut by_pattern: HashMap<&'static str, i64> = HashMap::new();
    for h in &hits {
        *by_pattern.entry(h.pattern.label()).or_default() += 1;
    }

    println!("=== heuristic followup hits ===");
    println!("total hits: {}", commas(hits.len() as i64));
    println!();
    println!("by pattern:");
    let mut pats: Vec<(&&str, &i64)> = by_pattern.iter().collect();
    pats.sort_by(|a, b| b.1.cmp(a.1));
    for (label, n) in pats {
        println!("  {:<22} {:>6}", label, commas(*n));
    }
    println!();

    let shown = show.min(hits.len());
    println!("=== top {shown} hits (by first-edit input size) ===");
    for h in hits.iter().take(shown) {
        println!(
            "[{pat}] {file}  first={first_size}L ({first_len}B) → second={second_size}L  gap={gap}s",
            pat = h.pattern.label(),
            file = h.file,
            first_size = h.first_size,
            first_len = h.first_input_len,
            second_size = h.second_size,
            gap = h.gap_secs,
        );
        println!("        session={}", h.session);
        println!("        first_call={} second_call={}", h.first_call_id, h.second_call_id);
        println!("        fix: {}", h.second_summary);
    }
    println!();
    println!("=== tool self-corrections ===");
    println!("(emitted as warnings on otherwise-successful edits — the tool caught what the model wrote)");
    let mut warn_by_kind: HashMap<&'static str, i64> = HashMap::new();
    for w in &warning_hits {
        *warn_by_kind.entry(w.kind).or_default() += 1;
    }
    let mut warn_kinds: Vec<(&&str, &i64)> = warn_by_kind.iter().collect();
    warn_kinds.sort_by(|a, b| b.1.cmp(a.1));
    let pct_of = |n: i64| -> String {
        if total_successful_edits == 0 {
            String::new()
        } else {
            format!(" ({:.2}% of {} successful edits)", pct(n, total_successful_edits), commas(total_successful_edits))
        }
    };
    for (kind, n) in warn_kinds {
        println!("  {:<16} {:>6}{}", kind, commas(*n), pct_of(*n));
    }
    let warn_show = show.min(warning_hits.len());
    if warn_show > 0 {
        println!();
        println!("--- top {warn_show} self-correction examples (by input size) ---");
        let mut sorted_warns = warning_hits.clone();
        sorted_warns.sort_by(|a, b| b.input_len.cmp(&a.input_len));
        for w in sorted_warns.iter().take(warn_show) {
            println!(
                "[{kind}] {files}  ({len}B)",
                kind = w.kind,
                files = truncate_line(&w.files, 80),
                len = w.input_len,
            );
            println!("        session={} call={}", w.session, w.call_id);
        }
    }

    println!();
    println!("=== same-locus re-edits (overlapping anchor ranges, both > max-fix) ===");
    println!("hits: {}", commas(locus_hits.len() as i64));
    let locus_show = show.min(locus_hits.len());
    for h in locus_hits.iter().take(locus_show) {
        println!(
            "{file}  first={a0}..{a1} ({fs}L) → second={b0}..{b1} ({ss}L)  gap={gap}s",
            file = h.file,
            a0 = h.first_range.0,
            a1 = h.first_range.1,
            fs = h.first_size,
            b0 = h.second_range.0,
            b1 = h.second_range.1,
            ss = h.second_size,
            gap = h.gap_secs,
        );
        println!("        session={}", h.session);
        println!("        first_call={} second_call={}", h.first_call_id, h.second_call_id);
    }

    println!();
    println!("=== payload self-duplication (model pasted same N-line chunk twice in one payload) ===");
    payload_dups.retain(|p| p.repeat_len >= min_dup);
    payload_dups.sort_by(|a, b| b.repeat_len.cmp(&a.repeat_len));
    println!(
        "hits with repeat_len >= {}: {} ({:.2}% of {} successful edits)",
        min_dup,
        commas(payload_dups.len() as i64),
        pct(payload_dups.len() as i64, total_successful_edits),
        commas(total_successful_edits)
    );
    let dup_show = show.min(payload_dups.len());
    for p in payload_dups.iter().take(dup_show) {
        println!(
            "k={k} block={blk}L  {file}",
            k = p.repeat_len,
            blk = p.block_len,
            file = p.file,
        );
        println!("        session={} call={}", p.session, p.call_id);
        println!("        sample: {}", p.sample);
    }

    println!();
    println!("=== same-anchor reused by multiple ops in one input ===");
    anchor_dups.sort_by(|a, b| b.count.cmp(&a.count));
    println!("hits: {}", commas(anchor_dups.len() as i64));
    let anchor_show = show.min(anchor_dups.len());
    for a in anchor_dups.iter().take(anchor_show) {
        println!(
            "anchor {anchor} referenced {n}x  files={files}",
            anchor = a.anchor,
            n = a.count,
            files = truncate_line(&a.files, 80),
        );
        println!("        session={} call={}", a.session, a.call_id);
    }

    Ok(())
}
