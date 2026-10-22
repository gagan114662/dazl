// RFC 4180 CSV with a UTF-8 BOM so Excel opens names/quotes correctly.
export interface CsvColumn { key: string; label: string }

// Spreadsheet formula injection: lead fields come from scraped pages and model output,
// so a cell starting with =, +, -, @ (or tab/CR, which some parsers trim past) is
// prefixed with ' to force literal text when the export is opened in Excel/Sheets.
const FORMULA_LEAD = /^[=+\-@\t\r]/
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  let s = v instanceof Date ? v.toISOString() : String(v)
  if (FORMULA_LEAD.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const head = columns.map(c => cell(c.label)).join(',')
  const body = rows.map(r => columns.map(c => cell(r[c.key])).join(','))
  return '﻿' + [head, ...body].join('\r\n') + '\r\n'
}
