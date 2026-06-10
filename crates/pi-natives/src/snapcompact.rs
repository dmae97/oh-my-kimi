//! Snapcompact frame rendering.
//!
//! Rasterizes pre-normalized conversation text onto a square bitmap using one
//! of the bundled public-domain pixel fonts, then encodes it as PNG:
//!
//! - `5x8`  — X.org BDF font (legacy shape).
//! - `8x8`  — unscii-8 hex font (Latin-1 subset), the square cell that won the
//!   snapcompact `SQuAD` evals.
//!
//! Shape controls, all eval-validated in `packages/snapcompact`:
//!
//! - **variant** — `sent` cycles glyph ink through six hues at sentence
//!   boundaries; `bw` prints plain black ink (best for Anthropic readers).
//! - **lineRepeat** — prints every text line N times; copies after the first
//!   sit on a pale highlight band. Redundancy coding: two looks per glyph at
//!   half the density ("8x8r" shapes).
//! - **cellWidth/cellHeight** — target cell size. When it differs from the
//!   font's natural cell, glyphs are rasterized at native size and the canvas
//!   is Lanczos3-resampled to the target (anisotropic stretch, e.g. the
//!   OpenAI-optimal "6x6u" shape), producing an anti-aliased RGB frame.
//! - **dim spans** — `U+000E`/`U+000F` in the text toggle dim gray ink on/off
//!   without occupying a cell; the TypeScript serializer wraps tool output in
//!   them so archived conversation reads louder than archived tool noise.
//!
//! Text normalization, frame chunking, provider shape selection, and archive
//! management live in `packages/snapcompact/src/snapcompact.ts`; this module
//! is only the hot `text -> PNG bytes` path.

use std::{borrow::Cow, collections::HashMap, f32::consts::PI, sync::LazyLock};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Upper bound on the frame edge: a hard stop against absurd allocations
/// (`size * size` pixel buffer), far above the 2576px production frame.
const MAX_FRAME_SIZE: u32 = 16384;

/// Indexed palette: 0 is the white background, 1-6 are the six dark sentence
/// hues from the eval renderer (HLS l=0.22 s=0.95, h ∈ {0, .08, .3, .5, .62,
/// .78}), 7 is plain black ink (`bw` variant), 8 is the pale highlight band
/// behind repeated line copies, 9 is the dim gray ink for tool-output spans.
const PALETTE: [[u8; 3]; 10] = [
	[255, 255, 255],
	[109, 2, 2],     // red
	[109, 53, 2],    // amber
	[24, 109, 2],    // green
	[2, 109, 109],   // teal
	[2, 32, 109],    // blue
	[75, 2, 109],    // violet
	[0, 0, 0],       // bw ink
	[255, 247, 194], // repeat highlight band
	[128, 128, 128], // dim ink (tool-output spans)
];
const INK_COLORS: usize = 6;
const INK_BLACK: u8 = 7;
const BG_REPEAT: u8 = 8;
const INK_DIM: u8 = 9;
/// Zero-width ink toggles embedded in the text stream (shift-out/shift-in).
const DIM_ON: u32 = 0x0e;
const DIM_OFF: u32 = 0x0f;

static FONT_5X8: LazyLock<Font> = LazyLock::new(|| parse_bdf(include_str!("fonts/5x8.bdf"), 5, 8));
static FONT_8X8: LazyLock<Font> = LazyLock::new(|| parse_hex(include_str!("fonts/unscii-8.hex")));

struct Glyph {
	/// Glyph width in pixels (≤ 8 for the bundled fonts).
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
	/// Natural cell advance (x) in pixels.
	cell_w: usize,
	/// Natural cell pitch (y) in pixels.
	cell_h: usize,
}

fn parse_bdf(text: &str, cell_w: usize, cell_h: usize) -> Font {
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
	Font { glyphs, ascent, cell_w, cell_h }
}

/// Parse a unifont-style `.hex` font (`CODEPOINT:16-hex-digit bitmap`, one
/// byte per row of an 8x8 glyph). Baseline sits at row 7 (`ascent` 7 with a
/// one-pixel descender row), matching the eval renderer.
fn parse_hex(text: &str) -> Font {
	let mut glyphs = HashMap::new();
	for line in text.lines() {
		let Some((cp, bits)) = line.split_once(':') else {
			continue;
		};
		let Ok(enc) = u32::from_str_radix(cp.trim(), 16) else {
			continue;
		};
		let bits = bits.trim();
		if bits.len() != 16 {
			continue;
		}
		let rows: Vec<u8> = (0..8)
			.map(|i| u8::from_str_radix(&bits[i * 2..i * 2 + 2], 16).unwrap_or(0))
			.collect();
		glyphs.insert(enc, Glyph { w: 8, h: 8, xoff: 0, yoff: -1, rows });
	}
	Font { glyphs, ascent: 7, cell_w: 8, cell_h: 8 }
}

fn resolve_font(name: &str) -> Option<&'static Font> {
	match name {
		"5x8" => Some(&FONT_5X8),
		"8x8" => Some(&FONT_8X8),
		_ => None,
	}
}

/// Frame grid geometry shared with the TypeScript caller.
struct Grid {
	cols:   usize,
	rows:   usize,
	repeat: usize,
}

/// Rasterize `text` onto a `width` x `height` palette-indexed bitmap at the
/// font's natural cell size, row-major with no word wrap. Each text line is
/// printed `grid.repeat` times; copies after the first sit on the highlight
/// band. Ink cycles through six hues at sentence boundaries (terminator in
/// `.!?` followed by a space) unless `black_ink` pins it to black; `U+000E`/
/// `U+000F` toggle dim gray ink without occupying a cell, and dim wins over
/// both variants. Characters beyond `cols * rows` are ignored; code points
/// missing from the font leave their cell blank.
fn render_bitmap(
	text: &str,
	width: usize,
	height: usize,
	font: &Font,
	grid: &Grid,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![0u8; width * height]; // 0 = white background
	let capacity = grid.cols * grid.rows;
	if capacity == 0 {
		return pixels;
	}
	if grid.repeat > 1 {
		for row in 0..grid.rows {
			for copy in 1..grid.repeat {
				let band_top = (row * grid.repeat + copy) * font.cell_h;
				for y in band_top..(band_top + font.cell_h).min(height) {
					pixels[y * width..y * width + width].fill(BG_REPEAT);
				}
			}
		}
	}
	let codes: Vec<u32> = text.chars().map(|ch| ch as u32).collect();
	let mut sentence = 0usize;
	let mut dim = false;
	let mut cell = 0usize;
	for i in 0..codes.len() {
		if cell >= capacity {
			break;
		}
		let code = codes[i];
		match code {
			DIM_ON => {
				dim = true;
				continue;
			},
			DIM_OFF => {
				dim = false;
				continue;
			},
			_ => {},
		}
		let ink = if dim {
			INK_DIM
		} else if black_ink {
			INK_BLACK
		} else {
			(1 + sentence % INK_COLORS) as u8
		};
		if matches!(code, 0x2e | 0x21 | 0x3f) && codes.get(i + 1) == Some(&0x20) {
			sentence += 1;
		}
		let row = cell / grid.cols;
		let col = cell - row * grid.cols;
		cell += 1;
		let Some(glyph) = font.glyphs.get(&code) else {
			continue;
		};
		if glyph.rows.is_empty() {
			continue;
		}
		let left = (col * font.cell_w) as i32 + glyph.xoff;
		for copy in 0..grid.repeat {
			let cell_top = ((row * grid.repeat + copy) * font.cell_h) as i32;
			let top = cell_top + font.ascent - glyph.h - glyph.yoff;
			for (r, &bits) in glyph.rows.iter().enumerate() {
				if bits == 0 {
					continue;
				}
				let y = top + r as i32;
				if y < 0 || y >= height as i32 {
					continue;
				}
				let row_base = y as usize * width;
				for b in 0..glyph.w {
					if bits & (0x80u8 >> b) != 0 {
						let x = left + i32::from(b);
						if x >= 0 && (x as usize) < width {
							pixels[row_base + x as usize] = ink;
						}
					}
				}
			}
		}
	}
	pixels
}

// ============================================================================
// Lanczos3 resampling (stretch shapes)
// ============================================================================

fn lanczos3(x: f32) -> f32 {
	let x = x.abs();
	if x < 1e-6 {
		return 1.0;
	}
	if x >= 3.0 {
		return 0.0;
	}
	let pix = PI * x;
	(pix.sin() / pix) * ((pix / 3.0).sin() / (pix / 3.0))
}

/// Per-output-pixel kernel contributions for one axis, PIL-convention
/// (`center = (i + 0.5) * scale`, kernel stretched by `max(scale, 1)`,
/// weights normalized).
fn contributions(src_len: usize, dst_len: usize) -> Vec<(usize, Vec<f32>)> {
	let scale = src_len as f32 / dst_len as f32;
	let filt_scale = scale.max(1.0);
	let support = 3.0 * filt_scale;
	let mut out = Vec::with_capacity(dst_len);
	for i in 0..dst_len {
		let center = (i as f32 + 0.5) * scale;
		let begin = ((center - support) as isize).max(0) as usize;
		let end = ((center + support).ceil() as usize).min(src_len);
		let mut weights = Vec::with_capacity(end - begin);
		let mut total = 0.0f32;
		for x in begin..end {
			let w = lanczos3((x as f32 + 0.5 - center) / filt_scale);
			weights.push(w);
			total += w;
		}
		if total != 0.0 {
			for w in &mut weights {
				*w /= total;
			}
		}
		out.push((begin, weights));
	}
	out
}

/// Separable Lanczos3 resize of an interleaved RGB f32 buffer.
fn resize_rgb(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
	let horiz = contributions(sw, dw);
	let mut tmp = vec![0f32; dw * sh * 3];
	for y in 0..sh {
		let src_row = &src[y * sw * 3..(y + 1) * sw * 3];
		let dst_row = &mut tmp[y * dw * 3..(y + 1) * dw * 3];
		for (x, (begin, weights)) in horiz.iter().enumerate() {
			let mut acc = [0f32; 3];
			for (k, &w) in weights.iter().enumerate() {
				let s = (begin + k) * 3;
				acc[0] = src_row[s].mul_add(w, acc[0]);
				acc[1] = src_row[s + 1].mul_add(w, acc[1]);
				acc[2] = src_row[s + 2].mul_add(w, acc[2]);
			}
			dst_row[x * 3..x * 3 + 3].copy_from_slice(&acc);
		}
	}
	let vert = contributions(sh, dh);
	let mut out = vec![0f32; dw * dh * 3];
	for (y, (begin, weights)) in vert.iter().enumerate() {
		let dst_row = &mut out[y * dw * 3..(y + 1) * dw * 3];
		for (k, &w) in weights.iter().enumerate() {
			let src_row = &tmp[(begin + k) * dw * 3..(begin + k + 1) * dw * 3];
			for (d, &s) in dst_row.iter_mut().zip(src_row) {
				*d = s.mul_add(w, *d);
			}
		}
	}
	out
}

// ============================================================================
// PNG encoding
// ============================================================================

/// Pack one-byte-per-pixel palette indices into 4-bit PNG scanline data
/// (two pixels per byte, high nibble first). With only 9 palette entries,
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

/// Encode an interleaved RGB8 buffer as PNG. Stretched frames are
/// continuous-tone, so adaptive filtering (the `Balanced` default) helps.
fn encode_rgb_png(pixels: &[u8], size: usize, compression: png::Compression) -> Result<Vec<u8>> {
	let mut out = Vec::new();
	let mut encoder = png::Encoder::new(&mut out, size as u32, size as u32);
	encoder.set_color(png::ColorType::Rgb);
	encoder.set_depth(png::BitDepth::Eight);
	encoder.set_compression(compression);
	let mut writer = encoder
		.write_header()
		.map_err(|err| Error::from_reason(format!("Failed to write PNG header: {err}")))?;
	writer
		.write_image_data(pixels)
		.map_err(|err| Error::from_reason(format!("Failed to write PNG data: {err}")))?;
	writer
		.finish()
		.map_err(|err| Error::from_reason(format!("Failed to finish PNG stream: {err}")))?;
	Ok(out)
}

// ============================================================================
// Entry point
// ============================================================================

/// Shape options for one snapcompact frame.
#[napi(object)]
#[derive(Default)]
pub struct SnapcompactRenderOptions {
	/// Frame edge in pixels.
	pub size:        u32,
	/// Bundled font: `"5x8"` (X.org BDF) or `"8x8"` (unscii-8). Default `"5x8"`.
	pub font:        Option<String>,
	/// Target cell advance in pixels. Differing from the font's natural cell
	/// triggers the Lanczos stretch path. Default: font natural width.
	pub cell_width:  Option<u32>,
	/// Target cell pitch in pixels. Default: font natural height.
	pub cell_height: Option<u32>,
	/// Ink variant: `"sent"` (six-hue sentence cycling) or `"bw"` (black).
	/// Default `"sent"`.
	pub variant:     Option<String>,
	/// Print each text line this many times; copies after the first sit on a
	/// pale highlight band. Default 1.
	pub line_repeat: Option<u32>,
}

/// Render one snapcompact frame: print pre-normalized text onto a square
/// bitmap and encode it as PNG.
///
/// The glyph grid holds `floor(size/cellWidth) *
/// floor(size/cellHeight/lineRepeat)` characters; input beyond that is ignored
/// (the caller chunks text to capacity). Native-cell shapes encode as 4-bit
/// indexed PNG; stretched shapes (target cell != font cell) encode as RGB.
/// `U+000E`/`U+000F` in `text` toggle dim-gray ink spans without occupying a
/// cell.
/// Returns the PNG encoded as base64, created as a one-byte (Latin-1) JS
/// string straight from native code — no `Uint8Array` hop or JS-side
/// re-encode.
#[napi]
pub fn render_snapcompact_png(
	text: String,
	options: SnapcompactRenderOptions,
) -> Result<Latin1String> {
	let size = options.size;
	if size == 0 || size > MAX_FRAME_SIZE {
		return Err(Error::from_reason(format!(
			"Invalid frame size {size}: expected 1..={MAX_FRAME_SIZE}"
		)));
	}
	let font_name = options.font.as_deref().unwrap_or("5x8");
	let font = resolve_font(font_name).ok_or_else(|| {
		Error::from_reason(format!(
			"Unknown snapcompact font {font_name:?}: expected \"5x8\" or \"8x8\""
		))
	})?;
	let black_ink = match options.variant.as_deref().unwrap_or("sent") {
		"sent" => false,
		"bw" => true,
		other => {
			return Err(Error::from_reason(format!(
				"Unknown snapcompact variant {other:?}: expected \"sent\" or \"bw\""
			)));
		},
	};
	let target_w = options.cell_width.unwrap_or(font.cell_w as u32).max(1) as usize;
	let target_h = options.cell_height.unwrap_or(font.cell_h as u32).max(1) as usize;
	let repeat = options.line_repeat.unwrap_or(1).max(1) as usize;
	let size = size as usize;
	let grid = Grid { cols: size / target_w, rows: size / target_h / repeat, repeat };
	if grid.cols == 0 || grid.rows == 0 {
		return Err(Error::from_reason(format!(
			"Frame size {size} cannot fit a {target_w}x{target_h} cell grid (repeat {repeat})"
		)));
	}

	if (target_w, target_h) == (font.cell_w, font.cell_h) {
		// Native cell: rasterize straight onto the frame, indexed.
		let pixels = render_bitmap(&text, size, size, font, &grid, black_ink);
		return Ok(STANDARD
			.encode(encode_indexed_png(&pixels, size, png::Compression::Balanced)?)
			.into());
	}

	// Stretch shape: rasterize at the font's natural cell on a tight canvas,
	// Lanczos3-resample to the target cell, paste onto the white frame.
	let src_w = grid.cols * font.cell_w;
	let src_h = grid.rows * grid.repeat * font.cell_h;
	let dst_w = grid.cols * target_w;
	let dst_h = grid.rows * grid.repeat * target_h;
	let indexed = render_bitmap(&text, src_w, src_h, font, &grid, black_ink);
	let mut rgb = vec![0f32; src_w * src_h * 3];
	for (dst, &idx) in rgb.chunks_exact_mut(3).zip(&indexed) {
		let [r, g, b] = PALETTE[idx as usize];
		dst[0] = f32::from(r);
		dst[1] = f32::from(g);
		dst[2] = f32::from(b);
	}
	let resized = resize_rgb(&rgb, src_w, src_h, dst_w, dst_h);
	let mut frame = vec![255u8; size * size * 3];
	for y in 0..dst_h.min(size) {
		let src_row = &resized[y * dst_w * 3..(y + 1) * dst_w * 3];
		let dst_row = &mut frame[y * size * 3..];
		for (d, &s) in dst_row[..dst_w.min(size) * 3].iter_mut().zip(src_row) {
			*d = s.round().clamp(0.0, 255.0) as u8;
		}
	}
	Ok(STANDARD
		.encode(encode_rgb_png(&frame, size, png::Compression::Balanced)?)
		.into())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn opts(size: u32) -> SnapcompactRenderOptions {
		SnapcompactRenderOptions { size, ..Default::default() }
	}

	#[test]
	fn fonts_parse_ascii_coverage() {
		for (font, ascent) in [(&*FONT_5X8, 7), (&*FONT_8X8, 7)] {
			assert_eq!(font.ascent, ascent);
			// Every printable ASCII char must have a glyph.
			for cp in 0x20u32..0x7f {
				assert!(font.glyphs.contains_key(&cp), "missing glyph for U+{cp:04X}");
			}
		}
	}

	#[test]
	fn bitmap_inks_sentences_and_caps_capacity() {
		// 40px -> 8 cols x 5 rows = 40 cells (5x8 font).
		let grid = Grid { cols: 8, rows: 5, repeat: 1 };
		let pixels = render_bitmap("Hi. Ok.", 40, 40, &FONT_5X8, &grid, false);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1), "first sentence should use ink 1");
		assert!(inks.contains(&2), "second sentence should use ink 2");
		assert!(!inks.contains(&3), "no third sentence ink expected");

		// Overflow input renders without panicking and stays in-bounds.
		let overflow = render_bitmap(&"x".repeat(100), 40, 40, &FONT_5X8, &grid, false);
		assert_eq!(overflow.len(), 40 * 40);
	}

	#[test]
	fn bw_variant_prints_black_only() {
		let grid = Grid { cols: 8, rows: 8, repeat: 1 };
		let pixels = render_bitmap("Hi. Ok.", 64, 64, &FONT_8X8, &grid, true);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(!inks.is_empty());
		assert!(inks.iter().all(|&p| p == INK_BLACK), "bw must ink only black");
	}

	#[test]
	fn dim_markers_toggle_gray_without_consuming_cells() {
		let grid = Grid { cols: 8, rows: 8, repeat: 1 };
		let pixels = render_bitmap("\u{e}AB\u{f}CD", 64, 64, &FONT_8X8, &grid, true);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&INK_DIM), "dim span must ink gray");
		assert!(inks.contains(&INK_BLACK), "post-span text must return to black");
		// Markers are zero-width: glyphs land in the same cells as without them.
		let plain = render_bitmap("ABCD", 64, 64, &FONT_8X8, &grid, true);
		for (i, (a, b)) in pixels.iter().zip(&plain).enumerate() {
			assert_eq!(*a != 0, *b != 0, "cell layout must ignore markers (pixel {i})");
		}
	}

	#[test]
	fn line_repeat_duplicates_rows_on_highlight_bands() {
		// 64px, 8x8 font, repeat 2 -> 8 cols x 4 unique rows.
		let grid = Grid { cols: 8, rows: 4, repeat: 2 };
		let pixels = render_bitmap("ABCDEFGH", 64, 64, &FONT_8X8, &grid, true);
		// Copy band (rows 8..16) carries the highlight background.
		assert!(pixels[9 * 64..10 * 64].contains(&BG_REPEAT), "duplicate band must be highlighted");
		// Identical glyph ink in both copies: compare full 8-row bands modulo
		// background.
		for y in 0..8 {
			for x in 0..64 {
				let a = pixels[y * 64 + x];
				let b = pixels[(y + 8) * 64 + x];
				assert_eq!(a == INK_BLACK, b == INK_BLACK, "copy ink mismatch at ({x},{y})");
			}
		}
	}

	/// Decode the base64 JS-string payload back to PNG bytes for inspection.
	fn png_bytes(encoded: Latin1String) -> Vec<u8> {
		STANDARD
			.decode(&*encoded)
			.expect("output must be valid base64")
	}

	#[test]
	fn render_native_is_indexed_and_stretch_is_rgb() {
		let native = png_bytes(
			render_snapcompact_png("Hello world. Again.".into(), SnapcompactRenderOptions {
				size: 128,
				font: Some("8x8".into()),
				variant: Some("bw".into()),
				line_repeat: Some(2),
				..Default::default()
			})
			.unwrap(),
		);
		// PNG color type lives at byte 25 of the IHDR: 3 = indexed.
		assert_eq!(native[25], 3);

		let stretched = png_bytes(
			render_snapcompact_png("Hello world. Again.".into(), SnapcompactRenderOptions {
				size: 128,
				font: Some("8x8".into()),
				cell_width: Some(6),
				cell_height: Some(6),
				..Default::default()
			})
			.unwrap(),
		);
		// 2 = truecolor RGB.
		assert_eq!(stretched[25], 2);
		let legacy = png_bytes(render_snapcompact_png("Hi. Ok.".into(), opts(40)).unwrap());
		assert_eq!(legacy[25], 3, "default shape stays the legacy 5x8 indexed path");
	}

	#[test]
	fn rejects_bad_shapes() {
		assert!(render_snapcompact_png("x".into(), opts(0)).is_err());
		assert!(
			render_snapcompact_png("x".into(), SnapcompactRenderOptions {
				size: 64,
				font: Some("9x9".into()),
				..Default::default()
			})
			.is_err()
		);
		assert!(
			render_snapcompact_png("x".into(), SnapcompactRenderOptions {
				size: 64,
				variant: Some("zebra".into()),
				..Default::default()
			})
			.is_err()
		);
	}
}
