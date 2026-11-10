// Two sessions refreshing one shared cache: torn writes, lost races, rewritten transcripts.
import { expect, test } from 'claude-code/testing'

import { makeResolver, stats } from '../hooks/agg'
import type { FileTask } from '../hooks/agg'
import type { Io, Mem } from '../hooks/core'
import { SLOTS, parseSlot, readSlots, refreshCore } from '../hooks/core'

const ROOT = 'C:\\h\\.claude\\projects'
const DIR = 'C:\\h\\.claude\\lucelis'
const PATHS = { projects: ROOT, dir: DIR }

/** A fake disk. Transcripts hold extractor rows directly; the fake extractor slices them by offset. */
const makeDisk = () => {
  const files = new Map<string, string>()
  const io = (gate?: { write?: Promise<void> }): Io => ({
    now: async () => 1_000,
    exists: async p => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '\\')),
    read: async p => { const t = files.get(p); if (t === undefined) throw new Error('missing ' + p); return t },
    write: async (p, text) => { if (gate?.write) await gate.write; files.set(p, text) },
    list: async p => {
      const out = new Map<string, { name: string; kind: 'file' | 'dir'; size: number }>()
      for (const [k, v] of files) {
        if (!k.startsWith(p + '\\')) continue
        const rest = k.slice(p.length + 1).split('\\')
        out.set(rest[0], rest.length === 1 ? { name: rest[0], kind: 'file', size: v.length } : { name: rest[0], kind: 'dir', size: 0 })
      }
      return [...out.values()]
    },
    extract: async (root: string, tasks: FileTask[]) => {
      let s = 'N\t2026-11-09\t0\n'
      for (const t of tasks) {
        const text = files.get(root + '\\' + t.p) ?? ''
        const from = t.o > text.length ? 0 : t.o
        s += text.slice(from) + `F\t${t.p}\t${text.length}\t1\n`
      }
      return s
    },
  })
  return { files, io }
}
const row = (sid: string, id: string, k: number) => ['A', sid, id, 1_000, '2026-11-09', 10, 'claude-opus-5-5', k, 10 * k, 100 * k, 1000 * k, 'C:\\W\\P', 0].join('\t') + '\n'
const T1 = `${ROOT}\\D\\s1.jsonl`
const T2 = `${ROOT}\\D\\s2.jsonl`
const activity = (m: Mem) => { const a = m.held!; return stats(a, makeResolver(a, []), '0000-01-01', '9999-12-31').all.tokens }
const responses = (m: Mem) => Object.values(m.held!.sess).reduce((n, s) => n + s.resp, 0)

test('two sessions race on the shared cache: no corrupt JSON, nothing lost for good, nothing counted twice', async () => {
  const { files, io } = makeDisk()
  files.set(T1, row('s1', 'r1', 1) + row('s1', 'r2', 2) + row('s1', 'r3', 3))
  files.set(T2, row('s2', 'q1', 4) + row('s2', 'q2', 5))
  const A: Mem = { held: null, seq: 0 }
  const B: Mem = { held: null, seq: 0 }
  await refreshCore(io(), PATHS, A, false) // slot a, seq 1

  // B sees only s2's growth and stalls just before writing.
  files.set(T2, files.get(T2)! + row('s2', 'q3', 6))
  let release!: () => void
  const gate = { write: new Promise<void>(r => { release = r }) }
  const bRun = refreshCore(io(gate), PATHS, B, false)
  await new Promise(r => setTimeout(r, 0))

  // Meanwhile s1 grows and A refreshes completely (slot b, seq 2, everything so far).
  files.set(T1, files.get(T1)! + row('s1', 'r4', 7) + row('s1', 'r5', 8))
  await refreshCore(io(), PATHS, A, false)
  expect(activity(A)).toBe(111 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8))

  // B now writes its older view over a slot: the race A lost.
  release()
  await bRun
  const mid = await readSlots(io(), DIR)
  expect(mid.best).not.toBe(null)

  // A torn write into the other slot (a process killed mid-write).
  const other = `${DIR}\\${SLOTS[mid.best!.slot === 0 ? 1 : 0]}`
  files.set(other, (files.get(other) ?? '').slice(0, 50))
  expect(parseSlot(files.get(other)!, 0)).toBe(null)

  // The next refresh, by either session, converges on the truth.
  const C: Mem = { held: null, seq: 0 }
  const note = await refreshCore(io(), PATHS, C, false)
  expect(note).toContain('damaged')
  expect(responses(C)).toBe(8)
  expect(activity(C)).toBe(111 * 36)
  // Every slot on disk is now valid JSON with a matching checksum, or absent.
  for (const s of SLOTS) { const t = files.get(`${DIR}\\${s}`); if (t !== undefined) expect(parseSlot(t, 0)).not.toBe(null) }
})

test('a transcript that shrank (rewritten) triggers a clean rebuild with the current content', async () => {
  const { files, io } = makeDisk()
  files.set(T1, row('s1', 'r1', 1) + row('s1', 'r2', 2))
  const M: Mem = { held: null, seq: 0 }
  await refreshCore(io(), PATHS, M, false)
  files.set(T1, row('s1', 'r9', 9))
  const note = await refreshCore(io(), PATHS, M, false)
  expect(note).toContain('rewritten')
  expect(activity(M)).toBe(111 * 9)
})

test('both slots damaged: rebuild from the transcripts, never show garbage', async () => {
  const { files, io } = makeDisk()
  files.set(T1, row('s1', 'r1', 1))
  files.set(`${DIR}\\cache-a.json`, '{"kind":"lucelis-cache","seq":5,"sum":"00000000","body":"{}"}')
  files.set(`${DIR}\\cache-b.json`, 'not json')
  const M: Mem = { held: null, seq: 0 }
  const note = await refreshCore(io(), PATHS, M, false)
  expect(note).toContain('unreadable')
  expect(activity(M)).toBe(111)
})
