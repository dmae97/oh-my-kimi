package initcheck

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCheckModelsAcceptsJSONCWithoutExecutingKeyCommands(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	keyFile := filepath.Join(root, "k3.key")
	require.NoError(t, os.WriteFile(keyFile, []byte("not-a-real-secret"), 0o600))
	marker := filepath.Join(root, "command-executed")
	input := `{
		// model configuration
		"providers": {
			"kimi-coding": {
				"api": "anthropic-messages",
				"baseUrl": "https://api.kimi.com/coding",
				"apiKey": "!cat ` + keyFile + `",
				"models": [{"id":"k3","thinkingLevelMap":{"medium":"max","high":"max","xhigh":"max",},}],
			},
			"modelstudio-maas": {
				"api": "openai-completions",
				"baseUrl": "https://example.invalid/v1?token=never-print#fragment",
				"apiKey": "!touch ` + marker + `",
				"compat": {"thinkingFormat":"qwen"},
				"models": [{"id":"qwen3.8-max-preview"}],
			},
		},
	}`

	cfg, err := ParseModels([]byte(input))
	require.NoError(t, err)
	report := CheckModels(root, cfg, DefaultSpecs, os.LookupEnv)
	require.Zero(t, report.FailureCount())
	require.Len(t, report.Checks, 2)
	require.Equal(t, "file command", report.Checks[0].KeySource)
	require.Equal(t, "command (not executed)", report.Checks[1].KeySource)
	_, err = os.Stat(marker)
	require.ErrorIs(t, err, os.ErrNotExist)

	var output strings.Builder
	require.NoError(t, WriteConfigReport(&output, report))
	require.NotContains(t, output.String(), "not-a-real-secret")
	require.NotContains(t, output.String(), "never-print")
	require.NotContains(t, output.String(), marker)
}

func TestCheckModelsRejectsIncompatibleQwenThinkingFormat(t *testing.T) {
	t.Parallel()
	cfg := mustParse(t, validConfig(`"thinkingFormat":"openai"`))
	report := CheckModels(t.TempDir(), cfg, DefaultSpecs, func(string) (string, bool) { return "set", true })
	require.Equal(t, 1, report.FailureCount())
	require.Contains(t, report.Checks[1].Issues, "thinkingFormat must be qwen")
}

func TestInspectKeySources(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	keyFile := filepath.Join(root, "key")
	require.NoError(t, os.WriteFile(keyFile, []byte("x"), 0o600))

	tests := []struct {
		name       string
		value      string
		configured bool
		source     string
	}{
		{"missing", "", false, "missing"},
		{"file", "!cat " + keyFile, true, "file command"},
		{"missing file", "!cat " + filepath.Join(root, "none"), false, "file command"},
		{"opaque command", "!printf secret", true, "command (not executed)"},
		{"environment", "$TEST_KEY", true, "environment"},
		{"missing environment", "${ABSENT_KEY}", false, "environment"},
		{"inline", "inline-secret", true, "inline value"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := inspectKey(root, tt.value, func(name string) (string, bool) {
				if name == "TEST_KEY" {
					return "secret", true
				}
				return "", false
			})
			require.Equal(t, tt.configured, got.Configured)
			require.Equal(t, tt.source, got.Source)
		})
	}
}

func TestParseModelsPreservesCommentMarkersInsideStrings(t *testing.T) {
	t.Parallel()
	cfg, err := ParseModels([]byte(`{
		"providers": {
			"p": {"baseUrl":"https://example.test/v1//literal", "apiKey":"value/*literal*/", "models":[],},
		},
	}`))
	require.NoError(t, err)
	require.Equal(t, "https://example.test/v1//literal", cfg.Providers["p"].BaseURL)
	require.NotNil(t, cfg.Providers["p"].APIKey)
	require.Equal(t, "value/*literal*/", *cfg.Providers["p"].APIKey)
}

func TestAPIKeyPrecedenceMatchesNullishFallback(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		replacement string
		failures    int
	}{
		{"legacy only", `"api_key":"$KEY"`, 0},
		{"null primary", `"apiKey":null,"api_key":"$KEY"`, 0},
		{"empty primary", `"apiKey":"","api_key":"$KEY"`, 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			config := strings.ReplaceAll(
				validConfig(`"thinkingFormat":"qwen"`),
				`"apiKey":"$KEY"`,
				test.replacement,
			)
			report := CheckModels(
				t.TempDir(),
				mustParse(t, config),
				DefaultSpecs,
				func(string) (string, bool) { return "set", true },
			)
			require.Equal(t, test.failures, report.FailureCount())
			if test.failures > 0 {
				for _, check := range report.Checks {
					require.Contains(t, check.Issues, "API key source is unavailable (missing)")
				}
			}
		})
	}
}

func mustParse(t *testing.T, input string) ModelsConfig {
	t.Helper()
	cfg, err := ParseModels([]byte(input))
	require.NoError(t, err)
	return cfg
}

func validConfig(thinkingCompat string) string {
	return `{"providers":{
		"kimi-coding":{"api":"anthropic-messages","baseUrl":"https://api.kimi.com/coding","apiKey":"$KEY","models":[{"id":"k3","thinkingLevelMap":{"medium":"max","high":"max","xhigh":"max"}}]},
		"modelstudio-maas":{"api":"openai-completions","baseUrl":"https://example.test/v1","apiKey":"$KEY","compat":{` + thinkingCompat + `},"models":[{"id":"qwen3.8-max-preview"}]}
	}}`
}
