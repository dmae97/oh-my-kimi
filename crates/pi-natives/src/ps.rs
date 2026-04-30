//! Cross-platform process tree management.
//!
//! Provides process tree enumeration and termination without requiring
//! processes to be spawned with `detached: true`.
//!
//! # Platform Implementation
//! - **Linux**: Owns pidfds and signals through `pidfd_send_signal`
//! - **macOS**: Uses `libproc` (`proc_listchildpids`) and PID validation
//! - **Windows**: Owns process handles opened from Toolhelp snapshots

use std::{collections::HashSet, time::Duration};

use napi::{
	Env, Result,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;

use crate::task;
#[derive(Default)]
#[napi(object)]
pub struct ProcessTerminateOptions<'env> {
	/// Also signal the process group when supported by the platform.
	pub group:       Option<bool>,
	/// Milliseconds to wait after polite termination before hard-killing.
	/// Omit to use the default grace period. Pass a negative value to skip the
	/// graceful phase and hard-kill immediately.
	pub graceful_ms: Option<i32>,
	/// Milliseconds to wait after hard-kill for the process tree to exit.
	pub timeout_ms:  Option<u32>,
	/// Abort signal for cancelling termination while waiting.
	pub signal:      Option<Unknown<'env>>,
}

/// Options for waiting on a process exit.
#[derive(Default)]
#[napi(object)]
pub struct ProcessWaitOptions<'env> {
	/// Milliseconds to wait before returning false. Omit to wait indefinitely.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the wait.
	pub signal:     Option<Unknown<'env>>,
}

/// Current state of a process reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ProcessStatus {
	/// The referenced process is still running.
	#[napi(value = "running")]
	Running,
	/// The referenced process has exited or is no longer observable.
	#[napi(value = "exited")]
	Exited,
}

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		ffi::OsStr,
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		sync::Arc,
	};

	use super::ProcessStatus;

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:   i32,
		pidfd: Arc<OwnedFd>,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			Some(Self { pid, pidfd: open_pidfd(pid)? })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if self.status() != ProcessStatus::Running {
				return Vec::new();
			}

			let children_path = format!("/proc/{}/task/{}/children", self.pid, self.pid);
			let Ok(content) = fs::read_to_string(&children_path) else {
				return Vec::new();
			};

			content
				.split_whitespace()
				.filter_map(|part| part.parse::<i32>().ok())
				.filter_map(Self::from_pid)
				.filter(|child| {
					child.status() == ProcessStatus::Running
						&& current_parent_pid(child.pid) == Some(self.pid)
				})
				.collect()
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if self.status() == ProcessStatus::Running {
				current_parent_pid(self.pid)
			} else {
				None
			}
		}

		pub fn args(&self) -> Vec<String> {
			if self.status() != ProcessStatus::Running {
				return Vec::new();
			}

			let cmdline_path = format!("/proc/{}/cmdline", self.pid);
			let Ok(content) = fs::read(cmdline_path) else {
				return Vec::new();
			};
			split_nul_arguments(&content)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// SAFETY: `self.pidfd` is an owned file descriptor returned by a successful
			// `pidfd_open` call and remains open for the duration of this syscall. A null
			// `siginfo_t` pointer is explicitly accepted by `pidfd_send_signal` and makes
			// the kernel synthesize the same signal metadata as `kill(2)`. Flags are zero,
			// which is the documented default behavior.
			let ret = unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					self.pidfd.as_raw_fd(),
					signal,
					ptr::null::<libc::siginfo_t>(),
					0,
				)
			};
			ret == 0
		}

		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			// SAFETY: `self.pid` names the process currently referenced by `self.pidfd`
			// unless it exits concurrently. If it exits, `getpgid` reports failure rather
			// than dereferencing caller-owned memory.
			let pgid = unsafe { libc::getpgid(self.pid) };
			if pgid < 0 { None } else { Some(pgid) }
		}

		pub fn status(&self) -> ProcessStatus {
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and the pidfd
				// remains open for the duration of the call. Timeout zero makes this a
				// non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the pidfd as
					// still running. The pidfd is still owned and the kernel has not reported
					// the process gone — a spurious `Exited` here makes every downstream
					// signal/kill fall through silently.
					if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
						continue;
					}
					return ProcessStatus::Running;
				}
				if ready == 0 {
					return ProcessStatus::Running;
				}
				if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL))
					!= 0
				{
					return ProcessStatus::Exited;
				}
				return ProcessStatus::Running;
			}
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
				}
			}
		}
	}

	fn split_nul_arguments(content: &[u8]) -> Vec<String> {
		content
			.split(|byte| *byte == 0)
			.filter(|part| !part.is_empty())
			.map(|part| String::from_utf8_lossy(part).into_owned())
			.collect()
	}

	fn current_parent_pid(pid: i32) -> Option<i32> {
		let status_path = format!("/proc/{pid}/status");
		let content = fs::read_to_string(status_path).ok()?;
		content.lines().find_map(|line| {
			line
				.strip_prefix("PPid:")
				.and_then(|ppid| ppid.trim().parse::<i32>().ok())
		})
	}

	fn open_pidfd(pid: i32) -> Option<Arc<OwnedFd>> {
		// SAFETY: `pidfd_open` takes the PID by value and does not read caller-owned
		// memory. Flags are zero, which is valid. On success the returned descriptor is
		// newly owned by this process and is immediately wrapped in `OwnedFd` below.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return None;
		}

		// SAFETY: `fd` is non-negative and was just returned by `pidfd_open`, so it is
		// an open descriptor owned by this process. `OwnedFd` takes sole ownership and
		// will close it exactly once.
		Some(Arc::new(unsafe { OwnedFd::from_raw_fd(fd as RawFd) }))
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut matches = Vec::new();
		let Ok(entries) = fs::read_dir("/proc") else {
			return matches;
		};
		let target_os = OsStr::new(target);
		for entry in entries.flatten() {
			let name = entry.file_name();
			let Some(name_str) = name.to_str() else {
				continue;
			};
			let Ok(pid) = name_str.parse::<i32>() else {
				continue;
			};
			let exe_path = format!("/proc/{pid}/exe");
			let Ok(resolved) = fs::read_link(&exe_path) else {
				continue;
			};
			if resolved.as_os_str() == target_os
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{collections::HashSet, ptr};

	use super::ProcessStatus;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listchildpids(ppid: i32, buffer: *mut i32, buffersize: i32) -> i32;
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
		fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
	}

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct Process {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let info = read_bsdinfo(pid)?;
			if i32::try_from(info.pbi_pid).ok()? != pid {
				return None;
			}
			Some(Self { pid, start_tvsec: info.pbi_start_tvsec, start_tvusec: info.pbi_start_tvusec })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}

			// SAFETY: Passing a null buffer with size 0 is the documented libproc query
			// form for obtaining the byte count needed for child PIDs; libproc does not
			// dereference the null pointer in this mode.
			let bytes = unsafe { proc_listchildpids(self.pid, ptr::null_mut(), 0) };
			if bytes <= 0 {
				return Vec::new();
			}

			let count = bytes as usize / size_of::<i32>();
			let mut buffer = vec![0i32; count];
			// SAFETY: `buffer` is valid for `buffer.len() * size_of::<i32>()` bytes and
			// is properly aligned for `i32`; libproc writes at most the supplied size.
			let actual = unsafe {
				proc_listchildpids(
					self.pid,
					buffer.as_mut_ptr(),
					(buffer.len() * size_of::<i32>()) as i32,
				)
			};
			if actual <= 0 {
				return Vec::new();
			}

			let child_count = ((actual as usize) / size_of::<i32>()).min(buffer.len());
			buffer[..child_count]
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.collect()
		}

		pub fn parent_pid(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_ppid).ok().filter(|ppid| *ppid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			process_args(self.pid)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly small
			// window remains between this check and the syscall — but matching against
			// the recorded `(pid, start_tvsec, start_tvusec)` triple eliminates the
			// PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not access
			// caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
				}
			}
		}

		pub fn status(&self) -> ProcessStatus {
			if self.live_bsdinfo().is_some() {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	const KERN_PROCARGS2: libc::c_int = 49;

	const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

	/// Find processes whose libproc-reported executable path equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		// SAFETY: Passing a null buffer with size 0 is the documented libproc query
		// form for obtaining the byte count needed for all PIDs; libproc does not
		// dereference the null pointer in this mode.
		let bytes = unsafe { proc_listallpids(ptr::null_mut(), 0) };
		if bytes <= 0 {
			return Vec::new();
		}
		// macOS truncates the second `proc_listallpids` call's result tightly to
		// the buffer size we report — even when the buffer is large enough on paper —
		// so a near-fit buffer can silently lose ~half the pids. Pad generously.
		let count = (bytes as usize) / size_of::<i32>();
		let cap = count.saturating_mul(4).max(2048);
		let mut buffer = vec![0i32; cap];
		// SAFETY: `buffer` is valid for `buffer.len() * size_of::<i32>()` bytes and
		// is properly aligned for `i32`; libproc writes at most the supplied size.
		let actual =
			unsafe { proc_listallpids(buffer.as_mut_ptr(), (buffer.len() * size_of::<i32>()) as i32) };
		if actual <= 0 {
			return Vec::new();
		}
		let pid_count = ((actual as usize) / size_of::<i32>()).min(buffer.len());

		let mut path_buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
		let mut matches = Vec::new();
		for &pid in &buffer[..pid_count] {
			if pid <= 0 {
				continue;
			}
			// SAFETY: `path_buf` is valid for `path_buf.len()` bytes; libproc writes a
			// NUL-terminated path no longer than the supplied capacity and returns the
			// number of bytes written.
			let len = unsafe {
				proc_pidpath(
					pid,
					path_buf.as_mut_ptr().cast::<std::ffi::c_void>(),
					path_buf.len() as u32,
				)
			};
			if len <= 0 {
				continue;
			}
			let path_bytes = &path_buf[..len as usize];
			let path_bytes = match path_bytes.iter().position(|byte| *byte == 0) {
				Some(end) => &path_bytes[..end],
				None => path_bytes,
			};
			let Ok(path) = std::str::from_utf8(path_bytes) else {
				continue;
			};
			if path == target
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}

	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		// SAFETY: `proc_bsdinfo` is a plain C data struct. Zero initialization is
		// valid because every field is an integer or fixed-size integer array, and
		// libproc fully overwrites the fields it reports on a successful call.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: `info` is a writable `proc_bsdinfo` buffer whose exact byte size is
		// supplied to libproc. The PID, flavor, and arg are scalar values passed by
		// value; libproc writes at most the supplied buffer size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast::<std::ffi::c_void>(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		if actual < size_of::<libc::proc_bsdinfo>() as i32 {
			return None;
		}
		Some(info)
	}

	fn process_args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: `mib` points to three initialized integers and the old-value buffer
		// is null with a zero-length query, which is the documented `sysctl` sizing
		// pattern. `size` is a valid out-parameter for the required byte count.
		let sizing_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				ptr::null_mut(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !sizing_ok || size <= size_of::<libc::c_int>() {
			return Vec::new();
		}

		let mut buffer = vec![0u8; size];
		// SAFETY: `mib` still points to three initialized integers. `buffer` is
		// writable for `size` bytes, and `size` is provided as the in/out byte count.
		let read_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				buffer.as_mut_ptr().cast::<std::ffi::c_void>(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !read_ok {
			return Vec::new();
		}
		buffer.truncate(size);
		parse_macos_procargs(&buffer)
	}

	fn parse_macos_procargs(buffer: &[u8]) -> Vec<String> {
		// KERN_PROCARGS2 layout: `argc: i32 | exec_path: NUL-padded | argv[0..argc] |
		// env[..]`. argc covers only argv, so we must skip the exec_path NUL padding
		// and stop after exactly argc entries — otherwise environment variables leak
		// into the arg list (each NUL-terminated env=value is indistinguishable from
		// an arg).
		let argc_size = size_of::<libc::c_int>();
		if buffer.len() <= argc_size {
			return Vec::new();
		}

		let argc_bytes: [u8; 4] = match buffer[..argc_size].try_into() {
			Ok(bytes) => bytes,
			Err(_) => return Vec::new(),
		};
		let argc = libc::c_int::from_ne_bytes(argc_bytes);
		if argc <= 0 {
			return Vec::new();
		}

		let mut offset = argc_size;
		while offset < buffer.len() && buffer[offset] != 0 {
			offset += 1;
		}
		while offset < buffer.len() && buffer[offset] == 0 {
			offset += 1;
		}

		let mut args = Vec::with_capacity(argc as usize);
		while offset < buffer.len() && args.len() < argc as usize {
			let end = buffer[offset..]
				.iter()
				.position(|byte| *byte == 0)
				.map_or(buffer.len(), |position| offset + position);
			if end == offset {
				break;
			}
			args.push(String::from_utf8_lossy(&buffer[offset..end]).into_owned());
			offset = end + 1;
		}
		args
	}
}
#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::c_void,
		mem,
		sync::Arc,
	};

	use smallvec::SmallVec;

	use super::ProcessStatus;

	#[repr(C)]
	#[allow(non_snake_case, reason = "Windows PROCESSENTRY32W field names must match Win32 ABI")]
	struct PROCESSENTRY32W {
		dwSize:              u32,
		cntUsage:            u32,
		th32ProcessID:       u32,
		th32DefaultHeapID:   usize,
		th32ModuleID:        u32,
		cntThreads:          u32,
		th32ParentProcessID: u32,
		pcPriClassBase:      i32,
		dwFlags:             u32,
		szExeFile:           [u16; 260],
	}

	#[repr(C)]
	struct ProcessBasicInformation {
		exit_status: i32,
		peb_base_address: usize,
		affinity_mask: usize,
		base_priority: i32,
		unique_process_id: usize,
		inherited_from_unique_process_id: usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct PebPartial {
		reserved1:          [u8; 2],
		being_debugged:     u8,
		reserved2:          [u8; 1],
		reserved3:          [usize; 2],
		loader:             usize,
		process_parameters: usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct UserProcessParametersPartial {
		reserved1:       [u8; 16],
		reserved2:       [usize; 10],
		image_path_name: UnicodeString,
		command_line:    UnicodeString,
	}

	#[repr(C)]
	#[derive(Clone, Copy, Default)]
	struct Filetime {
		dw_low_date_time:  u32,
		dw_high_date_time: u32,
	}

	type Handle = *mut c_void;
	type NtStatus = i32;
	const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
	const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
	const PROCESS_VM_READ: u32 = 0x0010;
	const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
	const STATUS_SUCCESS: NtStatus = 0;
	const TH32CS_SNAPPROCESS: u32 = 0x00000002;
	const PROCESS_TERMINATE: u32 = 0x0001;
	const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
	const SYNCHRONIZE: u32 = 0x00100000;
	const PROCESS_REFERENCE_ACCESS: u32 =
		PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
	const WAIT_OBJECT_0: u32 = 0;

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> Handle;
		fn Process32FirstW(hSnapshot: Handle, lppe: *mut PROCESSENTRY32W) -> i32;
		fn Process32NextW(hSnapshot: Handle, lppe: *mut PROCESSENTRY32W) -> i32;
		fn CloseHandle(hObject: Handle) -> i32;
		fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> Handle;
		fn TerminateProcess(hProcess: Handle, uExitCode: u32) -> i32;
		fn QueryFullProcessImageNameW(
			hProcess: Handle,
			dwFlags: u32,
			lpExeName: *mut u16,
			lpdwSize: *mut u32,
		) -> i32;
		fn WaitForSingleObject(hHandle: Handle, dwMilliseconds: u32) -> u32;
		fn GetProcessTimes(
			hProcess: Handle,
			lpCreationTime: *mut Filetime,
			lpExitTime: *mut Filetime,
			lpKernelTime: *mut Filetime,
			lpUserTime: *mut Filetime,
		) -> i32;
		fn ReadProcessMemory(
			hProcess: Handle,
			lpBaseAddress: *const c_void,
			lpBuffer: *mut c_void,
			nSize: usize,
			lpNumberOfBytesRead: *mut usize,
		) -> i32;
		fn LocalFree(hMem: Handle) -> Handle;
	}

	#[link(name = "shell32")]
	unsafe extern "system" {
		fn CommandLineToArgvW(lpCmdLine: *const u16, pNumArgs: *mut i32) -> *mut *mut u16;
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtQueryInformationProcess(
			ProcessHandle: Handle,
			ProcessInformationClass: u32,
			ProcessInformation: *mut c_void,
			ProcessInformationLength: u32,
			ReturnLength: *mut u32,
		) -> NtStatus;
	}

	struct OwnedHandle {
		raw: isize,
	}

	impl OwnedHandle {
		fn from_raw(raw: Handle) -> Option<Self> {
			if raw.is_null() || raw == INVALID_HANDLE_VALUE {
				None
			} else {
				Some(Self { raw: raw as isize })
			}
		}

		fn as_raw(&self) -> Handle {
			self.raw as Handle
		}
	}

	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			// SAFETY: `self.raw` was returned by a successful Win32 handle-producing
			// function and stored only in this `OwnedHandle`. `Drop` runs once, so this
			// closes the owned handle exactly once and no code uses it afterward.
			let _ = unsafe { CloseHandle(self.as_raw()) };
		}
	}

	#[derive(Clone)]
	/// Stable Windows process reference backed by an owned process handle plus
	/// the kernel-reported creation time, which pins identity even if the PID is
	/// recycled while we hold the handle.
	pub struct Process {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		creation_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pid_u32 = u32::try_from(pid).ok()?;
			let handle = open_process(pid_u32, PROCESS_REFERENCE_ACCESS)?;
			let creation_time = process_creation_time(handle.as_raw())?;
			Some(Self { pid, handle, creation_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn parent_pid(&self) -> Option<i32> {
			process_basic_information(self.handle.as_raw())
				.and_then(|info| i32::try_from(info.inherited_from_unique_process_id).ok())
				.filter(|pid| *pid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			process_command_line(self)
				.as_deref()
				.map(split_windows_command_line)
				.unwrap_or_default()
		}

		pub fn children(&self) -> Vec<Self> {
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		pub fn descendants(&self) -> Vec<Self> {
			let tree = build_process_tree();
			let Ok(root) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			let mut out = Vec::new();
			Self::collect_descendants_from_tree(root, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(pid: i32, tree: &HashMap<u32, SmallVec<[u32; 4]>>) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| {
					let child = Self::from_pid(i32::try_from(child_pid).ok()?)?;
					(child.status() == ProcessStatus::Running).then_some(child)
				})
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: u32,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			out: &mut Vec<Self>,
		) {
			let Some(children) = tree.get(&parent) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Ok(child_pid_i) = i32::try_from(child_pid) else {
					continue;
				};
				let Some(child) = Self::from_pid(child_pid_i) else {
					continue;
				};
				if child.status() != ProcessStatus::Running {
					continue;
				}
				// Post-order: collect grandchildren first so leaves are signalled before
				// their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
			}
		}

		pub fn kill(&self, _signal: i32) -> bool {
			// The handle pins the original kernel process object even after the PID is
			// recycled, so `TerminateProcess` cannot accidentally hit a different
			// process. SAFETY: `self.handle` is an owned process handle opened with
			// `PROCESS_TERMINATE` access and remains valid for the duration of this
			// call. The exit code is passed by value.
			unsafe { TerminateProcess(self.handle.as_raw(), 1) != 0 }
		}

		pub const fn group_id(&self) -> Option<i32> {
			None
		}

		pub fn status(&self) -> ProcessStatus {
			// `WaitForSingleObject` on a process handle opened with `SYNCHRONIZE` is
			// the definitive liveness probe: the handle becomes signalled iff the
			// process has exited. This avoids the `STILL_ACTIVE == 259` pitfall in
			// `GetExitCodeProcess`, where a process that legitimately exits with code
			// 259 is indistinguishable from a still-running one.
			//
			// SAFETY: `self.handle` is an owned process handle opened with
			// `SYNCHRONIZE` access. A zero timeout makes this a non-blocking probe.
			let result = unsafe { WaitForSingleObject(self.handle.as_raw(), 0) };
			if result == WAIT_OBJECT_0 {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}
	}

	fn process_basic_information(handle: Handle) -> Option<ProcessBasicInformation> {
		let mut info = ProcessBasicInformation {
			exit_status: 0,
			peb_base_address: 0,
			affinity_mask: 0,
			base_priority: 0,
			unique_process_id: 0,
			inherited_from_unique_process_id: 0,
		};
		let mut returned = 0u32;
		// SAFETY: `handle` is a valid process handle. `info` is writable for exactly
		// `size_of::<ProcessBasicInformation>()` bytes, and `returned` is a valid
		// optional out-parameter for the byte count.
		let status = unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_BASIC_INFORMATION_CLASS,
				(&raw mut info).cast::<c_void>(),
				mem::size_of::<ProcessBasicInformation>() as u32,
				&raw mut returned,
			)
		};
		(status == STATUS_SUCCESS).then_some(info)
	}

	fn process_command_line(process: &Process) -> Option<String> {
		let pid_u32 = u32::try_from(process.pid).ok()?;
		let read_handle = open_process(pid_u32, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)?;
		// PID-reuse defense: `OpenProcess` resolves a PID to *whichever* process owns
		// it right now, which need not be the one our original handle pinned. Compare
		// the freshly opened handle's creation time against the recorded value to
		// reject reads from an unrelated process that happens to share the PID.
		if process_creation_time(read_handle.as_raw())? != process.creation_time {
			return None;
		}
		let info = process_basic_information(read_handle.as_raw())?;
		let peb: PebPartial = read_remote(read_handle.as_raw(), info.peb_base_address)?;
		if peb.process_parameters == 0 {
			return None;
		}
		let params: UserProcessParametersPartial =
			read_remote(read_handle.as_raw(), peb.process_parameters)?;
		read_remote_unicode_string(read_handle.as_raw(), params.command_line)
	}

	fn process_creation_time(handle: Handle) -> Option<u64> {
		let mut creation = Filetime::default();
		let mut exit = Filetime::default();
		let mut kernel = Filetime::default();
		let mut user = Filetime::default();
		// SAFETY: `handle` is a valid process handle opened with at least
		// `PROCESS_QUERY_LIMITED_INFORMATION`. All four out-parameters point to
		// initialized, writable `Filetime` values that live until the call returns.
		let ok = unsafe {
			GetProcessTimes(handle, &raw mut creation, &raw mut exit, &raw mut kernel, &raw mut user)
				!= 0
		};
		if !ok {
			return None;
		}
		Some((u64::from(creation.dw_high_date_time) << 32) | u64::from(creation.dw_low_date_time))
	}

	fn read_remote<T: Copy>(handle: Handle, address: usize) -> Option<T> {
		if address == 0 {
			return None;
		}
		let mut value = mem::MaybeUninit::<T>::uninit();
		let mut bytes_read = 0usize;
		// SAFETY: `handle` is opened with `PROCESS_VM_READ`. `address` comes from
		// kernel-reported process structures for that same process. `value` points to
		// uninitialized local storage large enough for `T`, and `bytes_read` is a valid
		// out-parameter. The value is only assumed initialized after the OS reports a
		// full-size successful read.
		let ok = unsafe {
			ReadProcessMemory(
				handle,
				address as *const c_void,
				value.as_mut_ptr().cast::<c_void>(),
				mem::size_of::<T>(),
				&raw mut bytes_read,
			) != 0
		};
		if ok && bytes_read == mem::size_of::<T>() {
			// SAFETY: The successful `ReadProcessMemory` call above initialized exactly
			// `size_of::<T>()` bytes in `value`.
			Some(unsafe { value.assume_init() })
		} else {
			None
		}
	}

	fn read_remote_unicode_string(handle: Handle, value: UnicodeString) -> Option<String> {
		if value.length == 0 || value.buffer == 0 || value.length % 2 != 0 {
			return None;
		}
		let code_units = usize::from(value.length) / size_of::<u16>();
		let mut buffer = vec![0u16; code_units];
		let mut bytes_read = 0usize;
		// SAFETY: `handle` is opened with `PROCESS_VM_READ`. `value.buffer` and
		// `value.length` come from the remote process' own `UNICODE_STRING`. `buffer`
		// is writable for exactly `value.length` bytes, and `bytes_read` is a valid
		// out-parameter. The string is decoded only after a full successful read.
		let ok = unsafe {
			ReadProcessMemory(
				handle,
				value.buffer as *const c_void,
				buffer.as_mut_ptr().cast::<c_void>(),
				usize::from(value.length),
				&raw mut bytes_read,
			) != 0
		};
		if ok && bytes_read == usize::from(value.length) {
			Some(String::from_utf16_lossy(&buffer))
		} else {
			None
		}
	}

	fn split_windows_command_line(command_line: &str) -> Vec<String> {
		use std::os::windows::ffi::OsStringExt;

		let mut wide: Vec<u16> = command_line.encode_utf16().chain([0]).collect();
		let mut argc = 0i32;
		// SAFETY: `wide` is a local, NUL-terminated UTF-16 buffer that remains alive
		// for the duration of the call. `argc` is a valid out-parameter. The returned
		// argv block is released with `LocalFree` below as required by
		// `CommandLineToArgvW`.
		let argv = unsafe { CommandLineToArgvW(wide.as_mut_ptr(), &raw mut argc) };
		if argv.is_null() || argc <= 0 {
			return Vec::new();
		}
		let argc = argc as usize;
		// SAFETY: `CommandLineToArgvW` returned a non-null pointer to `argc` argument
		// pointers, valid until freed with `LocalFree`.
		let pointers = unsafe { std::slice::from_raw_parts(argv, argc) };
		let args = pointers
			.iter()
			.filter_map(|&arg| {
				if arg.is_null() {
					return None;
				}
				let mut len = 0usize;
				// SAFETY: Each pointer in the argv block is a NUL-terminated UTF-16
				// string owned by the argv block and valid until `LocalFree` below.
				while unsafe { *arg.add(len) } != 0 {
					len += 1;
				}
				// SAFETY: The loop above found the terminating NUL, so the preceding
				// `len` code units form a valid readable slice.
				let slice = unsafe { std::slice::from_raw_parts(arg, len) };
				Some(
					std::ffi::OsString::from_wide(slice)
						.to_string_lossy()
						.into_owned(),
				)
			})
			.collect();
		// SAFETY: `argv` is the allocation returned by `CommandLineToArgvW` and has
		// not been freed yet. No pointers into it are used after this call.
		let _ = unsafe { LocalFree(argv.cast::<c_void>()) };
		args
	}

	fn open_process(pid: u32, access: u32) -> Option<Arc<OwnedHandle>> {
		// SAFETY: `OpenProcess` takes the PID and access mask by value and does not
		// dereference caller-owned memory. Handle inheritance is disabled. Identity
		// is established by the caller (typically `Process::from_pid`) capturing the
		// creation time immediately after a successful open and re-checking it on
		// every subsequent operation that re-resolves the PID.
		let handle = unsafe { OpenProcess(access, 0, pid) };
		OwnedHandle::from_raw(handle).map(Arc::new)
	}

	fn create_process_snapshot() -> Option<OwnedHandle> {
		// SAFETY: The process snapshot API takes flags and a process ID by value and
		// does not dereference caller-owned memory. PID zero requests all processes.
		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		OwnedHandle::from_raw(snapshot)
	}

	fn process_entry() -> PROCESSENTRY32W {
		PROCESSENTRY32W {
			dwSize:              mem::size_of::<PROCESSENTRY32W>() as u32,
			cntUsage:            0,
			th32ProcessID:       0,
			th32DefaultHeapID:   0,
			th32ModuleID:        0,
			cntThreads:          0,
			th32ParentProcessID: 0,
			pcPriClassBase:      0,
			dwFlags:             0,
			szExeFile:           [0; 260],
		}
	}

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes.
	fn build_process_tree() -> HashMap<u32, SmallVec<[u32; 4]>> {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		let Some(snapshot) = create_process_snapshot() else {
			return tree;
		};

		let mut entry = process_entry();
		// SAFETY: `snapshot` is a valid Toolhelp snapshot handle. `entry` points to a
		// writable `PROCESSENTRY32W` whose `dwSize` field was initialized to the exact
		// ABI size before the call.
		if unsafe { Process32FirstW(snapshot.as_raw(), &raw mut entry) } == 0 {
			return tree;
		}

		loop {
			tree
				.entry(entry.th32ParentProcessID)
				.or_default()
				.push(entry.th32ProcessID);

			// SAFETY: `snapshot` remains a valid Toolhelp snapshot handle, and `entry`
			// remains a writable `PROCESSENTRY32W` with its ABI size preserved.
			if unsafe { Process32NextW(snapshot.as_raw(), &raw mut entry) } == 0 {
				break;
			}
		}

		tree
	}

	/// Process groups are not exposed on Windows.
	/// Always returns `false`.
	pub const fn kill_process_group(_pgid: i32, _signal: i32) -> bool {
		false
	}

	/// Find processes whose `QueryFullProcessImageNameW` result equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		use std::{ffi::OsString, os::windows::ffi::OsStringExt};

		let mut matches = Vec::new();
		let Some(snapshot) = create_process_snapshot() else {
			return matches;
		};

		let mut entry = process_entry();
		let mut buf = vec![0u16; 32_768];
		let target = OsString::from(target);

		// SAFETY: `snapshot` is a valid Toolhelp snapshot handle. `entry` points to a
		// writable `PROCESSENTRY32W` whose `dwSize` field was initialized to the exact
		// ABI size before the call.
		if unsafe { Process32FirstW(snapshot.as_raw(), &raw mut entry) } == 0 {
			return matches;
		}

		loop {
			let pid = entry.th32ProcessID;
			if let Some(handle) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
				let mut size = buf.len() as u32;
				// SAFETY: `handle` was opened with query access and remains valid for the
				// call. `buf` is writable for `size` UTF-16 code units, and `size` is a valid
				// in/out parameter initialized to that capacity.
				let ok = unsafe {
					QueryFullProcessImageNameW(handle.as_raw(), 0, buf.as_mut_ptr(), &raw mut size) != 0
				};
				if ok {
					let path = OsString::from_wide(&buf[..size as usize]);
					if path == target
						&& let Some(process) = Process::from_pid(i32::try_from(pid).unwrap_or_default())
					{
						matches.push(process);
					}
				}
			}

			// SAFETY: `snapshot` remains a valid Toolhelp snapshot handle, and `entry`
			// remains a writable `PROCESSENTRY32W` with its ABI size preserved.
			if unsafe { Process32NextW(snapshot.as_raw(), &raw mut entry) } == 0 {
				break;
			}
		}

		matches
	}
}

/// Stable process reference.
#[napi]
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl Process {
	/// Open a stable process reference from a PID.
	#[napi]
	pub fn from_pid(pid: i32) -> Option<Process> {
		platform::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	#[napi]
	pub fn from_path(path: String) -> Vec<Process> {
		platform::find_by_path(&path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[napi(getter)]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Parent process id for this process, when available.
	#[napi(getter)]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.parent_pid()
	}

	/// Launch arguments for this process.
	#[napi]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[napi]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// By default this waits 1000ms after polite termination before
	/// hard-killing. Pass `graceful_ms < 0` to skip the graceful phase.
	#[napi]
	pub fn terminate<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessTerminateOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let group = options.group.unwrap_or(false);
		let graceful_ms = options.graceful_ms.unwrap_or(1000);
		let timeout_ms = options.timeout_ms.unwrap_or(5000);
		let ct = task::CancelToken::new(None, options.signal);
		let process = self.clone();
		task::future(env, "process.terminate", async move {
			process
				.terminate_tree(group, graceful_ms, timeout_ms, ct)
				.await
		})
	}

	/// Wait until this process exits.
	///
	/// When `options.timeout_ms` is omitted, waits until the process exits.
	#[napi]
	pub fn wait_for_exit<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessWaitOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let ct = task::CancelToken::new(None, options.signal);
		let timeout = options
			.timeout_ms
			.map(|ms| Duration::from_millis(u64::from(ms)));
		let process = self.clone();
		task::future(env, "process.wait_for_exit", async move {
			wait_for_exit(&process, &[], timeout, ct).await
		})
	}

	/// Process group id for this process, when supported by the platform.
	#[napi]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	#[napi]
	pub fn children(&self) -> Vec<Process> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[napi]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status()
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	fn live_descendants(&self) -> Vec<Self> {
		self
			.inner
			.descendants()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		let descendants = self.live_descendants();
		let mut signaled = 0u32;
		for child in &descendants {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if self.inner.kill(signal) {
			signaled += 1;
		}
		signaled
	}

	async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: task::CancelToken,
	) -> Result<bool> {
		if self.status() != ProcessStatus::Running {
			return Ok(true);
		}

		let process_group = if group { self.group_id() } else { None };

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, TERM_SIGNAL);
		}
		let mut descendants = self.live_descendants();
		for child in &descendants {
			let _ = child.inner.kill(TERM_SIGNAL);
		}
		let _ = self.inner.kill(TERM_SIGNAL);

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&descendants,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too.
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, KILL_SIGNAL);
		}
		descendants = self.live_descendants();
		for child in &descendants {
			let _ = child.inner.kill(KILL_SIGNAL);
		}
		let _ = self.inner.kill(KILL_SIGNAL);

		wait_for_exit(self, &descendants, Some(Duration::from_millis(u64::from(timeout_ms))), ct)
			.await
	}
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: task::CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	let poll_interval = Duration::from_millis(50);
	let mut elapsed = Duration::ZERO;
	while timeout.is_none_or(|limit| elapsed < limit) {
		let sleep_for =
			timeout.map_or(poll_interval, |limit| limit.saturating_sub(elapsed).min(poll_interval));
		if sleep_for.is_zero() {
			break;
		}
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;
		elapsed += sleep_for;

		if root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
		{
			return Ok(true);
		}
	}

	Ok(false)
}

/// Send `signal` to the process group `pgid`.
/// Returns false when process groups are unsupported on the platform.
#[allow(clippy::missing_const_for_fn, reason = "Dispatches to platform-specific implementation")]
pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
	platform::kill_process_group(pgid, signal)
}

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Process-group calls are no-ops
/// on platforms that do not expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	pgids:     Vec<i32>,
	processes: Vec<Process>,
	seen_pids: HashSet<i32>,
}

impl TerminationTargets {
	/// Create an empty target set.
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a process group id. Duplicates are ignored.
	pub fn add_pgid(&mut self, pgid: i32) {
		if !self.pgids.contains(&pgid) {
			self.pgids.push(pgid);
		}
	}

	/// Record a pid. Duplicates are ignored. If the pid is alive, opens
	/// a stable [`Process`] reference so the descendant tree can be
	/// killed even if the original pid is reused later.
	pub fn add_pid(&mut self, pid: i32) {
		if self.seen_pids.insert(pid)
			&& let Some(process) = Process::from_pid(pid)
		{
			self.processes.push(process);
		}
	}

	/// True when no targets have been recorded.
	pub const fn is_empty(&self) -> bool {
		self.pgids.is_empty() && self.processes.is_empty()
	}

	/// Send `signal` to every recorded target. Failures are swallowed:
	/// targets routinely exit between collection and signalling, and
	/// the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		for &pgid in &self.pgids {
			let _ = kill_process_group(pgid, signal);
		}
		for process in &self.processes {
			let _ = process.signal_tree(signal);
		}
	}
}
