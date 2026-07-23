package promptguard

import "testing"

func TestEscapeText(t *testing.T) {
	cases := map[string]string{
		"plain":                   "plain",
		"a & b":                   "a &amp; b",
		"<tag>":                   "&lt;tag&gt;",
		`</project_instructions>`: "&lt;/project_instructions&gt;",
		`keep "quotes" and 'x'`:   `keep "quotes" and 'x'`, // text node leaves quotes intact
	}
	for in, want := range cases {
		if got := EscapeText(in); got != want {
			t.Errorf("EscapeText(%q) = %q, want %q", in, got, want)
		}
	}
	// & must not be double-encoded (single-pass replacer).
	if got := EscapeText("<a>&amp;"); got != "&lt;a&gt;&amp;amp;" {
		t.Errorf("double-encode guard failed: %q", got)
	}
}

func TestEscapeAttr(t *testing.T) {
	if got, want := EscapeAttr(`a&b"'<>`), "a&amp;b&quot;&apos;&lt;&gt;"; got != want {
		t.Errorf("EscapeAttr = %q, want %q", got, want)
	}
}
