// Command omk-initcheck performs fast, credential-safe OMK readiness checks.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"omk.local/initcheck"
)

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, os.LookupEnv))
}

func run(
	args []string,
	stdout io.Writer,
	stderr io.Writer,
	lookupEnv func(string) (string, bool),
) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintf(stdout, "omk-initcheck %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return 0
	}
	if args[0] != "models" {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	return runModels(args[1:], stdout, stderr, lookupEnv)
}

func runModels(
	args []string,
	stdout io.Writer,
	stderr io.Writer,
	lookupEnv func(string) (string, bool),
) int {
	flags := flag.NewFlagSet("models", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", defaultRoot(lookupEnv), "OMK agent root")
	configOnly := flags.Bool("config-only", false, "skip endpoint probes")
	timeout := flags.Duration("timeout", 8*time.Second, "total timeout per HTTP probe")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || *timeout <= 0 {
		fmt.Fprintln(stderr, "invalid models arguments")
		return 2
	}

	data, err := os.ReadFile(filepath.Join(*root, "models.json"))
	if err != nil {
		fmt.Fprintln(stdout, "  MISSING        models.json")
		return 1
	}
	config, err := initcheck.ParseModels(data)
	if err != nil {
		fmt.Fprintln(stdout, "  INVALID        models.json (JSON/JSONC parse error)")
		return 1
	}
	report := initcheck.CheckModels(*root, config, initcheck.DefaultSpecs, lookupEnv)
	if err := initcheck.WriteConfigReport(stdout, report); err != nil {
		fmt.Fprintln(stderr, "write report failed")
		return 2
	}
	failures := report.FailureCount()
	if !*configOnly {
		fmt.Fprintln(stdout, "\n## Model API connectivity (unauthenticated reachability check)")
		results := initcheck.ProbeModels(context.Background(), config, initcheck.DefaultSpecs, *timeout)
		if err := initcheck.WriteProbeReport(stdout, results); err != nil {
			fmt.Fprintln(stderr, "write report failed")
			return 2
		}
		failures += initcheck.ProbeFailureCount(results)
	}
	if failures > 0 {
		return 1
	}
	return 0
}

func defaultRoot(lookupEnv func(string) (string, bool)) string {
	if root, found := lookupEnv("OMK_AGENT_ROOT"); found && root != "" {
		return root
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".omk", "agent")
}

const usage = `usage: omk-initcheck <command>

commands:
  models [--root PATH] [--config-only] [--timeout 8s]
  version`
