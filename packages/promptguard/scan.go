package promptguard

import (
	"regexp"
	"sort"
	"strings"
)

// Severity ranks a defensive finding.
type Severity int

const (
	Low Severity = iota
	Medium
	High
)

func (s Severity) String() string {
	switch s {
	case High:
		return "high"
	case Medium:
		return "medium"
	default:
		return "low"
	}
}

// Finding is one detected injection signal. Excerpt is a bounded, escaped
// snippet safe to embed in a report; it is evidence, never an instruction.
type Finding struct {
	Rule     string   `json:"rule"`
	Severity Severity `json:"-"`
	Level    string   `json:"severity"`
	Offset   int      `json:"offset"`
	Excerpt  string   `json:"excerpt"`
}

type rule struct {
	name     string
	severity Severity
	re       *regexp.Regexp
}

// rules detect, and only detect, common prompt-injection shapes so a host can
// triage untrusted content. They are intentionally conservative signals.
var rules = []rule{
	{"instruction_override", High, regexp.MustCompile(`(?i)\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(all\s+)?(previous|prior|above|earlier|system)\b[^.\n]{0,20}\b(instruction|prompt|message|rule)`)},
	{"system_prompt_exfiltration", High, regexp.MustCompile(`(?i)\b(reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}\b(your\s+)?(system|developer|initial)\b[^.\n]{0,15}\b(prompt|message|instruction)`)},
	{"persona_reset", Medium, regexp.MustCompile(`(?i)\byou\s+are\s+now\b|\bfrom\s+now\s+on\s+you\b|\bact\s+as\s+(an?\s+)?unrestricted`)},
	{"mode_escalation", Medium, regexp.MustCompile(`(?i)\b(developer|god|dan|jailbreak)\s*mode\b`)},
	{"data_exfiltration", Medium, regexp.MustCompile(`(?i)\b(exfiltrate|send|post)\b[^.\n]{0,30}\b(secret|api[_\s-]?key|token|credential|password)`)},
	{"role_tag_injection", Medium, regexp.MustCompile(`(?i)</?(system|assistant|user|developer)>`)},
	{"encoding_marker", Low, regexp.MustCompile(`(?i)\bbase64\b|\brot13\b`)},
}

// Scan returns findings sorted by severity (high first) then position. It never
// mutates or emits attack strings, only bounded escaped evidence.
func Scan(text string) []Finding {
	var out []Finding
	for _, r := range rules {
		for _, m := range r.re.FindAllStringIndex(text, -1) {
			out = append(out, Finding{
				Rule:     r.name,
				Severity: r.severity,
				Level:    r.severity.String(),
				Offset:   m[0],
				Excerpt:  snippet(text, m[0], m[1]),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Severity != out[j].Severity {
			return out[i].Severity > out[j].Severity
		}
		return out[i].Offset < out[j].Offset
	})
	return out
}

// Highest returns the maximum severity found, and whether any finding exists.
func Highest(findings []Finding) (Severity, bool) {
	if len(findings) == 0 {
		return Low, false
	}
	top := findings[0].Severity
	for _, f := range findings[1:] {
		if f.Severity > top {
			top = f.Severity
		}
	}
	return top, true
}

const snippetPad = 24

func snippet(text string, start, end int) string {
	from := start - snippetPad
	if from < 0 {
		from = 0
	}
	to := end + snippetPad
	if to > len(text) {
		to = len(text)
	}
	window := strings.Join(strings.Fields(text[from:to]), " ")
	return EscapeText(window)
}
