use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	env, fs,
	path::{Path, PathBuf},
};

use serde::Deserialize;

const IDENTIFIER_FIELD_PRIORITY: &[&str] = &[
	"name",
	"identifier",
	"attrpath",
	"key",
	"label",
	"alias",
	"field",
	"member",
	"property",
	"tag",
	"target",
	"variable",
];

const BODY_FIELD_PRIORITY: &[&str] = &["body", "value", "declaration_list", "block", "members"];
const PROMOTION_FIELD_PRIORITY: &[&str] = &["definition", "declaration", "item", "member"];

#[derive(Clone, Copy)]
struct GrammarSpec {
	language:       &'static str,
	package:        &'static str,
	node_types_rel: &'static str,
}

#[derive(Deserialize)]
struct RawTypeRef {
	#[serde(rename = "type")]
	kind:  Option<String>,
	named: bool,
}

#[derive(Deserialize)]
struct RawFieldSpec {
	#[serde(default)]
	multiple: bool,
	#[serde(default)]
	types:    Vec<RawTypeRef>,
}

#[derive(Deserialize)]
struct RawNodeType {
	#[serde(rename = "type")]
	kind:     Option<String>,
	fields:   Option<BTreeMap<String, RawFieldSpec>>,
	children: Option<RawFieldSpec>,
	subtypes: Option<Vec<RawTypeRef>>,
}

#[derive(serde::Serialize)]
struct GeneratedSchema {
	languages: BTreeMap<String, BTreeMap<String, GeneratedNodeTypeSchema>>,
}

#[derive(serde::Serialize)]
struct GeneratedNodeTypeSchema {
	identifier_fields:       Vec<String>,
	body_fields:             Vec<String>,
	promotion_fields:        Vec<String>,
	container_child_kinds:   Vec<String>,
	is_supertype:            bool,
	has_structural_children: bool,
}

const GRAMMARS: &[GrammarSpec] = &[
	GrammarSpec {
		language:       "astro",
		package:        "tree-sitter-astro-next",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "bash",
		package:        "tree-sitter-bash",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "c",
		package:        "tree-sitter-c",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "clojure",
		package:        "tree-sitter-clojure",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "cmake",
		package:        "tree-sitter-cmake",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "cpp",
		package:        "tree-sitter-cpp",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "csharp",
		package:        "tree-sitter-c-sharp",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "css",
		package:        "tree-sitter-css",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "diff",
		package:        "tree-sitter-diff",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "dockerfile",
		package:        "tree-sitter-dockerfile-updated",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "elixir",
		package:        "tree-sitter-elixir",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "erlang",
		package:        "tree-sitter-erlang",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "go",
		package:        "tree-sitter-go",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "graphql",
		package:        "tree-sitter-graphql",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "handlebars",
		package:        "tree-sitter-glimmer",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "haskell",
		package:        "tree-sitter-haskell",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "hcl",
		package:        "tree-sitter-hcl",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "html",
		package:        "tree-sitter-html",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "ini",
		package:        "tree-sitter-ini",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "java",
		package:        "tree-sitter-java",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "javascript",
		package:        "tree-sitter-javascript",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "json",
		package:        "tree-sitter-json",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "toml",
		package:        "tree-sitter-toml-ng",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "just",
		package:        "tree-sitter-just",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "julia",
		package:        "tree-sitter-julia",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "kotlin",
		package:        "tree-sitter-kotlin-sg",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "lua",
		package:        "tree-sitter-lua",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "make",
		package:        "tree-sitter-make",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "markdown",
		package:        "tree-sitter-md",
		node_types_rel: "tree-sitter-markdown/src/node-types.json",
	},
	GrammarSpec {
		language:       "nix",
		package:        "tree-sitter-nix",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "objc",
		package:        "tree-sitter-objc",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "odin",
		package:        "tree-sitter-odin",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "perl",
		package:        "tree-sitter-perl-next",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "php",
		package:        "tree-sitter-php",
		node_types_rel: "php/src/node-types.json",
	},
	GrammarSpec {
		language:       "powershell",
		package:        "tree-sitter-powershell",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "protobuf",
		package:        "tree-sitter-proto",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "python",
		package:        "tree-sitter-python",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "r",
		package:        "tree-sitter-r",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "regex",
		package:        "tree-sitter-regex",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "ruby",
		package:        "tree-sitter-ruby",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "rust",
		package:        "tree-sitter-rust",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "scala",
		package:        "tree-sitter-scala",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "solidity",
		package:        "tree-sitter-solidity",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "sql",
		package:        "tree-sitter-sequel",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "starlark",
		package:        "tree-sitter-starlark",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "svelte",
		package:        "tree-sitter-svelte-next",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "swift",
		package:        "tree-sitter-swift",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "toml",
		package:        "tree-sitter-toml-ng",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "tlaplus",
		package:        "tree-sitter-tlaplus",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "tsx",
		package:        "tree-sitter-typescript",
		node_types_rel: "tsx/src/node-types.json",
	},
	GrammarSpec {
		language:       "typescript",
		package:        "tree-sitter-typescript",
		node_types_rel: "typescript/src/node-types.json",
	},
	GrammarSpec {
		language:       "verilog",
		package:        "tree-sitter-verilog",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "vue",
		package:        "tree-sitter-vue-next",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "xml",
		package:        "tree-sitter-xml",
		node_types_rel: "xml/src/node-types.json",
	},
	GrammarSpec {
		language:       "yaml",
		package:        "tree-sitter-yaml",
		node_types_rel: "src/node-types.json",
	},
	GrammarSpec {
		language:       "zig",
		package:        "tree-sitter-zig",
		node_types_rel: "src/node-types.json",
	},
];

fn main() {
	napi_build::setup();
	generate_chunk_schema();
}

fn generate_chunk_schema() {
	let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set");
	let workspace_root = Path::new(&manifest_dir)
		.parent()
		.and_then(Path::parent)
		.expect("pi-natives should live under the workspace root");
	let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR should be set"));
	let output_path = out_dir.join("chunk_schema.json");
	let locked_versions = locked_package_versions(&workspace_root.join("Cargo.lock"));
	let registry_roots = cargo_registry_roots();
	let mut languages = BTreeMap::new();

	for grammar in GRAMMARS {
		let Some(version) = locked_versions.get(grammar.package) else {
			continue;
		};
		let Some(package_dir) = find_registry_package_dir(&registry_roots, grammar.package, version)
		else {
			continue;
		};
		let node_types_path = package_dir.join(grammar.node_types_rel);
		if !node_types_path.exists() {
			continue;
		}

		println!("cargo:rerun-if-changed={}", node_types_path.display());
		let source =
			fs::read_to_string(&node_types_path).expect("node-types.json should be readable");
		let raw_nodes: Vec<RawNodeType> =
			serde_json::from_str(&source).expect("node-types.json should parse");
		let schemas = build_language_schema(raw_nodes);
		if !schemas.is_empty() {
			languages.insert(grammar.language.to_string(), schemas);
		}
	}

	let generated = GeneratedSchema { languages };
	let json = serde_json::to_string(&generated).expect("schema JSON should serialize");
	fs::write(output_path, json).expect("schema JSON should write");
}

fn build_language_schema(raw_nodes: Vec<RawNodeType>) -> BTreeMap<String, GeneratedNodeTypeSchema> {
	let mut raw_by_kind = HashMap::new();
	for raw in raw_nodes {
		let Some(kind) = raw.kind.clone() else {
			continue;
		};
		raw_by_kind.insert(kind, raw);
	}

	let structural_state = compute_structural_state(&raw_by_kind);
	let mut out = BTreeMap::new();
	for (kind, raw) in &raw_by_kind {
		let identifier_fields = pick_priority_fields(raw.fields.as_ref(), IDENTIFIER_FIELD_PRIORITY);
		let body_fields = pick_priority_fields(raw.fields.as_ref(), BODY_FIELD_PRIORITY);
		let promotion_fields =
			collect_promotion_fields(raw, &structural_state, &identifier_fields, &body_fields);
		let container_child_kinds = collect_child_container_kinds(raw, &structural_state);
		let is_supertype = is_supertype(raw);
		let has_structural_children = structural_state
			.get(kind)
			.is_some_and(|state| state.has_structural_children);

		if identifier_fields.is_empty()
			&& body_fields.is_empty()
			&& promotion_fields.is_empty()
			&& container_child_kinds.is_empty()
			&& !is_supertype
			&& !has_structural_children
		{
			continue;
		}

		out.insert(kind.clone(), GeneratedNodeTypeSchema {
			identifier_fields,
			body_fields,
			promotion_fields,
			container_child_kinds,
			is_supertype,
			has_structural_children,
		});
	}

	out
}

fn pick_priority_fields(
	fields: Option<&BTreeMap<String, RawFieldSpec>>,
	priority: &[&str],
) -> Vec<String> {
	let Some(fields) = fields else {
		return Vec::new();
	};

	priority
		.iter()
		.filter(|field| fields.contains_key(**field))
		.map(|field| (*field).to_string())
		.collect()
}

fn collect_child_container_kinds(
	raw: &RawNodeType,
	structural_state: &HashMap<String, StructuralState>,
) -> Vec<String> {
	let mut kinds = BTreeSet::new();
	let child_types = raw
		.children
		.as_ref()
		.map(|children| children.types.as_slice())
		.unwrap_or_default();

	for child in child_types {
		if !child.named {
			continue;
		}
		let Some(kind) = child.kind.as_deref() else {
			continue;
		};
		if structural_state
			.get(kind)
			.copied()
			.is_some_and(StructuralState::is_structural)
		{
			kinds.insert(kind.to_string());
		}
	}

	kinds.into_iter().collect()
}

fn collect_promotion_fields(
	raw: &RawNodeType,
	structural_state: &HashMap<String, StructuralState>,
	identifier_fields: &[String],
	body_fields: &[String],
) -> Vec<String> {
	let Some(fields) = raw.fields.as_ref() else {
		return Vec::new();
	};

	PROMOTION_FIELD_PRIORITY
		.iter()
		.filter_map(|field_name| {
			let spec = fields.get(*field_name)?;
			if spec.multiple
				|| identifier_fields.iter().any(|field| field == field_name)
				|| body_fields.iter().any(|field| field == field_name)
			{
				return None;
			}

			let has_structural_type = spec.types.iter().any(|field_type| {
				field_type.named
					&& field_type
						.kind
						.as_deref()
						.and_then(|kind| structural_state.get(kind))
						.copied()
						.is_some_and(StructuralState::is_structural)
			});
			has_structural_type.then(|| (*field_name).to_string())
		})
		.collect()
}

#[derive(Clone, Copy, Default)]
struct StructuralState {
	is_structural:           bool,
	has_structural_children: bool,
}

impl StructuralState {
	const fn is_structural(self) -> bool {
		self.is_structural
	}
}

fn compute_structural_state(
	raw_by_kind: &HashMap<String, RawNodeType>,
) -> HashMap<String, StructuralState> {
	let mut state = raw_by_kind
		.iter()
		.map(|(kind, raw)| {
			let base_structural = is_supertype(raw)
				|| raw.fields.as_ref().is_some_and(|fields| !fields.is_empty())
				|| !named_child_type_kinds(raw).is_empty();
			(kind.clone(), StructuralState {
				is_structural:           base_structural,
				has_structural_children: false,
			})
		})
		.collect::<HashMap<_, _>>();

	loop {
		let mut changed = false;
		for (kind, raw) in raw_by_kind {
			let next_has_structural_children =
				named_child_type_kinds(raw).into_iter().any(|child_kind| {
					state
						.get(child_kind.as_str())
						.copied()
						.is_some_and(StructuralState::is_structural)
				});

			let entry = state
				.get_mut(kind.as_str())
				.expect("every raw node should have structural state");
			let next_is_structural = entry.is_structural || next_has_structural_children;
			if next_is_structural != entry.is_structural
				|| next_has_structural_children != entry.has_structural_children
			{
				entry.is_structural = next_is_structural;
				entry.has_structural_children = next_has_structural_children;
				changed = true;
			}
		}
		if !changed {
			break;
		}
	}

	state
}

fn is_supertype(raw: &RawNodeType) -> bool {
	raw.subtypes
		.as_ref()
		.is_some_and(|subtypes| !subtypes.is_empty())
}

fn named_child_type_kinds(raw: &RawNodeType) -> BTreeSet<String> {
	let mut kinds = BTreeSet::new();
	if let Some(fields) = raw.fields.as_ref() {
		for field in fields.values() {
			for field_type in &field.types {
				if field_type.named
					&& let Some(kind) = &field_type.kind
				{
					kinds.insert(kind.clone());
				}
			}
		}
	}

	if let Some(children) = raw.children.as_ref() {
		for child in &children.types {
			if child.named
				&& let Some(kind) = &child.kind
			{
				kinds.insert(kind.clone());
			}
		}
	}

	kinds
}

fn cargo_registry_roots() -> Vec<PathBuf> {
	let mut roots = Vec::new();
	if let Some(cargo_home) = env::var_os("CARGO_HOME") {
		roots.push(PathBuf::from(cargo_home).join("registry").join("src"));
	}
	if let Some(home) = env::var_os("HOME") {
		roots.push(
			PathBuf::from(home)
				.join(".cargo")
				.join("registry")
				.join("src"),
		);
	}
	roots
}

fn find_registry_package_dir(
	registry_roots: &[PathBuf],
	package: &str,
	version: &str,
) -> Option<PathBuf> {
	for registry_root in registry_roots {
		let Ok(registry_dirs) = fs::read_dir(registry_root) else {
			continue;
		};
		for registry_dir in registry_dirs.flatten() {
			let candidate = registry_dir.path().join(format!("{package}-{version}"));
			if candidate.exists() {
				return Some(candidate);
			}
		}
	}
	None
}

fn locked_package_versions(lock_path: &Path) -> HashMap<String, String> {
	let source = fs::read_to_string(lock_path).expect("Cargo.lock should be readable");
	let mut versions = HashMap::new();
	let mut current_name = None;
	let mut current_version = None;

	for line in source.lines() {
		let trimmed = line.trim();
		if trimmed == "[[package]]" {
			if let (Some(name), Some(version)) = (current_name.take(), current_version.take()) {
				versions.insert(name, version);
			}
			continue;
		}
		if let Some(value) = trimmed.strip_prefix("name = \"") {
			current_name = value.strip_suffix('"').map(ToOwned::to_owned);
			continue;
		}
		if let Some(value) = trimmed.strip_prefix("version = \"") {
			current_version = value.strip_suffix('"').map(ToOwned::to_owned);
		}
	}

	if let (Some(name), Some(version)) = (current_name, current_version) {
		versions.insert(name, version);
	}

	versions
}
