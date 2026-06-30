//! Platform directory traversal fast path for no-ignore filesystem scans.
//!
//! This module keeps ignore semantics out of the native path on purpose. The
//! `ignore` crate owns `.ignore`/`.gitignore`/global-exclude behavior; the fast
//! scanner is enabled only when callers explicitly disable those sources.

use std::{
	ffi::{OsStr, OsString},
	io,
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;

use crate::{
	fs_cache::{FileType, GlobMatch, ScanDetail, ScanOptions},
	task,
};

const HEARTBEAT_INTERVAL: usize = 128;

/// Result of attempting a platform-native directory scan.
pub enum FastEntryScan {
	/// The current platform/configuration cannot use the native scanner safely.
	Unsupported,
	/// Native scanner produced entries with the same contract as `fs_cache`
	/// scans.
	Entries(Vec<GlobMatch>),
}

/// Visitor decision for streaming native traversal.
pub enum FastWalkControl {
	/// Continue traversing remaining entries.
	Continue,
	/// Stop traversal immediately after the current entry.
	Stop,
}

/// Status returned by streaming native traversal.
pub enum FastWalkStatus {
	/// The current platform/configuration cannot use the native scanner safely.
	Unsupported,
	/// Traversal visited every reachable entry.
	Complete,
	/// The visitor stopped traversal early.
	Stopped,
}

#[derive(Clone)]
struct RawDirEntry {
	name:      OsString,
	file_type: FileType,
	mtime:     Option<f64>,
	size:      Option<f64>,
}

/// Scans entries using platform syscalls when the scan contract is equivalent.
pub fn collect_entries(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
) -> Result<FastEntryScan> {
	let mut matches = Vec::new();
	let status = walk_entries(root, options, ct, |_path, entry| {
		matches.push(entry);
		Ok(FastWalkControl::Continue)
	})?;
	if matches!(status, FastWalkStatus::Unsupported) {
		return Ok(FastEntryScan::Unsupported);
	}
	matches.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	Ok(FastEntryScan::Entries(matches))
}

/// Streams entries using platform syscalls when the scan contract is
/// equivalent.
pub fn walk_entries<F>(
	root: &Path,
	options: ScanOptions,
	ct: &task::CancelToken,
	visitor: F,
) -> Result<FastWalkStatus>
where
	F: FnMut(&Path, GlobMatch) -> Result<FastWalkControl>,
{
	if !can_use_fast_scan(options) {
		return Ok(FastWalkStatus::Unsupported);
	}
	ct.heartbeat()?;
	let mut visitor = visitor;
	let mut visited = 0usize;
	match walk_dir(root, "", options, ct, &mut visited, &mut visitor) {
		Ok(true) => Ok(FastWalkStatus::Stopped),
		Ok(false) => Ok(FastWalkStatus::Complete),
		Err(FastScanError::Unsupported) => Ok(FastWalkStatus::Unsupported),
		Err(FastScanError::Cancelled(err)) => Err(err),
		Err(FastScanError::InvalidData { path, message }) => Err(Error::from_reason(format!(
			"Native directory scan failed for {}: {message}",
			path.display()
		))),
	}
}

const fn can_use_fast_scan(options: ScanOptions) -> bool {
	platform::SUPPORTED && !options.use_gitignore && !options.follow_links
}

enum FastScanError {
	Unsupported,
	Cancelled(Error),
	InvalidData { path: PathBuf, message: String },
}

impl From<Error> for FastScanError {
	fn from(err: Error) -> Self {
		Self::Cancelled(err)
	}
}

fn walk_dir<F>(
	dir: &Path,
	relative_dir: &str,
	options: ScanOptions,
	ct: &task::CancelToken,
	visited: &mut usize,
	visitor: &mut F,
) -> std::result::Result<bool, FastScanError>
where
	F: FnMut(&Path, GlobMatch) -> Result<FastWalkControl>,
{
	let mut raw_entries = match platform::read_dir_entries(dir, options.detail) {
		Ok(entries) => entries,
		Err(err) if err.kind() == io::ErrorKind::Unsupported => {
			return Err(FastScanError::Unsupported);
		},
		Err(err) if is_skippable_directory_error(&err) => return Ok(false),
		Err(err) => {
			return Err(FastScanError::InvalidData {
				path:    dir.to_path_buf(),
				message: err.to_string(),
			});
		},
	};
	raw_entries.sort_unstable_by(|a, b| a.name.cmp(&b.name));

	for entry in raw_entries {
		if *visited == 0 || *visited >= HEARTBEAT_INTERVAL {
			*visited = 0;
			ct.heartbeat()?;
		}
		*visited += 1;

		let name = entry_name(&entry.name);
		if name.is_empty() || name == "." || name == ".." {
			continue;
		}
		if !options.include_hidden && is_hidden_name(&name) {
			continue;
		}
		if name == ".git" || (options.skip_node_modules && name == "node_modules") {
			continue;
		}

		let relative = join_relative_path(relative_dir, &name);
		let is_dir = entry.file_type == FileType::Dir;
		let absolute = dir.join(&entry.name);
		let matched = GlobMatch {
			path:      relative.clone(),
			file_type: entry.file_type,
			mtime:     entry.mtime,
			size:      entry.size,
		};
		if matches!(visitor(&absolute, matched)?, FastWalkControl::Stop) {
			return Ok(true);
		}
		if is_dir && walk_dir(&absolute, &relative, options, ct, visited, visitor)? {
			return Ok(true);
		}
	}

	Ok(false)
}

fn is_skippable_directory_error(err: &io::Error) -> bool {
	matches!(
		err.kind(),
		io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::PermissionDenied
	)
}

fn entry_name(name: &OsStr) -> String {
	name.to_string_lossy().into_owned()
}

fn is_hidden_name(name: &str) -> bool {
	name.as_bytes().first() == Some(&b'.')
}

fn join_relative_path(parent: &str, name: &str) -> String {
	if parent.is_empty() {
		name.to_string()
	} else {
		let mut path = String::with_capacity(parent.len() + 1 + name.len());
		path.push_str(parent);
		path.push('/');
		path.push_str(name);
		path
	}
}

fn mtime_millis(seconds: i64, nanos: i64) -> Option<f64> {
	if seconds < 0 {
		return None;
	}
	Some((seconds as f64).mul_add(1000.0, nanos.max(0) as f64 / 1_000_000.0))
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::CString,
		io,
		mem::size_of,
		os::{
			fd::RawFd,
			unix::ffi::{OsStrExt, OsStringExt},
		},
		path::Path,
	};

	use super::{FileType, RawDirEntry, ScanDetail, mtime_millis};

	pub(super) const SUPPORTED: bool = true;

	const BUFFER_SIZE: usize = 256 * 1024;
	const VREG: u32 = 1;
	const VDIR: u32 = 2;
	const VLNK: u32 = 5;

	struct FdGuard(RawFd);

	impl Drop for FdGuard {
		fn drop(&mut self) {
			// SAFETY: `FdGuard` owns this file descriptor and closes it exactly once.
			unsafe { libc::close(self.0) };
		}
	}

	pub(super) fn read_dir_entries(path: &Path, detail: ScanDetail) -> io::Result<Vec<RawDirEntry>> {
		let fd = open_dir(path)?;
		let mut attrs = libc::attrlist {
			bitmapcount: libc::ATTR_BIT_MAP_COUNT,
			reserved:    0,
			commonattr:  libc::ATTR_CMN_NAME | libc::ATTR_CMN_OBJTYPE,
			volattr:     0,
			dirattr:     0,
			fileattr:    0,
			forkattr:    0,
		};
		if detail == ScanDetail::Full {
			attrs.commonattr |= libc::ATTR_CMN_MODTIME;
			attrs.fileattr |= libc::ATTR_FILE_DATALENGTH;
		}

		let mut buffer = vec![0u8; BUFFER_SIZE];
		let mut entries = Vec::new();
		loop {
			// SAFETY: `fd` is an open directory descriptor, `attrs` points to a valid
			// attrlist for the duration of the call, and `buffer` is writable.
			let count = unsafe {
				libc::getattrlistbulk(
					fd.0,
					std::ptr::addr_of_mut!(attrs).cast(),
					buffer.as_mut_ptr().cast(),
					buffer.len(),
					libc::FSOPT_NOFOLLOW as u64,
				)
			};
			if count == 0 {
				break;
			}
			if count < 0 {
				let err = io::Error::last_os_error();
				if err.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return Err(map_unsupported(err));
			}

			let mut offset = 0usize;
			for _ in 0..count {
				if offset + size_of::<u32>() > buffer.len() {
					return Err(invalid_data("truncated getattrlistbulk record length"));
				}
				let record_len = u32::from_ne_bytes(
					buffer[offset..offset + size_of::<u32>()]
						.try_into()
						.expect("slice length checked"),
				) as usize;
				if record_len < size_of::<u32>() || offset + record_len > buffer.len() {
					return Err(invalid_data("invalid getattrlistbulk record length"));
				}
				let record = &buffer[offset..offset + record_len];
				if let Some(entry) = parse_record(record, detail)? {
					entries.push(entry);
				}
				offset += record_len;
			}
		}
		Ok(entries)
	}

	fn open_dir(path: &Path) -> io::Result<FdGuard> {
		let path = CString::new(path.as_os_str().as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
		// SAFETY: `path` is a NUL-terminated C string; flags open the directory for
		// metadata traversal only and do not transfer ownership of the string.
		let fd =
			unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
		if fd < 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(FdGuard(fd))
		}
	}

	fn parse_record(record: &[u8], detail: ScanDetail) -> io::Result<Option<RawDirEntry>> {
		let mut cursor = size_of::<u32>();
		let name_ref_start = cursor;
		let name_ref = read_value::<libc::attrreference_t>(record, &mut cursor)?;
		let obj_type = read_value::<u32>(record, &mut cursor)?;
		let (mtime, data_length) = if detail == ScanDetail::Full {
			let modified = read_value::<libc::timespec>(record, &mut cursor)?;
			let data_length = read_value::<u64>(record, &mut cursor)?;
			(mtime_millis(modified.tv_sec as i64, modified.tv_nsec as i64), Some(data_length))
		} else {
			(None, None)
		};

		let name_start = checked_attr_offset(name_ref_start, name_ref.attr_dataoffset)?;
		let name_len = name_ref.attr_length as usize;
		if name_len == 0 || name_start + name_len > record.len() {
			return Err(invalid_data("invalid getattrlistbulk name reference"));
		}
		let name_bytes = trim_nul(&record[name_start..name_start + name_len]);
		if name_bytes.is_empty() {
			return Ok(None);
		}

		let Some(file_type) = file_type_from_vtype(obj_type) else {
			return Ok(None);
		};
		let size = if file_type == FileType::File {
			data_length.map(|value| value as f64)
		} else {
			None
		};
		Ok(Some(RawDirEntry {
			name: std::ffi::OsString::from_vec(name_bytes.to_vec()),
			file_type,
			mtime,
			size,
		}))
	}

	fn read_value<T: Copy>(record: &[u8], cursor: &mut usize) -> io::Result<T> {
		let end = cursor.saturating_add(size_of::<T>());
		if end > record.len() {
			return Err(invalid_data("truncated getattrlistbulk attribute"));
		}
		let ptr = record[*cursor..end].as_ptr();
		*cursor = end;
		// SAFETY: Bounds were checked above; `getattrlistbulk` records are byte
		// packed, so unaligned reads are required and do not outlive `record`.
		Ok(unsafe { std::ptr::read_unaligned(ptr.cast::<T>()) })
	}

	fn checked_attr_offset(base: usize, offset: i32) -> io::Result<usize> {
		if offset < 0 {
			return Err(invalid_data("negative getattrlistbulk attribute offset"));
		}
		base
			.checked_add(offset as usize)
			.ok_or_else(|| invalid_data("overflowing getattrlistbulk attribute offset"))
	}

	fn trim_nul(bytes: &[u8]) -> &[u8] {
		let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
		&bytes[..end]
	}

	const fn file_type_from_vtype(value: u32) -> Option<FileType> {
		match value {
			VREG => Some(FileType::File),
			VDIR => Some(FileType::Dir),
			VLNK => Some(FileType::Symlink),
			_ => None,
		}
	}

	fn map_unsupported(err: io::Error) -> io::Error {
		if matches!(err.raw_os_error(), Some(libc::ENOTSUP | libc::EINVAL)) {
			io::Error::new(io::ErrorKind::Unsupported, err)
		} else {
			err
		}
	}

	fn invalid_data(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, message)
	}
}

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		ffi::{CString, OsString},
		io,
		mem::{size_of, zeroed},
		os::unix::ffi::{OsStrExt, OsStringExt},
		path::Path,
	};

	use super::{FileType, RawDirEntry, ScanDetail, mtime_millis};

	pub(super) const SUPPORTED: bool = true;

	const BUFFER_SIZE: usize = 256 * 1024;
	const LINUX_DIRENT64_NAME_OFFSET: usize = 19;
	const STATX_TYPE: u32 = 0x0001;
	const STATX_SIZE: u32 = 0x0200;
	const STATX_MTIME: u32 = 0x0040;
	const STATX_BASIC_STATS: u32 = 0x07ff;

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct StatxTimestamp {
		tv_sec:     i64,
		tv_nsec:    u32,
		__reserved: i32,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct Statx {
		stx_mask:             u32,
		stx_blksize:          u32,
		stx_attributes:       u64,
		stx_nlink:            u32,
		stx_uid:              u32,
		stx_gid:              u32,
		stx_mode:             u16,
		__spare0:             [u16; 1],
		stx_ino:              u64,
		stx_size:             u64,
		stx_blocks:           u64,
		stx_attributes_mask:  u64,
		stx_atime:            StatxTimestamp,
		stx_btime:            StatxTimestamp,
		stx_ctime:            StatxTimestamp,
		stx_mtime:            StatxTimestamp,
		stx_rdev_major:       u32,
		stx_rdev_minor:       u32,
		stx_dev_major:        u32,
		stx_dev_minor:        u32,
		stx_mnt_id:           u64,
		stx_dio_mem_align:    u32,
		stx_dio_offset_align: u32,
		__spare3:             [u64; 12],
	}

	struct FdGuard(libc::c_int);

	impl Drop for FdGuard {
		fn drop(&mut self) {
			// SAFETY: `FdGuard` owns this file descriptor and closes it exactly once.
			unsafe { libc::close(self.0) };
		}
	}

	struct EntryStat {
		file_type: FileType,
		mtime:     Option<f64>,
		size:      Option<f64>,
	}

	pub(super) fn read_dir_entries(path: &Path, detail: ScanDetail) -> io::Result<Vec<RawDirEntry>> {
		let fd = open_dir(path)?;
		let mut buffer = vec![0u8; BUFFER_SIZE];
		let mut entries = Vec::new();
		loop {
			// SAFETY: `fd` is an open directory descriptor and `buffer` is writable.
			let read = unsafe {
				libc::syscall(
					libc::SYS_getdents64,
					fd.0,
					buffer.as_mut_ptr().cast::<libc::c_void>(),
					buffer.len(),
				)
			};
			if read == 0 {
				break;
			}
			if read < 0 {
				let err = io::Error::last_os_error();
				if err.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return Err(err);
			}

			let mut offset = 0usize;
			let read_len = read as usize;
			while offset < read_len {
				if offset + LINUX_DIRENT64_NAME_OFFSET > read_len {
					return Err(invalid_data("truncated getdents64 record"));
				}
				let reclen = read_u16(&buffer[offset + 16..read_len])? as usize;
				if reclen < LINUX_DIRENT64_NAME_OFFSET || offset + reclen > read_len {
					return Err(invalid_data("invalid getdents64 record length"));
				}
				let d_type = buffer[offset + 18];
				let name_bytes =
					trim_nul(&buffer[offset + LINUX_DIRENT64_NAME_OFFSET..offset + reclen]);
				offset += reclen;
				if name_bytes.is_empty() {
					continue;
				}

				let dtype_file_type = file_type_from_dtype(d_type);
				let stat = if detail == ScanDetail::Full || dtype_file_type.is_none() {
					match stat_entry(fd.0, name_bytes, detail) {
						Ok(Some(stat)) => Some(stat),
						Ok(None) => continue,
						Err(err) if is_skippable_entry_error(&err) => continue,
						Err(err) => return Err(err),
					}
				} else {
					None
				};
				let file_type = stat
					.as_ref()
					.map_or(dtype_file_type, |stat| Some(stat.file_type));
				let Some(file_type) = file_type else {
					continue;
				};
				entries.push(RawDirEntry {
					name: OsString::from_vec(name_bytes.to_vec()),
					file_type,
					mtime: stat.as_ref().and_then(|stat| stat.mtime),
					size: stat.as_ref().and_then(|stat| stat.size),
				});
			}
		}
		Ok(entries)
	}

	fn open_dir(path: &Path) -> io::Result<FdGuard> {
		let path = CString::new(path.as_os_str().as_bytes())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
		// SAFETY: `path` is a NUL-terminated C string; flags request a directory
		// descriptor used only with getdents/statx and do not retain the pointer.
		let fd =
			unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
		if fd < 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(FdGuard(fd))
		}
	}

	fn stat_entry(
		dirfd: libc::c_int,
		name: &[u8],
		detail: ScanDetail,
	) -> io::Result<Option<EntryStat>> {
		let name = CString::new(name)
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "entry name contains NUL"))?;
		match statx_entry(dirfd, &name, detail) {
			Ok(value) => Ok(value),
			Err(err) if matches!(err.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) => {
				fstatat_entry(dirfd, &name, detail)
			},
			Err(err) => Err(err),
		}
	}

	fn statx_entry(
		dirfd: libc::c_int,
		name: &CString,
		detail: ScanDetail,
	) -> io::Result<Option<EntryStat>> {
		// SAFETY: `Statx` is a plain-old-data buffer whose all-zero value is a
		// valid initialization before the kernel fills it.
		let mut statx = unsafe { zeroed::<Statx>() };
		let mask = if detail == ScanDetail::Full {
			STATX_BASIC_STATS
		} else {
			STATX_TYPE
		};
		// SAFETY: `name` is NUL-terminated, `statx` is writable, and `dirfd` is an
		// open directory descriptor for an AT_* relative metadata query.
		let rc = unsafe {
			libc::syscall(
				libc::SYS_statx,
				dirfd,
				name.as_ptr(),
				libc::AT_SYMLINK_NOFOLLOW | libc::AT_NO_AUTOMOUNT,
				mask,
				std::ptr::addr_of_mut!(statx),
			)
		};
		if rc != 0 {
			return Err(io::Error::last_os_error());
		}
		let Some(file_type) = file_type_from_mode(statx.stx_mode as libc::mode_t) else {
			return Ok(None);
		};
		let mtime = if detail == ScanDetail::Full && statx.stx_mask & STATX_MTIME != 0 {
			mtime_millis(statx.stx_mtime.tv_sec, i64::from(statx.stx_mtime.tv_nsec))
		} else {
			None
		};
		let size = if detail == ScanDetail::Full
			&& file_type == FileType::File
			&& statx.stx_mask & STATX_SIZE != 0
		{
			Some(statx.stx_size as f64)
		} else {
			None
		};
		Ok(Some(EntryStat { file_type, mtime, size }))
	}

	fn fstatat_entry(
		dirfd: libc::c_int,
		name: &CString,
		detail: ScanDetail,
	) -> io::Result<Option<EntryStat>> {
		// SAFETY: `libc::stat` is a POD buffer filled by fstatat.
		let mut stat = unsafe { zeroed::<libc::stat>() };
		// SAFETY: `name` is NUL-terminated, `stat` is writable, and `dirfd` is an
		// open directory descriptor for an AT_* relative metadata query.
		let rc = unsafe {
			libc::fstatat(
				dirfd,
				name.as_ptr(),
				std::ptr::addr_of_mut!(stat),
				libc::AT_SYMLINK_NOFOLLOW,
			)
		};
		if rc != 0 {
			return Err(io::Error::last_os_error());
		}
		let Some(file_type) = file_type_from_mode(stat.st_mode) else {
			return Ok(None);
		};
		let mtime = if detail == ScanDetail::Full {
			mtime_millis(stat.st_mtime, stat.st_mtime_nsec as i64)
		} else {
			None
		};
		let size = if detail == ScanDetail::Full && file_type == FileType::File {
			Some(stat.st_size as f64)
		} else {
			None
		};
		Ok(Some(EntryStat { file_type, mtime, size }))
	}

	fn read_u16(bytes: &[u8]) -> io::Result<u16> {
		if bytes.len() < size_of::<u16>() {
			return Err(invalid_data("truncated u16"));
		}
		Ok(u16::from_ne_bytes(
			bytes[..size_of::<u16>()]
				.try_into()
				.expect("slice length checked"),
		))
	}

	fn trim_nul(bytes: &[u8]) -> &[u8] {
		let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
		&bytes[..end]
	}

	fn file_type_from_dtype(value: u8) -> Option<FileType> {
		match value {
			libc::DT_REG => Some(FileType::File),
			libc::DT_DIR => Some(FileType::Dir),
			libc::DT_LNK => Some(FileType::Symlink),
			_ => None,
		}
	}

	fn file_type_from_mode(mode: libc::mode_t) -> Option<FileType> {
		match mode & libc::S_IFMT {
			libc::S_IFREG => Some(FileType::File),
			libc::S_IFDIR => Some(FileType::Dir),
			libc::S_IFLNK => Some(FileType::Symlink),
			_ => None,
		}
	}

	fn is_skippable_entry_error(err: &io::Error) -> bool {
		matches!(
			err.kind(),
			io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied | io::ErrorKind::NotADirectory
		)
	}

	fn invalid_data(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, message)
	}
}

#[cfg(target_os = "windows")]
mod platform {
	use std::{
		ffi::OsString,
		io,
		os::windows::ffi::{OsStrExt, OsStringExt},
		path::Path,
	};

	use windows_sys::{
		Wdk::Storage::FileSystem::{
			FILE_ID_FULL_DIR_INFORMATION, FileIdFullDirectoryInformation, NtQueryDirectoryFile,
		},
		Win32::{
			Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STATUS_NO_MORE_FILES},
			Storage::FileSystem::{
				CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
				FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
				FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
			},
			System::IO::IO_STATUS_BLOCK,
		},
	};

	use super::{FileType, RawDirEntry, ScanDetail, mtime_millis};

	pub(super) const SUPPORTED: bool = true;

	const BUFFER_SIZE: usize = 256 * 1024;
	const WINDOWS_TICK: i64 = 10_000_000;
	const UNIX_EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;

	struct HandleGuard(HANDLE);

	impl Drop for HandleGuard {
		fn drop(&mut self) {
			// SAFETY: `HandleGuard` owns this handle and closes it exactly once.
			unsafe { CloseHandle(self.0) };
		}
	}

	pub(super) fn read_dir_entries(path: &Path, detail: ScanDetail) -> io::Result<Vec<RawDirEntry>> {
		let handle = open_dir(path)?;
		let mut buffer = vec![0u8; BUFFER_SIZE];
		let mut restart = true;
		let mut entries = Vec::new();

		loop {
			let mut iosb = IO_STATUS_BLOCK::default();
			// SAFETY: `handle` is an open directory handle, `buffer` is writable, and
			// the query class matches the record parser below.
			let status = unsafe {
				NtQueryDirectoryFile(
					handle.0,
					std::ptr::null_mut(),
					None,
					std::ptr::null(),
					std::ptr::addr_of_mut!(iosb),
					buffer.as_mut_ptr().cast(),
					buffer.len() as u32,
					FileIdFullDirectoryInformation,
					false,
					std::ptr::null(),
					restart,
				)
			};
			restart = false;
			if status == STATUS_NO_MORE_FILES {
				break;
			}
			if status < 0 {
				return Err(io::Error::from_raw_os_error(status));
			}

			let mut offset = 0usize;
			loop {
				if offset + std::mem::size_of::<FILE_ID_FULL_DIR_INFORMATION>() > buffer.len() {
					return Err(invalid_data("truncated NtQueryDirectoryFile record"));
				}
				let info = unsafe {
					// SAFETY: Bounds were checked above; records are byte-packed in the
					// buffer and may not be aligned for Rust references.
					std::ptr::read_unaligned(
						buffer[offset..]
							.as_ptr()
							.cast::<FILE_ID_FULL_DIR_INFORMATION>(),
					)
				};
				let name_offset = offset + std::mem::offset_of!(FILE_ID_FULL_DIR_INFORMATION, FileName);
				let name_len = info.FileNameLength as usize;
				if name_len % 2 != 0 || name_offset + name_len > buffer.len() {
					return Err(invalid_data("invalid NtQueryDirectoryFile name length"));
				}
				let name_units: Vec<u16> = buffer[name_offset..name_offset + name_len]
					.chunks_exact(2)
					.map(|chunk| u16::from_ne_bytes([chunk[0], chunk[1]]))
					.collect();
				let name = OsString::from_wide(&name_units);
				if let Some(file_type) = file_type_from_attributes(info.FileAttributes) {
					let size = if detail == ScanDetail::Full && file_type == FileType::File {
						Some(info.EndOfFile.max(0) as f64)
					} else {
						None
					};
					let mtime = if detail == ScanDetail::Full {
						mtime_from_filetime(info.LastWriteTime)
					} else {
						None
					};
					entries.push(RawDirEntry { name, file_type, mtime, size });
				}
				if info.NextEntryOffset == 0 {
					break;
				}
				offset = offset.saturating_add(info.NextEntryOffset as usize);
			}
		}
		Ok(entries)
	}

	fn open_dir(path: &Path) -> io::Result<HandleGuard> {
		let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
		path.push(0);
		// SAFETY: `path` is NUL-terminated; the returned handle is owned by
		// `HandleGuard` on success.
		let handle = unsafe {
			CreateFileW(
				path.as_ptr(),
				FILE_LIST_DIRECTORY,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				std::ptr::null(),
				OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
				std::ptr::null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			Err(io::Error::last_os_error())
		} else {
			Ok(HandleGuard(handle))
		}
	}

	fn file_type_from_attributes(attributes: u32) -> Option<FileType> {
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			Some(FileType::Symlink)
		} else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
			Some(FileType::Dir)
		} else {
			Some(FileType::File)
		}
	}

	fn mtime_from_filetime(filetime: i64) -> Option<f64> {
		let ticks = filetime.checked_sub(UNIX_EPOCH_AS_FILETIME)?;
		let seconds = ticks / WINDOWS_TICK;
		let nanos = (ticks % WINDOWS_TICK) * 100;
		mtime_millis(seconds, nanos)
	}

	fn invalid_data(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::InvalidData, message)
	}
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
	use std::{io, path::Path};

	use super::{RawDirEntry, ScanDetail};

	pub(super) const SUPPORTED: bool = false;

	pub(super) fn read_dir_entries(
		_path: &Path,
		_detail: ScanDetail,
	) -> io::Result<Vec<RawDirEntry>> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"native directory scan unsupported on this platform",
		))
	}
}
