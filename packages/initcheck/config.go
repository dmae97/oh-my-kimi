package initcheck

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	catCommandPattern = regexp.MustCompile(`^cat\s+(?:"([^"]+)"|'([^']+)'|(\S+))$`)
	envPattern        = regexp.MustCompile(`\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))`)
)

type keyStatus struct {
	Configured bool
	Source     string
}

// CheckModels validates model contracts without resolving secret values or
// executing API-key commands. lookupEnv is injectable to keep tests isolated.
func CheckModels(
	root string,
	config ModelsConfig,
	specs []ModelSpec,
	lookupEnv func(string) (string, bool),
) ConfigReport {
	report := ConfigReport{
		ProviderCount: len(config.Providers),
		Checks:        make([]CheckResult, 0, len(specs)),
	}
	for _, spec := range specs {
		result := CheckResult{
			Name:         spec.Name,
			Provider:     spec.Provider,
			ModelID:      spec.ModelID,
			FailoverRank: spec.FailoverRank,
		}
		provider, found := config.Providers[spec.Provider]
		if !found {
			result.Issues = append(result.Issues, fmt.Sprintf("provider %q is missing", spec.Provider))
			report.Checks = append(report.Checks, result)
			continue
		}
		model, found := findModel(provider.Models, spec.ModelID)
		if !found {
			result.Issues = append(result.Issues, fmt.Sprintf("model %q is missing", spec.ModelID))
			report.Checks = append(report.Checks, result)
			continue
		}
		validateModel(root, provider, model, spec, lookupEnv, &result)
		report.Checks = append(report.Checks, result)
	}
	return report
}

func validateModel(
	root string,
	provider Provider,
	model Model,
	spec ModelSpec,
	lookupEnv func(string) (string, bool),
	result *CheckResult,
) {
	api := firstNonEmpty(model.API, provider.API)
	baseURL := firstNonEmpty(model.BaseURL, provider.BaseURL)
	key := inspectKey(root, providerKey(provider), lookupEnv)
	result.KeySource = key.Source

	if api != spec.API {
		result.Issues = append(result.Issues, "api must be "+spec.API)
	}
	if !validHTTPURL(baseURL) {
		result.Issues = append(result.Issues, "baseUrl must be an http(s) URL without userinfo")
	}
	if !key.Configured {
		result.Issues = append(result.Issues, "API key source is unavailable ("+key.Source+")")
	}
	thinkingFormat := firstNonEmpty(model.Compat.ThinkingFormat, provider.Compat.ThinkingFormat)
	if spec.ThinkingFormat != "" && thinkingFormat != spec.ThinkingFormat {
		result.Issues = append(result.Issues, "thinkingFormat must be "+spec.ThinkingFormat)
	}
	levels := make([]string, 0, len(spec.ThinkingLevelMap))
	for level := range spec.ThinkingLevelMap {
		levels = append(levels, level)
	}
	sort.Strings(levels)
	for _, level := range levels {
		expected := spec.ThinkingLevelMap[level]
		if model.ThinkingLevelMap[level] != expected {
			result.Issues = append(result.Issues, "thinkingLevelMap."+level+" must be "+expected)
		}
	}
	if baseURL != "" && baseURL != spec.RecommendedBaseURL {
		result.Warnings = append(result.Warnings, "custom baseUrl")
	}
}

func inspectKey(root, value string, lookupEnv func(string) (string, bool)) keyStatus {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return keyStatus{Source: "missing"}
	}
	if strings.HasPrefix(trimmed, "!") {
		command := strings.TrimSpace(strings.TrimPrefix(trimmed, "!"))
		matches := catCommandPattern.FindStringSubmatch(command)
		if matches == nil {
			return keyStatus{Configured: true, Source: "command (not executed)"}
		}
		path := firstNonEmpty(matches[1], matches[2], matches[3])
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		info, err := os.Stat(filepath.Clean(path))
		return keyStatus{
			Configured: err == nil && info.Mode().IsRegular() && info.Size() > 0,
			Source:     "file command",
		}
	}
	if strings.HasPrefix(trimmed, "$") {
		matches := envPattern.FindAllStringSubmatch(trimmed, -1)
		if len(matches) == 0 {
			return keyStatus{Source: "invalid environment reference"}
		}
		for _, match := range matches {
			name := firstNonEmpty(match[1], match[2])
			value, found := lookupEnv(name)
			if !found || value == "" {
				return keyStatus{Source: "environment"}
			}
		}
		return keyStatus{Configured: true, Source: "environment"}
	}
	return keyStatus{Configured: true, Source: "inline value"}
}

func providerKey(provider Provider) string {
	if provider.APIKey != nil {
		return *provider.APIKey
	}
	if provider.APIKeyAlt != nil {
		return *provider.APIKeyAlt
	}
	return ""
}

func findModel(models []Model, id string) (Model, bool) {
	for _, model := range models {
		if model.ID == id {
			return model, true
		}
	}
	return Model{}, false
}

func validHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Host != "" && parsed.User == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
