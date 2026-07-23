// Package promptguard is a portable, dependency-free toolkit for assembling
// prompts that resist injection from untrusted context, tool, and retrieved
// content. It is defense in depth: structural isolation and detection, not a
// sandbox. It never generates override or bypass material.
package promptguard

import "strings"

// textEscaper encodes only the three XML text-node metacharacters. Quotes and
// apostrophes are preserved so embedded prose and code stay readable.
var textEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
)

// attrEscaper additionally encodes quotes for safe use inside an attribute.
var attrEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&apos;",
)

// EscapeText encodes untrusted content for an XML text node so it cannot open
// or close a surrounding tag. strings.Replacer is single-pass, so "&" is never
// double-encoded.
func EscapeText(s string) string { return textEscaper.Replace(s) }

// EscapeAttr encodes untrusted content for an XML attribute value.
func EscapeAttr(s string) string { return attrEscaper.Replace(s) }
