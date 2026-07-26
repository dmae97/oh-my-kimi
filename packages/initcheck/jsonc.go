package initcheck

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

var errUnterminatedBlockComment = errors.New("unterminated JSONC block comment")

// StripJSONC removes line comments, block comments, and trailing commas while
// preserving quoted content. Removed bytes become spaces to retain offsets.
func StripJSONC(input []byte) ([]byte, error) {
	out := bytes.Clone(input)
	inString := false
	escaped := false
	for i := 0; i < len(out); i++ {
		current := out[i]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if current == '\\' {
				escaped = true
			} else if current == '"' {
				inString = false
			}
			continue
		}
		if current == '"' {
			inString = true
			continue
		}
		if current != '/' || i+1 >= len(out) {
			continue
		}
		switch out[i+1] {
		case '/':
			out[i], out[i+1] = ' ', ' '
			i += 2
			for i < len(out) && out[i] != '\n' && out[i] != '\r' {
				out[i] = ' '
				i++
			}
			i--
		case '*':
			out[i], out[i+1] = ' ', ' '
			i += 2
			closed := false
			for i < len(out) {
				if i+1 < len(out) && out[i] == '*' && out[i+1] == '/' {
					out[i], out[i+1] = ' ', ' '
					i++
					closed = true
					break
				}
				if out[i] != '\n' && out[i] != '\r' {
					out[i] = ' '
				}
				i++
			}
			if !closed {
				return nil, errUnterminatedBlockComment
			}
		}
	}
	stripTrailingCommas(out)
	return out, nil
}

func stripTrailingCommas(data []byte) {
	inString := false
	escaped := false
	for i, current := range data {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if current == '\\' {
				escaped = true
			} else if current == '"' {
				inString = false
			}
			continue
		}
		if current == '"' {
			inString = true
			continue
		}
		if current != ',' {
			continue
		}
		j := i + 1
		for j < len(data) && isJSONSpace(data[j]) {
			j++
		}
		if j < len(data) && (data[j] == '}' || data[j] == ']') {
			data[i] = ' '
		}
	}
}

func isJSONSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\n' || value == '\r'
}

// ParseModels parses JSON or JSONC without interpolating or executing values.
func ParseModels(input []byte) (ModelsConfig, error) {
	clean, err := StripJSONC(input)
	if err != nil {
		return ModelsConfig{}, err
	}
	var config ModelsConfig
	if err := json.Unmarshal(clean, &config); err != nil {
		return ModelsConfig{}, fmt.Errorf("parse models config: %w", err)
	}
	if config.Providers == nil {
		return ModelsConfig{}, errors.New("parse models config: providers object missing")
	}
	return config, nil
}
