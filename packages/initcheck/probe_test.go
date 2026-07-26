package initcheck

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestProbeModelsStripsCredentialsAndDoesNotFollowRedirects(t *testing.T) {
	t.Parallel()
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirected.Add(1)
	}))
	t.Cleanup(target.Close)

	var mu sync.Mutex
	seen := make([]*http.Request, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Clone(r.Context()))
		mu.Unlock()
		if r.URL.Path == "/coding/models" {
			http.Redirect(w, r, target.URL, http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)

	cfg := ModelsConfig{Providers: map[string]Provider{
		"kimi-coding": {
			BaseURL: server.URL + "/coding?api_key=do-not-send#fragment",
			Models:  []Model{{ID: "k3"}},
		},
		"modelstudio-maas": {
			BaseURL: server.URL + "/v1?token=do-not-send",
			Models:  []Model{{ID: "qwen3.8-max-preview"}},
		},
	}}

	results := ProbeModels(context.Background(), cfg, DefaultSpecs, 2*time.Second)
	require.Len(t, results, 2)
	require.Equal(t, "k3", results[0].Name)
	require.Equal(t, "qwen3.8-max", results[1].Name)
	require.True(t, results[0].Reachable)
	require.Equal(t, http.StatusFound, results[0].Status)
	require.True(t, results[1].Reachable)
	require.Equal(t, http.StatusUnauthorized, results[1].Status)
	require.Zero(t, redirected.Load(), "probe followed a redirect")

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, seen, 2)
	for _, request := range seen {
		require.Empty(t, request.URL.RawQuery)
		require.Empty(t, request.URL.Fragment)
		require.Empty(t, request.Header.Get("Authorization"))
		require.Empty(t, request.Header.Get("Proxy-Authorization"))
		require.Empty(t, request.Header.Get("Cookie"))
		require.Equal(t, "application/json", request.Header.Get("Accept"))
	}
}

func TestProbeModelsReportsInSpecOrderDespiteCompletionOrder(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow/models" {
			time.Sleep(40 * time.Millisecond)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)

	specs := []ModelSpec{
		{Name: "slow", Provider: "slow", ModelID: "one"},
		{Name: "fast", Provider: "fast", ModelID: "two"},
	}
	cfg := ModelsConfig{Providers: map[string]Provider{
		"slow": {BaseURL: server.URL + "/slow", Models: []Model{{ID: "one"}}},
		"fast": {BaseURL: server.URL + "/fast", Models: []Model{{ID: "two"}}},
	}}
	results := ProbeModels(context.Background(), cfg, specs, time.Second)
	require.Equal(t, "slow", results[0].Name)
	require.Equal(t, "fast", results[1].Name)
	require.True(t, results[0].Reachable)
	require.False(t, results[1].Reachable)
	require.Equal(t, 1, ProbeFailureCount(results))
}

func TestBuildProbeURL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		base string
		want string
		ok   bool
	}{
		{"https://example.test/v1?key=x#f", "https://example.test/v1/models", true},
		{"http://example.test/", "http://example.test/models", true},
		{"https://user:pass@example.test/v1", "", false},
		{"file:///tmp/socket", "", false},
		{"not a URL", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.base, func(t *testing.T) {
			t.Parallel()
			got, err := BuildProbeURL(tt.base)
			if !tt.ok {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got.String())
		})
	}
}

func FuzzBuildProbeURLNeverRetainsCredentials(f *testing.F) {
	for _, seed := range []string{
		"https://example.test/v1?token=secret#x",
		"https://user:pass@example.test/v1",
		"http://127.0.0.1:8080",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		probe, err := BuildProbeURL(input)
		if err != nil {
			return
		}
		require.Nil(t, probe.User)
		require.Empty(t, probe.RawQuery)
		require.Empty(t, probe.Fragment)
		require.Contains(t, probe.Path, "/models")
		_, err = url.ParseRequestURI(probe.String())
		require.NoError(t, err, fmt.Sprintf("invalid sanitized URL %q", probe.String()))
	})
}
