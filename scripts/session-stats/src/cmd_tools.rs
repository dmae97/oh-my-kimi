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
//! Optional CSV at `$TOOL_USAGE_CSV`.

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
}

pub fn run(args: Vec<String>) -> Result<()> {
    let mut limit: usize = 1_000;
    let mut workers: usize = 0;

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
                    "usage: session-stats tools [-n N] [-j workers]\n\
                     \n\
                     Aggregates per-tool token usage across the most-recent N session\n\
                     jsonl files (default 1000). Tokenizer: o200k_base."
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
    }

    print_grand(&grand, sessions);
    println!();
    print_table(&tools);
    write_csv(&tools)?;
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
    // Pending arg attribution: when a result arrives we credit the tool listed
    // here; otherwise we fall back to message.toolName on the result event.
    let mut pending: HashMap<String, String> = HashMap::new();

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
                            pending.insert(it.id, name);
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
                let name = pending
                    .remove(&m.tool_call_id)
                    .unwrap_or_else(|| normalize_tool(&m.tool_name));
                let t = tools.entry(name).or_default();
                t.results += 1;
                t.res_tok += tok;
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

    Some(FileResult { totals, tools })
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
