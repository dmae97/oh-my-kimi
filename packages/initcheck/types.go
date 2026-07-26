// Package initcheck performs credential-safe OMK model-readiness checks.
package initcheck

// ModelSpec defines one required model and its compatibility contract.
type ModelSpec struct {
	Name               string
	Provider           string
	ModelID            string
	API                string
	RecommendedBaseURL string
	ThinkingFormat     string
	ThinkingLevelMap   map[string]string
	FailoverRank       int
}

// DefaultSpecs is the initial OMK safety-failover pair, in failover order.
var DefaultSpecs = []ModelSpec{
	{
		Name:               "k3",
		Provider:           "kimi-coding",
		ModelID:            "k3",
		API:                "anthropic-messages",
		RecommendedBaseURL: "https://api.kimi.com/coding",
		ThinkingLevelMap: map[string]string{
			"medium": "max",
			"high":   "max",
			"xhigh":  "max",
		},
		FailoverRank: 1,
	},
	{
		Name:               "qwen3.8-max",
		Provider:           "modelstudio-maas",
		ModelID:            "qwen3.8-max-preview",
		API:                "openai-completions",
		RecommendedBaseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		ThinkingFormat:     "qwen",
		FailoverRank:       2,
	},
}

// ModelsConfig is the subset of models.json needed by readiness checks.
type ModelsConfig struct {
	Providers map[string]Provider `json:"providers"`
}

// Provider contains provider defaults and model entries.
type Provider struct {
	API       string  `json:"api"`
	BaseURL   string  `json:"baseUrl"`
	APIKey    *string `json:"apiKey"`
	APIKeyAlt *string `json:"api_key"`
	Compat    Compat  `json:"compat"`
	Models    []Model `json:"models"`
}

// Model contains model-level overrides.
type Model struct {
	ID               string            `json:"id"`
	API              string            `json:"api"`
	BaseURL          string            `json:"baseUrl"`
	Compat           Compat            `json:"compat"`
	ThinkingLevelMap map[string]string `json:"thinkingLevelMap"`
}

// Compat contains model compatibility switches used by the checker.
type Compat struct {
	ThinkingFormat string `json:"thinkingFormat"`
}

// CheckResult is a credential-free readiness result for one model.
type CheckResult struct {
	Name         string
	Provider     string
	ModelID      string
	KeySource    string
	FailoverRank int
	Warnings     []string
	Issues       []string
}

// ConfigReport is the deterministic result of static model checks.
type ConfigReport struct {
	ProviderCount int
	Checks        []CheckResult
}

// FailureCount counts contract issues across all checked models.
func (r ConfigReport) FailureCount() int {
	failures := 0
	for _, check := range r.Checks {
		failures += len(check.Issues)
	}
	return failures
}
