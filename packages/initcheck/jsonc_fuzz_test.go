package initcheck

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func FuzzParseModelsNeverPanics(f *testing.F) {
	f.Add([]byte(`{"providers":{}}`))
	f.Add([]byte(`{/*comment*/"providers":{},}`))
	f.Add([]byte(`{"providers":{"p":{"baseUrl":"https://x.test/a//b"}}}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		_, _ = ParseModels(input)
	})
}

func TestStripJSONCRejectsUnterminatedBlockComment(t *testing.T) {
	t.Parallel()
	_, err := StripJSONC([]byte(`{"providers":{}} /*`))
	require.Error(t, err)
}
