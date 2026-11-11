import type { EngineInterface } from 'claude-code'

import type { Settings, Window } from '../types'

// Low-quota warning: once per quota window, in one session only, when what is left of the
// 5-hour or 7-day quota drops to the person's warning level. It reads only the figures the
// engine already reports (session.measure); nothing is polled.
//
// Several sessions see the same figures at the same moment, so they agree on who warns
// through a small claim file beside Lucelis' history cache (not $.store: the settings live
// there, and a session writing an old copy of the store must never undo a newer setting).

/** Which setting holds the warning level for a window kind. */
const LEVEL: Record<string, 'h5' | 'd7'> = { five_hour: 'h5', seven_day: 'd7' }
const NAME: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day' }

/** One quota window, named so a re-reported reset time a few seconds off is the same window. */
export const windowId = (w: Window): string => `${w.kind}@${(w.resetsAt ?? '').slice(0, 13)}`

/** What is left of a window, 0-100. */
export const leftOf = (w: Window): number => Math.max(0, Math.min(100, Math.round(100 - w.percentUsed)))

/** The default level, % left: at or under it the bar figure and the glint are red and the pop-up shows. */
export const DEFAULT_LEVEL = 30
/** The levels Settings offers. */
export const LEVELS = [10, 20, 30, 40] as const

/** The warning level for a window kind, or null for a kind that is not warned about. */
export const levelFor = (kind: string, warn?: Settings['warn']): number | null => {
  const k = LEVEL[kind]
  return k ? (warn?.[k] ?? DEFAULT_LEVEL) : null
}

/** Whether any window is at or under its warning level now (the logo's red glint). The level
 * colours the bar whether or not the pop-up is on; on/off governs only the pop-up. */
export const isLow = (windows: readonly Window[], warn?: Settings['warn']): boolean =>
  windows.some(w => { const l = levelFor(w.kind, warn); return l !== null && leftOf(w) <= l })

/** Claims kept: window id -> who claimed it and when. */
export type Warned = Record<string, { by: string; at: number }>

/** The windows to warn about now: at or under their level, and not warned about yet. */
export const due = (windows: readonly Window[], warn: Settings['warn'], warned: Warned): Window[] =>
  warn.on ? windows.filter(w => { const l = levelFor(w.kind, warn); return l !== null && leftOf(w) <= l && !warned[windowId(w)] }) : []

/** Drops claims for windows that have reset, so the file stays small. */
export const prune = (warned: Warned, now: number): Warned => {
  const out: Warned = {}
  for (const [id, v] of Object.entries(warned)) {
    const at = Date.parse(`${id.split('@')[1]}:59:59Z`)
    if (Number.isNaN(at) || at > now) out[id] = v
  }
  return out
}

/** "Lucelis: 5-hour quota 15% left · resets in 1h 20m" */
export const message = (w: Window, now: number): string => {
  const left = leftOf(w)
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  let reset = ''
  if (!Number.isNaN(at) && at > now) {
    const m = Math.round((at - now) / 60_000)
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
    reset = ` · resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`}`
  }
  return `${NAME[w.kind] ?? w.kind} quota ${left}% left${reset}`
}

/** The claim file and how it is read and written; a stand-in in tests. */
export type ClaimIo = { read: () => Promise<Warned>; write: (w: Warned) => Promise<void>; sleep: (ms: number) => Promise<void>; random: () => number }

export function fileIo($: EngineInterface, path: string): ClaimIo {
  return {
    read: async () => {
      try {
        if (!(await $.fs.exists(path))) return {}
        const v = JSON.parse(await $.fs.read(path))
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Warned : {}
      } catch { return {} }
    },
    write: w => $.fs.write(path, JSON.stringify(w)),
    sleep: ms => $.clock.sleep(ms),
    random: Math.random,
  }
}

/** Windows this session has already handled, so it never repeats even if the file cannot be read. */
const handled = new Set<string>()
export const forgetHandled = () => handled.clear()

/**
 * Claims each due window and returns the ones this session won. Claim, wait a random
 * 400-1200 ms, read again: if another session's claim replaced ours, it warns, not us.
 */
export async function claim(io: ClaimIo, sid: string, now: number, windows: readonly Window[], warn: Settings['warn']): Promise<Window[]> {
  const fresh = due(windows, warn, {}).filter(w => !handled.has(windowId(w)))
  if (!fresh.length) return []
  const before = prune(await io.read(), now)
  const mine = fresh.filter(w => !before[windowId(w)])
  for (const w of fresh) handled.add(windowId(w))
  if (!mine.length) return []
  const next: Warned = { ...before }
  for (const w of mine) next[windowId(w)] = { by: sid, at: now }
  // No claim file to write (a folder that is not there yet, a locked file): warn from this
  // session alone rather than not at all.
  try { await io.write(next) } catch { return mine }
  await io.sleep(400 + Math.floor(io.random() * 800))
  const after = await io.read()
  return mine.filter(w => after[windowId(w)]?.by === sid)
}
