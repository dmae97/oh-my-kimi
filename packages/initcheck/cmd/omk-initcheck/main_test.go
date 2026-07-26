package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRunModelsConfigOnly(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	config := `{"providers":{
		"kimi-coding":{"api":"anthropic-messages","baseUrl":"https://api.kimi.com/coding","apiKey":"$KEY","models":[{"id":"k3","thinkingLevelMap":{"medium":"max","high":"max","xhigh":"max"}}]},
		"modelstudio-maas":{"api":"openai-completions","baseUrl":"https://example.test/v1?secret=never-print","apiKey":"$KEY","compat":{"thinkingFormat":"qwen"},"models":[{"id":"qwen3.8-max-preview"}]}
	}}`
	require.NoError(t, os.WriteFile(filepath.Join(root, "models.json"), []byte(config), 0o600))
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"models", "--root", root, "--config-only"},
		&stdout,
		&stderr,
		func(string) (string, bool) { return "value", true },
	)
	require.Zero(t, code, stderr.String())
	require.Contains(t, stdout.String(), "k3")
	require.Contains(t, stdout.String(), "qwen3.8-max")
	require.NotContains(t, stdout.String(), "never-print")
}

func TestRunModelsExitCodes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		args []string
		want int
	}{
		{"missing config", []string{"models", "--root", t.TempDir(), "--config-only"}, 1},
		{"bad timeout", []string{"models", "--timeout", "0s"}, 2},
		{"unknown command", []string{"unknown"}, 2},
		{"version", []string{"version"}, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var stdout, stderr bytes.Buffer
			require.Equal(t, test.want, run(test.args, &stdout, &stderr, os.LookupEnv))
		})
	}
}
