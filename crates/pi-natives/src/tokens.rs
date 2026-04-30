//! Token counting via tiktoken-rs.
//!
//! Two encodings are exposed:
//!
//!   - `O200kBase` — GPT-4o / o1 / GPT-5 (the modern `OpenAI` default).
//!   - `Cl100kBase` — GPT-3.5 / GPT-4 / older models.
//!
//! `o200k_base` is the default. Anthropic doesn't publish their tokenizer, so
//! either of these is an approximation for Claude (within ~5–10% across
//! English/code text). `o200k_base` is closer to current frontier models'
//! actual segmentation and is the right default for budget estimates.
//!
//! Both BPE tables are embedded in the binary; encoders are built once on
//! first use and reused thereafter.

use std::sync::LazyLock;

use napi::bindgen_prelude::Either;
use napi_derive::napi;
use rayon::prelude::*;
use tiktoken_rs::{CoreBPE, cl100k_base, o200k_base};

/// Tokenizer encoding to use.
#[napi(string_enum)]
pub enum Encoding {
	/// GPT-4o / o1 / GPT-5 (default).
	O200kBase,
	/// GPT-3.5 / GPT-4 / older.
	Cl100kBase,
}

static O200K: LazyLock<CoreBPE> =
	LazyLock::new(|| o200k_base().expect("failed to initialize o200k_base BPE tables"));

static CL100K: LazyLock<CoreBPE> =
	LazyLock::new(|| cl100k_base().expect("failed to initialize cl100k_base BPE tables"));

fn encoder(encoding: Option<Encoding>) -> &'static CoreBPE {
	match encoding.unwrap_or(Encoding::O200kBase) {
		Encoding::O200kBase => &O200K,
		Encoding::Cl100kBase => &CL100K,
	}
}

/// Count tokens in `input`.
///
/// `input` may be a single string or an array of strings; an array returns
/// the sum across all elements (encoded in parallel via rayon). Always
/// returns a single token total — use this for any aggregate budget question
/// without paying a per-element napi crossing.
///
/// Uses ordinary encoding (no special-token handling), which is the right
/// choice for measuring user/model content rather than wire-protocol tokens.
/// Defaults to `o200k_base`; pass `Cl100kBase` for older `OpenAI` models.
#[napi]
pub fn count_tokens(input: Either<String, Vec<String>>, encoding: Option<Encoding>) -> u32 {
	let bpe = encoder(encoding);
	match input {
		Either::A(text) => bpe.encode_ordinary(&text).len() as u32,
		Either::B(texts) => texts
			.par_iter()
			.map(|s| bpe.encode_ordinary(s).len() as u32)
			.sum(),
	}
}
