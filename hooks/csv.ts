import type { Agg, Resolver } from './agg'

// CSV export: one row per day x project x model, from the history Lucelis already keeps.
// Only counts and names: no transcript text. UTF-8 with a byte-order mark and CRLF line
// ends, so Excel opens it with project names intact.

const HEAD = ['Date', 'Project', 'Model', 'Activity tokens', 'Input', 'Output', 'Cache writes', 'Cache reads', 'Responses', 'Sessions']

/** RFC 4180: quote a field holding a comma, quote, or line break; double inner quotes. */
export const field = (v: string | number): string => {
  const s = String(v)
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
