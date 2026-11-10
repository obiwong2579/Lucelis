import { expect, test } from 'claude-code/testing'

import { emptyAgg, growth, ingest, isAgg, makeResolver, rangeOf, shortProject, stats, streaks } from '../hooks/agg'
import type { Agg } from '../hooks/agg'
import { PRICES_AS_OF, compose, costTable, normalizeModel, priceFor } from '../hooks/prices'

const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)

const MAIN = { p: 'P\\s1.jsonl', o: 0, owner: 's1' }
const A = (sid: string, id: string, ms: number, day: string, h: number, inp: number, out: number, cw: number, cr: number, cwd = 'C:\\W\\Project Atlas\\game', side = 0) =>
  ['A', sid, id, ms, day, h, 'claude-opus-5-5', inp, out, cw, cr, cwd, side].join('\t')

// ---------------------------------------------------------------- pricing (official table, 2026-11-09)

const NOW = 1_000_000_000
const MEASURED = compose({ input: 1_000, cacheWrite: 5_000, cacheRead: 90_000, output: 2_000 }, 96_000)!
const row = (rows: ReturnType<typeof costTable>, id: string) => rows.find(r => r.id === id)!

test('pricing is dated and matched on exact model ids', async () => {
  expect(PRICES_AS_OF).toBe('2026-11-10')
  expect(priceFor('claude-opus-5-5')?.name).toBe('Opus 5.5')
  expect(priceFor('claude-opus-5-5[1m]')?.name).toBe('Opus 5.5')
  expect(priceFor('anthropic.claude-sonnet-5-5')?.name).toBe('Sonnet 5.5')
  expect(normalizeModel('claude-haiku-5-5-20261001')).toBe('claude-haiku-5-5')
  // Another version of a family is not priced with this family's row.
  expect(priceFor('claude-opus-5')).toBe(null)
  expect(priceFor('claude-sonnet-4-6')).toBe(null)
})

test('warm partial-cache prompt: measured read + new tail at the 1h write price (Opus 5.5)', async () => {
  // next prompt = 90K read + 5K written last time (now cached) + 1K uncached + 2K reply = 95K read, 3K written
  expect(MEASURED).toEqual({ read: 95_000, write: 3_000, basis: 'measured' })
  const rows = costTable(MEASURED, 'claude-opus-5-5', { 'claude-opus-5-5': { at: NOW - 60_000, ctx: 96_000 } }, NOW)
  const o = row(rows, 'claude-opus-5-5')
  expect(o.mode).toBe('warm')
  near(o.now, (95_000 * 0.2 + 3_000 * 8) / 1e6) // $0.043
  near(o.cold, (98_000 * 8) / 1e6) // $0.784
  near(o.saves, o.cold - o.now)
})

test('Sonnet 5.5: cache read $0.10, 1h write $4; another model starts cold', async () => {
  const mine = costTable(MEASURED, 'claude-sonnet-5-5', { 'claude-sonnet-5-5': { at: NOW, ctx: 96_000 } }, NOW)
  near(row(mine, 'claude-sonnet-5-5').now, (95_000 * 0.1 + 3_000 * 4) / 1e6)
  const other = costTable(MEASURED, 'claude-opus-5-5', { 'claude-opus-5-5': { at: NOW, ctx: 96_000 } }, NOW)
  const s = row(other, 'claude-sonnet-5-5')
  expect(s.mode).toBe('cold')
  near(s.now, (98_000 * 4) / 1e6)
  expect(s.saves).toBe(0)
})

test('Haiku 5.5 up to 100K: $0.01 read, $0.20 1h write', async () => {
  const rows = costTable(MEASURED, 'claude-haiku-5-5', { 'claude-haiku-5-5': { at: NOW, ctx: 96_000 } }, NOW)
  const h = row(rows, 'claude-haiku-5-5')
  near(h.now, (95_000 * 0.01 + 3_000 * 0.2) / 1e6)
  near(h.cold, (98_000 * 0.2) / 1e6)
})

test('Haiku 5.5 over 100K: the whole prompt pays the higher tier, cache hits included', async () => {
  const big = compose({ input: 2_000, cacheWrite: 8_000, cacheRead: 150_000, output: 0 }, 160_000)!
  const rows = costTable(big, 'claude-haiku-5-5', { 'claude-haiku-5-5': { at: NOW, ctx: 160_000 } }, NOW)
  const h = row(rows, 'claude-haiku-5-5')
  near(h.now, (158_000 * 0.05 + 2_000 * 1) / 1e6)
  near(h.cold, (160_000 * 1) / 1e6)
})

test('Fable 5.1: $0.25 read, $20 1h write', async () => {
  const rows = costTable(MEASURED, 'claude-fable-5-1', { 'claude-fable-5-1': { at: NOW, ctx: 96_000 } }, NOW)
  near(row(rows, 'claude-fable-5-1').now, (95_000 * 0.25 + 3_000 * 20) / 1e6)
  near(row(rows, 'claude-fable-5-1').cold, (98_000 * 20) / 1e6)
})

test('an unknown model is shown as unpriced, never priced with a guess', async () => {
  const rows = costTable(MEASURED, 'claude-opus-4-1', {}, NOW)
  const u = rows.find(r => r.isMine)!
  expect(u.isUnpriced).toBe(true)
  expect(u.now).toBe(0)
  expect(rows.filter(r => r.isCheapest && r.isUnpriced).length).toBe(0)
})

test('completely cold prompt: past the 60-minute clock, now equals cold and nothing is saved', async () => {
  const rows = costTable(MEASURED, 'claude-opus-5-5', { 'claude-opus-5-5': { at: NOW - 61 * 60_000, ctx: 96_000 } }, NOW)
  const o = row(rows, 'claude-opus-5-5')
  expect(o.mode).toBe('cold')
  near(o.now, o.cold)
  expect(rows.every(r => r.saves === 0)).toBe(true)
})

test('model A -> B -> A: each model keeps its own cache clock', async () => {
  const rows = costTable(MEASURED, 'claude-opus-5-5', {
    'claude-opus-5-5': { at: NOW, ctx: 96_000 },
    'claude-sonnet-5-5': { at: NOW - 10 * 60_000, ctx: 50_000 },
  }, NOW)
  const s = row(rows, 'claude-sonnet-5-5')
  expect(s.mode).toBe('warm')
  near(s.now, (50_000 * 0.1 + 48_000 * 4) / 1e6) // its 50K prefix read, the rest written
})

test('no request on record: the whole context is assumed cached, labelled as such', async () => {
  expect(compose(null, 100_000)).toEqual({ read: 100_000, write: 0, basis: 'assumed' })
  expect(compose(null, 0)).toBe(null)
})

// ---------------------------------------------------------------- projects

const withSessions = (sess: Record<string, { root: string; cwd: string }>, git: Record<string, string> = {}): Agg => {
  const a = emptyAgg()
  for (const [sid, s] of Object.entries(sess)) a.sess[sid] = { ...(emptyAgg() as any), root: s.root, cwd: s.cwd, first: 0, last: 0, act: 0, lastTs: 0, resp: 1, side: 0, prompts: 0, in: 0, out: 0, cw: 0, cr: 0, comp: 0, lastComp: 0, model: '', cur: 0, lu: [0, 0, 0, 0], ring: [] }
  a.git = git
  return a
}

test('a session started in a child folder joins the project of the folder above it', async () => {
  const a = withSessions({
    s1: { root: 'C:\\Work', cwd: 'C:\\Work\\Project Atlas\\docs' },
    s2: { root: 'C:\\Work\\Project Atlas\\game', cwd: 'C:\\Work\\Project Atlas\\game' },
  })
  const r = makeResolver(a, [])
  expect(r('C:\\Work\\Project Atlas\\game').name).toBe('Project Atlas')
  expect(r('C:\\Work\\Project Atlas\\tools\\x').key).toBe(r('C:\\Work\\Project Atlas').key)
  expect(r('C:\\Work').name).toBe('Work')
  expect(r('c:\\work\\project atlas\\GAME').key).toBe(r('C:\\Work\\Project Atlas').key) // case-insensitive
})

test('ambiguous launch from a sub-folder alone: an alias maps it and its siblings to one project', async () => {
  const a = withSessions({ s1: { root: 'D:\\X\\Proj\\game', cwd: 'D:\\X\\Proj\\game' } })
  expect(makeResolver(a, [])('D:\\X\\Proj\\game').name).toBe('game')
  const r = makeResolver(a, [{ path: 'D:\\X\\Proj\\', name: 'Proj' }])
  expect(r('D:\\X\\Proj\\game').name).toBe('Proj')
  expect(r('D:\\X\\Proj\\tools').name).toBe('Proj')
  expect(r('D:\\X\\Proj\\game').source).toBe('alias')
})

test('a git repository root wins over the folder heuristic; an alias wins over git', async () => {
  const a = withSessions({ s1: { root: 'C:\\Work', cwd: 'C:\\Work\\repo\\src' } }, { 'C:\\Work\\repo\\src': 'C:\\Work\\repo\\src' })
  expect(makeResolver(a, [])('C:\\Work\\repo\\src').source).toBe('git')
  expect(makeResolver(a, [{ path: 'C:\\Work\\repo', name: 'Repo' }])('C:\\Work\\repo\\src').name).toBe('Repo')
  expect(shortProject('Project Atlas')).toBe('ATLAS')
})

// ---------------------------------------------------------------- ingest

test('ingest: implausible rows are a corruption guard; stopped files stay pending', async () => {
  const a = emptyAgg()
  ingest(a, [A('s1', 'x', 1, '2026-11-09', 1, 9_000_000, 1, 1, 1), `F\t${MAIN.p}\t10\t1`].join('\n'), [MAIN])
  expect(a.flagged).toBe(1)
  const b = emptyAgg()
  const other = { p: 'P\\s2.jsonl', o: 0, owner: 's2' }
  const r = ingest(b, [A('s1', 'm1', 1, '2026-11-09', 1, 1, 1, 1, 1), `F\t${MAIN.p}\t200\t0`].join('\n'), [MAIN, other])
  expect(r.next).toEqual([{ ...MAIN, o: 200 }, other])
})

test('stats separate activity tokens, cache reads and processed tokens', async () => {
  const a = emptyAgg()
  ingest(a, ['N\t2026-11-09\t0', A('s1', 'm1', 1, '2026-11-09', 1, 10, 100, 1_000, 50_000), `F\t${MAIN.p}\t10\t1`].join('\n'), [MAIN])
  const st = stats(a, makeResolver(a, []), '2026-11-09', '2026-11-09')
  expect(st.all.tokens).toBe(1_110)
  expect(st.all.cr).toBe(50_000)
  expect(st.all.processed).toBe(51_110)
})

test('a corrupt or old cache is not taken as an aggregate', async () => {
  expect(isAgg(null)).toBe(false)
  expect(isAgg({ v: 1, files: {}, sess: {}, rows: {}, hours: {}, orphans: [] })).toBe(false)
  expect(isAgg(JSON.parse(JSON.stringify(emptyAgg())))).toBe(true)
})

test('growth skips deltas across a compaction and stays descriptive', async () => {
  const g = growth([10_000, 12_000, 14_000, -1, 3_000, 4_000, 5_000], 6_000)
  expect(g.l5.sum).toBe(3_000)
  expect(g.l5.broken).toBe(true)
  expect(g.pace).toBe('Low')
})

test('periods and streaks', async () => {
  expect(rangeOf('7d', '2026-11-09', '')).toEqual({ from: '2026-11-03', to: '2026-11-09', prev: { from: '2026-10-27', to: '2026-11-02' } })
  const a = emptyAgg()
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-07', '2026-11-08']) a.hours[d] = [1, ...new Array(47).fill(0)]
  expect(streaks(a, '2026-11-09')).toEqual({ current: 2, longest: 3 })
})

test('a compaction records the turn before it first: no stale pre-compaction size after the marker', async () => {
  // Real order in a transcript: prompt, turn (ctx 532K), /compact, prompt, turn (ctx 100K), prompt.
  const P = (uuid: string, ms: number) => ['P', 's1', uuid, ms, '2026-11-10', 3, 'C:\W'].join('\t')
  const C = (uuid: string, ms: number) => ['C', 's1', uuid, ms].join('\t')
  const a = emptyAgg()
  const text = [
    P('p1', 1_000), A('s1', 'm1', 2_000, '2026-11-10', 3, 2_000, 100, 30_000, 500_000), // turn ends at 532K
    C('c1', 3_000),
    P('p2', 4_000), A('s1', 'm2', 5_000, '2026-11-10', 3, 354, 100, 100_000, 0), // turn ends at 100,354
    P('p3', 6_000),
    ['F', MAIN.p, 999, 1].join('\t'),
  ].join('\n')
  ingest(a, text, [MAIN])
  expect(a.sess.s1.ring).toEqual([532_000, -1, 100_354])
  expect(a.sess.s1.comp).toBe(1)
  // Growth never spans the marker, so the compaction is not read as a 432K shrink in one turn.
  const g = growth(a.sess.s1.ring, 100_354)
  expect(g.avg >= 0).toBe(true)
})

test('an alias named like an existing project joins it: one key, one total, whichever folder the session is in', async () => {
  const a = emptyAgg()
  const t = { p: 'X\\s1.jsonl', o: 0, owner: 's1' }
  const ms = Date.parse('2026-11-10T02:00:00Z')
  ingest(a, [
    'N\t2026-11-10\t480',
    ['P', 's1', 'p1', ms, '2026-11-10', 10, 'F:\\W'].join('\t'),
    ['A', 's1', 'm1', ms + 1000, '2026-11-10', 10, 'claude-opus-5-5', 10, 500, 20_000, 0, 'F:\\W\\Main', 0].join('\t'),
    ['A', 's1', 'm2', ms + 2000, '2026-11-10', 10, 'claude-opus-5-5', 10, 700, 30_000, 0, 'F:\\W\\Main-review', 0].join('\t'),
    ['A', 's1', 'm3', ms + 3000, '2026-11-10', 10, 'claude-opus-5-5', 10, 100, 1_000, 0, 'F:\\W\\Other', 0].join('\t'),
    `F\t${t.p}\t999\t1`,
  ].join('\n'), [t])
  const plain = makeResolver(a, [])
  expect(plain('F:\\W\\Main').key).not.toBe(plain('F:\\W\\Main-review').key)
  const r = makeResolver(a, [{ path: 'F:\\W\\Main-review', name: 'main' }])
  expect(r('F:\\W\\Main-review').key).toBe(r('F:\\W\\Main').key) // joined (name match ignores case)
  expect(r('F:\\W\\Main-review\\sub').key).toBe(r('F:\\W\\Main').key)
  expect(r('F:\\W\\Other').key).not.toBe(r('F:\\W\\Main').key)
  const s = stats(a, r, '2026-11-10', '2026-11-10')
  expect(s.byProject.get(r('F:\\W\\Main').key)!.tokens).toBe(10 + 500 + 20_000 + 10 + 700 + 30_000)
  expect(s.byProject.size).toBe(3) // Main (+ review), Other, and the start folder itself
  // Two aliases sharing a new name are one project; an alias with a name of its own keeps its own key.
  const two = makeResolver(a, [{ path: 'F:\\W\\Main', name: 'Suite' }, { path: 'F:\\W\\Other', name: 'Suite' }, { path: 'F:\\W\\Main-review', name: 'Review' }])
  expect(two('F:\\W\\Main').key).toBe(two('F:\\W\\Other').key)
  expect(two('F:\\W\\Main-review').key).not.toBe(two('F:\\W\\Main').key)
})
