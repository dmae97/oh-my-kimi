import { style } from "../../../util/theme.js";

export function formatScopedNames(names: readonly string[] | undefined, empty = "none"): string {
  if (!names || names.length === 0) return empty;
  const preview = names.slice(0, 8).join(", ");
  return names.length > 8 ? `${preview}, … +${names.length - 8}` : preview;
}

export function section(title: string, lines: readonly string[] = []): string {
  return [
    style.phosphorBold(`\n  ${title}`),
    style.phosphorDim("  ─────────────────────────────────────────────"),
    ...lines,
    "",
  ].join("\n");
}

export function commandLine(command: string, aliases: string, description: string): string {
  const aliasText = aliases ? ` ${style.phosphorDim(aliases)}` : "";
  return `  ${style.phosphor(command)}${aliasText} — ${description}`;
}
