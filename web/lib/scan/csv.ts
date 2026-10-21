// RFC 4180 CSV with a UTF-8 BOM so Excel opens names/quotes correctly.
export interface CsvColumn { key: string; label: string }

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = v instanceof Date ? v.toISOString() : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const head = columns.map(c => cell(c.label)).join(',')
  const body = rows.map(r => columns.map(c => cell(r[c.key])).join(','))
  return '﻿' + [head, ...body].join('\r\n') + '\r\n'
}
