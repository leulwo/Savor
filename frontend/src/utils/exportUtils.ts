/**
 * Export helpers for analytics reports.
 * Generates downloadable CSV and XLSX (Excel) files from tabular data.
 */

export type SheetRow = Record<string, string | number | null | undefined | boolean>;

function escapeCsvValue(value: SheetRow[keyof SheetRow]): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  // Spreadsheet applications interpret leading =, +, -, @ and control characters
  // as formulas, even inside quoted CSV cells. Keep numeric amounts numeric.
  const text = typeof value === 'string' && (/^\s*[=+\-@＝＋－＠]/u.test(str) || /^[\t\r\n]/.test(str)) ? `'${str}` : str;
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(rows: SheetRow[], columns?: { key: string; label: string }[]): string {
  if (rows.length === 0) {
    if (columns) return columns.map(c => escapeCsvValue(c.label)).join(",");
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
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const rows = sheet.rows;
    const cols = sheet.columns || (rows.length > 0 ? Object.keys(rows[0]).map(key => ({ key, label: key })) : []);
    const name = (sheet.name.replace(/[\\/?*\[\]:]/g, '_').slice(0, 31) || 'Report');
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map(c => c.label));
    rows.forEach(row => {
      ws.addRow(cols.map(c => {
        const v = row[c.key];
        if (v === null || v === undefined) return "";
        // Plain strings are written as strings, never as ExcelJS formula objects.
        return typeof v === "number" ? v : String(v);
      }));
    });
    cols.forEach((column, index) => {
      ws.getColumn(index + 1).width = Math.max(8, Math.min(40, (column.label?.length || 8) + 2));
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  triggerDownload(new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
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
