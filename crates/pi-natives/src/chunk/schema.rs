use std::{cell::RefCell, collections::HashMap};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GeneratedSchema {
	languages: HashMap<String, HashMap<String, NodeTypeSchema>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct NodeTypeSchema {
	pub identifier_fields:       Vec<String>,
	pub body_fields:             Vec<String>,
	pub promotion_fields:        Vec<String>,
	pub container_child_kinds:   Vec<String>,
	pub is_supertype:            bool,
	pub has_structural_children: bool,
}

impl NodeTypeSchema {
	pub const fn is_structural(&self) -> bool {
		self.is_supertype
			|| !self.identifier_fields.is_empty()
			|| !self.body_fields.is_empty()
			|| !self.container_child_kinds.is_empty()
			|| self.has_structural_children
	}
}

thread_local! {
	static CURRENT_LANGUAGE: RefCell<Option<&'static str>> = const { RefCell::new(None) };
}

static GENERATED_SCHEMA: std::sync::LazyLock<HashMap<String, HashMap<String, NodeTypeSchema>>> =
	std::sync::LazyLock::new(|| {
		let raw = include_str!(concat!(env!("OUT_DIR"), "/chunk_schema.json"));
		let generated: GeneratedSchema =
			serde_json::from_str(raw).expect("generated chunk schema should parse");
		generated.languages
	});

pub struct SchemaLanguageGuard {
	previous: Option<&'static str>,
}

impl Drop for SchemaLanguageGuard {
	fn drop(&mut self) {
		CURRENT_LANGUAGE.with(|current| {
			*current.borrow_mut() = self.previous;
		});
	}
}

pub fn enter_language(language: &'static str) -> SchemaLanguageGuard {
	let previous = CURRENT_LANGUAGE.with(|current| current.replace(Some(language)));
	SchemaLanguageGuard { previous }
}

pub fn current_language() -> Option<&'static str> {
	CURRENT_LANGUAGE.with(|current| *current.borrow())
}

pub fn schema_for(language: &str, kind: &str) -> Option<&'static NodeTypeSchema> {
	GENERATED_SCHEMA
		.get(language)
		.and_then(|schemas| schemas.get(kind))
}

pub fn schema_for_current(kind: &str) -> Option<&'static NodeTypeSchema> {
	current_language().and_then(|language| schema_for(language, kind))
}

#[cfg(test)]
pub fn has_schema(language: &str) -> bool {
	GENERATED_SCHEMA.contains_key(language)
}

#[cfg(test)]
mod tests {
	use super::{has_schema, schema_for};

	#[test]
	fn python_function_definition_schema_has_name_and_body() {
		let schema = schema_for("python", "function_definition")
			.expect("python function_definition schema should exist");
		assert_eq!(schema.identifier_fields, vec!["name".to_string()]);
		assert_eq!(schema.body_fields, vec!["body".to_string()]);
		assert!(schema.promotion_fields.is_empty());
		assert!(schema.is_structural());
	}

	#[test]
	fn nix_let_expression_schema_exposes_binding_set_child() {
		let schema =
			schema_for("nix", "let_expression").expect("nix let_expression schema should exist");
		assert_eq!(schema.body_fields, vec!["body".to_string()]);
		assert!(
			schema
				.container_child_kinds
				.iter()
				.any(|kind| kind == "binding_set"),
			"let_expression should surface binding_set children"
		);
		assert!(schema.has_structural_children);
	}

	#[test]
	fn wrapper_schemas_preserve_promotable_definition_fields() {
		let python = schema_for("python", "decorated_definition")
			.expect("python decorated_definition schema should exist");
		assert_eq!(python.promotion_fields, vec!["definition".to_string()]);

		let typescript = schema_for("typescript", "export_statement")
			.expect("typescript export_statement schema should exist");
		assert!(
			typescript
				.promotion_fields
				.iter()
				.any(|field| field == "declaration"),
			"export_statement should preserve declaration field for promotion"
		);
	}

	#[test]
	fn generated_schema_covers_expected_languages() {
		for language in ["python", "nix", "toml", "typescript", "rust", "yaml", "handlebars"] {
			assert!(has_schema(language), "{language} should have generated schema data");
		}
	}
}
