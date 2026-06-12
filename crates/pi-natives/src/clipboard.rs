//! Clipboard utilities backed by arboard.
//!
//! Provides text copy and image read support across Linux, macOS, and Windows.
//! Performs text copy synchronously so macOS writes run on the caller thread.
//! This avoids worker-thread `AppKit` pasteboard warnings in CLI contexts.

use std::io::Cursor;

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Clipboard image payload encoded as PNG bytes.
#[napi(object)]
pub struct ClipboardImage {
	/// PNG-encoded image bytes.
	pub data:      Uint8Array,
	/// MIME type for the encoded image payload.
	pub mime_type: String,
}

fn encode_png(image: ImageData<'_>) -> Result<Vec<u8>> {
	let width = u32::try_from(image.width)
		.map_err(|_| Error::from_reason("Clipboard image width overflow"))?;
	let height = u32::try_from(image.height)
		.map_err(|_| Error::from_reason("Clipboard image height overflow"))?;
	let bytes = image.bytes.into_owned();
	let buffer = RgbaImage::from_raw(width, height, bytes)
		.ok_or_else(|| Error::from_reason("Clipboard image buffer size mismatch"))?;
	let capacity = width.saturating_mul(height).saturating_mul(4) as usize;
	let mut output = Vec::with_capacity(capacity);
	DynamicImage::ImageRgba8(buffer)
		.write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode clipboard image: {err}")))?;
	Ok(output)
}

/// Copy plain text to the system clipboard.
///
/// # Parameters
/// - `text`: UTF-8 text to place on the clipboard.
///
/// # Errors
/// Returns an error if clipboard access fails.
#[napi]
pub fn copy_to_clipboard(text: String) -> Result<()> {
	set_clipboard_text(text)
}

/// Linux: keep a single `arboard::Clipboard` alive for the whole process.
///
/// X11 (and Wayland) clipboards are owner-based: the process that set the
/// selection must stay alive and answer `SelectionRequest` events, otherwise
/// the contents vanish the moment the owner goes away. arboard serves those
/// requests from a global background thread that only lives as long as a
/// `Clipboard` instance exists — so creating a throwaway `Clipboard` per copy
/// (which is then dropped) tears that thread down immediately and leaves the
/// X11 clipboard empty even while our process keeps running (issue #2075).
/// Holding one instance for the lifetime of the process keeps that owner thread
/// serving, without shelling out to `xclip`/`wl-copy`. Wayland is unaffected
/// (`wl-clipboard-rs` forks its own serving process) but sharing the instance
/// is harmless there.
#[cfg(target_os = "linux")]
fn set_clipboard_text(text: String) -> Result<()> {
	use std::sync::{Mutex, OnceLock};

	static CLIPBOARD: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
	let cell = CLIPBOARD.get_or_init(|| Mutex::new(None));
	let mut guard = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	if guard.is_none() {
		*guard = Some(
			Clipboard::new()
				.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?,
		);
	}
	guard
		.as_mut()
		.expect("clipboard initialized above")
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

/// macOS / Windows: the OS retains clipboard contents after the writing process
/// exits, so a transient `Clipboard` is sufficient. Keeping the write on the
/// calling thread also avoids worker-thread `AppKit` pasteboard warnings on
/// macOS.
#[cfg(not(target_os = "linux"))]
fn set_clipboard_text(text: String) -> Result<()> {
	let mut clipboard = Clipboard::new()
		.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
	clipboard
		.set_text(text)
		.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
	Ok(())
}

/// Read an image from the system clipboard.
///
/// Returns `Ok(None)` when no image data is available.
///
/// # Errors
/// Returns an error if clipboard access fails or image encoding fails.
#[napi]
pub fn read_image_from_clipboard() -> task::Promise<Option<ClipboardImage>> {
	task::blocking("clipboard.read_image", (), move |_| -> Result<Option<ClipboardImage>> {
		let mut clipboard = Clipboard::new()
			.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
		match clipboard.get_image() {
			Ok(image) => {
				let bytes = encode_png(image)?;
				Ok(Some(ClipboardImage {
					data:      Uint8Array::from(bytes),
					mime_type: "image/png".to_string(),
				}))
			},
			Err(ClipboardError::ContentNotAvailable) => Ok(None),
			Err(err) => Err(Error::from_reason(format!("Failed to read clipboard image: {err}"))),
		}
	})
}
