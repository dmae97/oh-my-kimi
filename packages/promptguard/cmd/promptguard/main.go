// Command promptguard exposes the promptguard library over stdin/stdout.
//
//	promptguard boundary            # print the runtime trust boundary
//	promptguard escape < file       # XML-escape stdin text
//	promptguard scan   < file       # detect injection signals; exit 3 on high
//	promptguard scan --json < file  # machine-readable findings
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"omk.local/promptguard"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "boundary":
		fmt.Fprintln(stdout, promptguard.TrustBoundary)
		return 0
	case "escape":
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintln(stderr, "read:", err)
			return 1
		}
		fmt.Fprint(stdout, promptguard.EscapeText(string(data)))
		return 0
	case "scan":
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintln(stderr, "read:", err)
			return 1
		}
		findings := promptguard.Scan(string(data))
		if contains(args[1:], "--json") {
			enc := json.NewEncoder(stdout)
			enc.SetIndent("", "  ")
			if err := enc.Encode(findings); err != nil {
				fmt.Fprintln(stderr, "encode:", err)
				return 1
			}
		} else {
			for _, f := range findings {
				fmt.Fprintf(stdout, "[%s] %s @%d: %s\n", f.Level, f.Rule, f.Offset, f.Excerpt)
			}
		}
		if top, ok := promptguard.Highest(findings); ok && top == promptguard.High {
			return 3 // fail-closed signal for CI gating
		}
		return 0
	default:
		fmt.Fprintln(stderr, usage)
		return 2
	}
}

func contains(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

const usage = "usage: promptguard <boundary|escape|scan> [--json]"
