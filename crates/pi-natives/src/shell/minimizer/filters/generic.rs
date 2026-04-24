//! Generic fallback transforms.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	let stripped = primitives::strip_ansi(input);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	let text = if deduped.lines().count() > 200 {
		primitives::head_tail_lines(&deduped, 100, 60)
	} else {
		deduped
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}
