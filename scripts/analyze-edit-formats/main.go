// Analyzes how agents use the `edit` tool across today's session jsonl files
// in ~/.omp/agent/sessions/.
//
// For every edit-family toolCall (edit, ast_edit, write) we:
//   - record what shape of arguments was supplied (loc, splice/pre/post/sed,
//     bracket form of locator, line vs file targeted, etc.)
//   - pair it with its toolResult and classify the result as success or as a
//     specific failure category (anchor stale, anchor unknown, no enclosing
//     block, parse error, ssr no match, etc.).
//
// Output is a markdown-ish report on stdout plus a CSV of every edit attempt
// to ./edit-analysis.csv (override with $EDIT_ANALYSIS_CSV).
package main

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type rawMessage struct {
	Type    string          `json:"type"`
	Message json.RawMessage `json:"message"`
}

type message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolName   string          `json:"toolName"`
	ToolCallID string          `json:"toolCallId"`
}

type contentItem struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	Arguments json.RawMessage `json:"arguments"`
}

type editEntry struct {
	File       string
	CallID     string
	ToolName   string
	NumEdits   int
	Verbs      []string // splice/pre/post/sed per sub-edit
	LocShapes  []string // bare/bracket-(/bracket-[/bracket-tail/bracket-head/$pre/$post/$sed
	HasNewFile bool
	HasGlob    bool
	HasOps     bool
	Format     string   // edit-tool argument schema family
	ResultRaw  string
	Status     string // "success" or failure category
}

// matchDate accepts files whose path contains any of the supplied date
// prefixes (e.g. "2026-04-28"). With no flags it accepts every .jsonl.
var dateFilters []string

func matchDate(p string) bool {
	if len(dateFilters) == 0 {
		return true
	}
	for _, d := range dateFilters {
		if strings.Contains(p, d) {
			return true
		}
	}
	return false
}

func main() {
	dateFilters = os.Args[1:]
	root, err := os.UserHomeDir()
	must(err)
	base := filepath.Join(root, ".omp", "agent", "sessions")

	var files []string
	must(filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(p, ".jsonl") {
			return nil
		}
		if !matchDate(p) {
			return nil
		}
		files = append(files, p)
		return nil
	}))
	sort.Strings(files)
	fmt.Fprintf(os.Stderr, "loaded %d session files for today\n", len(files))

	var entries []editEntry
	for _, f := range files {
		entries = append(entries, processFile(f)...)
	}

	report(entries)
	writeCSV(entries)
}

func processFile(path string) []editEntry {
	fh, err := os.Open(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		return nil
	}
	defer fh.Close()

	calls := map[string]*editEntry{}
	var order []string

	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for sc.Scan() {
		var rm rawMessage
		if err := json.Unmarshal(sc.Bytes(), &rm); err != nil {
			continue
		}
		if rm.Type != "message" {
			continue
		}
		var m message
		if err := json.Unmarshal(rm.Message, &m); err != nil {
			continue
		}
		var items []contentItem
		if err := json.Unmarshal(m.Content, &items); err != nil {
			continue
		}

		switch m.Role {
		case "assistant":
			for _, it := range items {
				if it.Type != "toolCall" {
					continue
				}
				if !isEditTool(it.Name) {
					continue
				}
				e := classifyArgs(it.Name, it.Arguments)
				e.File = path
				e.CallID = it.ID
				e.ToolName = it.Name
				calls[it.ID] = &e
				order = append(order, it.ID)
			}
		case "toolResult":
			if !isEditTool(m.ToolName) {
				continue
			}
			e, ok := calls[m.ToolCallID]
			if !ok {
				// orphan result, skip
				continue
			}
			text := joinText(items)
			e.ResultRaw = text
			e.Status = classifyResult(m.ToolName, text)
		}
	}

	out := make([]editEntry, 0, len(order))
	for _, id := range order {
		if e, ok := calls[id]; ok {
			out = append(out, *e)
		}
	}
	return out
}

func isEditTool(name string) bool {
	switch strings.ToLower(name) {
	case "edit", "ast_edit", "write":
		return true
	}
	return false
}

func joinText(items []contentItem) string {
	var b strings.Builder
	for _, it := range items {
		if it.Type == "text" {
			b.WriteString(it.Text)
		}
	}
	return b.String()
}

// ---- argument classification ----

type editOp struct {
	Loc    string          `json:"loc"`
	Splice json.RawMessage `json:"splice"`
	Pre    json.RawMessage `json:"pre"`
	Post   json.RawMessage `json:"post"`
	Sed    json.RawMessage `json:"sed"`
}

type editArgs struct {
	Path  string   `json:"path"`
	Edits []editOp `json:"edits"`

	// ast_edit
	Ops []json.RawMessage `json:"ops"`

	// Write
	Content *string `json:"content,omitempty"`
}

var anchorBare = regexp.MustCompile(`^[a-zA-Z]?\d+[a-z]{2}$`)
var anchorWithFile = regexp.MustCompile(`^[^:]+:\d+[a-z]{2}$`)

func classifyArgs(name string, raw json.RawMessage) editEntry {
	e := editEntry{}
	e.Format = detectFormat(name, raw)
	switch strings.ToLower(name) {
	case "edit":
		var a editArgs
		_ = json.Unmarshal(raw, &a)
		e.NumEdits = len(a.Edits)
		for _, op := range a.Edits {
			e.LocShapes = append(e.LocShapes, locShape(op.Loc))
			verbs := []string{}
			if !isNullOrEmpty(op.Splice) {
				verbs = append(verbs, "splice")
			}
			if !isNullOrEmpty(op.Pre) {
				verbs = append(verbs, "pre")
			}
			if !isNullOrEmpty(op.Post) {
				verbs = append(verbs, "post")
			}
			if !isNullOrEmpty(op.Sed) {
				verbs = append(verbs, "sed")
			}
			if len(verbs) == 0 {
				verbs = append(verbs, "none")
			}
			e.Verbs = append(e.Verbs, strings.Join(verbs, "+"))
		}
	case "ast_edit":
		var a editArgs
		_ = json.Unmarshal(raw, &a)
		e.HasOps = len(a.Ops) > 0
		e.NumEdits = len(a.Ops)
		if strings.ContainsAny(a.Path, "*?,") {
			e.HasGlob = true
		}
	case "write":
		e.HasNewFile = true
		e.NumEdits = 1
		e.Verbs = []string{"write"}
	}
	return e
}

// detectFormat figures out which edit-tool argument schema is in use by
// looking at the top-level argument keys and (for `edit`) the keys of the
// first sub-edit. Older sessions used many incompatible schemas.
func detectFormat(name string, raw json.RawMessage) string {
	switch strings.ToLower(name) {
	case "write":
		return "write"
	case "ast_edit":
		return "ast_edit"
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return "unknown"
	}
	has := func(k string) bool { _, ok := top[k]; return ok }
	switch {
	case has("oldText") && has("newText"):
		return "oldText/newText"
	case has("old_text") && has("new_text"):
		return "old_text/new_text"
	case has("diff") && has("op"):
		return "diff+op"
	case has("diff") && has("operation"):
		return "diff+operation"
	case has("diff"):
		return "diff"
	case has("replace") || has("insert"):
		return "replace/insert"
	}
	if edits, ok := top["edits"]; ok {
		var list []map[string]json.RawMessage
		if err := json.Unmarshal(edits, &list); err == nil && len(list) > 0 {
			first := list[0]
			fh := func(k string) bool { _, ok := first[k]; return ok }
			switch {
			case fh("loc") && (fh("splice") || fh("pre") || fh("post") || fh("sed")):
				return "loc+splice/pre/post/sed"
			case fh("loc") && fh("content"):
				return "loc+content"
			case fh("set_line"):
				return "set_line"
			case fh("insert_after"):
				return "insert_after"
			case fh("op") && fh("pos") && fh("end") && fh("lines"):
				return "op+pos+end+lines"
			case fh("op") && fh("pos") && fh("lines"):
				return "op+pos+lines"
			case fh("op") && fh("sel") && fh("content"):
				return "op+sel+content"
			case fh("all") && (fh("new_text") || fh("old_text")):
				return "per-edit:old_text/new_text"
			}
			keys := make([]string, 0, len(first))
			for k := range first {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			return "edits[" + strings.Join(keys, ",") + "]"
		}
	}
	keys := make([]string, 0, len(top))
	for k := range top {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

func isNullOrEmpty(b json.RawMessage) bool {
	s := strings.TrimSpace(string(b))
	return s == "" || s == "null"
}

func locShape(loc string) string {
	if loc == "" {
		return "empty"
	}
	if loc == "$" {
		return "$file"
	}
	// strip optional file: prefix
	rest := loc
	if i := strings.LastIndex(loc, ":"); i >= 0 && !strings.HasPrefix(loc, "$") {
		rest = loc[i+1:]
	}
	switch {
	case strings.HasPrefix(rest, "(") && strings.HasSuffix(rest, ")"):
		return "bracket-(body)"
	case strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]"):
		return "bracket-[block]"
	case strings.HasPrefix(rest, "(") || strings.HasPrefix(rest, "["):
		return "bracket-tail"
	case strings.HasSuffix(rest, ")") || strings.HasSuffix(rest, "]"):
		return "bracket-head"
	case anchorBare.MatchString(rest):
		return "bare-anchor"
	}
	return "other"
}

// ---- result classification ----

var (
	reAnchorStale     = regexp.MustCompile(`(?i)(Edit rejected:.*line[s]? .* changed since the last read|line[s]? ha(s|ve) changed since last read)`)
	reAnchorMissing   = regexp.MustCompile(`(?i)anchor .* (not found|unknown|missing)|loc requires the full anchor`)
	reNoEnclosing     = regexp.MustCompile(`(?i)No enclosing .* block`)
	reParseError      = regexp.MustCompile(`(?i)parse|syntax error|unbalanced|unexpected token`)
	reSSRNoMatch      = regexp.MustCompile(`(?i)0 matches|no replacements|no match found|No replacements made|Failed to find expected lines`)
	reFileNotRead     = regexp.MustCompile(`(?i)must be read first|has not been read|not yet read`)
	reFileChanged     = regexp.MustCompile(`(?i)file has been (modified|changed) externally`)
	rePermDenied      = regexp.MustCompile(`(?i)permission denied|not allowed`)
	reGenericRejected = regexp.MustCompile(`(?i)\b(rejected|failed|error|invalid)\b`)
	reTruncated       = regexp.MustCompile(`(?i)\[Output truncated`)
	reAborted         = regexp.MustCompile(`(?i)Tool execution was aborted|Request was aborted|cancelled|canceled by user`)
	reSuccess         = regexp.MustCompile(`(?i)^(Updated|Successfully (wrote|replaced|edited|deleted|inserted)|Replaced|Applied|Deleted|Created|Wrote|edit applied|Edited|Inserted|OK\b)`)
)

func classifyResult(tool, text string) string {
	t := strings.TrimSpace(text)
	if t == "" {
		return "empty"
	}
	first := strings.SplitN(t, "\n", 2)[0]
	switch {
	case reTruncated.MatchString(first):
		return "truncated"
	case reAborted.MatchString(t):
		return "aborted"
	case reSuccess.MatchString(first):
		return "success"
	case reAnchorStale.MatchString(t):
		return "fail:anchor-stale"
	case reNoEnclosing.MatchString(t):
		return "fail:no-enclosing-block"
	case reAnchorMissing.MatchString(t):
		return "fail:anchor-missing"
	case reParseError.MatchString(t):
		return "fail:parse"
	case reSSRNoMatch.MatchString(t):
		return "fail:no-match"
	case reFileNotRead.MatchString(t):
		return "fail:file-not-read"
	case reFileChanged.MatchString(t):
		return "fail:file-changed"
	case rePermDenied.MatchString(t):
		return "fail:perm"
	case reGenericRejected.MatchString(first):
		return "fail:other"
	}
	return "unknown"
}

// ---- reporting ----

func report(entries []editEntry) {
	if len(entries) == 0 {
		fmt.Println("no edit-family tool calls found in today's sessions")
		return
	}

	byTool := map[string]int{}
	byFormat := map[string]int{}
	statusByFormat := map[string]map[string]int{}
	statusByTool := map[string]map[string]int{}
	verbCount := map[string]int{}
	locCount := map[string]int{}
	failsByVerb := map[string]map[string]int{}
	failsByLoc := map[string]map[string]int{}

	for _, e := range entries {
		byTool[e.ToolName]++
		if statusByTool[e.ToolName] == nil {
			statusByTool[e.ToolName] = map[string]int{}
		}
		statusByTool[e.ToolName][e.Status]++
		byFormat[e.Format]++
		if statusByFormat[e.Format] == nil {
			statusByFormat[e.Format] = map[string]int{}
		}
		statusByFormat[e.Format][e.Status]++

		for _, v := range e.Verbs {
			verbCount[v]++
			if failsByVerb[v] == nil {
				failsByVerb[v] = map[string]int{}
			}
			failsByVerb[v][e.Status]++
		}
		for _, l := range e.LocShapes {
			locCount[l]++
			if failsByLoc[l] == nil {
				failsByLoc[l] = map[string]int{}
			}
			failsByLoc[l][e.Status]++
		}
	}

	fmt.Println("# Edit-tool usage in today's sessions")
	fmt.Printf("\nTotal tool calls: %d (across %d sessions)\n",
		len(entries), countSessions(entries))

	fmt.Println("\n## By tool")
	printSorted(byTool)

	fmt.Println("\n## Outcome by tool")
	tools := keys(byTool)
	sort.Strings(tools)
	for _, t := range tools {
		fmt.Printf("\n  %s (%d calls):\n", t, byTool[t])
		printSortedIndent(statusByTool[t], "    ")
	}

	fmt.Println("\n## edit verb distribution (per sub-edit)")
	printSorted(verbCount)

	fmt.Println("\n## edit locator shape distribution")
	printSorted(locCount)

	fmt.Println("\n## Failure rate per verb shape")
	for _, v := range sortedKeys(verbCount) {
		total, failed := 0, 0
		for status, n := range failsByVerb[v] {
			total += n
			if strings.HasPrefix(status, "fail") {
				failed += n
			}
		}
		fmt.Printf("  %-20s %d/%d failed (%.0f%%)\n", v, failed, total, pct(failed, total))
	}

	fmt.Println("\n## Failure rate per locator shape")
	for _, l := range sortedKeys(locCount) {
		total, failed := 0, 0
		for status, n := range failsByLoc[l] {
			total += n
			if strings.HasPrefix(status, "fail") {
				failed += n
			}
		}
		fmt.Printf("  %-20s %d/%d failed (%.0f%%)\n", l, failed, total, pct(failed, total))
	}

	fmt.Println("\n## edit-tool argument-format usage")
	printSorted(byFormat)

	fmt.Println("\n## Failure rate per argument format")
	for _, fname := range sortedKeys(byFormat) {
		total, failed := 0, 0
		for status, n := range statusByFormat[fname] {
			total += n
			if strings.HasPrefix(status, "fail") {
				failed += n
			}
		}
		fmt.Printf("  %-32s %6d/%-6d failed (%.0f%%)\n", fname, failed, total, pct(failed, total))
	}

	fmt.Println("\n## Failure breakdown per top format")
	cap := 0
	for _, fname := range sortedKeys(byFormat) {
		if cap >= 8 {
			break
		}
		cap++
		fmt.Printf("\n  %s (%d total)\n", fname, byFormat[fname])
		printSortedIndent(statusByFormat[fname], "    ")
	}

	fmt.Println("\n## Sample failed edits")
	shown := 0
	for _, e := range entries {
		if !strings.HasPrefix(e.Status, "fail") {
			continue
		}
		fmt.Printf("\n— %s [%s] verbs=%v loc=%v\n  result: %s\n",
			e.ToolName, e.Status, e.Verbs, e.LocShapes,
			truncate(strings.SplitN(e.ResultRaw, "\n\n", 2)[0], 220))
		shown++
		if shown >= 8 {
			break
		}
	}
}

func countSessions(es []editEntry) int {
	s := map[string]struct{}{}
	for _, e := range es {
		s[e.File] = struct{}{}
	}
	return len(s)
}

func printSorted(m map[string]int) {
	for _, k := range sortedKeys(m) {
		fmt.Printf("  %-25s %d\n", k, m[k])
	}
}

func printSortedIndent(m map[string]int, indent string) {
	for _, k := range sortedKeys(m) {
		fmt.Printf("%s%-25s %d\n", indent, k, m[k])
	}
}

func sortedKeys(m map[string]int) []string {
	type kv struct {
		k string
		v int
	}
	pairs := make([]kv, 0, len(m))
	for k, v := range m {
		pairs = append(pairs, kv{k, v})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].v != pairs[j].v {
			return pairs[i].v > pairs[j].v
		}
		return pairs[i].k < pairs[j].k
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.k
	}
	return out
}

func keys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func pct(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " | ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func writeCSV(entries []editEntry) {
	csvPath := os.Getenv("EDIT_ANALYSIS_CSV")
	if csvPath == "" {
		csvPath = "edit-analysis.csv"
	}
	f, err := os.Create(csvPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "csv:", err)
		return
	}
	defer f.Close()
	w := csv.NewWriter(f)
	defer w.Flush()
	_ = w.Write([]string{"session", "tool", "status", "num_edits", "verbs", "loc_shapes", "result_first_line"})
	for _, e := range entries {
		first := strings.SplitN(e.ResultRaw, "\n", 2)[0]
		_ = w.Write([]string{
			filepath.Base(e.File),
			e.ToolName,
			e.Status,
			fmt.Sprintf("%d", e.NumEdits),
			strings.Join(e.Verbs, ","),
			strings.Join(e.LocShapes, ","),
			truncate(first, 200),
		})
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}
