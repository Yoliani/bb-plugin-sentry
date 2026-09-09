// bb-plugin-sentry — CLI output helpers. Aligned table / detail rendering,
// adapted from bb's builtin tasks plugin (cli/format.ts).

function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Renders a header-aligned column table, or `emptyMessage` when no rows. */
export function table(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  emptyMessage: string,
): string {
  if (rows.length === 0) return emptyMessage;
  const normalized = rows.map((row) => row.map(oneLine));
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...normalized.map((row) => (row[index] ?? "").length),
    ),
  );
  const render = (row: readonly string[]) =>
    row
      .map((value, index) =>
        index === row.length - 1
          ? value
          : value.padEnd(widths[index] ?? value.length),
      )
      .join("  ")
      .trimEnd();
  return [render([...headers]), ...normalized.map(render)].join("\n");
}

/** Renders aligned `label  value` lines, padding labels to the widest one. */
export function detail(
  fields: readonly (readonly [string, unknown])[],
): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields
    .map(([label, value]) => `${label.padEnd(width)}  ${oneLine(value)}`)
    .join("\n");
}

export function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}
