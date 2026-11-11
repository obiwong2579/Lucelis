import type { Agg, Resolver } from './agg'

// CSV export: one row per day x project x model, from the history Lucelis already keeps.
// Only counts and names: no transcript text. UTF-8 with a byte-order mark and CRLF line
// ends, so Excel opens it with project names intact.
//
// COLUMNS. Date: local day. Project: the project name as Lucelis shows it (aliases applied).
// Model: the model id. Activity tokens = input + cache writes + output. Responses: replies by
// the main thread and subagents. Sessions: distinct sessions with at least one reply on that
// day, in that project, from that model; a session spanning several days or models is counted
// in each of its rows, so the column is not meant to be summed.
//
// SPREADSHEET SAFETY. Project and model names come from folder names, aliases and transcripts,
// so a name can start with = + - @ (or a tab or line break before one), which Excel and other
// spreadsheets would run as a formula. Such a text cell gets a leading apostrophe (OWASP's
// advice for CSV injection), so it opens as text. Excel shows that apostrophe in the cell, and
// it stays in the file: the export is meant for reading in a spreadsheet, not for re-import.
// Numbers and dates are written by Lucelis and never touched. Lucelis' own data is unchanged.

const HEAD = ['Date', 'Project', 'Model', 'Activity tokens', 'Input', 'Output', 'Cache writes', 'Cache reads', 'Responses', 'Sessions']

/** Characters a spreadsheet may read as the start of a formula, after leading blanks and control characters. */
const FORMULA_START = /^[\s\u0000-\u001f\u007f\u00a0\u3000]*[=+\-@\uff1d\uff0b\uff0d\uff20]|^[\t\r\n]/
/** A text cell made safe to open in a spreadsheet (see the top of this file); other text unchanged. */
export const safeText = (s: string): string => (FORMULA_START.test(s) ? `'${s}` : s)

/** RFC 4180: quote a field holding a comma, quote, or line break; double inner quotes. Text is made spreadsheet-safe first. */
export const field = (v: string | number): string => {
  const s = typeof v === 'number' ? String(v) : safeText(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The CSV text for [from, to] (inclusive, local dates), every project, sorted by date, project, model. */
export const toCsv = (a: Agg, resolve: Resolver, from: string, to: string): { text: string; rows: number } => {
  // Row: [activity tokens, input, output, cacheWrite, cacheRead, responses, prompts]
  const sum = new Map<string, { day: string; project: string; model: string; n: number[]; sessions: Set<string> }>()
  for (const key in a.rows) {
    const [sid, day, cwd, model] = key.split('\t')
    if (!model || day < from || day > to) continue // prompt-count rows carry no model
    const project = resolve(cwd).name
    const k = `${day}\t${project}\t${model}`
    let s = sum.get(k)
    if (!s) sum.set(k, (s = { day, project, model, n: [0, 0, 0, 0, 0, 0], sessions: new Set() }))
    const r = a.rows[key]
    for (let i = 0; i < 6; i++) s.n[i] += r[i] ?? 0
    s.sessions.add(sid)
  }
  const lines = [HEAD.join(',')]
  for (const s of [...sum.values()].sort((x, y) => x.day.localeCompare(y.day) || x.project.localeCompare(y.project) || x.model.localeCompare(y.model)))
    lines.push([s.day, s.project, s.model, ...s.n, s.sessions.size].map(field).join(','))
  return { text: '﻿' + lines.join('\r\n') + '\r\n', rows: sum.size }
}

/** Lucelis-export-2026-11-11.csv */
export const exportName = (today: string) => `Lucelis-export-${today}.csv`
