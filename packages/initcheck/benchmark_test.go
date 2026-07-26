package initcheck

import "testing"

func BenchmarkParseAndCheckModels(b *testing.B) {
	input := []byte(validConfig(`"thinkingFormat":"qwen"`))
	lookupEnv := func(string) (string, bool) { return "set", true }
	b.ReportAllocs()
	for range b.N {
		config, err := ParseModels(input)
		if err != nil {
			b.Fatal(err)
		}
		report := CheckModels(".", config, DefaultSpecs, lookupEnv)
		if report.FailureCount() != 0 {
			b.Fatal("unexpected readiness failure")
		}
	}
}
