package initcheck

import (
	"fmt"
	"io"
	"strings"
)

// WriteConfigReport writes a stable, credential-free human report.
func WriteConfigReport(writer io.Writer, report ConfigReport) error {
	if _, err := fmt.Fprintf(writer, "  ok             models.json (%d providers)\n", report.ProviderCount); err != nil {
		return err
	}
	for _, check := range report.Checks {
		if len(check.Issues) > 0 {
			if _, err := fmt.Fprintf(
				writer,
				"  INVALID        %s (%s/%s) — %s\n",
				check.Name,
				check.Provider,
				check.ModelID,
				strings.Join(check.Issues, "; "),
			); err != nil {
				return err
			}
			continue
		}
		warning := ""
		if len(check.Warnings) > 0 {
			warning = " [" + strings.Join(check.Warnings, "; ") + "]"
		}
		if _, err := fmt.Fprintf(
			writer,
			"  ok             %s (%s/%s) key=%s failoverRank=#%d%s\n",
			check.Name,
			check.Provider,
			check.ModelID,
			check.KeySource,
			check.FailoverRank,
			warning,
		); err != nil {
			return err
		}
	}
	return nil
}

// WriteProbeReport writes sanitized endpoint URLs and bounded result reasons.
func WriteProbeReport(writer io.Writer, results []ProbeResult) error {
	for _, result := range results {
		if result.Skipped {
			if _, err := fmt.Fprintf(writer, "  SKIP           %s (%s)\n", result.Name, result.Reason); err != nil {
				return err
			}
			continue
		}
		if result.Reachable {
			if _, err := fmt.Fprintf(
				writer,
				"  %-14s %s → %s (HTTP %d)\n",
				"reachable",
				result.Name,
				result.URL,
				result.Status,
			); err != nil {
				return err
			}
			continue
		}
		status := ""
		if result.Status > 0 {
			status = fmt.Sprintf("HTTP %d; ", result.Status)
		}
		if _, err := fmt.Fprintf(
			writer,
			"  UNREACHABLE    %s → %s (%s%s)\n",
			result.Name,
			result.URL,
			status,
			result.Reason,
		); err != nil {
			return err
		}
	}
	return nil
}
