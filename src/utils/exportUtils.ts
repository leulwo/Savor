/**
 * Export helpers for analytics reports.
 * Generates downloadable CSV and XLSX (Excel) files from tabular data.
 */

export type SheetRow = Record<string, string | number | null | undefined | boolean>;

function escapeCsvValue(value: SheetRow[keyof SheetRow]): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsv(rows: SheetRow[], columns?: { key: string; label: string }[]): string {
  if (rows.length === 0) {
    if (columns) return columns.map(c => c.label).join(",");
    return "";
  }
  const cols = columns || Object.keys(rows[0]).map(key => ({ key, label: key }));
  const header = cols.map(c => escapeCsvValue(c.label)).join(",");
  const body = rows.map(row =>
    cols.map(c => escapeCsvValue(row[c.key])).join(",")
  );
  return [header, ...body].join("\n");
}

/** Download a CSV file with UTF-8 BOM so Excel renders it correctly. */
export function downloadCsv(filename: string, rows: SheetRow[], columns?: { key: string; label: string }[]) {
  const csv = buildCsv(rows, columns);
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}

/** Download a multi-sheet .xlsx workbook. */
export async function downloadXlsx(
  filename: string,
  sheets: { name: string; rows: SheetRow[]; columns?: { key: string; label: string }[] }[]
) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const rows = sheet.rows;
    const cols = sheet.columns || (rows.length > 0 ? Object.keys(rows[0]).map(key => ({ key, label: key })) : []);
    let aoa: (string | number | Date)[][] = [cols.map(c => c.label)];
    rows.forEach(row => {
      aoa.push(cols.map(c => {
        const v = row[c.key];
        if (v === null || v === undefined) return "";
        return typeof v === "number" ? v : String(v);
      }));
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // reasonable column widths
    ws["!cols"] = cols.map(c => ({ wch: Math.max(8, Math.min(40, (c.label?.length || 8) + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
