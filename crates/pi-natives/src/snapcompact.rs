//! Snapcompact frame rendering.
//!
//! Rasterizes pre-normalized conversation text onto a square 8-bit indexed
//! bitmap using the bundled public-domain X.org `5x8` BDF font, with glyph
//! ink cycling through six hues at sentence boundaries, then encodes the
//! bitmap as an indexed PNG.
//!
//! Text normalization, frame chunking, and archive management live in
//! `packages/agent/src/compaction/snapcompact.ts`; this module is only the
//! hot `text -> PNG bytes` path.

use std::{borrow::Cow, collections::HashMap, sync::LazyLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Horizontal advance per glyph cell in pixels.
const GLYPH_ADVANCE_X: usize = 5;
/// Vertical pitch per text row in pixels.
const GLYPH_PITCH_Y: usize = 8;

/// Upper bound on the frame edge: a hard stop against absurd allocations
/// (`size * size` pixel buffer), far above the 2576px production frame.
const MAX_FRAME_SIZE: u32 = 16384;

/// Sentence ink palette: index 0 is the white background, 1-6 are the six
/// dark hues from the eval renderer (HLS l=0.22 s=0.95, h ∈ {0, .08, .3,
/// .5, .62, .78}), pre-baked to sRGB.
const PALETTE: [[u8; 3]; 7] = [
	[255, 255, 255],
	[109, 2, 2],   // red
	[109, 53, 2],  // amber
	[24, 109, 2],  // green
	[2, 109, 109], // teal
	[2, 32, 109],  // blue
	[75, 2, 109],  // violet
];
const INK_COLORS: usize = PALETTE.len() - 1;

static FONT: LazyLock<Font> = LazyLock::new(|| parse_bdf(include_str!("fonts/5x8.bdf")));

struct Glyph {
	/// Glyph width in pixels (≤ 8 for this font).
	w:    u8,
	/// Glyph height in pixels.
	h:    i32,
	xoff: i32,
	yoff: i32,
	/// One bitmask per bitmap row, MSB-leftmost.
	rows: Vec<u8>,
}

struct Font {
	/// Glyphs keyed by Unicode code point (ASCII + Latin-1 coverage).
	glyphs: HashMap<u32, Glyph>,
	ascent: i32,
}

fn parse_bdf(text: &str) -> Font {
	let mut glyphs = HashMap::new();
	let mut ascent = 0i32;
	let mut enc = -1i64;
	let mut bbx = [0i32; 4];
	let mut lines = text.lines();
	while let Some(line) = lines.next() {
		if let Some(rest) = line.strip_prefix("FONT_ASCENT") {
			ascent = rest.trim().parse().unwrap_or(0);
		} else if let Some(rest) = line.strip_prefix("ENCODING") {
			enc = rest.trim().parse().unwrap_or(-1);
		} else if let Some(rest) = line.strip_prefix("BBX") {
			let mut parts = rest.split_ascii_whitespace();
			for slot in &mut bbx {
				*slot = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
			}
		} else if line.starts_with("BITMAP") {
			let mut rows = Vec::new();
			for row in lines.by_ref() {
				if row.starts_with("ENDCHAR") {
					break;
				}
				rows.push(u8::from_str_radix(row.trim(), 16).unwrap_or(0));
			}
			if enc >= 0 {
				glyphs.insert(enc as u32, Glyph {
					w: bbx[0].clamp(0, 8) as u8,
					h: bbx[1],
					xoff: bbx[2],
					yoff: bbx[3],
					rows,
				});
			}
		}
	}
	Font { glyphs, ascent }
}

/// Rasterize `text` onto a `size` x `size` palette-indexed bitmap, row-major
/// with no word wrap. Ink color advances at sentence boundaries (terminator
/// in `.!?` followed by a space). Characters beyond the grid capacity are
/// ignored; code points missing from the font leave their cell blank.
fn render_bitmap(text: &str, size: usize, font: &Font) -> Vec<u8> {
	let cols = size / GLYPH_ADVANCE_X;
	let grid_rows = size / GLYPH_PITCH_Y;
	let capacity = cols * grid_rows;
	let mut pixels = vec![0u8; size * size]; // 0 = white background
	if capacity == 0 {
		return pixels;
	}
	let codes: Vec<u32> = text.chars().map(|ch| ch as u32).collect();
	let count = codes.len().min(capacity);
	let mut sentence = 0usize;
	for i in 0..count {
		let code = codes[i];
		let ink = (1 + sentence % INK_COLORS) as u8;
		if matches!(code, 0x2e | 0x21 | 0x3f) && codes.get(i + 1) == Some(&0x20) {
			sentence += 1;
		}
		let Some(glyph) = font.glyphs.get(&code) else {
			continue;
		};
		if glyph.rows.is_empty() {
			continue;
		}
		let row = i / cols;
		let col = i - row * cols;
		let top = (row * GLYPH_PITCH_Y) as i32 + font.ascent - glyph.h - glyph.yoff;
		let left = (col * GLYPH_ADVANCE_X) as i32 + glyph.xoff;
		for (r, &bits) in glyph.rows.iter().enumerate() {
			if bits == 0 {
				continue;
			}
			let y = top + r as i32;
			if y < 0 || y >= size as i32 {
				continue;
			}
			let row_base = y as usize * size;
			for b in 0..glyph.w {
				if bits & (0x80u8 >> b) != 0 {
					let x = left + i32::from(b);
					if x >= 0 && (x as usize) < size {
						pixels[row_base + x as usize] = ink;
					}
				}
			}
		}
	}
	pixels
}

/// Pack one-byte-per-pixel palette indices into 4-bit PNG scanline data
/// (two pixels per byte, high nibble first). With only 7 palette entries,
/// 4-bit depth halves the pre-deflate stream vs 8-bit.
fn pack_nibbles(pixels: &[u8], size: usize) -> Vec<u8> {
	let row_bytes = size.div_ceil(2);
	let mut packed = vec![0u8; row_bytes * size];
	for y in 0..size {
		let src = &pixels[y * size..(y + 1) * size];
		let dst = &mut packed[y * row_bytes..(y + 1) * row_bytes];
		for (x, &px) in src.iter().enumerate() {
			dst[x / 2] |= px << (4 * (1 - x % 2));
		}
	}
	packed
}

/// Encode a palette-indexed bitmap as a 4-bit indexed PNG with `None` row
/// filtering (the glyph bitmap is already minimal-entropy; filtering costs
/// encode time without helping deflate).
fn encode_indexed_png(
	pixels: &[u8],
	size: usize,
	compression: png::Compression,
) -> Result<Vec<u8>> {
	let mut palette = Vec::with_capacity(PALETTE.len() * 3);
	for rgb in PALETTE {
		palette.extend_from_slice(&rgb);
	}
	let mut out = Vec::new();
	let mut encoder = png::Encoder::new(&mut out, size as u32, size as u32);
	encoder.set_color(png::ColorType::Indexed);
	encoder.set_depth(png::BitDepth::Four);
	encoder.set_palette(Cow::Owned(palette));
	encoder.set_compression(compression);
	// MUST come after `set_compression`, which resets the filter to the
	// compression level's default (`Adaptive` for `Balanced`).
	encoder.set_filter(png::Filter::NoFilter);
	let mut writer = encoder
		.write_header()
		.map_err(|err| Error::from_reason(format!("Failed to write PNG header: {err}")))?;
	writer
		.write_image_data(&pack_nibbles(pixels, size))
		.map_err(|err| Error::from_reason(format!("Failed to write PNG data: {err}")))?;
	writer
		.finish()
		.map_err(|err| Error::from_reason(format!("Failed to finish PNG stream: {err}")))?;
	Ok(out)
}

/// Render one snapcompact frame: print pre-normalized text onto a
/// `size` x `size` 4-bit indexed bitmap and encode it as a PNG.
///
/// The glyph grid holds `floor(size/5) * floor(size/8)` characters; input
/// beyond that is ignored (the caller chunks text to capacity). Returns the
/// PNG bytes.
#[napi]
pub fn render_snapcompact_png(text: String, size: u32) -> Result<Uint8Array> {
	if size == 0 || size > MAX_FRAME_SIZE {
		return Err(Error::from_reason(format!(
			"Invalid frame size {size}: expected 1..={MAX_FRAME_SIZE}"
		)));
	}
	let pixels = render_bitmap(&text, size as usize, &FONT);
	Ok(encode_indexed_png(&pixels, size as usize, png::Compression::Balanced)?.into())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn font_parses_ascii_coverage() {
		let font = &*FONT;
		assert_eq!(font.ascent, 7);
		// Every printable ASCII char must have a glyph.
		for cp in 0x20u32..0x7f {
			assert!(font.glyphs.contains_key(&cp), "missing glyph for U+{cp:04X}");
		}
	}

	#[test]
	fn bitmap_inks_sentences_and_caps_capacity() {
		let font = &*FONT;
		// 40px -> 8 cols x 5 rows = 40 cells.
		let pixels = render_bitmap("Hi. Ok.", 40, font);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1), "first sentence should use ink 1");
		assert!(inks.contains(&2), "second sentence should use ink 2");
		assert!(!inks.contains(&3), "no third sentence ink expected");

		// Overflow input renders without panicking and stays in-bounds.
		let overflow = render_bitmap(&"x".repeat(100), 40, font);
		assert_eq!(overflow.len(), 40 * 40);
	}
}
