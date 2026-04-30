//! macOS power assertions for preventing idle sleep.
//!
//! Exposes a small N-API handle that acquires a macOS `IOKit` power assertion
//! on construction and releases it on `stop()`/drop. On non-macOS platforms the
//! handle is a no-op so higher layers can use one code path.

use napi_derive::napi;

/// Options for starting a macOS power assertion.
#[napi(object, js_name = "MacOSPowerAssertionOptions")]
pub struct MacOSPowerAssertionOptions {
	/// Human-readable reason shown in macOS power diagnostics.
	pub reason:  Option<String>,
	/// Keep the display awake in addition to preventing idle system sleep.
	pub display: Option<bool>,
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CString, c_char, c_void},
		ptr,
	};

	use napi::{Error, Result};

	const UTF8_ENCODING: u32 = 0x0800_0100;
	const ASSERTION_LEVEL_ON: u32 = 255;
	const ASSERTION_ID_NONE: u32 = 0;
	const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
	const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";

	type CFStringRef = *const c_void;
	type CFTypeRef = *const c_void;
	type IOPMAssertionID = u32;
	type IOPMAssertionLevel = u32;
	type IOReturn = i32;

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		fn CFStringCreateWithCString(
			alloc: *const c_void,
			c_str: *const c_char,
			encoding: u32,
		) -> CFStringRef;
		fn CFRelease(value: CFTypeRef);
	}

	#[link(name = "IOKit", kind = "framework")]
	unsafe extern "C" {
		fn IOPMAssertionCreateWithName(
			assertion_type: CFStringRef,
			assertion_level: IOPMAssertionLevel,
			assertion_name: CFStringRef,
			assertion_id: *mut IOPMAssertionID,
		) -> IOReturn;
		fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
	}

	struct CfString(CFStringRef);

	impl CfString {
		fn new(value: &str) -> Result<Self> {
			let c_string = CString::new(value).map_err(|_| {
				Error::from_reason("Power assertion strings must not contain NUL bytes")
			})?;
			// SAFETY: `c_string` is a valid, NUL-terminated UTF-8 byte sequence for the
			// duration of the call, and CoreFoundation copies the contents into a new
			// `CFString` when creation succeeds.
			let string_ref =
				unsafe { CFStringCreateWithCString(ptr::null(), c_string.as_ptr(), UTF8_ENCODING) };
			if string_ref.is_null() {
				return Err(Error::from_reason(
					"Failed to allocate CoreFoundation string for power assertion",
				));
			}
			Ok(Self(string_ref))
		}

		const fn as_ptr(&self) -> CFStringRef {
			self.0
		}
	}

	impl Drop for CfString {
		fn drop(&mut self) {
			if self.0.is_null() {
				return;
			}
			// SAFETY: `self.0` was returned by `CFStringCreateWithCString` in
			// `CfString::new` and this wrapper owns the single outstanding reference, so
			// releasing it here balances creation exactly once.
			unsafe { CFRelease(self.0) };
		}
	}

	pub struct AssertionInner {
		assertion_id: IOPMAssertionID,
	}

	impl AssertionInner {
		pub fn start(reason: &str, display: bool) -> Result<Self> {
			let assertion_type = CfString::new(if display {
				PREVENT_USER_IDLE_DISPLAY_SLEEP
			} else {
				PREVENT_USER_IDLE_SYSTEM_SLEEP
			})?;
			let assertion_reason = CfString::new(reason)?;
			let mut assertion_id = ASSERTION_ID_NONE;
			// SAFETY: both `CFStringRef` values are valid live CoreFoundation strings owned
			// by this stack frame, `ASSERTION_LEVEL_ON` is the documented enabled value,
			// and `assertion_id` points to writable storage for the returned identifier.
			let status = unsafe {
				IOPMAssertionCreateWithName(
					assertion_type.as_ptr(),
					ASSERTION_LEVEL_ON,
					assertion_reason.as_ptr(),
					&raw mut assertion_id,
				)
			};
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to acquire macOS power assertion (IOReturn={status})"
				)));
			}
			Ok(Self { assertion_id })
		}

		pub fn stop(&mut self) -> Result<()> {
			if self.assertion_id == ASSERTION_ID_NONE {
				return Ok(());
			}
			let assertion_id = self.assertion_id;
			self.assertion_id = ASSERTION_ID_NONE;
			// SAFETY: `assertion_id` came from a successful `IOPMAssertionCreateWithName`
			// call owned by this handle, and we clear local ownership before releasing so
			// the same assertion cannot be released twice.
			let status = unsafe { IOPMAssertionRelease(assertion_id) };
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to release macOS power assertion (IOReturn={status})"
				)));
			}
			Ok(())
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			let _ = self.stop();
		}
	}
}

/// Long-lived macOS power assertion.
///
/// On macOS this acquires an `IOKit` assertion that prevents idle sleep until
/// the handle is stopped or dropped. On other platforms it is a no-op handle so
/// the caller can keep one cross-platform code path.
#[napi(js_name = "MacOSPowerAssertion")]
pub struct MacOSPowerAssertion {
	#[cfg(target_os = "macos")]
	inner: Option<platform::AssertionInner>,
}

#[napi]
impl MacOSPowerAssertion {
	/// Acquire a macOS power assertion.
	#[napi(factory)]
	pub fn start(options: Option<MacOSPowerAssertionOptions>) -> napi::Result<Self> {
		let reason = options
			.as_ref()
			.and_then(|value| value.reason.as_deref())
			.filter(|value| !value.trim().is_empty())
			.unwrap_or("Oh My Pi agent session");
		let display = options
			.as_ref()
			.and_then(|value| value.display)
			.unwrap_or(false);
		#[cfg(target_os = "macos")]
		{
			Ok(Self { inner: Some(platform::AssertionInner::start(reason, display)?) })
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = reason;
			let _ = display;
			Ok(Self {})
		}
	}

	/// Release the power assertion early.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "not const on macOS")]
	pub fn stop(&mut self) -> napi::Result<()> {
		#[cfg(target_os = "macos")]
		if let Some(inner) = &mut self.inner {
			inner.stop()?;
		}
		Ok(())
	}
}
