//! Filesystem utilities

use std::{borrow::Cow, path::Path};
#[cfg(any(windows, test))]
use std::path::PathBuf;

/// Normalizes shell-facing path aliases before std::fs sees them.
pub fn normalize_shell_path(path: &Path) -> Cow<'_, Path> {
	#[cfg(windows)]
	{
		translate_unix_drive_path(path).map_or(Cow::Borrowed(path), Cow::Owned)
	}
	#[cfg(not(windows))]
	{
		Cow::Borrowed(path)
	}
}

#[cfg(any(windows, test))]
fn translate_unix_drive_path(path: &Path) -> Option<PathBuf> {
	let raw = path.to_str()?;
	let bytes = raw.as_bytes();
	let (drive, tail) = drive_alias_parts(bytes)?;

	let mut native = String::with_capacity(3 + tail.len());
	native.push(char::from(drive).to_ascii_uppercase());
	native.push(':');
	native.push('\\');
	for &byte in tail {
		native.push(if is_path_separator(byte) { '\\' } else { char::from(byte) });
	}
	Some(PathBuf::from(native))
}

#[cfg(any(windows, test))]
fn drive_alias_parts(bytes: &[u8]) -> Option<(u8, &[u8])> {
	if bytes.len() >= 2
		&& is_path_separator(bytes[0])
		&& bytes[1].is_ascii_alphabetic()
		&& bytes.get(2).is_none_or(|byte| is_path_separator(*byte))
	{
		let tail = if bytes.len() > 2 { &bytes[3..] } else { &[] };
		return Some((bytes[1], tail));
	}

	if bytes.len() >= 6
		&& is_path_separator(bytes[0])
		&& bytes[1..4].eq_ignore_ascii_case(b"mnt")
		&& is_path_separator(bytes[4])
		&& bytes[5].is_ascii_alphabetic()
		&& bytes.get(6).is_none_or(|byte| is_path_separator(*byte))
	{
		let tail = if bytes.len() > 6 { &bytes[7..] } else { &[] };
		return Some((bytes[5], tail));
	}

	None
}

#[cfg(any(windows, test))]
const fn is_path_separator(byte: u8) -> bool {
	byte == b'/' || byte == b'\\'
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unix_drive_aliases_translate_to_windows_roots() {
		assert_eq!(translate_unix_drive_path(Path::new("/c")).as_deref(), Some(Path::new("C:\\")));
		assert_eq!(
			translate_unix_drive_path(Path::new("/d/project/app")).as_deref(),
			Some(Path::new("D:\\project\\app")),
		);
		assert_eq!(
			translate_unix_drive_path(Path::new("/D/project")).as_deref(),
			Some(Path::new("D:\\project")),
		);
	}

	#[test]
	fn wsl_mount_drive_aliases_translate_to_windows_roots() {
		assert_eq!(
			translate_unix_drive_path(Path::new("/mnt/d/project")).as_deref(),
			Some(Path::new("D:\\project")),
		);
		assert_eq!(
			translate_unix_drive_path(Path::new("/MNT/c")).as_deref(),
			Some(Path::new("C:\\")),
		);
	}

	#[test]
	fn non_drive_absolute_paths_are_left_native() {
		assert_eq!(translate_unix_drive_path(Path::new("/")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("/dev/null")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("/mnt/data")).as_deref(), None);
		assert_eq!(translate_unix_drive_path(Path::new("relative/path")).as_deref(), None);
	}
}

pub use super::platform::fs::*;

/// Extension trait for path-related filesystem operations.
pub trait PathExt {
	/// Returns true if the path exists and is readable by the current user.
	fn readable(&self) -> bool;
	/// Returns true if the path exists and is writable by the current user.
	fn writable(&self) -> bool;
	/// Returns true if the path exists and is executable by the current user.
	///
	/// On Windows, this returns true if *either* the path itself is a file with
	/// a `PATHEXT` extension *or* appending some `PATHEXT` extension resolves
	/// to an existing file. To recover the actual on-disk path in the
	/// latter case, use [`resolve_executable`] which takes ownership
	/// and avoids copies on platforms where no resolution is needed.
	fn executable(&self) -> bool;

	/// Returns true if the path exists and is a block device.
	fn exists_and_is_block_device(&self) -> bool;
	/// Returns true if the path exists and is a character device.
	fn exists_and_is_char_device(&self) -> bool;
	/// Returns true if the path exists and is a FIFO (named pipe).
	fn exists_and_is_fifo(&self) -> bool;
	/// Returns true if the path exists and is a socket.
	fn exists_and_is_socket(&self) -> bool;
	/// Returns true if the path exists and has the setgid bit set.
	fn exists_and_is_setgid(&self) -> bool;
	/// Returns true if the path exists and has the setuid bit set.
	fn exists_and_is_setuid(&self) -> bool;
	/// Returns true if the path exists and has the sticky bit set.
	fn exists_and_is_sticky_bit(&self) -> bool;

	/// Returns the device ID and inode number for the path.
	fn get_device_and_inode(&self) -> Result<(u64, u64), crate::error::Error>;
}
