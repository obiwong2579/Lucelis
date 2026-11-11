// 1.1.0 extras: what's new after an update, "last seen" figures, the tight bar, the format guard.

import { expect, mock, test } from 'claude-code/testing'

import { FORMAT_NOTE, emptyAgg, formatSuspect, ingest } from '../hooks/agg'
import type { Part } from '../hooks/bar'
import { barLayout, compactParts } from '../hooks/bar'
import { envelope } from '../hooks/core'
import { GOOD, MUTED, RED } from '../hooks/fmt'
import type { View } from '../hooks/model'
import { whatsNew } from '../hooks/update'
import { FORMAT_CHANGE } from './fixtures/format-change'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const H5 = (used: number, resetsAt = '2026-11-11T12:30:00Z') => ({ kind: 'five_hour', percentUsed: used, resetsAt })
const D7 = (used: number, resetsAt = '2026-11-14T08:00:00Z') => ({ kind: 'seven_day', percentUsed: used, resetsAt })

const CHANGELOG = '# Changelog\n\n## 1.1.0 — 2026-11-11\n\n- **Low-quota warning.** Text.\n- **Logo states.** Text.\n- **This week** on the Overview tab.\n\n## 1.0.2 — 2026-11-10\n\n- **Old.** Text.\n'

type Opts = { store?: Record<string, unknown>; rateLimits?: unknown[]; version?: string; history?: boolean; agg?: ReturnType<typeof emptyAgg> }

const histAgg = () => {
  const a = emptyAgg()
  a.today = '2026-11-11'; a.tz = 0; a.built = NOW
  a.sess.s1 = { first: NOW - 3600e3, last: NOW, act: 0, lastTs: NOW, resp: 3, side: 0, prompts: 1, in: 1, out: 1, cw: 1, cr: 1, comp: 0, lastComp: 0, model: 'claude-opus-5-5', cur: 0, lu: [0, 0, 0, 0], ring: [], cwd: 'F:\\W\\Atlas', root: 'F:\\W\\Atlas' }
  a.rows['s1\t2026-11-11\tF:\\W\\Atlas\tclaude-opus-5-5'] = [3000, 1000, 1000, 1000, 0, 3, 0]
  return a
}

const boot = async ($: any, on: any, o: Opts = {}) => {
  const db: Record<string, unknown> = { ...(o.store ?? {}) }
  const calls = { toast: [] as string[], notify: [] as any[], copied: [] as string[], db }
  const clock = mock.clock(on, { now: NOW })
  on('store.get', (_: any, e: any) => ({ value: db[e.key] }))
  on('store.set', (_: any, e: any) => { db[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW - 60e3, context: { window: 1_000_000, tokens: 0, percent: 0 }, rateLimits: o.rateLimits ?? [] } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', () => ({ value: undefined }))
  const hist = o.history || o.agg ? envelope(o.agg ?? histAgg(), 1) : ''
  on('fs.exists', (_: any, e: any) => ({ value: !!hist && String(e.path).endsWith('cache-a.json') }))
  on('fs.read', (_: any, e: any) => {
    const p = String(e.path)
    return { value: p.endsWith('plugin.json') ? JSON.stringify({ version: o.version ?? '1.1.0' }) : p.endsWith('CHANGELOG.md') ? CHANGELOG : hist }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: hist.length || 2, mtimeMs: 1, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'N\t2026-11-11\t0\n', stderr: '', isStdoutTruncated: false } }))
  on('ui.toast', (_: any, e: any) => { calls.toast.push(e.text); return { value: undefined } })
  on('ui.notify', (_: any, e: any) => { calls.notify.push(e); return { value: { isSent: true, channel: 'client' } } })
  on('ui.copy', (_: any, e: any) => { calls.copied.push(e.text); return { value: { isCopied: true } } })
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'F:\\W\\Atlas' })
  await clock.advance(10)
  const measure = async (...rateLimits: unknown[]) => {
    await $.session.measure({ context: { window: 1_000_000, tokens: 1000, percent: 0 }, rateLimits, changed: ['rateLimits'] })
    await clock.advance(1500)
  }
  return { calls, clock, measure }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 160, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const bandText = async ($: any) => {
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const s = JSON.stringify(await band.find({ key: 'bar' }) ?? await band.find({}))
  await band.unmount()
  return s
}

// ---------------------------------------------------------------- what's new

test("what's new: the summary is the version's bold leads, cut to fit", async () => {
  expect(whatsNew(CHANGELOG, '1.1.0')).toBe('Low-quota warning, Logo states, This week')
  expect(whatsNew(CHANGELOG, '1.0.2')).toBe('Old')
  expect(whatsNew(CHANGELOG, '2.0.0')).toBe('')
  expect(whatsNew(CHANGELOG, '1.1.0', 30).endsWith('…')).toBe(true)
  expect(whatsNew(CHANGELOG, '1.1.0', 30).length <= 30).toBe(true)
})

test("what's new: first install is silent; an update shows one quiet line on Overview, never a pop-up", async ($, on) => {
  // First install: nothing recorded yet -> record the version, show nothing.
  const first = await boot($, on, { history: true })
  expect(first.calls.db.seenVersion).toBe('1.1.0')
  let pane = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { bodyColumns: 100 } })
  expect(await pane.find({ key: 'news' })).toBe(undefined)
  await pane.unmount()
  expect(first.calls.toast.length + first.calls.notify.length).toBe(0)
})

test("what's new: after an update, Full notes copies the link and Dismiss hides the line", async ($, on) => {
  const b = await boot($, on, { history: true, store: { seenVersion: '1.0.2' } })
  expect(b.calls.db.seenVersion).toBe('1.1.0') // recorded at once: the next session shows nothing
  const pane = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { bodyColumns: 100 } })
  // In About Lucelis at the bottom of Overview, not at the top.
  expect(JSON.stringify(await pane.find({ key: 'news-b' }))).toContain('New in 1.1.0')
  const line = JSON.stringify(await pane.find({ key: 'news' }))
  expect(line).toContain('Low-quota warning, Logo states, This week.')
  await pane.press({ key: 'news-notes' })
  expect(b.calls.copied).toEqual(['https://github.com/obiwong2579/Lucelis/blob/main/CHANGELOG.md'])
  expect(JSON.stringify(await pane.find({ key: 'news' }))).toContain('Link copied')
  await pane.press({ key: 'news-x' })
  expect(await pane.find({ key: 'news' })).toBe(undefined)
  expect(b.calls.toast.length + b.calls.notify.length).toBe(0)
  await pane.unmount()
})

// ---------------------------------------------------------------- last seen

test('last seen: a new session shows the kept figures dimmed and marked, never warns from them, and drops them for live ones', async ($, on) => {
  const b = await boot($, on, { store: { lastSeen: [H5(80), D7(40)] } })
  let s = await bandText($)
  expect(s).toContain('last seen')
  expect(s).toContain('20%')
  expect(s).not.toContain(RED) // 20% left is under the level, but a kept figure is never coloured
  expect(s).not.toContain('quota low')
  expect(b.calls.toast.length).toBe(0)
  await b.measure(H5(50), D7(40))
  s = await bandText($)
  expect(s).not.toContain('last seen')
  expect(s).toContain('50%')
})

test('last seen: once the kept window has reset, nothing is shown', async ($, on) => {
  await boot($, on, { store: { lastSeen: [H5(80, '2026-11-11T09:00:00Z')] } })
  const s = await bandText($)
  expect(s).not.toContain('last seen')
  expect(s).toContain('waiting for the first reply')
})

test('last seen: kept only when a whole-number figure or a window changes', async ($, on) => {
  const b = await boot($, on)
  const orig = b.calls.db
  await b.measure(H5(50.2), D7(40))
  expect((orig.lastSeen as any[]).map(w => w.kind)).toEqual(['five_hour', 'seven_day'])
  const first = JSON.stringify(orig.lastSeen)
  await b.measure(H5(50.4), D7(40)) // still 50% left: not written again
  expect(JSON.stringify(orig.lastSeen)).toBe(first)
  await b.measure(H5(52), D7(40))
  expect(JSON.stringify(orig.lastSeen)).not.toBe(first)
})

// ---------------------------------------------------------------- tight bar

const VIEW = {
  quotas: [{ kind: 'five_hour', left: 76, resetIn: 2 * 3600e3 }, { kind: 'seven_day', left: 22, resetIn: 3 * 86400e3 }],
  cache: { mode: 'warm', idleMs: 60_000, minsLeft: 4, resend: 1, cached: 1, reusable: 1, lastTurnHit: 1, sessionHit: 1 },
  ctx: { percent: 41, tokens: 410_000, window: 1_000_000, left: 590_000, isNearLimit: false },
  session: { project: { key: 'p', name: 'Workspace', source: 'root' }, model: 'claude-opus-5-5', elapsedMs: 3600e3, tokens: 100_000 },
} as unknown as View
const ST = { mode: 'normal', wrap: false, logo: true, show: { h5: true, d7: true, cache: true, ctx: true, resets: true, today: false, session: true, elapsed: false, trend: false, project: true, model: false }, warn: { h5: 30, d7: 30, toast: false, notify: false, back: false } } as any
const text = (L: ReturnType<typeof barLayout>) => L.rows[0].map((p, i) => (i && !p.after ? (L.tier ? ' ' : ' │ ') : '') + p.segs.map(s => s[0]).join('')).join('')
const colourOf = (L: ReturnType<typeof barLayout>, key: string) => L.rows[0].find(p => p.key === key)?.segs[1][1]

test('tight bar: shorter forms before anything is dropped; 5H and 7D never drop; colours unchanged', async () => {
  const seen = new Map<number, string>()
  let last = 0
  for (let cols = 140; cols >= 20; cols--) {
    const L = barLayout(VIEW, ST, cols)
    // Only ever tighter as the window narrows, within each button size (below 56 columns the
    // More / Details buttons become glyphs and give room back).
    if (cols === 55) last = 0
    expect(L.tier >= last).toBe(true)
    last = L.tier
    const keys = L.rows[0].map(p => p.key)
    expect(keys.includes('five_hour') && keys.includes('seven_day')).toBe(true)
    // Usage items are kept until the one-letter row: nothing is dropped while a tighter form is left.
    if (L.tier < 2) expect(['cache', 'ctx'].every(k => keys.includes(k))).toBe(true)
    expect(colourOf(L, 'five_hour')).toBe(GOOD)
    expect(colourOf(L, 'seven_day')).toBe(RED) // 22% left, at or under 30
    if (!seen.has(L.tier)) seen.set(L.tier, text(L))
  }
  expect(seen.get(0)).toContain('5H 76% · 2h00m │ 7D 22%')
  expect(seen.get(1)).toContain('5H 76 7D 22 WARM CTX 41')
  expect(seen.get(2)).toContain('5H 76 7D 22 W C 41')
})

test('tight bar: a wide window is unchanged, and reset times stay in More when tight', async () => {
  const wide = barLayout(VIEW, ST, 160)
  expect(wide.tier).toBe(0)
  expect(text(wide)).toContain('│')
  const tight = barLayout(VIEW, ST, 40)
  expect(tight.tier > 0).toBe(true)
  expect(tight.state.resets).toBe('width')
  expect(tight.state.h5).toBe('shown')
})

test('tight bar: a "last seen" figure keeps its mark when tight', async () => {
  const v = { ...VIEW, quotas: VIEW.quotas.map(q => ({ ...q, stale: true })) } as unknown as View
  const parts: Part[] = compactParts(v, ST)
  expect(parts.find(p => p.key === 'five_hour')!.forms[0][1][1]).toBe(MUTED)
  const L = barLayout(v, ST, 40)
  expect(text(L)).toContain('(last)')
})

// ---------------------------------------------------------------- format guard

test('format guard: the real extractor reports changed-format replies; the pane says so plainly', async () => {
  const a = emptyAgg()
  ingest(a, FORMAT_CHANGE.out, FORMAT_CHANGE.files.map(f => ({ ...f })))
  expect(a.sess.S1.resp).toBe(FORMAT_CHANGE.expect.responses)
  expect(a.shape).toBe(FORMAT_CHANGE.expect.shape)
  expect(a.parseErrors).toBe(0)
  expect(formatSuspect(a)).toBe(true)
  // A few odd records among many good ones is not a format change.
  const ok = histAgg(); ok.shape = 9
  expect(formatSuspect(ok)).toBe(false)
  ok.shape = 12; ok.sess.s1.resp = 1000
  expect(formatSuspect(ok)).toBe(false)
})

test('format guard: a note in the pane footer, not a pop-up', async ($, on) => {
  const a = histAgg(); a.shape = 40
  const b = await boot($, on, { agg: a })
  const pane = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { bodyColumns: 100 } })
  expect(JSON.stringify(await pane.find({ key: 'format' }))).toContain(FORMAT_NOTE)
  await pane.press({ key: 'tab-models' })
  expect(JSON.stringify(await pane.find({ key: 'format' }))).toContain(FORMAT_NOTE)
  expect(b.calls.toast.length + b.calls.notify.length).toBe(0)
  await pane.unmount()
})

// ---------------------------------------------------------------- pane layout (1.1.0)

test('Settings: groups in order, each warning is one choice per quota, updates live in About Lucelis', async ($, on) => {
  const b = await boot($, on, { history: true })
  const pane = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { bodyColumns: 100 } })
  // Overview: the period choice sits under the OVERVIEW heading; About Lucelis comes last.
  const ov = JSON.stringify(await pane.find({ key: 'h-ov' }))
  expect(ov).toContain('p-7d')
  expect(await pane.find({ key: 'h-ab' })).toBeDefined()
  expect(await pane.find({ key: 'check' })).toBeDefined()
  expect(JSON.stringify(await pane.find({ key: 'ab-p' }))).not.toContain('obiwong2579')
  await pane.press({ key: 'tab-settings' })
  const all = JSON.stringify(await pane.find({}))
  const order = ['APPEARANCE', 'COMPACT BAR ITEMS', 'LOW-QUOTA WARNING', 'DASHBOARD', 'PROJECT NAMES', 'HISTORY DATA'].map(t => all.indexOf(t))
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((x, y) => x - y)).toEqual(order)
  expect(await pane.find({ key: 'check' })).toBe(undefined) // not in Settings any more
  // How to be told: pop-up and Windows notification, both off by default; Quota is back only with notifications on.
  expect((await pane.find({ key: 'wt-off' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'wf-off' }))?.props.variant).toBe('primary')
  expect(await pane.find({ key: 'wb-on' })).toBe(undefined)
  expect(all.indexOf('How to tell you') > all.indexOf('LOW-QUOTA WARNING') && all.indexOf('How to tell you') < all.indexOf('DASHBOARD')).toBe(true)
  expect(all.includes('obiwong2579')).toBe(false)
  // 5H off: the choice is saved as 0, and the other quota keeps its level.
  await pane.press({ key: 'wn-h5-0' })
  for (let i = 0; i < 30 && (b.calls.db.settings as any)?.warn?.h5 !== 0; i++) await new Promise(r => setTimeout(r, 10))
  expect((b.calls.db.settings as any).warn).toEqual({ h5: 0, d7: 30, toast: false, notify: false, back: false })
  await pane.press({ key: 'wf-on' })
  expect(await pane.find({ key: 'wb-on' })).toBeDefined()
  expect((await pane.find({ key: 'wn-h5-0' }))?.props.variant).toBe('primary')
  // Detected projects are folded away until asked for.
  expect(await pane.find({ key: 'dp-F:\\W\\Atlas' })).toBe(undefined)
  await pane.press({ key: 'dp-toggle' })
  expect(JSON.stringify(await pane.find({}))).toContain('named from:')
  await pane.unmount()
})
