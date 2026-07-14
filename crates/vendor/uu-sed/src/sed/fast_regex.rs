// A unified interface to byte and fancy Regex
//
// This allows using byte Regex when possible, resorting to the
// slower fancy_regex crate when needed.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{error::Error, sync::LazyLock};

use fancy_regex::{
	CaptureMatches as FancyCaptureMatches, Captures as FancyCaptures, Regex as FancyRegex,
};
use memchr::memmem;
use regex::{
	Regex as RustRegex,
	bytes::{CaptureMatches as ByteCaptureMatches, Captures as ByteCaptures, Regex as ByteRegex},
};
use uucore::error::{UResult, USimpleError};

use crate::sed::fast_io::IOChunk;

/// REs requiring the fancy_regex capabilities rather than the
/// faster regex::bytes engine
// False positives only result in a small performance pessimization,
// so this is just a maximally sensitive, good-enough approximation.
// For example, r"\\1" and r"[\1]" will match, whereas only a number
// after an odd number of backslashes and outside a character class
// should match.
static NEEDS_FANCY_RE: LazyLock<RustRegex> =
	LazyLock::new(|| regex::Regex::new(r"\\[1-9]").unwrap());

/// All characters signifying that the match must be handled by an RE
/// rather than by plain string pattern matching.
// These do not include the ^$ metacharacters, which we can easily handle.
// Plain string fixed-string matching is currently faster than Regex
// matching, because Regex always constructs an automaton and needs
// to handle state transitions, whereas plain string matching can
// use tailored CPU string or vectored instructions.
static NEEDS_RE: LazyLock<RustRegex> = LazyLock::new(|| {
	regex::Regex::new(
		r"(?x) # Turn on verbose mode
          ( ^                   # Non-escaped: i.e. at BOL
             | ^[^\\]            # or after a BOL non \
             | [^\\] {2}         # or after two non \ characters
             | \\.               # or after a consumed or escaped \
           )
           (                     # A potentially incompatible match
              [.?|+(\[{*]        # Any magic RE character
                                 # Some are operators so illegal at
                                 # BOL but they should error there,
                                 # not use them as literals.
             | \\[WwDdSsPp]      # Unicode classes
             | \\[AzBb]          # Empty matches
             | \\[0-9]           # Back-references
           )
        ",
	)
	.unwrap()
});

#[derive(Clone, Debug)]
/// Types of literal string anchored matches
enum AnchoredMatch {
	Begin, // ^...
	End,   // ...$
	Both,  // ^...$
	Free,  // ...
}

#[derive(Clone, Debug)]
/// A fast Regex-like matcher for literal strings using memchr:memmem
pub struct LiteralMatcher {
	needle:     Vec<u8>,       // Bytes without any anchors
	match_type: AnchoredMatch, // Type of anchoring specified
}

impl LiteralMatcher {
	/// Construct a new matcher based on a needle possible with anchors.
	pub fn new(needle: &str) -> Self {
		let needle_bytes = needle.as_bytes();
		if needle_bytes[0] == b'^' && needle_bytes[needle_bytes.len() - 1] == b'$' {
			LiteralMatcher {
				match_type: AnchoredMatch::Both,
				needle:     needle_bytes[1..needle_bytes.len() - 1].to_vec(),
			}
		} else if needle_bytes[0] == b'^' {
			LiteralMatcher {
				match_type: AnchoredMatch::Begin,
				needle:     needle_bytes[1..needle_bytes.len()].to_vec(),
			}
		} else if needle_bytes[needle_bytes.len() - 1] == b'$' {
			LiteralMatcher {
				match_type: AnchoredMatch::End,
				needle:     needle_bytes[0..needle_bytes.len() - 1].to_vec(),
			}
		} else {
			LiteralMatcher { match_type: AnchoredMatch::Free, needle: needle_bytes.to_vec() }
		}
	}

	/// Returns the start index of a match, if any
	fn anchored_find(&self, haystack: &[u8]) -> Option<usize> {
		let nlen = self.needle.len();
		let hlen = haystack.len();

		match self.match_type {
			AnchoredMatch::Both => {
				if hlen == nlen && haystack == self.needle.as_slice() {
					Some(0)
				} else {
					None
				}
			},
			AnchoredMatch::Begin => {
				if hlen >= nlen && &haystack[..nlen] == self.needle.as_slice() {
					Some(0)
				} else {
					None
				}
			},
			AnchoredMatch::End => {
				if hlen >= nlen && &haystack[hlen - nlen..] == self.needle.as_slice() {
					Some(hlen - nlen)
				} else {
					None
				}
			},
			AnchoredMatch::Free => memmem::find(haystack, &self.needle),
		}
	}

	/// Return true if the needle occurs in the haystack.
	pub fn is_match(&self, haystack: &[u8]) -> bool {
		self.anchored_find(haystack).is_some()
	}

	/// Return the position and contents of the matched needle.
	pub fn find<'t>(&self, haystack: &'t [u8]) -> Option<(usize, usize, &'t str)> {
		self.anchored_find(haystack).and_then(|start| {
			let end = start + self.needle.len();
			std::str::from_utf8(&haystack[start..end])
				.ok()
				.map(|s| (start, end, s))
		})
	}

	/// Return all positions and contents of the matched needle.
	pub fn iter<'t>(
		&'t self,
		haystack: &'t [u8],
	) -> Box<dyn Iterator<Item = (usize, usize, &'t str)> + 't> {
		let needle = &self.needle;
		let nlen = needle.len();

		match self.match_type {
			AnchoredMatch::Both | AnchoredMatch::Begin | AnchoredMatch::End => {
				// At most one match; yield it if present
				Box::new(self.find(haystack).into_iter())
			},
			AnchoredMatch::Free => {
				// Multiple potential matches
				Box::new(memmem::find_iter(haystack, needle).filter_map(move |start| {
					let end = start + nlen;
					std::str::from_utf8(&haystack[start..end])
						.ok()
						.map(|s| (start, end, s))
				}))
			},
		}
	}
}

/// Return the passed pattern without any backslash escapes.
pub fn remove_escapes(pattern: &str) -> String {
	let mut chars = pattern.chars().peekable();
	let mut result = String::with_capacity(pattern.len());

	while let Some(c) = chars.next() {
		if c == '\\' {
			// Look ahead and consume the next character if present
			if let Some(&next) = chars.peek() {
				result.push(next);
				chars.next(); // consume the peeked char
			}
		} else {
			result.push(c);
		}
	}

	result
}

#[derive(Clone, Debug)]
/// A regular expression that can be implemented in diverse efficient ways
pub enum Regex {
	Literal(LiteralMatcher), // Fastest: literal bytes
	Byte(ByteRegex),         // Slower: byte-based RE
	Fancy(FancyRegex),       // Slowest: RE supporting UTF-8 and back-references
}

/// Ensure that a regex matches GNU sed's default semantics for `.`
/// through the appropriate use of the s flag.
pub fn ensure_dotall(pattern: &str) -> String {
	// Add (?s) if no flags present.
	if !pattern.starts_with("(?") {
		return format!("(?s){pattern}");
	}

	let Some(close) = pattern.find(')') else {
		// Malformed inline flag group.
		return pattern.to_owned();
	};

	// Add s flag to ?(...) unless 's' or its complement 'm' is there.
	let flags = &pattern[2..close];

	if flags.contains('m') || flags.contains('s') {
		pattern.to_owned()
	} else {
		format!("(?{flags}s){}", &pattern[close + 1..])
	}
}

impl Regex {
	/// Construct the most efficient RE-like matching engine possible.
	pub fn new(pattern: &str) -> Result<Self, Box<dyn Error>> {
		if NEEDS_FANCY_RE.is_match(pattern) {
			Ok(Self::Fancy(FancyRegex::new(&ensure_dotall(pattern))?))
		} else if NEEDS_RE.is_match(pattern) {
			Ok(Self::Byte(ByteRegex::new(&ensure_dotall(pattern))?))
		} else {
			Ok(Self::Literal(LiteralMatcher::new(&remove_escapes(pattern))))
		}
	}

	/// Check if the regex matches the content of the IOChunk.
	pub fn is_match(&self, chunk: &mut IOChunk) -> UResult<bool> {
		match self {
			Regex::Literal(m) => Ok(m.is_match(chunk.as_bytes())),
			Regex::Byte(re) => Ok(re.is_match(chunk.as_bytes())),
			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				re.is_match(text)
					.map_err(|e| USimpleError::new(2, e.to_string()))
			},
		}
	}

	/// Return an iterator over capture groups.
	pub fn captures_iter<'t>(&'t self, chunk: &'t IOChunk) -> UResult<CaptureMatches<'t>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				Ok(CaptureMatches::Literal(Box::new(
					m.iter(haystack)
						.map(|(start, end, text)| Ok(Captures::Literal(Match { start, end, text }))),
				)))
			},

			Regex::Byte(re) => Ok(CaptureMatches::Byte(re.captures_iter(chunk.as_bytes()))),

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				Ok(CaptureMatches::Fancy(re.captures_iter(text)))
			},
		}
	}

	/// Return the number of capture groups, including group 0.
	pub fn captures_len(&self) -> usize {
		match self {
			Regex::Literal(_) => 1, // Only group 0
			Regex::Byte(re) => re.captures_len(),
			Regex::Fancy(re) => re.captures_len(),
		}
	}

	/// Return the elements of the first capture.
	pub fn captures<'t>(&self, chunk: &'t IOChunk) -> UResult<Option<Captures<'t>>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				match m.find(haystack) {
					Some((start, end, text)) => Ok(Some(Captures::Literal(Match { start, end, text }))),
					None => Ok(None),
				}
			},

			Regex::Byte(re) => {
				let bytes = chunk.as_bytes();
				Ok(re.captures(bytes).map(Captures::Byte))
			},

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				match re.captures(text) {
					Ok(Some(caps)) => Ok(Some(Captures::Fancy(caps))),
					Ok(None) => Ok(None),
					Err(e) => Err(USimpleError::new(2, e.to_string())),
				}
			},
		}
	}

	/// Return a non-capturing result for a single match.
	pub fn find<'t>(&self, chunk: &'t IOChunk) -> UResult<Option<Match<'t>>> {
		match self {
			Regex::Literal(m) => {
				let haystack = chunk.as_bytes();
				match m.find(haystack) {
					Some((start, end, text)) => Ok(Some(Match { start, end, text })),
					None => Ok(None),
				}
			},

			Regex::Byte(re) => {
				let haystack = chunk.as_bytes();
				if let Some(m) = re.find(haystack) {
					// Attempt UTF-8 decode for the match region only
					let text = std::str::from_utf8(&haystack[m.start()..m.end()])
						.map_err(|e| USimpleError::new(2, e.to_string()))?;
					Ok(Some(Match { start: m.start(), end: m.end(), text }))
				} else {
					Ok(None)
				}
			},

			Regex::Fancy(re) => {
				let text = chunk.as_str()?;
				match re.find(text) {
					Ok(Some(m)) => {
						Ok(Some(Match { start: m.start(), end: m.end(), text: m.as_str() }))
					},
					Ok(None) => Ok(None),
					Err(e) => Err(USimpleError::new(2, e.to_string())),
				}
			},
		}
	}
}

/// Unified enum for holding either byte or fancy capture iterators.
pub enum CaptureMatches<'t> {
	Literal(Box<dyn Iterator<Item = UResult<Captures<'t>>> + 't>),
	Byte(ByteCaptureMatches<'t, 't>),
	Fancy(FancyCaptureMatches<'t, 't>),
}

impl<'t> Iterator for CaptureMatches<'t> {
	type Item = UResult<Captures<'t>>;

	fn next(&mut self) -> Option<Self::Item> {
		match self {
			CaptureMatches::Literal(iter) => iter.next(),
			CaptureMatches::Byte(iter) => iter.next().map(|caps| Ok(Captures::Byte(caps))),
			CaptureMatches::Fancy(iter) => match iter.next() {
				Some(Ok(caps)) => Some(Ok(Captures::Fancy(caps))),
				Some(Err(e)) => {
					Some(Err(USimpleError::new(2, format!("error retrieving RE captures: {e}"))))
				},
				None => None,
			},
		}
	}
}

#[derive(Clone, Debug)]
/// Result type for RE capture get(n)
pub struct Match<'t> {
	start: usize,   // Match start
	end:   usize,   // Match end
	text:  &'t str, // Actual match
}

/// Provide interface compatible with Regex::Match.
impl<'t> Match<'t> {
	pub fn start(&self) -> usize {
		self.start
	}

	pub fn end(&self) -> usize {
		self.end
	}

	pub fn as_str(&self) -> &'t str {
		self.text
	}
}

/// Provide interface compatible with Regex::Captures.
pub enum Captures<'t> {
	Literal(Match<'t>), // only group 0
	Byte(ByteCaptures<'t>),
	Fancy(FancyCaptures<'t>),
}

impl<'t> Captures<'t> {
	/// Get capture group at index `i`
	/// Returns Ok(None) if the group didn't match.
	/// Returns Err if UTF-8 conversion fails (in Byte variant).
	pub fn get(&self, i: usize) -> UResult<Option<Match<'t>>> {
		match self {
			Captures::Literal(m) => Ok(if i == 0 { Some(m.clone()) } else { None }),
			Captures::Byte(caps) => match caps.get(i) {
				Some(m) => Ok(Some(Match {
					start: m.start(),
					end:   m.end(),
					text:  std::str::from_utf8(m.as_bytes())
						.map_err(|e| USimpleError::new(1, e.to_string()))?,
				})),
				None => Ok(None),
			},
			Captures::Fancy(caps) => match caps.get(i) {
				Some(m) => Ok(Some(Match { start: m.start(), end: m.end(), text: m.as_str() })),
				None => Ok(None),
			},
		}
	}

	/// Return the number of capture groups (including group 0).
	pub fn len(&self) -> usize {
		match self {
			Captures::Literal(_) => 1,
			Captures::Byte(caps) => caps.len(),
			Captures::Fancy(caps) => caps.len(),
		}
	}

	/// Return true if there are no captures.
	// Unused, but provided for completeness.
	pub fn is_empty(&self) -> bool {
		match self {
			Captures::Literal(_) => false, // A literal match always has group 0
			Captures::Byte(caps) => caps.len() == 0,
			Captures::Fancy(caps) => caps.len() == 0,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// FANCY_RE
	#[test]
	fn test_needs_fancy_re_matches() {
		let should_match = [
			r"(\w+):\1", // back-reference \1
		];

		for pat in &should_match {
			assert!(NEEDS_FANCY_RE.is_match(pat), "Expected NEEDS_FANCY_RE to match: {pat:?}");
		}
	}

	#[test]
	fn test_needs_fancy_re_does_not_match() {
		let should_not_match = [
			r"\ 1", // Non-adjacent
			r"\0",  // Only \[1-9]
			// Simple ASCII
			r"foo",
			r"foo|bar",
			r"^foo[0-9]+bar$",
		];

		for pat in &should_not_match {
			assert!(!NEEDS_FANCY_RE.is_match(pat), "Expected NEEDS_FANCY_RE to NOT match: {pat:?}");
		}
	}

	// NEEDS_RE
	#[test]
	fn test_needs_re_matches() {
		let should_match = [
			r".",       // Single regex wildcard
			r"a+b",     // Regex +
			r"foo|bar", // Regex alternation
			r"abc?",    // Regex optional
			r"a*b",     // Regex star
			r"[abc]",   // Character class
			r"(abc)",   // Group
			r"{1,2}",   // Repetition
			r"\d",      // Class shorthand
			r"\S",      // Class shorthand
			r"\1",      // Backreference
			r"a\Pb",    // Unicode property
		];

		for pat in &should_match {
			assert!(NEEDS_RE.is_match(pat), "Expected NEEDS_RE to match: {pat:?}");
		}
	}

	#[test]
	fn test_needs_re_does_not_match() {
		let should_not_match = [
			r"abc",
			r"a\.b", // Escaped dot
			r"hello world",
			r"^abc$",  // Anchors alone
			r"file\.", // Escaped dot
			r"literal123",
			r"\\", // Escaped backslash
		];

		for pat in &should_not_match {
			assert!(!NEEDS_RE.is_match(pat), "Expected NEEDS_RE to NOT match: {pat:?}");
		}
	}

	// Regex::new
	#[test]
	fn assert_byte_selection() {
		let re = Regex::new(r"x*").unwrap();
		assert!(matches!(re, Regex::Byte(_)));
	}

	#[test]
	fn assert_fancy() {
		let re = Regex::new(r"(.)\1").unwrap();
		assert!(matches!(re, Regex::Fancy(_)));
	}

	#[test]
	fn assert_literal() {
		let re = Regex::new(r"x\.").unwrap();
		assert!(matches!(re, Regex::Literal(_)));
	}

	#[test]
	fn handles_invalid_regex_gracefully() {
		let err = Regex::new("(").unwrap_err().to_string();
		assert!(
			err.contains("unclosed group") || err.contains("error parsing"),
			"Unexpected error: {err:?}"
		);
	}

	// remove_escapes
	#[test]
	fn test_remove_escapes() {
		use super::remove_escapes;

		assert_eq!(remove_escapes("abc"), "abc");
		assert_eq!(remove_escapes(r"a\.c"), "a.c");
		assert_eq!(remove_escapes(r"\\d"), r"\d");
		assert_eq!(remove_escapes(r"\.\*\+\?"), ".*+?");
		assert_eq!(remove_escapes(r"escaped\\backslash"), r"escaped\backslash");
		assert_eq!(remove_escapes(r"trailing\\"), r"trailing\");
	}

	// LiteralMatcher
	#[test]
	fn test_literal_matcher_basic_match() {
		let matcher = LiteralMatcher::new("needle");
		assert!(matcher.is_match(b"this is a needle in a haystack"));
		assert!(!matcher.is_match(b"no match here"));
	}

	#[test]
	fn test_literal_matcher_anchor_start_match() {
		let matcher = LiteralMatcher::new("^needle");
		assert!(matcher.is_match(b"needle in a haystack"));
		assert!(!matcher.is_match(b"no needle match here"));
		assert!(!matcher.is_match(b"no"));
	}

	#[test]
	fn test_literal_matcher_anchor_end_match() {
		let matcher = LiteralMatcher::new("needle$");
		assert!(matcher.is_match(b"In a haystack there's a needle"));
		assert!(!matcher.is_match(b"no needle match here"));
		assert!(!matcher.is_match(b"no"));
	}

	#[test]
	fn test_literal_matcher_anchor_begin_end_match() {
		let matcher = LiteralMatcher::new("^needle$");
		assert!(matcher.is_match(b"needle"));
		assert!(!matcher.is_match(b"no needle match"));
		assert!(!matcher.is_match(b"needle no match"));
		assert!(!matcher.is_match(b"no match needle"));
		assert!(!matcher.is_match(b"nada"));
	}

	#[test]
	fn test_literal_matcher_utf8_match() {
		let matcher = LiteralMatcher::new("✓"); // U+2713 CHECK MARK (3 bytes)
		let haystack = "contains ✓ unicode".as_bytes();
		assert!(matcher.is_match(haystack));
		let found = matcher.find(haystack).unwrap();
		assert_eq!(found.2, "✓");
	}

	#[test]
	fn test_literal_matcher_find_location() {
		let matcher = LiteralMatcher::new("abc");
		let haystack = b"___abc___";
		let result = matcher.find(haystack);
		assert!(result.is_some());
		let (start, end, text) = result.unwrap();
		assert_eq!((start, end), (3, 6));
		assert_eq!(text, "abc");
	}

	#[test]
	fn test_literal_matcher_find_location_end() {
		let matcher = LiteralMatcher::new("abc$");
		let haystack = b"012abc";
		let result = matcher.find(haystack);
		assert!(result.is_some());
		let (start, end, text) = result.unwrap();
		assert_eq!((start, end), (3, 6));
		assert_eq!(text, "abc");
	}

	#[test]
	fn test_literal_matcher_iter_multiple() {
		let matcher = LiteralMatcher::new("test");
		let haystack = b"this test is a test of test matching";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 3);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, ["test", "test", "test"]);
	}

	#[test]
	fn test_literal_matcher_iter_begin() {
		let matcher = LiteralMatcher::new("^test");
		let haystack = b"test is a test of test matching";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 1);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, ["test"]);
	}

	#[test]
	fn test_literal_matcher_iter_end() {
		let matcher = LiteralMatcher::new("test$");
		let haystack = b"this test is a test of test";
		let matches: Vec<_> = matcher.iter(haystack).collect();
		assert_eq!(matches.len(), 1);

		let strings: Vec<_> = matches.iter().map(|(_, _, s)| *s).collect();
		assert_eq!(strings, ["test"]);
	}

	#[test]
	fn test_literal_matcher_no_match() {
		let matcher = LiteralMatcher::new("missing");
		let haystack = b"nothing to see here";
		assert!(!matcher.is_match(haystack));
		assert!(matcher.find(haystack).is_none());
		assert_eq!(matcher.iter(haystack).count(), 0);
	}

	#[test]
	fn test_literal_matcher_anchored_no_match() {
		let matcher = LiteralMatcher::new("^see$");
		let haystack = b"nothing to see here";
		assert!(!matcher.is_match(haystack));
		assert!(matcher.find(haystack).is_none());
		assert_eq!(matcher.iter(haystack).count(), 0);
	}

	#[test]
	fn prepends_s_when_no_flag_group() {
		assert_eq!(ensure_dotall("abc"), "(?s)abc");
	}

	#[test]
	fn adds_s_when_no_m_or_s() {
		assert_eq!(ensure_dotall("(?i)abc"), "(?is)abc");
		assert_eq!(ensure_dotall("(?)abc"), "(?s)abc");
	}

	#[test]
	fn leaves_m_unchanged() {
		assert_eq!(ensure_dotall("(?m)abc"), "(?m)abc");
		assert_eq!(ensure_dotall("(?im)abc"), "(?im)abc");
		assert_eq!(ensure_dotall("(?mi)abc"), "(?mi)abc");
	}

	#[test]
	fn leaves_existing_s_unchanged() {
		assert_eq!(ensure_dotall("(?s)abc"), "(?s)abc");
		assert_eq!(ensure_dotall("(?is)abc"), "(?is)abc");
	}

	#[test]
	fn leaves_malformed_flag_group_unchanged() {
		assert_eq!(ensure_dotall("(?iabc"), "(?iabc");
	}
}
