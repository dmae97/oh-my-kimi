package initcheck

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ProbeResult is one unauthenticated, credential-free endpoint check.
type ProbeResult struct {
	Name      string
	URL       string
	Status    int
	Reachable bool
	Skipped   bool
	Reason    string
}

// BuildProbeURL creates a /models endpoint after rejecting URL userinfo and
// dropping all query parameters and fragments.
func BuildProbeURL(base string) (*url.URL, error) {
	parsed, err := url.Parse(base)
	if err != nil || !validHTTPURL(base) {
		return nil, errors.New("valid baseUrl unavailable")
	}
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	parsed.RawFragment = ""
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + "/models"
	parsed.RawPath = ""
	return parsed, nil
}

// ProbeModels checks all configured endpoints concurrently and stores results
// at their input indices, making output deterministic.
func ProbeModels(
	ctx context.Context,
	config ModelsConfig,
	specs []ModelSpec,
	timeout time.Duration,
) []ProbeResult {
	results := make([]ProbeResult, len(specs))
	client := probeClient(timeout)
	var wait sync.WaitGroup
	wait.Add(len(specs))
	for index, spec := range specs {
		index, spec := index, spec
		go func() {
			defer wait.Done()
			results[index] = probeModel(ctx, client, config, spec)
		}()
	}
	wait.Wait()
	client.CloseIdleConnections()
	return results
}

func probeModel(
	ctx context.Context,
	client *http.Client,
	config ModelsConfig,
	spec ModelSpec,
) ProbeResult {
	result := ProbeResult{Name: spec.Name}
	provider, found := config.Providers[spec.Provider]
	if !found {
		result.Skipped = true
		result.Reason = "provider unavailable"
		return result
	}
	model, found := findModel(provider.Models, spec.ModelID)
	if !found {
		result.Skipped = true
		result.Reason = "model unavailable"
		return result
	}
	endpoint, err := BuildProbeURL(firstNonEmpty(model.BaseURL, provider.BaseURL))
	if err != nil {
		result.Skipped = true
		result.Reason = "valid baseUrl unavailable"
		return result
	}
	result.URL = endpoint.String()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, result.URL, nil)
	if err != nil {
		result.Reason = "request construction failed"
		return result
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		result.Reason = classifyNetworkError(err)
		return result
	}
	defer response.Body.Close()
	result.Status = response.StatusCode
	result.Reachable = response.StatusCode >= 200 && response.StatusCode < 500
	if !result.Reachable {
		result.Reason = "HTTP status outside reachable range"
	}
	return result
}

func probeClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func classifyNetworkError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "timeout"
	}
	return "network error"
}

// ProbeFailureCount counts non-skipped endpoints that are not reachable.
func ProbeFailureCount(results []ProbeResult) int {
	failures := 0
	for _, result := range results {
		if !result.Skipped && !result.Reachable {
			failures++
		}
	}
	return failures
}
