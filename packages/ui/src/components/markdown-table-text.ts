export function tableMarkdown(rows: string[][]): string {
  if (!rows.length) return "";
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const escaped = rows.map((row) =>
    Array.from({ length: columns }, (_, i) =>
      (row[i] ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"),
    ),
  );
  return [escaped[0], Array.from({ length: columns }, () => "---"), ...escaped.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

export function tableCsv(rows: string[][]): string {
  const escapeCell = (value: string) => {
    // Spreadsheet applications interpret model-generated formula prefixes as executable cells.
    const text = /^[\t\r\n]|^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${rows.map((row) => row.map(escapeCell).join(",")).join("\r\n")}`;
}
