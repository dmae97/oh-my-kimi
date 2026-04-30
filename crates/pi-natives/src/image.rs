//! Minimal image processing API for resizing and format conversion.
//!
//! Provides only the subset of functionality needed:
//! - Load image from bytes (PNG, JPEG, WebP, GIF)
//! - Get dimensions
//! - Resize with configurable filter
//! - Export as PNG, JPEG, WebP, or GIF

use std::{io::Cursor, sync::Arc};

use icy_sixel::{EncodeOptions, sixel_encode};
use image::{
	DynamicImage, ImageFormat as StdImageFormat, ImageReader, codecs::jpeg::JpegEncoder,
	imageops::FilterType,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Output format for [`PhotonImage::encode`].
#[napi]
pub enum ImageFormat {
	/// PNG encoded bytes.
	PNG  = 0,
	/// JPEG encoded bytes.
	JPEG = 1,
	/// WebP encoded bytes.
	WEBP = 2,
	/// GIF encoded bytes.
	GIF  = 3,
}

/// Sampling filter for resize operations.
#[napi]
pub enum SamplingFilter {
	/// Nearest-neighbor sampling (fast, low quality).
	Nearest    = 1,
	/// Triangle filter (linear interpolation).
	Triangle   = 2,
	/// Catmull-Rom filter with sharper edges.
	CatmullRom = 3,
	/// Gaussian filter for smoother results.
	Gaussian   = 4,
	/// Lanczos3 filter for high-quality downscaling.
	Lanczos3   = 5,
}

impl From<SamplingFilter> for FilterType {
	fn from(filter: SamplingFilter) -> Self {
		match filter {
			SamplingFilter::Nearest => Self::Nearest,
			SamplingFilter::Triangle => Self::Triangle,
			SamplingFilter::CatmullRom => Self::CatmullRom,
			SamplingFilter::Gaussian => Self::Gaussian,
			SamplingFilter::Lanczos3 => Self::Lanczos3,
		}
	}
}

/// Image container for native interop.
#[napi]
pub struct PhotonImage {
	/// Shared decoded image data.
	img: Arc<DynamicImage>,
}

type ImageTask = task::Promise<PhotonImage>;

#[napi]
impl PhotonImage {
	/// Create a new `PhotonImage` from encoded image bytes (PNG, JPEG, WebP,
	/// GIF). Returns the decoded image handle on success.
	///
	/// # Errors
	/// Returns an error if the image format cannot be detected or decoded.
	#[napi]
	pub fn parse(bytes: Uint8Array) -> ImageTask {
		let bytes = bytes.as_ref().to_vec();
		task::blocking("image.decode", (), move |_| -> Result<Self> {
			let img = decode_image_from_bytes(&bytes)?;
			Ok(Self { img: Arc::new(img) })
		})
	}

	/// Get the image width in pixels.
	#[napi(getter)]
	pub fn get_width(&self) -> u32 {
		self.img.width()
	}

	/// Get the image height in pixels.
	#[napi(getter)]
	pub fn get_height(&self) -> u32 {
		self.img.height()
	}

	/// Encode the image to bytes in the specified format.
	///
	/// # Errors
	/// Returns an error if encoding fails or format is invalid.
	#[napi]
	pub fn encode(&self, format: ImageFormat, quality: u8) -> task::Promise<Vec<u8>> {
		let img = Arc::clone(&self.img);
		task::blocking("image.encode", (), move |_| encode_image(&img, format, quality))
	}

	/// Resize the image to the specified pixel dimensions using the filter.
	/// Returns a new `PhotonImage` containing the resized image.
	#[napi]
	pub fn resize(&self, width: u32, height: u32, filter: SamplingFilter) -> ImageTask {
		let img = Arc::clone(&self.img);
		task::blocking("image.resize", (), move |_| {
			Ok(Self { img: Arc::new(img.resize_exact(width, height, filter.into())) })
		})
	}
}

/// Encode image bytes into a SIXEL escape sequence for terminal rendering.
///
/// The input image is decoded and resized to the requested pixel dimensions
/// before encoding.
///
/// # Errors
/// Returns an error if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
) -> Result<String> {
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}

	let source = decode_image_from_bytes(bytes.as_ref())?;
	let resized = if source.width() == target_width_px && source.height() == target_height_px {
		source
	} else {
		source.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
	};
	let rgba = resized.to_rgba8();
	let options = EncodeOptions::default();
	sixel_encode(rgba.as_raw(), target_width_px as usize, target_height_px as usize, &options)
		.map_err(|err| Error::from_reason(format!("Failed to encode SIXEL: {err}")))
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
	let reader = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;

	reader
		.decode()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}
fn encode_image(img: &DynamicImage, format: ImageFormat, quality: u8) -> Result<Vec<u8>> {
	let (w, h) = (img.width(), img.height());

	match format {
		ImageFormat::PNG => {
			let mut buffer = Vec::with_capacity((w * h * 4) as usize);
			img.write_to(&mut Cursor::new(&mut buffer), StdImageFormat::Png)
				.map_err(|e| Error::from_reason(format!("Failed to encode PNG: {e}")))?;
			Ok(buffer)
		},
		ImageFormat::JPEG => {
			let mut buffer = Vec::with_capacity((w * h * 3) as usize);
			let encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
			img.write_with_encoder(encoder)
				.map_err(|e| Error::from_reason(format!("Failed to encode JPEG: {e}")))?;
			Ok(buffer)
		},
		ImageFormat::WEBP => {
			// Lossy WebP via libwebp (the `image` crate's bundled WebP encoder is
			// lossless-only). quality is 0..=100; libwebp accepts an f32 in the same
			// range.
			let encoder = webp::Encoder::from_image(img)
				.map_err(|e| Error::from_reason(format!("Failed to prepare WebP encoder: {e}")))?;
			let memory = encoder.encode(quality as f32);
			Ok(memory.to_vec())
		},
		ImageFormat::GIF => {
			let mut buffer = Vec::with_capacity((w * h) as usize);
			img.write_to(&mut Cursor::new(&mut buffer), StdImageFormat::Gif)
				.map_err(|e| Error::from_reason(format!("Failed to encode GIF: {e}")))?;
			Ok(buffer)
		},
	}
}
