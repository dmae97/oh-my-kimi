//! Configuration for the shell output minimizer.
//!
//! [`MinimizerOptions`] is the N-API surface exposed through `ShellOptions`
//! and `ShellExecuteOptions`. [`MinimizerConfig`] is the internal resolved
//! view after merging field-level values with an optional TOML settings
//! file.

use std::{
	collections::{HashMap, HashSet},
	fs,
	path::{Path, PathBuf},
};

use napi_derive::napi;
use serde::Deserialize;

const DEFAULT_MAX_CAPTURE_BYTES: u32 = 4 * 1024 * 1024;

/// N-API opt-in handle for the minimizer.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:           Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:     Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:              Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:            Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes: Option<u32>,
}

/// Resolved minimizer configuration used by the engine.
#[derive(Debug, Clone)]
pub struct MinimizerConfig {
	pub enabled:           bool,
	pub only:              HashSet<String>,
	pub except:            HashSet<String>,
	pub max_capture_bytes: u32,
	pub per_command:       HashMap<String, toml::Value>,
}

impl Default for MinimizerConfig {
	fn default() -> Self {
		Self {
			enabled:           false,
			only:              HashSet::new(),
			except:            HashSet::new(),
			max_capture_bytes: DEFAULT_MAX_CAPTURE_BYTES,
			per_command:       HashMap::new(),
		}
	}
}

impl MinimizerConfig {
	/// Build a resolved configuration from `MinimizerOptions`, optionally
	/// merging in a TOML settings file.
	pub fn from_options(opts: &MinimizerOptions) -> Self {
		let mut cfg = Self::default();
		if let Some(enabled) = opts.enabled {
			cfg.enabled = enabled;
		}
		if let Some(list) = opts.only.as_ref() {
			cfg.only = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = opts.except.as_ref() {
			cfg.except = list.iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = opts.max_capture_bytes {
			cfg.max_capture_bytes = n.max(1024);
		}
		if let Some(path) = opts.settings_path.as_deref()
			&& !path.is_empty()
		{
			let expanded = expand_tilde(path);
			if let Ok(contents) = fs::read_to_string(&expanded)
				&& let Ok(file) = toml::from_str::<SettingsFile>(&contents)
			{
				file.merge_into(&mut cfg);
			}
		}
		cfg
	}

	/// Whether the engine should attempt to minimize output for `program`.
	pub fn is_program_enabled(&self, program: &str) -> bool {
		if !self.enabled {
			return false;
		}
		let key = program.to_lowercase();
		if self.except.contains(&key) {
			return false;
		}
		if !self.only.is_empty() && !self.only.contains(&key) {
			return false;
		}
		true
	}

	/// Fetch a per-command TOML table, if any.
	pub fn per_command(&self, program: &str) -> Option<&toml::Value> {
		self.per_command.get(&program.to_lowercase())
	}
}

#[derive(Debug, Default, Deserialize)]
struct SettingsFile {
	enabled:           Option<bool>,
	only:              Option<Vec<String>>,
	except:            Option<Vec<String>>,
	max_capture_bytes: Option<u32>,
	#[serde(flatten)]
	tables:            HashMap<String, toml::Value>,
}

impl SettingsFile {
	fn merge_into(self, cfg: &mut MinimizerConfig) {
		if let Some(v) = self.enabled {
			cfg.enabled = v;
		}
		if let Some(list) = self.only {
			cfg.only = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(list) = self.except {
			cfg.except = list.into_iter().map(|s| s.to_lowercase()).collect();
		}
		if let Some(n) = self.max_capture_bytes {
			cfg.max_capture_bytes = n.max(1024);
		}
		for (k, v) in self.tables {
			if v.is_table() {
				cfg.per_command.insert(k.to_lowercase(), v);
			}
		}
	}
}

fn expand_tilde(path: &str) -> PathBuf {
	if let Some(rest) = path.strip_prefix("~/")
		&& let Some(home) = home_dir()
	{
		return home.join(rest);
	}
	if path == "~"
		&& let Some(home) = home_dir()
	{
		return home;
	}
	Path::new(path).to_path_buf()
}

fn home_dir() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		std::env::var_os("HOME").map(PathBuf::from)
	}
	#[cfg(windows)]
	{
		std::env::var_os("USERPROFILE")
			.or_else(|| std::env::var_os("HOMEPATH"))
			.map(PathBuf::from)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn defaults_are_disabled() {
		let cfg = MinimizerConfig::default();
		assert!(!cfg.enabled);
		assert!(!cfg.is_program_enabled("git"));
	}

	#[test]
	fn enabled_without_only_enables_any_program() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		assert!(cfg.is_program_enabled("git"));
		assert!(cfg.is_program_enabled("cargo"));
	}

	#[test]
	fn only_list_is_respected() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			only: Some(vec!["git".into()]),
			..Default::default()
		});
		assert!(cfg.is_program_enabled("git"));
		assert!(!cfg.is_program_enabled("cargo"));
	}

	#[test]
	fn except_overrides_only() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			except: Some(vec!["docker".into()]),
			..Default::default()
		});
		assert!(!cfg.is_program_enabled("docker"));
		assert!(cfg.is_program_enabled("git"));
	}

	#[test]
	fn missing_settings_path_is_not_fatal() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			settings_path: Some("/does/not/exist.toml".into()),
			..Default::default()
		});
		assert!(cfg.enabled);
	}
}
