use tree_sitter::Node;

use super::{
	classify::{
		ClassifierTables, LangClassifier, NamingMode, RecurseMode, RuleStyle, StructuralOverrides,
		semantic_rule,
	},
	common::*,
	kind::ChunkKind,
};

pub struct GoClassifier;

const ROOT_RULES: &[super::classify::SemanticRule] = &[
	// ── Imports / package ──
	semantic_rule(
		"package_clause",
		ChunkKind::Module,
		RuleStyle::Named,
		NamingMode::AutoIdentifier,
		RecurseMode::None,
	),
	semantic_rule(
		"import_declaration",
		ChunkKind::Imports,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	// ── Functions ──
	semantic_rule(
		"function_declaration",
		ChunkKind::Function,
		RuleStyle::Named,
		NamingMode::AutoIdentifier,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	semantic_rule(
		"method_declaration",
		ChunkKind::Function,
		RuleStyle::Named,
		NamingMode::AutoIdentifier,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	// ── Statements ──
	semantic_rule(
		"expression_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	semantic_rule(
		"go_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	semantic_rule(
		"defer_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	semantic_rule(
		"send_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
];

const CLASS_RULES: &[super::classify::SemanticRule] = &[
	// ── Methods ──
	semantic_rule(
		"method_spec",
		ChunkKind::Method,
		RuleStyle::Named,
		NamingMode::AutoIdentifier,
		RecurseMode::None,
	),
	// ── Field / method lists ──
	semantic_rule(
		"field_declaration_list",
		ChunkKind::Fields,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	semantic_rule(
		"method_spec_list",
		ChunkKind::Methods,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
];

const FUNCTION_RULES: &[super::classify::SemanticRule] = &[
	// ── Control flow ──
	semantic_rule(
		"if_statement",
		ChunkKind::If,
		RuleStyle::Named,
		NamingMode::None,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	semantic_rule(
		"for_statement",
		ChunkKind::For,
		RuleStyle::Named,
		NamingMode::None,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	semantic_rule(
		"switch_statement",
		ChunkKind::Switch,
		RuleStyle::Named,
		NamingMode::None,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	semantic_rule(
		"expression_switch_statement",
		ChunkKind::Switch,
		RuleStyle::Named,
		NamingMode::None,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	semantic_rule(
		"type_switch_statement",
		ChunkKind::Switch,
		RuleStyle::Named,
		NamingMode::None,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	semantic_rule(
		"select_statement",
		ChunkKind::Switch,
		RuleStyle::Named,
		NamingMode::None,
		RecurseMode::Auto(ChunkContext::FunctionBody),
	),
	// ── Statements ──
	semantic_rule(
		"go_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	semantic_rule(
		"defer_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
	semantic_rule(
		"send_statement",
		ChunkKind::Statements,
		RuleStyle::Group,
		NamingMode::None,
		RecurseMode::None,
	),
];

const GO_TABLES: ClassifierTables = ClassifierTables {
	root:                 ROOT_RULES,
	class:                CLASS_RULES,
	function:             FUNCTION_RULES,
	structural_overrides: StructuralOverrides::EMPTY,
};

impl LangClassifier for GoClassifier {
	fn tables(&self) -> &'static ClassifierTables {
		&GO_TABLES
	}

	fn classify_override<'t>(
		&self,
		context: ChunkContext,
		node: Node<'t>,
		source: &str,
	) -> Option<RawChunkCandidate<'t>> {
		match context {
			ChunkContext::Root => classify_root_custom(node, source),
			ChunkContext::ClassBody => classify_class_custom(node, source),
			ChunkContext::FunctionBody => classify_function_custom(node, source),
		}
	}
}

fn classify_root_custom<'t>(node: Node<'t>, source: &str) -> Option<RawChunkCandidate<'t>> {
	match node.kind() {
		// ── Variables ──
		"const_declaration" | "var_declaration" | "short_var_declaration" => {
			Some(match extract_identifier(node, source) {
				Some(name) => make_kind_chunk(node, ChunkKind::Variable, Some(name), source, None),
				None => group_candidate(node, ChunkKind::Declarations, source),
			})
		},

		// ── Containers ──
		"type_declaration" => Some(classify_type_decl(node, source)),

		// ── Control flow (top-level scripts) ──
		"if_statement"
		| "switch_statement"
		| "expression_switch_statement"
		| "type_switch_statement"
		| "select_statement"
		| "for_statement" => Some(classify_function_go(node, source)),

		_ => None,
	}
}

fn classify_class_custom<'t>(node: Node<'t>, source: &str) -> Option<RawChunkCandidate<'t>> {
	match node.kind() {
		// ── Fields ──
		"field_declaration" | "embedded_field" => Some(match extract_identifier(node, source) {
			Some(name) => make_kind_chunk(node, ChunkKind::Field, Some(name), source, None),
			None => group_candidate(node, ChunkKind::Fields, source),
		}),
		_ => None,
	}
}

fn classify_function_custom<'t>(node: Node<'t>, source: &str) -> Option<RawChunkCandidate<'t>> {
	match node.kind() {
		// ── Variables ──
		"short_var_declaration" | "var_declaration" | "const_declaration" => {
			let span = line_span(node.start_position().row + 1, node.end_position().row + 1);
			Some(if span > 1 {
				if let Some(name) = extract_identifier(node, source) {
					make_kind_chunk(node, ChunkKind::Variable, Some(name), source, None)
				} else {
					group_from_sanitized(node, source)
				}
			} else {
				group_from_sanitized(node, source)
			})
		},
		_ => None,
	}
}

/// Classify Go function-level nodes (reused for top-level control flow
/// delegation).
fn classify_function_go<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
	let fn_recurse = || recurse_body(node, ChunkContext::FunctionBody);
	match node.kind() {
		"if_statement" => {
			make_candidate(node, ChunkKind::If, None, NameStyle::Named, None, fn_recurse(), source)
		},
		"switch_statement"
		| "expression_switch_statement"
		| "type_switch_statement"
		| "select_statement" => {
			make_candidate(node, ChunkKind::Switch, None, NameStyle::Named, None, fn_recurse(), source)
		},
		"for_statement" => {
			make_candidate(node, ChunkKind::For, None, NameStyle::Named, None, fn_recurse(), source)
		},
		_ => group_candidate(node, ChunkKind::Statements, source),
	}
}

/// Classify Go `type_declaration` nodes.
///
/// A single `type_spec` with a struct/interface body becomes a container;
/// a single `type_spec` without one becomes a named leaf.
/// Multiple `type_spec` children (type group) become a group.
fn classify_type_decl<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
	let specs: Vec<Node<'t>> = named_children(node)
		.into_iter()
		.filter(|c| c.kind() == "type_spec")
		.collect();

	if specs.len() == 1 {
		let spec = specs[0];
		let name = extract_identifier(spec, source).unwrap_or_else(|| "anonymous".to_string());
		if let Some(recurse) = recurse_type_spec(spec) {
			return make_container_chunk_from(
				node,
				spec,
				ChunkKind::Type,
				Some(name),
				source,
				Some(recurse),
			);
		}
		return make_kind_chunk_from(node, spec, ChunkKind::Type, Some(name), source, None);
	}

	group_candidate(node, ChunkKind::Declarations, source)
}

fn group_from_sanitized<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
	let sanitized = sanitize_node_kind(node.kind());
	let kind = ChunkKind::from_sanitized_kind(sanitized);
	let identifier = if kind == ChunkKind::Chunk {
		Some(sanitized.to_string())
	} else {
		None
	};
	make_candidate(node, kind, identifier, NameStyle::Group, None, None, source)
}

/// For a `type_spec`, find a `struct_type` or `interface_type` child and return
/// its body (`field_declaration_list` or `method_spec_list`) as a recurse spec.
fn recurse_type_spec(node: Node<'_>) -> Option<RecurseSpec<'_>> {
	let container = child_by_kind(node, &["struct_type", "interface_type"])?;
	let body = child_by_kind(container, &["field_declaration_list", "method_spec_list"])
		.unwrap_or(container);
	Some(RecurseSpec { node: body, context: ChunkContext::ClassBody })
}
