import type { EngineInterface } from 'claude-code'

import type { Settings, Window } from '../types'

// Low-quota warning: when what is left of the 5-hour or 7-day quota drops to the person's
// level, tell them (if they chose to be told) at most once per quota window across all their
// open sessions. It reads only the figures the engine already reports (session.measure);
// nothing is polled, and nothing runs while no quota is at or under its level.
//
// HOW SESSIONS AGREE (one winner per window). Every open session sees the same figures at
// about the same moment, each in its own process. The plugin file API has no exclusive
// create, rename or delete, so a shared file cannot be a lock. Instead claims are directories,
// `~/.claude/lucelis/claims/<kind>-<reset minute>`, created with Windows `mkdir` in a short
// `cmd.exe` run: creating a directory is atomic on NTFS, so for any one name exactly one
// session's mkdir succeeds; every other gets "already exists".
// Sessions may report one window's reset time a minute or two apart (rounding, a few seconds
// of drift), so a claim takes three names: its reset minute and the minute either side, in
// ascending order, stopping at the first that already exists (that session loses). Two
// reports up to 2 minutes apart share at least one name. Every session takes the shared names
// in the same order, so the one that wins the lowest shared name also gets the others, and a
// session that loses stops before taking any name a later winner needs: exactly one session
// takes all three and tells the person. 5H and 7D names never overlap, and no session ever
// rewrites another's record. The cmd run happens only when a window is due.
//
// WHAT IS AND IS NOT GUARANTEED.
// - Claim: at most one session wins a given window (the mkdir), given one shared folder.
// - Delivery is best effort: the winner shows the pop-up / notification right after winning.
//   If it is closed in between, or the app refuses the notification, nobody repeats it for
//   that window (at most once, not exactly once).
// - When the claim cannot be made at all (cmd unavailable, a folder path cmd cannot quote,
//   a timeout), the session warns on its own: a rare duplicate is preferred to silence.
// - A window with no readable reset time has no shared identity: each session warns about it
//   at most once (no cross-session agreement), and no reset time is ever invented.

/** Which setting holds the warning level for a window kind. */
const LEVEL: Record<string, 'h5' | 'd7'> = { five_hour: 'h5', seven_day: 'd7' }
const NAME: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day' }

/** The reset instant in epoch milliseconds, or null when missing or unreadable (any offset is honoured). */
export const resetMs = (w: Window): number | null => {
  const t = typeof w.resetsAt === 'string' && w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(t) ? t : null
}

/**
 * A quota window's shared name: its kind and its reset instant to the minute, from the real
 * instant (so "+08:00" and "Z" spellings of one moment agree). Null without a reset time.
 */
export const windowKey = (w: Window): string | null => {
  const t = resetMs(w)
  return LEVEL[w.kind] && t !== null ? `${w.kind}-${Math.round(t / 60_000)}` : null
}

/** A window's identity inside one session (also for windows with no reset time). */
export const windowId = (w: Window): string => windowKey(w) ?? `${w.kind}-noreset`

/** Two reports of one window may differ by a few seconds; claims this close are the same window. */
const SAME_WINDOW_MIN = 2
/** A claim's names: its reset minute and the minute either side, ascending ([] for a bad key). */
export const claimNames = (key: string): string[] => {
  const k = parseKey(key)
  return k ? [k.minute - 1, k.minute, k.minute + 1].map(m => `${k.kind}-${m}`) : []
}
/** A claim is kept this long after its window reset, then removed with the next claim. */
const KEEP_AFTER_RESET_MS = 60 * 60_000

/** A claim directory name, read back: its kind and reset minute, or null for anything else. */
export const parseKey = (name: string): { kind: string; minute: number } | null => {
  const m = /^(five_hour|seven_day)-(\d{1,12})$/.exec(name)
  return m ? { kind: m[1], minute: Number(m[2]) } : null
}

/** Claims whose window reset more than an hour ago (same time base as when they were made). */
export const expiredKeys = (names: readonly string[], now: number): string[] =>
  names.filter(n => { const k = parseKey(n); return !!k && k.minute * 60_000 + KEEP_AFTER_RESET_MS < now })

/** Whether a claim already exists for this window (within the same-window tolerance). */
export const isClaimed = (names: readonly string[], key: string): boolean => {
  const want = parseKey(key)
  return !!want && names.some(n => { const k = parseKey(n); return !!k && k.kind === want.kind && Math.abs(k.minute - want.minute) <= SAME_WINDOW_MIN })
}

/** What is left of a window, 0-100. */
export const leftOf = (w: Window): number => Math.max(0, Math.min(100, Math.round(100 - w.percentUsed)))

/** The default level, % left: at or under it the bar figure and the glint are red and the pop-up shows. */
export const DEFAULT_LEVEL = 30
/** The levels Settings offers. */
export const LEVELS = [10, 20, 30, 40] as const

/** The warning level for a window kind (0: off), or null for a kind that is not warned about. */
export const levelFor = (kind: string, warn?: Settings['warn']): number | null => {
  const k = LEVEL[kind]
  return k ? (warn?.[k] ?? DEFAULT_LEVEL) : null
}

/** Whether `left` % of a window kind is at or under its warning level (the red figure and glint). */
export const lowAt = (kind: string, left: number, warn?: Settings['warn']): boolean => {
  const l = levelFor(kind, warn)
  return !!l && left <= l
}

/** The windows to warn about now: live figures at or under their level. Never a "last seen" one. */
export const due = (windows: readonly Window[], warn: Settings['warn']): Window[] =>
  windows.filter(w => !w.stale && lowAt(w.kind, leftOf(w), warn))

/** "5-hour quota 15% left · resets in 1h 20m" */
export const message = (w: Window, now: number): string => {
  const left = leftOf(w)
  const at = resetMs(w)
  let reset = ''
  if (at !== null && at > now) {
    const m = Math.round((at - now) / 60_000)
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
    reset = ` · resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`}`
  }
  return `${NAME[w.kind] ?? w.kind} quota ${left}% left${reset}`
}

/** How claims are listed and made; a stand-in in tests. */
export type ClaimIo = {
  /** The claim names that exist now ([] when none or unreadable). */
  list: () => Promise<string[]>
  /** Takes the claim `key` (all its names, or none past the first taken one), first removing `expired`. */
  acquire: (key: string, expired: readonly string[]) => Promise<'won' | 'taken' | 'error'>
}

/**
 * The cmd.exe script that removes expired claims, then makes this claim's names in ascending
 * order. Exit 0: all made (won); 2: one already existed (taken, stops there); 3: a mkdir
 * failed for another reason. Sent on stdin, so a folder with spaces needs no command-line
 * quoting; refused (null) for a path cmd would expand or misread (% " ^ ! < > | & line breaks).
 */
export const claimScript = (dir: string, key: string, expired: readonly string[]): string | null => {
  if (/[%"^!<>|&\r\n]/.test(dir) || !parseKey(key) || expired.some(e => !parseKey(e))) return null
  const lines = ['@echo off']
  for (const e of expired) lines.push(`rmdir "${dir}\\${e}" 2>nul`)
  for (const n of claimNames(key)) lines.push(`mkdir "${dir}\\${n}" 2>nul || if exist "${dir}\\${n}\\" (exit 2) else (exit 3)`)
  lines.push('exit 0', '')
  return lines.join('\r\n')
}

export function claimIo($: EngineInterface, dir: string): ClaimIo {
  return {
    list: async () => {
      try { return (await $.fs.list(dir)).filter(e => e.kind === 'dir').map(e => e.name) } catch { return [] }
    },
    acquire: async (key, expired) => {
      const script = claimScript(dir, key, expired)
      if (!script) return 'error'
      try {
        // The claims folder made first, so concurrent mkdirs never race on creating it.
        if (!(await $.fs.exists(dir))) await $.fs.write(`${dir}\\README.txt`, 'Lucelis low-quota warning claims: a few folders per quota window. Safe to delete.\r\n')
        const r = await $.process.run(['cmd.exe', '/d', '/q'], { stdin: script, timeoutMs: 5_000 })
        return r.exitCode === 0 ? 'won' : r.exitCode === 2 ? 'taken' : 'error'
      } catch { return 'error' }
    },
  }
}

/** Windows this session already handled, so it never repeats one. */
const handled = new Set<string>()
export const forgetHandled = () => handled.clear()

/** Returns the due windows this session should tell the person about (see the top of this file). */
export async function claim(io: ClaimIo, now: number, windows: readonly Window[], warn: Settings['warn']): Promise<Window[]> {
  const fresh = due(windows, warn).filter(w => !handled.has(windowId(w)))
  if (!fresh.length) return []
  for (const w of fresh) handled.add(windowId(w))
  const names = await io.list().catch(() => [] as string[])
  let expired = expiredKeys(names, now)
  const won: Window[] = []
  for (const w of fresh) {
    const key = windowKey(w)
    if (!key) { won.push(w); continue } // no reset time: this session alone, once
    if (isClaimed(names, key)) continue
    const r = await io.acquire(key, expired).catch(() => 'error' as const)
    expired = [] // removed (or tried) once
    if (r !== 'taken') won.push(w)
  }
  return won
}
