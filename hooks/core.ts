// The refresh pipeline, independent of the engine: everything it touches goes
// through an `Io`, so tests can run two sessions against one fake disk.
//
// Cache file safety. The engine's file API has no rename/replace, so a write
// cannot be made atomic. The safest supported alternative: two slot files
// (cache-a.json, cache-b.json), each a complete snapshot in an envelope with a
// sequence number and a checksum of its content.
// - A writer writes the slot that does NOT hold the newest valid snapshot.
// - A reader takes the newest slot whose checksum and shape verify.
// So a torn or interleaved write can only damage the slot being written; the
// other slot still holds the previous good snapshot. Every snapshot is
// self-consistent (aggregates and the byte offsets they came from travel
// together), so falling back to an older one only means re-reading those bytes:
// nothing is lost for good and nothing is counted twice.

import type { Agg, FileTask } from './agg'
import { cwdsOf, emptyAgg, ingest, isAgg, normPath } from './agg'

export type Io = {
  now: () => Promise<number>
  exists: (p: string) => Promise<boolean>
  read: (p: string) => Promise<string>
  write: (p: string, text: string) => Promise<void>
  list: (p: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other'; size: number }[]>
  extract: (root: string, tasks: FileTask[], own: string[]) => Promise<string>
}

export type Paths = { projects: string; dir: string }
export const SLOTS = ['cache-a.json', 'cache-b.json'] as const
const MAX_CALLS = 200

const join = (...p: string[]) => p.join('\\').replace(/[\\/]+/g, '\\')

/** FNV-1a over the text, as 8 hex digits. */
export const checksum = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

type Envelope = { kind: 'lucelis-cache'; seq: number; sum: string; body: string }
export type Snapshot = { slot: number; seq: number; agg: Agg }

/** One slot's text as a snapshot, or null when it is torn, corrupt or from another parser version. */
export const parseSlot = (text: string, slot: number): Snapshot | null => {
  try {
    const e = JSON.parse(text) as Envelope
    if (!e || e.kind !== 'lucelis-cache' || typeof e.body !== 'string' || checksum(e.body) !== e.sum) return null
    const agg = JSON.parse(e.body)
    return isAgg(agg) ? { slot, seq: Number(e.seq) || 0, agg } : null
  } catch { return null }
}
export const envelope = (agg: Agg, seq: number): string => {
  const body = JSON.stringify(agg)
  return JSON.stringify({ kind: 'lucelis-cache', seq, sum: checksum(body), body } satisfies Envelope)
}

/** Both slots: the newest good snapshot (if any), the highest sequence seen, and which slot to write next. */
export const readSlots = async (io: Io, dir: string) => {
  const snaps: Snapshot[] = []
  let damaged = 0
  for (let i = 0; i < SLOTS.length; i++) {
    const p = join(dir, SLOTS[i])
    if (!(await io.exists(p))) continue
    let s: Snapshot | null = null
    try { s = parseSlot(await io.read(p), i) } catch { s = null }
    if (s) snaps.push(s)
    else damaged++
  }
  snaps.sort((x, y) => y.seq - x.seq)
  const best = snaps[0] ?? null
  return { best, seq: Math.max(0, ...snaps.map(s => s.seq)), writeSlot: best ? 1 - best.slot : 0, damaged }
}

/** Every transcript file under projects/, with who owns it and its size. */
export const discover = async (io: Io, root: string) => {
  const files: { p: string; size: number; owner: string }[] = []
  if (!(await io.exists(root))) return files
  for (const d of await io.list(root)) {
    if (d.kind !== 'dir') continue
    const entries = await io.list(join(root, d.name))
    for (const e of entries) {
      if (e.kind === 'file' && e.name.endsWith('.jsonl')) files.push({ p: join(d.name, e.name), size: e.size, owner: e.name.slice(0, -6) })
    }
    for (const e of entries) {
      if (e.kind !== 'dir') continue
      const sub = join(root, d.name, e.name, 'subagents')
      if (!(await io.exists(sub))) continue
      for (const s of await io.list(sub)) {
        if (s.kind === 'file' && s.name.endsWith('.jsonl')) files.push({ p: join(d.name, e.name, 'subagents', s.name), size: s.size, owner: e.name })
      }
    }
  }
  return files
}

/** Records the enclosing git repository root (or '') for working directories not looked up yet. */
export const lookUpGit = async (io: Io, a: Agg): Promise<void> => {
  const seen = new Map<string, string>()
  for (const cwd of cwdsOf(a)) {
    if (cwd in a.git) continue
    let dir = normPath(cwd)
    let found = ''
    const walked: string[] = []
    while (dir && !found) {
      if (seen.has(dir)) { found = seen.get(dir)!; break }
      walked.push(dir)
      if (await io.exists(dir + '\\.git')) found = dir
      const up = dir.lastIndexOf('\\')
      if (up <= 2) break // stop at the drive root
      dir = dir.slice(0, up)
    }
    for (const w of walked) seen.set(w, found && w.toLowerCase().startsWith(found.toLowerCase()) ? found : '')
    a.git[cwd] = found
  }
}

export type Mem = { held: Agg | null; seq: number }

/**
 * One refresh: start from the newest good snapshot on disk (another session may
 * have written it), read only new transcript bytes, write the other slot.
 * `full` starts from nothing. Resolves the aggregate and a one-line note.
 */
export const refreshCore = async (io: Io, paths: Paths, mem: Mem, full: boolean): Promise<string> => {
  const t0 = await io.now()
  const disk = await readSlots(io, paths.dir)
  let why = ''
  let a: Agg
  if (full) { a = emptyAgg(); why = 'rebuilt on request' }
  else if (disk.best) a = disk.best.agg
  else { a = emptyAgg(); if (disk.damaged) why = 'cache unreadable: rebuilt' }
  if (!full && disk.damaged && disk.best) why = 'one cache slot was damaged: used the other'
  const found = await discover(io, paths.projects)
  // A file that shrank was rewritten: the only safe answer is a clean rebuild.
  if (found.some(f => a.files[f.p] && f.size < a.files[f.p].o)) { a = emptyAgg(); why = 'a transcript was rewritten: rebuilt' }
  // Owners: every session with any transcript file of its own (main or subagents/). A fork's
  // subagents/ folder holds copies of its parent's subagent transcripts under the parent's id;
  // those must stay copies even when the parent's main transcript is gone.
  const own = [...new Set(found.map(f => f.owner))]
  let tasks: FileTask[] = found.filter(f => f.size > (a.files[f.p]?.o ?? 0)).map(f => ({ p: f.p, o: a.files[f.p]?.o ?? 0, owner: f.owner }))
  let rows = 0
  let calls = 0
  while (tasks.length && calls < MAX_CALLS) {
    calls++
    const res = ingest(a, await io.extract(paths.projects, tasks, own), tasks)
    rows += res.rows
    tasks = res.next
  }
  await lookUpGit(io, a)
  a.built = await io.now()
  if (calls > 0 || why || !disk.best) {
    const seq = Math.max(disk.seq, mem.seq) + 1
    await io.write(join(paths.dir, SLOTS[disk.best ? disk.writeSlot : 0]), envelope(a, seq))
    mem.seq = seq
  }
  mem.held = a
  const ms = (await io.now()) - t0
  const msg = calls ? `${rows} new records from ${calls} read${calls > 1 ? 's' : ''} in ${(ms / 1000).toFixed(1)}s` : 'up to date'
  return (why ? `${why}; ${msg}` : msg) + (a.flagged ? ` · ${a.flagged} damaged records excluded` : '')
}

/** Loads the newest good snapshot without extracting (session start). */
export const loadCore = async (io: Io, paths: Paths, mem: Mem): Promise<void> => {
  const disk = await readSlots(io, paths.dir)
  mem.held = disk.best?.agg ?? emptyAgg()
  mem.seq = disk.seq
}
