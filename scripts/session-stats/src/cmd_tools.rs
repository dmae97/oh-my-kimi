//! `tools` subcommand — per-tool token totals across the most-recent N session
//! jsonl files.
//!
//! Token counting uses o200k_base via tiktoken-rs (the GPT-4o / GPT-5 family
//! tokenizer). It is not Claude's own BPE, but it is well-defined offline and
//! within ~5-10% across English/code in aggregate.
//!
//! Buckets:
//!   tool ARGS          — assistant tool-call argument JSON
//!   tool RESULTS       — tool result content text
//!   assistant THINKING — assistant `thinking` blocks
//!   assistant TEXT     — assistant prose
//!   user TEXT          — user-authored text content
//!
//! Output: grand totals + per-tool breakdown sorted by total (arg+res) tokens.
//! Optional CSV at `$TOOL_USAGE_CSV` (per-tool totals) or
//! `--calls-csv PATH` / `$TOOL_CALLS_CSV` (one row per tool call).
//!
//! Pass `--by <h|d|w|m|Nh|Nd|Nw>` to bucket per-call data into rolling windows
//! and surface per-tool tokens/call (avg + p50 + p95) over time, so you can
//! spot regressions in tool efficiency. The buckets do not align to calendar
//! boundaries; they are pure `floor(unix_secs / N)` slices.

use crate::common::*;
use anyhow::{Context, Result, bail};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Default, Clone)]
struct ToolAgg {
    calls: i64,
    results: i64,
    arg_tok: i64,
    res_tok: i64,
}

#[derive(Default, Clone)]
struct SessionTotals {
    arg_tok: i64,
    res_tok: i64,
    thinking_tok: i64,
    text_tok: i64,
    user_tok: i64,
    n_calls: i64,
    n_results: i64,
}

struct FileResult {
    totals: SessionTotals,
    tools: HashMap<String, ToolAgg>,
    calls: Vec<CallRecord>,
}

#[derive(Clone)]
struct CallRecord {
    ts: i64,
    tool: String,
    session: String,
    model: String,
    arg_tok: i32,
    res_tok: i32,
}

struct PendingCall {
    tool: String,
    ts: i64,
    arg_tok: i32,
    model: String,
}

pub fn run(args: Vec<String>) -> Result<()> {
    let mut limit: usize = 1_000;
    let mut workers: usize = 0;
    let mut by: Option<i64> = None;
    let mut top: usize = 12;
    let mut tool_filter: Option<String> = None;
    let mut calls_csv: Option<String> = std::env::var("TOOL_CALLS_CSV")
        .ok()
        .filter(|s| !s.is_empty());

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
            "--by" => {
                let spec = iter.next().context("--by requires a bucket spec")?;
                by = Some(parse_bucket(&spec)?);
            }
            "--top" => {
                top = iter
                    .next()
                    .context("--top requires a value")?
                    .parse()
                    .context("--top value")?;
            }
            "--tool" => {
                tool_filter = Some(iter.next().context("--tool requires a name")?);
            }
            "--calls-csv" => {
                calls_csv = Some(iter.next().context("--calls-csv requires a path")?);
            }
            "-h" | "--help" => {
                eprintln!(
"usage: session-stats tools [-n N] [-j workers] [--by SPEC] [--top N]
                           [--tool NAME] [--calls-csv PATH]

Aggregates per-tool token usage across the most-recent N session
jsonl files (default 1000). Tokenizer: o200k_base.

  --by SPEC      bucket per-call data into rolling windows. SPEC is one of:
                 hour, day, week, month, or <N>{{h,d,w}} (e.g. 7d, 12h, 2w).
                 Buckets are pure floor(unix_secs / N); they do not align to
                 calendar boundaries.
  --top N        limit per-tool series to the N most-called tools (default 12).
  --tool NAME    show only this tool in the bucketed series.
  --calls-csv PATH
                 emit one CSV row per tool call (ts, session, tool, model,
                 arg_tok, res_tok). Env fallback: TOOL_CALLS_CSV.

TOOL_USAGE_CSV env still emits the per-tool grand-totals CSV."
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
    eprintln!(
        "scanning {} session files (tokenizer: o200k_base)",
        files.len()
    );

    let results = parallel_collect(&files, workers, 5_000, process_file);

    let sessions = results.len();
    let mut grand = SessionTotals::default();
    let mut tools: HashMap<String, ToolAgg> = HashMap::new();
    let mut all_calls: Vec<CallRecord> = Vec::new();
    for r in results {
        grand.arg_tok += r.totals.arg_tok;
        grand.res_tok += r.totals.res_tok;
        grand.thinking_tok += r.totals.thinking_tok;
        grand.text_tok += r.totals.text_tok;
        grand.user_tok += r.totals.user_tok;
        grand.n_calls += r.totals.n_calls;
        grand.n_results += r.totals.n_results;
        for (name, t) in r.tools {
            let dst = tools.entry(name).or_default();
            dst.calls += t.calls;
            dst.results += t.results;
            dst.arg_tok += t.arg_tok;
            dst.res_tok += t.res_tok;
        }
        all_calls.extend(r.calls);
    }

    if let Some(ref name) = tool_filter {
        all_calls.retain(|c| &c.tool == name);
    }

    print_grand(&grand, sessions);
    println!();
    print_table(&tools);
    write_csv(&tools)?;

    if let Some(bucket_secs) = by {
        println!();
        print_buckets(&all_calls, bucket_secs, top, tool_filter.as_deref());
    }
    if let Some(path) = calls_csv {
        write_calls_csv(&all_calls, &path)?;
        eprintln!("wrote {} calls to {path}", commas(all_calls.len() as i64));
    }
    Ok(())
}

fn process_file(path: &Path) -> Option<FileResult> {
    let f = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("open {}: {e}", path.display());
            return None;
        }
    };
    let reader = BufReader::with_capacity(64 * 1024, f);

    let mut totals = SessionTotals::default();
    let mut tools: HashMap<String, ToolAgg> = HashMap::new();
    let mut calls: Vec<CallRecord> = Vec::new();
    let session = session_id_from_path(path);
    // Pending call records: keyed by toolCallId so the matching toolResult
    // can finalize a CallRecord with both arg+res tokens. Falls back to
    // message.toolName when the id is absent (legacy sessions).
    let mut pending: HashMap<String, PendingCall> = HashMap::new();

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
                    match it.kind.as_str() {
                        "toolCall" => {
                            let name = normalize_tool(&it.name);
                            let args_str = it.arguments.as_deref().map(RawValue::get).unwrap_or("");
                            let tok = count_tokens(args_str) as i64;
                            totals.arg_tok += tok;
                            totals.n_calls += 1;
                            let t = tools.entry(name.clone()).or_default();
                            t.calls += 1;
                            t.arg_tok += tok;
                            pending.insert(
                                it.id,
                                PendingCall {
                                    tool: name,
                                    ts: parse_ts(&ev.timestamp),
                                    arg_tok: clamp_i32(tok),
                                    model: m.model.clone(),
                                },
                            );
                        }
                        "thinking" => {
                            totals.thinking_tok += count_tokens(&it.thinking) as i64;
                        }
                        "text" => {
                            totals.text_tok += count_tokens(&it.text) as i64;
                        }
                        _ => {}
                    }
                }
            }
            "toolResult" => {
                let text = join_text(&items);
                let tok = count_tokens(&text) as i64;
                totals.res_tok += tok;
                totals.n_results += 1;
                let pc = pending.remove(&m.tool_call_id);
                let name = pc
                    .as_ref()
                    .map(|p| p.tool.clone())
                    .unwrap_or_else(|| normalize_tool(&m.tool_name));
                let t = tools.entry(name.clone()).or_default();
                t.results += 1;
                t.res_tok += tok;
                if let Some(p) = pc {
                    calls.push(CallRecord {
                        ts: p.ts,
                        tool: name,
                        session: session.clone(),
                        model: p.model,
                        arg_tok: p.arg_tok,
                        res_tok: clamp_i32(tok),
                    });
                }
            }
            "user" => {
                for it in items {
                    if it.kind == "text" {
                        totals.user_tok += count_tokens(&it.text) as i64;
                    }
                }
            }
            _ => {}
        }
    }

    Some(FileResult { totals, tools, calls })
}

use serde_json::value::RawValue;

fn normalize_tool(name: &str) -> String {
    if name.is_empty() {
        "<unknown>".to_string()
    } else {
        name.to_string()
    }
}

// ---- reporting ----

fn print_grand(g: &SessionTotals, sessions: usize) {
    let total = g.arg_tok + g.res_tok + g.thinking_tok + g.text_tok + g.user_tok;
    let rows: [(&str, i64); 5] = [
        ("tool call ARGS", g.arg_tok),
        ("tool RESULTS", g.res_tok),
        ("assistant THINKING", g.thinking_tok),
        ("assistant TEXT", g.text_tok),
        ("user TEXT", g.user_tok),
    ];
    let label_w = rows.iter().map(|(l, _)| l.len()).max().unwrap_or(0);
    let val_w = rows
        .iter()
        .map(|(_, n)| commas(*n).len())
        .chain(std::iter::once(commas(total).len()))
        .max()
        .unwrap_or(0);

    println!("=== Grand totals across {} sessions ===", commas(sessions as i64));
    for (label, n) in rows {
        println!(
            "{label:<label_w$}  {:>val_w$} tok ({:>5.1}%)",
            commas(n),
            pct(n, total),
        );
    }
    println!("{:<label_w$}  {}", "", "-".repeat(val_w));
    println!("{:<label_w$}  {:>val_w$} tok", "TOTAL", commas(total));
    println!();
    println!(
        "tool calls: {}, tool results: {}",
        commas(g.n_calls),
        commas(g.n_results)
    );
    if g.n_calls > 0 {
        println!(
            "avg arg tokens / call:    {:.1}",
            g.arg_tok as f64 / g.n_calls as f64
        );
    }
    if g.n_results > 0 {
        println!(
            "avg result tokens / call: {:.1}",
            g.res_tok as f64 / g.n_results as f64
        );
    }
    if g.arg_tok > 0 {
        println!(
            "ratio result / arg:       {:.2}x",
            g.res_tok as f64 / g.arg_tok as f64
        );
    }
}

struct ToolRow {
    name: String,
    calls: i64,
    arg_tok: i64,
    res_tok: i64,
    total: i64,
    avg_arg: f64,
    avg_res: f64,
    res_o_arg: f64,
}

fn print_table(tools: &HashMap<String, ToolAgg>) {
    let mut rows: Vec<ToolRow> = tools
        .iter()
        .filter_map(|(name, t)| {
            if t.calls == 0 && t.results == 0 {
                return None;
            }
            let mut r = ToolRow {
                name: name.clone(),
                calls: t.calls,
                arg_tok: t.arg_tok,
                res_tok: t.res_tok,
                total: t.arg_tok + t.res_tok,
                avg_arg: 0.0,
                avg_res: 0.0,
                res_o_arg: 0.0,
            };
            if t.calls > 0 {
                r.avg_arg = t.arg_tok as f64 / t.calls as f64;
                r.avg_res = t.res_tok as f64 / t.calls as f64;
            }
            if t.arg_tok > 0 {
                r.res_o_arg = t.res_tok as f64 / t.arg_tok as f64;
            }
            Some(r)
        })
        .collect();
    rows.sort_by(|a, b| b.total.cmp(&a.total));

    const TOP: usize = 25;
    let shown = TOP.min(rows.len());
    let head_rows = &rows[..shown];

    // "(N others)" trailing summary, computed before width measurement so its
    // string contents participate in column sizing.
    let others = (rows.len() > TOP).then(|| {
        let mut sc = 0i64;
        let mut sa = 0i64;
        let mut sr = 0i64;
        for r in &rows[TOP..] {
            sc += r.calls;
            sa += r.arg_tok;
            sr += r.res_tok;
        }
        OthersRow {
            label: format!("({} others)", rows.len() - TOP),
            calls: sc,
            arg_tok: sa,
            res_tok: sr,
            total: sa + sr,
        }
    });

    // Compute column widths from header label and every value that will
    // appear under that header (including the "others" summary row, if any).
    let max_str = |header: &str, vals: &[&str]| -> usize {
        vals.iter().map(|s| s.len()).chain(std::iter::once(header.len())).max().unwrap_or(0)
    };

    let names: Vec<&str> = head_rows
        .iter()
        .map(|r| r.name.as_str())
        .chain(others.as_ref().map(|o| o.label.as_str()))
        .collect();
    let calls: Vec<String> = head_rows
        .iter()
        .map(|r| commas(r.calls))
        .chain(others.as_ref().map(|o| commas(o.calls)))
        .collect();
    let arg_toks: Vec<String> = head_rows
        .iter()
        .map(|r| commas(r.arg_tok))
        .chain(others.as_ref().map(|o| commas(o.arg_tok)))
        .collect();
    let res_toks: Vec<String> = head_rows
        .iter()
        .map(|r| commas(r.res_tok))
        .chain(others.as_ref().map(|o| commas(o.res_tok)))
        .collect();
    let totals: Vec<String> = head_rows
        .iter()
        .map(|r| commas(r.total))
        .chain(others.as_ref().map(|o| commas(o.total)))
        .collect();
    let avg_args: Vec<String> = head_rows.iter().map(|r| format!("{:.1}", r.avg_arg)).collect();
    let avg_ress: Vec<String> = head_rows.iter().map(|r| format!("{:.1}", r.avg_res)).collect();
    let res_o_args: Vec<String> =
        head_rows.iter().map(|r| format!("{:.2}", r.res_o_arg)).collect();

    let name_w = max_str("tool", &names);
    let calls_w = max_str("calls", &calls.iter().map(String::as_str).collect::<Vec<_>>());
    let arg_w = max_str("arg_tok", &arg_toks.iter().map(String::as_str).collect::<Vec<_>>());
    let res_w = max_str("res_tok", &res_toks.iter().map(String::as_str).collect::<Vec<_>>());
    let tot_w = max_str("total", &totals.iter().map(String::as_str).collect::<Vec<_>>());
    let avga_w = max_str("avg_arg", &avg_args.iter().map(String::as_str).collect::<Vec<_>>());
    let avgr_w = max_str("avg_res", &avg_ress.iter().map(String::as_str).collect::<Vec<_>>());
    let ratio_w = max_str("res/arg", &res_o_args.iter().map(String::as_str).collect::<Vec<_>>());

    let total_width = name_w + 1 + calls_w + 1 + arg_w + 1 + res_w + 1 + tot_w + 1 + avga_w + 1 + avgr_w + 1 + ratio_w;

    println!(
        "{:<name_w$} {:>calls_w$} {:>arg_w$} {:>res_w$} {:>tot_w$} {:>avga_w$} {:>avgr_w$} {:>ratio_w$}",
        "tool", "calls", "arg_tok", "res_tok", "total", "avg_arg", "avg_res", "res/arg"
    );
    println!("{}", "-".repeat(total_width));

    for (i, r) in head_rows.iter().enumerate() {
        println!(
            "{:<name_w$} {:>calls_w$} {:>arg_w$} {:>res_w$} {:>tot_w$} {:>avga_w$} {:>avgr_w$} {:>ratio_w$}",
            r.name, calls[i], arg_toks[i], res_toks[i], totals[i], avg_args[i], avg_ress[i], res_o_args[i],
        );
    }
    if let Some(o) = others {
        let i = head_rows.len();
        println!(
            "{:<name_w$} {:>calls_w$} {:>arg_w$} {:>res_w$} {:>tot_w$}",
            o.label, calls[i], arg_toks[i], res_toks[i], totals[i],
        );
    }
}

struct OthersRow {
    label: String,
    calls: i64,
    arg_tok: i64,
    res_tok: i64,
    total: i64,
}

fn write_csv(tools: &HashMap<String, ToolAgg>) -> Result<()> {
    let path = std::env::var("TOOL_USAGE_CSV").unwrap_or_default();
    if path.is_empty() {
        return Ok(());
    }
    let f = File::create(&path).with_context(|| format!("create {path}"))?;
    let mut w = csv::Writer::from_writer(f);
    w.write_record(["tool", "calls", "results", "arg_tok", "res_tok", "total"])?;
    let mut names: Vec<&String> = tools.keys().collect();
    names.sort_by(|a, b| {
        let ai = {
            let t = &tools[a.as_str()];
            t.arg_tok + t.res_tok
        };
        let aj = {
            let t = &tools[b.as_str()];
            t.arg_tok + t.res_tok
        };
        aj.cmp(&ai)
    });
    for n in names {
        let t = &tools[n.as_str()];
        w.write_record([
            n.as_str(),
            &t.calls.to_string(),
            &t.results.to_string(),
            &t.arg_tok.to_string(),
            &t.res_tok.to_string(),
            &(t.arg_tok + t.res_tok).to_string(),
        ])?;
    }
    w.flush()?;
    Ok(())
}

// ---- per-call helpers ----

fn session_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn clamp_i32(n: i64) -> i32 {
    n.clamp(0, i32::MAX as i64) as i32
}

fn print_buckets(
    calls: &[CallRecord],
    bucket_secs: i64,
    top: usize,
    tool_filter: Option<&str>,
) {
    if calls.is_empty() {
        println!("(no per-call records — no toolCall/toolResult pairs found)");
        return;
    }

    // Pick the tools to show: top-N by call count, ignoring records with ts==0
    // (events that lacked a parseable timestamp).
    let mut per_tool: HashMap<&str, i64> = HashMap::new();
    for c in calls {
        if c.ts == 0 {
            continue;
        }
        *per_tool.entry(c.tool.as_str()).or_default() += 1;
    }
    let mut ranked: Vec<(&str, i64)> = per_tool.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    if tool_filter.is_none() {
        ranked.truncate(top);
    }

    let bucket_human = humanize_bucket(bucket_secs);
    println!(
        "=== per-call tokens by {} bucket (rolling, no calendar alignment) ===",
        bucket_human
    );
    println!(
        "showing {} tool{} (sorted by call count). totals/calls match per-call records only;",
        ranked.len(),
        if ranked.len() == 1 { "" } else { "s" }
    );
    println!(
        "calls without a matching toolResult or without a parseable timestamp are skipped here."
    );

    // Group calls per (tool, bucket_id).
    let mut by_bucket: HashMap<(&str, i64), Vec<&CallRecord>> = HashMap::new();
    for c in calls {
        if c.ts == 0 {
            continue;
        }
        if !ranked.iter().any(|(t, _)| *t == c.tool.as_str()) {
            continue;
        }
        let bid = c.ts.div_euclid(bucket_secs);
        by_bucket.entry((c.tool.as_str(), bid)).or_default().push(c);
    }

    for (tool, total_calls) in ranked {
        let mut bids: Vec<i64> = by_bucket
            .keys()
            .filter(|(t, _)| *t == tool)
            .map(|(_, b)| *b)
            .collect();
        if bids.is_empty() {
            continue;
        }
        bids.sort();

        println!();
        println!("=== {tool}  ({} calls) ===", commas(total_calls));
        println!(
            "{:<22} {:>7} {:>9} {:>9} {:>9} {:>9} {:>9}",
            "window", "calls", "avg_arg", "avg_res", "avg_tot", "p50_tot", "p95_tot"
        );
        let dashes = 22 + 1 + 7 + 5 * (1 + 9);
        println!("{}", "-".repeat(dashes));

        for bid in bids {
            let records = by_bucket.get(&(tool, bid)).expect("present");
            let n = records.len() as i64;
            let mut sum_arg = 0i64;
            let mut sum_res = 0i64;
            let mut totals: Vec<i64> = Vec::with_capacity(records.len());
            for r in records {
                sum_arg += r.arg_tok as i64;
                sum_res += r.res_tok as i64;
                totals.push(r.arg_tok as i64 + r.res_tok as i64);
            }
            let avg_arg = sum_arg as f64 / n as f64;
            let avg_res = sum_res as f64 / n as f64;
            let avg_tot = avg_arg + avg_res;
            let p50 = percentile(&mut totals.clone(), 50.0);
            let p95 = percentile(&mut totals, 95.0);
            let label = bucket_label(bid * bucket_secs, bucket_secs);
            println!(
                "{:<22} {:>7} {:>9} {:>9} {:>9} {:>9} {:>9}",
                label,
                commas(n),
                commas(avg_arg.round() as i64),
                commas(avg_res.round() as i64),
                commas(avg_tot.round() as i64),
                commas(p50.round() as i64),
                commas(p95.round() as i64),
            );
        }
    }
}

fn humanize_bucket(bucket_secs: i64) -> String {
    if bucket_secs % (7 * 86_400) == 0 {
        let n = bucket_secs / (7 * 86_400);
        if n == 1 { "7d".into() } else { format!("{n}w") }
    } else if bucket_secs % 86_400 == 0 {
        format!("{}d", bucket_secs / 86_400)
    } else if bucket_secs % 3600 == 0 {
        format!("{}h", bucket_secs / 3600)
    } else {
        format!("{}s", bucket_secs)
    }
}

fn write_calls_csv(calls: &[CallRecord], path: &str) -> Result<()> {
    let f = File::create(path).with_context(|| format!("create {path}"))?;
    let mut w = csv::Writer::from_writer(f);
    w.write_record([
        "ts_unix",
        "ts_iso",
        "session",
        "tool",
        "model",
        "arg_tok",
        "res_tok",
        "total_tok",
    ])?;
    for c in calls {
        let total = c.arg_tok as i64 + c.res_tok as i64;
        w.write_record([
            &c.ts.to_string(),
            &format_iso(c.ts),
            &c.session,
            &c.tool,
            &c.model,
            &c.arg_tok.to_string(),
            &c.res_tok.to_string(),
            &total.to_string(),
        ])?;
    }
    w.flush()?;
    Ok(())
}
