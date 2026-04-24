//! Marker state for launch-scoped command output minimization.

use std::{
	collections::HashMap,
	sync::atomic::{AtomicU64, Ordering},
};

use brush_core::{ExternalCommandInfo, ExternalCommandOutputMarker, ExternalCommandOutputMarkers};
use parking_lot::Mutex;

use crate::shell::minimizer::detect::{self, CommandIdentity};

const MARKER_END: char = '\x1f';
const MARKER_NAME: &str = "\x1ePI_MINIMIZER";

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Command metadata associated with one marked launch.
#[derive(Clone, Debug)]
pub struct MarkedCommand {
	/// Detected command identity used for minimizer dispatch.
	pub identity: CommandIdentity,
	/// Reconstructed command string for filters that inspect token text.
	pub command:  String,
}

/// Parsed marker kind from the captured output stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerKind {
	/// Start marker for a command id.
	Start { id: u64 },
	/// End marker for a command id and its exit status.
	End { id: u64, exit_code: i32 },
}

/// Parsed marker location in the captured output stream.
#[derive(Clone, Debug)]
pub struct ParsedMarker {
	/// Marker byte start offset.
	pub start: usize,
	/// Marker byte end offset.
	pub end:   usize,
	/// Parsed marker payload.
	pub kind:  MarkerKind,
}

/// Per-shell-run state shared with brush-core marker hooks.
pub struct CommandMarkerState {
	token:    String,
	next_id:  AtomicU64,
	commands: Mutex<HashMap<u64, MarkedCommand>>,
}

impl CommandMarkerState {
	/// Creates a fresh marker namespace for one shell command invocation.
	pub fn new() -> Self {
		let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
		Self {
			token:    format!("{}:{token}", std::process::id()),
			next_id:  AtomicU64::new(1),
			commands: Mutex::new(HashMap::new()),
		}
	}

	/// Returns command metadata for `id`, if it was launched by this run.
	pub fn command(&self, id: u64) -> Option<MarkedCommand> {
		self.commands.lock().get(&id).cloned()
	}

	/// Finds the next marker at or after `from`.
	pub fn find_marker(&self, text: &str, from: usize) -> Option<ParsedMarker> {
		let prefix = self.marker_prefix();
		let relative_start = text.get(from..)?.find(&prefix)?;
		let start = from + relative_start;
		let body_start = start + prefix.len();
		let relative_end = text.get(body_start..)?.find(MARKER_END)?;
		let body_end = body_start + relative_end;
		let end = body_end + MARKER_END.len_utf8();
		let body = text.get(body_start..body_end)?;
		let kind = parse_marker_body(body)?;
		Some(ParsedMarker { start, end, kind })
	}

	fn marker_prefix(&self) -> String {
		format!("{MARKER_NAME}:{}:", self.token)
	}
}

impl Default for CommandMarkerState {
	fn default() -> Self {
		Self::new()
	}
}

impl ExternalCommandOutputMarker for CommandMarkerState {
	fn markers_for_external_command(
		&self,
		info: ExternalCommandInfo<'_>,
	) -> Option<ExternalCommandOutputMarkers> {
		let tokens = command_tokens(&info);
		let identity = detect::detect_tokens(&tokens)?;
		let command = tokens
			.iter()
			.map(|token| quote_command_token(token))
			.collect::<Vec<_>>()
			.join(" ");
		let id = self.next_id.fetch_add(1, Ordering::Relaxed);
		self
			.commands
			.lock()
			.insert(id, MarkedCommand { identity, command });

		Some(ExternalCommandOutputMarkers {
			start_marker:      format!("{MARKER_NAME}:{}:S:{id}{MARKER_END}", self.token),
			end_marker_prefix: format!("{MARKER_NAME}:{}:E:{id}:", self.token),
			end_marker_suffix: MARKER_END.to_string(),
		})
	}
}

fn command_tokens(info: &ExternalCommandInfo<'_>) -> Vec<String> {
	std::iter::once(info.command_name)
		.chain(info.args.iter().copied())
		.map(ToOwned::to_owned)
		.collect()
}

fn parse_marker_body(body: &str) -> Option<MarkerKind> {
	let mut pieces = body.split(':');
	match pieces.next()? {
		"S" => {
			let id = pieces.next()?.parse().ok()?;
			if pieces.next().is_some() {
				return None;
			}
			Some(MarkerKind::Start { id })
		},
		"E" => {
			let id = pieces.next()?.parse().ok()?;
			let exit_code = pieces.next()?.parse().ok()?;
			if pieces.next().is_some() {
				return None;
			}
			Some(MarkerKind::End { id, exit_code })
		},
		_ => None,
	}
}

fn quote_command_token(token: &str) -> String {
	if token
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '=' | '+'))
	{
		return token.to_string();
	}

	format!("'{}'", token.replace('\'', "'\\''"))
}
