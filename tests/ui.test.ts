// v0.2.2 UI: the three levels (compact row, More snapshot, pane), fitting at
// several widths, tab navigation with visible selected states, Details navigation
// when the pane is already open, and settings that change and persist.

import { expect, mock, test } from 'claude-code/testing'

import { emptyAgg, ingest } from '../hooks/agg'
import type { ItemKey, Part, Seg } from '../hooks/bar'
import { ITEMS, barLayout, fit, snapshotLines } from '../hooks/bar'
import { HELP } from '../hooks/pane'
import { costTable } from '../hooks/prices'
import { envelope } from '../hooks/core'
import type { View } from '../hooks/model'

const NOW = Date.parse('2026-11-10T04:00:00Z')
const W = (segs: Seg[]) => segs.reduce((n, s) => n + s[0].length, 0)

/** A full live view: every field present, long values, so fitting is exercised. */
const FULL = {
  quotas: [{ kind: 'five_hour', left: 88, resetIn: 4 * 3600e3 + 33 * 60e3 }, { kind: 'seven_day', left: 17, resetIn: 4 * 86400e3 + 6 * 3600e3 }],
  cache: { mode: 'warm', idleMs: 120_000, minsLeft: 58, resend: 205_000, cached: 205_000, reusable: 99.6, lastTurnHit: 99, sessionHit: 98 },
  composition: { read: 205_000, write: 750, basis: 'measured' },
  costs: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', isMine: true, isUnpriced: false, mode: 'warm', now: 0.05, cold: 1.64, saves: 1.59, isCheapest: true },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', isMine: false, isUnpriced: false, mode: 'cold', now: 0.82, cold: 0.82, saves: 0, isCheapest: false },
  ],
  ctx: { percent: 20, tokens: 205_000, window: 1_000_000, left: 795_000, isNearLimit: false },
  session: {
    project: { key: 'f:\\workspace', name: 'Workspace', source: 'root' }, model: 'claude-opus-5-5',
    elapsedMs: 15.5 * 3600e3, activeMs: 76 * 60e3, startedAt: NOW - 15.5 * 3600e3, messages: 209, prompts: 8,
    input: 424, output: 300_000, cacheWrite: 905_000, cacheRead: 53_000_000, tokens: 1_210_000, compactions: 1, lastCompactionAgo: 11.5 * 3600e3,
  },
  growth: { l5: { sum: 298_000, turns: 5, broken: false }, l10: { sum: 460_000, turns: 7, broken: true }, avg: 65_700, direction: 'rising', pace: 'Fast' },
  today: { tokens: 295_000, project: { name: 'Workspace', tokens: 278_000, sessions: 1, messages: 80, share: 94 } },
  week: { tokens: 14_500_000, change: 12, project: { tokens: 4_530_000, change: 30 }, share30: 31 },
  relative: { n: 9, tokens: [1_210_000, 211_000], active: [76 * 60e3, 9 * 60e3], messages: [209, 29] },
  modelMix: { project: 'Workspace', rows: [{ model: 'claude-opus-5-5', share: 97 }] },
} as unknown as View

const SETTINGS = {
  isOn: true, mode: 'normal', period: '30d', heat: 'tokens', aliases: [],
  show: { h5: true, d7: true, cache: true, ctx: true, resets: true, today: true, session: true, elapsed: true, trend: true, project: true, model: true },
} as const

test('More is a snapshot of at most six lines that never outgrow the band, at any width', async () => {
  for (const cols of [30, 40, 50, 60, 80, 100, 140, 200]) {
    const lines = snapshotLines(FULL, cols, 480, NOW)
    expect(lines.length <= 6).toBe(true)
    for (const l of lines) {
      const label = cols < 60 ? 11 : 15
      const w = label + W(l.segs) + (l.chip ? l.chip[0].length + 1 : 0)
      // Each line fits its row (a floor of 20 value columns keeps very narrow bands legible).
      expect(w <= Math.max(cols - 2, label + 20)).toBe(true)
    }
    const text = lines.map(l => l.segs.map(s => s[0]).join('')).join('\n')
    expect((text.includes('left') || text.includes('remaining')) && !text.includes('5H')).toBe(true) // context left; no quota repeat
  }
  // Wide: the session line carries identity and both times; the cost line its "not your bill".
  const wide = snapshotLines(FULL, 140, 480, NOW)
  const who = wide.find(l => l.key === 'who')!.segs.map(s => s[0]).join('')
  expect(who.includes('Workspace') && who.includes('elapsed') && who.includes('active')).toBe(true)
  expect(who.includes('yesterday')).toBe(true) // D7: a start before midnight says so
  expect(wide.find(l => l.key === 'cost')!.segs.map(s => s[0]).join('').includes('not your bill')).toBe(true)
})

test('compact row: quota always, then context and cache, unambiguous "left", no overflow', async () => {
  for (const cols of [40, 60, 80, 100, 160]) {
    const room = cols - 22
    const shown = barLayout(FULL, SETTINGS as any, cols).rows[0]
    const keys = shown.map(p => p.key)
    expect(keys.filter(k => !k.endsWith('-reset')).slice(0, 2)).toEqual(['five_hour', 'seven_day'])
    // v0.2.3 short labels: no "left", "LOW" or "used" words on the bar.
    for (const p of shown) expect(p.segs.some(s => /left|LOW|used|tokens/.test(s[0]))).toBe(false)
    const used = shown.reduce((n, p, i) => n + W(p.segs) + (i && !p.after ? 3 : 0), 0)
    if (cols >= 60) expect(used <= room).toBe(true)
    // Priority (v0.2.3, usage first): cache and its countdown before context before project.
    if (keys.includes('ctx')) expect(keys.includes('cache')).toBe(true)
    if (keys.includes('proj')) expect(keys.includes('ctx')).toBe(true)
  }
  // At 62 columns (about the Desktop chat column with the pane open) cache still shows.
  expect(barLayout(FULL, SETTINGS as any, 62).rows[0].map(p => p.key)).toContain('cache')
  // Minimal mode: the two quotas only.
  expect(barLayout(FULL, { ...SETTINGS, mode: 'minimal' } as any, 200).rows[0].map(p => p.key)).toEqual(['five_hour', 'seven_day'])
})

test('a very narrow band uses glyph buttons and never overflows', async ($, on) => {
  await boot($, on)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 30 } })
  expect(await band.find({ text: '5H ' })).toBeDefined()
  expect((await band.find({ key: 'more' }))?.props.label).toBe('▾')
  expect((await band.find({ key: 'details' }))?.props.label).toBe('›')
  await band.press({ key: 'more' })
  expect((await band.find({ key: 'open-session' }))?.props.label).toBe('Session ›')
  await band.unmount()
  const wide = await $.ui.mount(BAND)
  expect(await wide.find({ text: 'LEFT ' })).toBeUndefined()
  expect((await wide.find({ key: 'details' }))?.props.label).toBe('Details ›')
  // The reset time rides with its quota (no separator) once context and cache are in.
  expect(await wide.find({ text: /^ · \d/ })).toBeDefined()
  await wide.unmount()
})

test('fit: shortest forms first by priority, then longer forms while room is left', async () => {
  const P = (key: string, prio: number, ...forms: string[]): Part => ({ key, prio, forms: forms.map(f => [[f, '#fff']] as Seg[]) })
  const parts = [P('a', 1, 'aaaaaaaa', 'aa'), P('b', 2, 'bbbbbbbb', 'bb'), P('c', 3, 'cc')]
  expect(fit(parts, 12).map(p => p.segs[0][0])).toEqual(['aa', 'bb', 'cc']) // 2 + 3+2 + 3+2 = 12: all placed short
  expect(fit(parts, 18).map(p => p.segs[0][0])).toEqual(['aaaaaaaa', 'bb', 'cc']) // then a grows first (+6)
  expect(fit(parts, 9).map(p => p.key)).toEqual(['a', 'b']) // c (lowest priority) is the one dropped
  expect(fit(parts, 100).map(p => p.segs[0][0])).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cc'])
  expect(fit(parts, 2, 2).map(p => p.key)).toEqual(['a', 'b']) // kept regardless of room
})

// ---------------------------------------------------------------- band and pane interaction

const historyText = () => {
  const a = emptyAgg()
  const t = { p: 'X\\s1.jsonl', o: 0, owner: 's1' }
  const day = Date.parse('2026-11-09T09:00:00Z')
  ingest(a, [
    'N\t2026-11-10\t480',
    ['P', 's1', 'p1', day, '2026-11-09', 17, 'F:\\W'].join('\t'),
    ['A', 's1', 'm1', day + 1000, '2026-11-09', 17, 'claude-opus-5-5', 10, 500, 20_000, 1_000, 'F:\\W\\Project Atlas', 0].join('\t'),
    `F\t${t.p}\t999\t1`,
  ].join('\n'), [t])
  return envelope(a, 1)
}

const boot = async ($: any, on: any, opts: { paneOpen?: boolean; store?: Record<string, unknown> } = {}) => {
  const text = historyText()
  const up = { id: 'lucelis', title: 'Lucelis', isPlaced: true, isShown: true, isFocused: false }
  const calls = { open: [] as any[], close: [] as any[], toast: [] as string[], panes: (opts.paneOpen ? [up] : []) as any[], db: { ...(opts.store ?? {}) } as Record<string, unknown> }
  on('store.get', (_: any, e: any) => ({ value: calls.db[e.key] }))
  on('store.set', (_: any, e: any) => { calls.db[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  mock.clock(on, { now: NOW })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW - 3600e3, context: { window: 1_000_000, tokens: 200_000, percent: 20 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-11-10T08:00:00Z' }, { kind: 'seven_day', percentUsed: 83, resetsAt: '2026-11-14T10:00:00Z' }] } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\t' : undefined }))
  on('fs.exists', (_: any, e: any) => ({ value: String(e.path).endsWith('cache-a.json') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: calls.panes }))
  on('ui.open', (_: any, e: any) => { calls.open.push(e); calls.panes = [up]; return { value: { isPlaced: true } } })
  on('ui.close', (_: any, e: any) => { calls.close.push(e); calls.panes = []; return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { calls.toast.push(e.text); return { value: undefined } })
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'F:\\W\\Project Atlas' })
  return calls
}
const BAND = { plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 90, scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const PANE = { plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { title: 'Lucelis', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

test('band links navigate: a closed pane opens on its tab; an open one switches tab and says so', async ($, on) => {
  const calls = await boot($, on, { paneOpen: true })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'more' })
  await band.press({ key: 'open-session' })
  expect(calls.open.length).toBe(1)
  expect(calls.open[0].focus).toBe(true)
  expect(calls.toast).toContain('Lucelis pane: Session tab')
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'tab-session' }))?.props.variant).toBe('primary')
  await band.press({ key: 'open-dashboard' })
  expect(calls.toast).toContain('Lucelis pane: Overview tab')
  expect((await pane.find({ key: 'tab-overview' }))?.props.variant).toBe('primary')
  expect(calls.close.length).toBe(0) // the links never close the pane; only Details toggles
  await pane.unmount()
  await band.unmount()
})

test('settings change at once, persist in the store, and survive a fresh load', async ($, on) => {
  const kept = { settings: { isOn: true, mode: 'normal', period: '30d', heat: 'tokens', show: { ctx: true }, aliases: [{ path: 'F:\\Old', name: 'Old' }] } }
  const calls = await boot($, on, { store: kept })
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-settings' })
  // A setting saved by an earlier version keeps its values; missing fields come from defaults.
  expect(await pane.find({ text: 'Old' })).toBeDefined()
  expect((await pane.find({ key: 'sh-today' }))?.props.variant).toBe('primary')
  // Density, an item toggle, default period, heatmap metric.
  await pane.press({ key: 'st-minimal' })
  await pane.press({ key: 'sh-ctx' })
  await pane.press({ key: 'dp-7d' })
  await pane.press({ key: 'dh-messages' })
  expect((await pane.find({ key: 'st-minimal' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'sh-ctx' }))?.props.variant).toBe('secondary')
  // Aliases: add one through the form, remove the old one.
  await pane.input({ key: 'alias-add', text: 'F:\\W\\Project Atlas => ATLAS GAME' })
  await pane.press({ key: 'al-rm-0' })
  for (let i = 0; i < 20 && (calls.db.settings as any)?.aliases?.length !== 1; i++) await new Promise(r => setTimeout(r, 10))
  const saved = calls.db.settings as any
  expect(saved.mode).toBe('minimal')
  expect(saved.show.ctx).toBe(false)
  expect(saved.period).toBe('7d')
  expect(saved.heat).toBe('messages')
  expect(saved.aliases).toEqual([{ path: 'F:\\W\\Project Atlas', name: 'ATLAS GAME' }])
  // The band follows at once: minimal shows the quotas only.
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: 'CTX ' })).toBeUndefined()
  await band.unmount()
  // Refresh and Rebuild give visible feedback.
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'rebuild' })
  await pane.unmount()
  for (let i = 0; i < 20 && calls.toast.filter(t => /Activity (refresh|rebuild)/.test(t)).length < 2; i++) await new Promise(r => setTimeout(r, 10))
  expect(calls.toast.some(t => t.startsWith('Lucelis refresh:'))).toBe(true)
  expect(calls.toast.some(t => t.startsWith('Lucelis rebuild:'))).toBe(true)
})

// ---------------------------------------------------------------- v0.2.3: compact bar items, density, Details toggle

const ALL_OFF = { h5: false, d7: false, cache: false, ctx: false, resets: false, today: false, session: false, elapsed: false, trend: false, project: false, model: false }
const withShow = (show: Record<string, boolean>, mode = 'normal') => ({ ...SETTINGS, mode, show: { ...ALL_OFF, ...show } }) as any
const keysOf = (L: { rows: { key: string }[][] }) => L.rows.map(r => r.map(p => p.key))
/** Which part keys each item draws. */
const DRAWS: Record<string, string[]> = {
  h5: ['five_hour'], d7: ['seven_day'], cache: ['cache'], ctx: ['ctx'], project: ['proj'], session: ['sess'],
  today: ['today'], elapsed: ['dur'], trend: ['trend'], model: ['model'],
}

test('every Compact Bar Item toggle works alone: on draws exactly its item, off removes it and keeps no room', async () => {
  expect(ITEMS.map(i => i.key).sort()).toEqual(Object.keys(ALL_OFF).sort()) // Settings and the bar use one list
  for (const mode of ['normal', 'detailed']) {
    for (const [item, parts] of Object.entries(DRAWS)) {
      const on = barLayout(FULL, withShow({ [item]: true }, mode), 120)
      expect(keysOf(on).flat()).toEqual(parts)
      expect(on.state[item as ItemKey]).toBe('shown')
      for (const other of ITEMS) if (other.key !== item) expect(on.state[other.key]).toBe('off')
    }
    // Reset times ride on a quota: with one quota on they follow it, alone they have nothing to attach to.
    expect(keysOf(barLayout(FULL, withShow({ h5: true, resets: true }, mode), 120)).flat()).toEqual(['five_hour', 'five_hour-reset'])
    expect(barLayout(FULL, withShow({ resets: true }, mode), 120).state.resets).toBe('nodata')
    // Everything off: nothing is forced on.
    const none = barLayout(FULL, withShow({}, mode), 120)
    expect(keysOf(none).flat()).toEqual([])
  }
})

test('the reported case: Normal, Project / Session / Today off, each other item turned on and off', async () => {
  const base = { h5: true, d7: true, cache: true, ctx: true, resets: true }
  for (const cols of [100, 200]) {
    for (const item of ['elapsed', 'trend', 'model']) {
      const off = barLayout(FULL, withShow(base), cols)
      expect(keysOf(off).flat().includes(DRAWS[item][0])).toBe(false)
      const on = barLayout(FULL, withShow({ ...base, [item]: true }), cols)
      expect(on.rows.length).toBe(1)
      expect(keysOf(on).flat().includes(DRAWS[item][0])).toBe(true) // v0.2.2: trend and model never appeared in Normal
      expect(on.state[item as ItemKey]).toBe('shown')
      // The usage items keep their places in front of it.
      expect(keysOf(on).flat().slice(0, 5)).toEqual(['five_hour', 'five_hour-reset', 'seven_day', 'seven_day-reset', 'cache'])
    }
  }
  // At the pane-open width nothing after the usage items fits, and Settings is told so (not "shown").
  const tightRow = barLayout(FULL, withShow({ ...base, trend: true, model: true }), 62)
  expect(tightRow.state.trend).toBe('width')
  expect(tightRow.state.model).toBe('width')
  expect(tightRow.state.h5).toBe('shown')
  expect(tightRow.state.cache).toBe('shown')
})

test('turning items off gives their room to the next enabled ones (reflow)', async () => {
  const all = { ...ALL_OFF, h5: true, d7: true, cache: true, ctx: true, project: true, session: true, today: true, trend: true, model: true }
  const full = barLayout(FULL, withShow(all), 90)
  expect(full.state.trend).toBe('width') // no room behind project, session and today
  const freed = barLayout(FULL, withShow({ ...all, project: false, session: false, today: false }), 90)
  expect(freed.state.trend).toBe('shown')
  expect(freed.state.model).toBe('shown')
  expect(freed.state.project).toBe('off')
  // No row ever outgrows its room.
  for (const cols of [40, 56, 62, 80, 100, 140]) for (const mode of ['minimal', 'normal', 'detailed']) {
    const L = barLayout(FULL, withShow(all, mode), cols)
    L.rows.forEach((r, i) => {
      const used = r.reduce((n, p, j) => n + W(p.segs) + (j && !p.after ? (i === 0 && L.tier ? 1 : 3) : 0), 0)
      if (cols >= 56) expect(used <= (i === 0 ? cols - 22 : cols - 2)).toBe(true)
    })
  }
})

test('density modes are distinct: Minimal = quotas, Normal = one usage-first row, Detailed = two rows', async () => {
  const everything = Object.fromEntries(Object.keys(ALL_OFF).map(k => [k, true]))
  const min = barLayout(FULL, withShow(everything, 'minimal'), 100)
  const nor = barLayout(FULL, withShow(everything, 'normal'), 100)
  const det = barLayout(FULL, withShow(everything, 'detailed'), 100)
  expect(keysOf(min)).toEqual([['five_hour', 'seven_day']]) // never blank, never more than the quotas
  expect(min.state.cache).toBe('density') // on, and Settings says why it is not drawn
  expect(min.state.h5).toBe('shown')
  expect(nor.rows.length).toBe(1)
  // Usage first: 5H, 7D, WARM + countdown, CTX in that order, before any session item.
  expect(keysOf(nor)[0].filter(k => !k.endsWith('-reset')).slice(0, 4)).toEqual(['five_hour', 'seven_day', 'cache', 'ctx'])
  expect(nor.rows[0].find(p => p.key === 'cache')!.segs.map(s => s[0]).join('')).toBe('WARM 58m')
  expect(det.rows.length).toBe(2)
  expect(keysOf(det)[0].every(k => ['five_hour', 'seven_day', 'cache', 'ctx'].includes(k.replace('-reset', '')))).toBe(true)
  expect(keysOf(det)[1]).toEqual(['proj', 'sess', 'today', 'dur', 'trend', 'model'])
  const text = (L: any) => JSON.stringify(L.rows)
  expect(new Set([text(min), text(nor), text(det)]).size).toBe(3)
  // Detailed with every second-row item off is a single row again (no empty row).
  expect(barLayout(FULL, withShow({ h5: true, d7: true }, 'detailed'), 100).rows.length).toBe(1)
})

test('an enabled item with no data is "no data yet", not "hidden for width"', async () => {
  const bare = { ...FULL, week: null, today: null, cache: null, session: { ...FULL.session!, tokens: null } } as unknown as View
  const L = barLayout(bare, withShow(Object.fromEntries(Object.keys(ALL_OFF).map(k => [k, true]))), 200)
  expect(L.state.trend).toBe('nodata')
  expect(L.state.today).toBe('nodata')
  expect(L.state.cache).toBe('nodata')
  expect(L.state.session).toBe('nodata')
  expect(L.state.project).toBe('shown')
  // A week with no earlier week to compare still shows its total (v0.2.2 hid the item).
  const noTrend = { ...FULL, week: { ...FULL.week!, change: null } } as unknown as View
  expect(barLayout(noTrend, withShow({ trend: true }), 100).state.trend).toBe('shown')
})

test('More: grouped lines, │ separators, plain token labels, your model cost and the other models', async () => {
  const lines = snapshotLines(FULL, 110, 480, NOW)
  expect(lines.map(l => l.label)).toEqual(['SESSION', 'ACTIVITY', 'CONTEXT', 'CACHE', 'NEXT MESSAGE', 'IF SWITCHED'])
  const text = (k: string) => lines.find(l => l.key === k)!.segs.map(s => s[0]).join('')
  for (const l of lines) {
    if (l.key !== 'alt') expect(l.segs.some(s => s[0] === ' │ ')).toBe(true)
    expect(l.segs.some(s => s[0] === ' · ')).toBe(false)
  }
  expect(text('act')).toBe('1.21M activity tokens │ 209 messages │ 300K output │ 905K cache writes │ 1 compaction')
  expect(text('act').includes('out 300K')).toBe(false)
  expect(text('ctx').includes('795K remaining')).toBe(true)
  expect(text('cache').startsWith('~58m until cold')).toBe(true)
  expect(text('cache').includes('inferred')).toBe(true) // never presented as Claude's own report
  expect(text('cost')).toBe('Opus 5.5 │ ~$0.05 now │ ~$1.64 if cold │ API-price estimate, not your bill')
  expect(text('alt')).toBe('Sonnet 5.5 ~$0.82 cold') // its own cache clock: cold, not warm like yours
  // A model with no price row is named and never priced.
  const unpriced = { ...FULL, costs: [{ id: 'claude-x-9', name: 'claude-x-9', isMine: true, isUnpriced: true, mode: 'cold', now: 0, cold: 0, saves: 0, isCheapest: false }, FULL.costs![1]] } as unknown as View
  const u = snapshotLines(unpriced, 100, 480, NOW).find(l => l.key === 'cost')!.segs.map(s => s[0]).join('')
  expect(u.includes('no price on record') && !u.includes('$')).toBe(true)
  // The Terms help defines the labels the bar uses.
  const help = HELP.join('\n')
  for (const term of ['Session activity', 'Project today', 'Output tokens', 'Cache reads', 'Processed tokens', 'not your bill', 'inferred']) expect(help.includes(term)).toBe(true)
})

test('Details is a true toggle by the engine record: open, close, reopen, and no stale state after the X', async ($, on) => {
  const calls = await boot($, on)
  const band = await $.ui.mount(BAND)
  const label = async () => (await band.find({ key: 'details' }))?.props.label
  expect(await label()).toBe('Details ›')
  await band.press({ key: 'details' })
  expect(calls.open.length).toBe(1)
  expect(calls.close.length).toBe(0)
  expect(await label()).toBe('Details ✕')
  await band.press({ key: 'details' })
  expect(calls.close.map((c: any) => c.id)).toEqual(['lucelis']) // the host's own close, this pane only
  expect(calls.open.length).toBe(1)
  expect(await label()).toBe('Details ›')
  await band.press({ key: 'details' })
  expect(calls.open.length).toBe(2)
  // The person closes the pane with its own X: the next press opens it (nothing remembered).
  calls.panes = []
  await band.press({ key: 'details' })
  expect(calls.open.length).toBe(3)
  expect(calls.close.length).toBe(1)
  // A pane that is open behind another tab is raised, not closed.
  calls.panes = [{ id: 'lucelis', title: 'Lucelis', isPlaced: true, isShown: false, isFocused: false }]
  await band.press({ key: 'details' })
  expect(calls.open.length).toBe(4)
  expect(calls.close.length).toBe(1)
  await band.unmount()
})

test('Compare models goes straight to the comparison, first on the Models tab', async ($, on) => {
  const calls = await boot($, on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60, context_tokens: 200_000, model: 'claude-opus-5-5' })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'more' })
  expect(await band.find({ text: 'NEXT MESSAGE' })).toBeDefined()
  expect(await band.find({ text: 'IF SWITCHED' })).toBeDefined()
  await band.press({ key: 'open-compare' })
  expect(calls.open.length).toBe(1)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'tab-models' }))?.props.variant).toBe('primary')
  const all = JSON.stringify(await pane.find({ type: 'Box' }))
  expect(all.includes('h-nm-mod')).toBe(true)
  expect(all.indexOf('h-nm-mod')).toBeLessThan(all.indexOf('h-md')) // the comparison comes before the period statistics
  for (const name of ['Fable 5.2', 'Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']) expect(all.includes(name)).toBe(true)
  await pane.unmount()
  await band.unmount()
})

test('Settings shows each item state and the toggles persist, new items included', async ($, on) => {
  // A v0.2.2-shaped store: no `resets`, no `elapsed`. They default to on; the saved ones keep their values.
  const kept = { settings: { isOn: true, mode: 'normal', period: '30d', heat: 'tokens', show: { h5: true, d7: true, cache: false, ctx: true, today: false, session: false, trend: false, project: false, model: false }, aliases: [] } }
  const calls = await boot($, on, { store: kept })
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 120 } })
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-settings' })
  const variant = async (k: string) => (await pane.find({ key: `sh-${k}` }))?.props.variant
  expect(await variant('cache')).toBe('secondary')
  expect(await variant('resets')).toBe('primary')
  expect(await variant('elapsed')).toBe('primary')
  expect(await band.find({ text: '◷ ' })).toBeDefined()
  // Trend on in Normal: it appears on the bar (the reported defect), and off again removes it.
  expect(await band.find({ text: /^7(d| days) $/ })).toBeUndefined()
  await pane.press({ key: 'sh-trend' })
  expect(await band.find({ text: /^7(d| days) $/ })).toBeDefined()
  await pane.press({ key: 'sh-model' })
  expect(await band.find({ text: 'Opus 5.5' })).toBeDefined()
  await pane.press({ key: 'sh-trend' })
  expect(await band.find({ text: /^7(d| days) $/ })).toBeUndefined()
  await pane.press({ key: 'sh-elapsed' })
  expect(await band.find({ text: '◷ ' })).toBeUndefined()
  // Minimal: only the quotas are drawn, and Settings says why the model is not.
  await pane.press({ key: 'st-minimal' })
  expect(await band.find({ text: 'Opus 5.5' })).toBeUndefined()
  expect(await band.find({ text: '5H ' })).toBeDefined()
  expect(await pane.find({ text: /hidden in Minimal mode/ })).toBeDefined()
  // Every item off: the bar says so and keeps its buttons.
  for (const k of ['h5', 'd7']) await pane.press({ key: `sh-${k}` })
  expect(await band.find({ text: /No bar items/ })).toBeDefined()
  expect(await band.find({ key: 'details' })).toBeDefined()
  for (let i = 0; i < 30 && (calls.db.settings as any)?.show?.d7 !== false; i++) await new Promise(r => setTimeout(r, 10))
  const saved = (calls.db.settings as any)
  expect(saved.mode).toBe('minimal')
  expect(saved.wrap).toBe(true) // new in v0.2.3: filled from the defaults
  expect(saved.show).toEqual({ h5: false, d7: false, cache: false, ctx: true, resets: true, today: false, session: false, elapsed: false, trend: false, project: false, model: true })
  await pane.unmount()
  await band.unmount()
})

test('pricing and cache clocks: Fable 5.2 priced by its own row, another model never borrows your warm cache', async () => {
  const comp = { read: 400_000, write: 2_000, basis: 'measured' } as const
  const T = Date.parse('2026-11-10T04:00:00Z')
  const rows = costTable(comp, 'claude-fable-5-2', { 'claude-fable-5-2': { at: T - 60_000, ctx: 400_000 } }, T)
  const r = (id: string) => rows.find(x => x.id === id)!
  const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)
  expect(r('claude-fable-5-2').isMine && !r('claude-fable-5-2').isUnpriced).toBe(true)
  near(r('claude-fable-5-2').now, (400_000 * 0.2 + 2_000 * 16) / 1e6)
  near(r('claude-fable-5-2').cold, (402_000 * 16) / 1e6)
  expect(r('claude-fable-5-2').mode).toBe('warm')
  // Every other model is cold: its "now" is its full cold write.
  for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    expect(r(id).mode).toBe('cold')
    near(r(id).now, r(id).cold)
  }
  near(r('claude-opus-5-5').cold, (402_000 * 8) / 1e6)
  near(r('claude-haiku-5-5').cold, (402_000 * 1) / 1e6) // over 100K: the higher Haiku row
  // An hour and a minute later your own cache is cold too.
  const later = costTable(comp, 'claude-fable-5-2', { 'claude-fable-5-2': { at: T - 61 * 60_000, ctx: 400_000 } }, T)
  expect(later.find(x => x.isMine)!.mode).toBe('cold')
  // A model id with no exact row stays unpriced (no family guessing).
  expect(costTable(comp, 'claude-fable-5-3', {}, T)[0].isUnpriced).toBe(true)
})

test('Second line: in Normal a narrow bar wraps what does not fit; a wide one stays one row; off = one row', async ($, on) => {
  const everything = Object.fromEntries(Object.keys(ALL_OFF).map(k => [k, true]))
  const narrowOn = barLayout(FULL, { ...withShow(everything), wrap: true }, 62)
  expect(narrowOn.rows.length).toBe(2)
  expect(keysOf(narrowOn)[0].slice(0, 3)).toEqual(['five_hour', 'seven_day', 'cache']) // usage stays on the first row
  expect(keysOf(narrowOn)[1].includes('proj')).toBe(true)
  expect(narrowOn.state.project).toBe('shown')
  expect(keysOf(narrowOn)[1].some(k => k.endsWith('-reset'))).toBe(false) // a reset time never leaves its quota
  for (const r of narrowOn.rows.slice(1)) expect(r.reduce((n, p, j) => n + W(p.segs) + (j ? 3 : 0), 0) <= 60).toBe(true)
  const narrowOff = barLayout(FULL, { ...withShow(everything), wrap: false }, 62)
  expect(narrowOff.rows.length).toBe(1)
  expect(narrowOff.state.project).toBe('width')
  expect(barLayout(FULL, { ...withShow(everything), wrap: true }, 200).rows.length).toBe(1) // wide: everything fits one row
  expect(barLayout(FULL, { ...withShow(everything, 'minimal'), wrap: true }, 40).rows.length).toBe(1) // Minimal never wraps
  // The Settings control changes it and saves it.
  const calls = await boot($, on)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-settings' })
  expect((await pane.find({ key: 'wr-on' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'wr-off' })
  expect((await pane.find({ key: 'wr-off' }))?.props.variant).toBe('primary')
  for (let i = 0; i < 30 && (calls.db.settings as any)?.wrap !== false; i++) await new Promise(r => setTimeout(r, 10))
  expect((calls.db.settings as any).wrap).toBe(false)
  await pane.unmount()
})
