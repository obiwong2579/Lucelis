import { expect, mock, test } from 'claude-code/testing'

import { emptyAgg, ingest } from '../hooks/agg'
import { envelope } from '../hooks/core'

// A synthetic history: two projects over three days, one compaction, one subagent response.
const NOW = Date.parse('2026-11-09T12:00:00Z')
const day = (d: string, h: number) => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00Z`)
const A = (sid: string, id: string, d: string, h: number, inp: number, out: number, cw: number, cr: number, cwd: string, side = 0, model = 'claude-opus-5-5') =>
  ['A', sid, id, day(d, h), d, h, model, inp, out, cw, cr, cwd, side].join('\t')
const P = (sid: string, id: string, d: string, h: number, cwd: string) => ['P', sid, id, day(d, h), d, h, cwd].join('\t')

const cacheText = () => {
  const a = emptyAgg()
  const s1 = { p: 'X\\s1.jsonl', o: 0, owner: 's1' }
  const s2 = { p: 'X\\s2.jsonl', o: 0, owner: 's2' }
  ingest(a, [
    'N\t2026-11-09\t0',
    P('s1', 'p1', '2026-11-07', 9, 'F:\\W'),
    A('s1', 'm1', '2026-11-07', 9, 10, 500, 20_000, 0, 'F:\\W\\Project Atlas'),
    P('s1', 'p2', '2026-11-08', 10, 'F:\\W\\Project Atlas'),
    A('s1', 'm2', '2026-11-08', 10, 5, 800, 3_000, 20_000, 'F:\\W\\Project Atlas'),
    A('s1', 'm3', '2026-11-08', 10, 5, 300, 0, 20_000, 'F:\\W\\Project Atlas', 1, 'claude-haiku-5-5'),
    ['C', 's1', 'c1', day('2026-11-08', 11)].join('\t'),
    `F\t${s1.p}\t999\t1`,
    P('s2', 'p3', '2026-11-09', 11, 'F:\\W'),
    A('s2', 'm4', '2026-11-09', 11, 7, 900, 15_000, 4_000, 'F:\\W\\Project Borealis', 0, 'claude-sonnet-5-5'),
    'T\ts2\tSpec work',
    `F\t${s2.p}\t999\t1`,
  ].join('\n'), [s1, s2])
  return envelope(a, 1)
}

const PANE = (surface: 'terminal' | 'desktop') => ({
  plugin: 'lucelis',
  surface,
  component: 'Pane',
  requestId: 'lucelis',
  props: { title: 'Lucelis', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

test('every pane tab draws from a cached history on desktop and terminal', async ($, on) => {
  const text = cacheText()
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 40_000, percent: 20 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 's2' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\t' : undefined }))
  on('fs.exists', (_: any, e: any) => ({ value: String(e.path).endsWith('cache-a.json') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'F:\\W' })

  for (const surface of ['desktop', 'terminal'] as const) {
    for (const cols of [40, 110]) {
      const ui = await $.ui.mount({ ...PANE(surface), props: { ...PANE(surface).props, bodyColumns: cols } })
      const variant = async (k: string) => (await ui.find({ key: k }))?.props.variant
      // Six tabs, each a real button; the selected one is drawn as primary.
      for (const t of ['overview', 'session', 'projects', 'models', 'patterns', 'settings']) expect(await ui.find({ key: `tab-${t}` })).toBeDefined()
      expect(await variant('tab-overview')).toBe('primary')
      expect(await variant('tab-models')).toBe('secondary')
      expect(await ui.find({ text: /OVERVIEW/ })).toBeDefined()
      expect(await ui.find({ text: 'DAILY ACTIVITY' })).toBeDefined()
      expect(await variant('p-30d')).toBe('primary') // default period
      await ui.press({ key: 'p-7d' })
      expect(await variant('p-7d')).toBe('primary')
      expect(await variant('p-30d')).toBe('secondary')
      await ui.press({ key: 'p-30d' })
      // Session tab: the live session, context health, no period row.
      await ui.press({ key: 'tab-session' })
      expect(await variant('tab-session')).toBe('primary')
      expect(await ui.find({ text: 'THIS SESSION' })).toBeDefined()
      expect(await ui.find({ text: 'CONTEXT HEALTH' })).toBeDefined()
      expect(await ui.find({ key: 'p-30d' })).toBeUndefined()
      // Projects (a table when wide, two-line rows when narrow), then a drill-down.
      await ui.press({ key: 'tab-projects' })
      const ATLAS = String.raw`open-f:\w\project atlas`
      expect(await ui.find({ key: ATLAS })).toBeDefined()
      expect(await ui.find({ key: String.raw`open-f:\w\project borealis` })).toBeDefined()
      expect(!!(await ui.find({ key: 'ph0' }))).toBe(cols >= 70)
      await ui.press({ key: ATLAS })
      expect(await ui.find({ key: 'back' })).toBeDefined()
      expect(await ui.find({ text: 'RECENT SESSIONS' })).toBeDefined()
      await ui.press({ key: 'back' })
      // Models, patterns, settings.
      await ui.press({ key: 'tab-models' })
      expect(await ui.find({ text: 'Opus 5.5' })).toBeDefined()
      expect(await ui.find({ text: 'CACHE USE BY MODEL' })).toBeDefined()
      await ui.press({ key: 'tab-patterns' })
      expect(await ui.find({ text: 'ACTIVITY HEATMAP' })).toBeDefined()
      expect(await ui.find({ text: /TIME PATTERNS/ })).toBeDefined()
      expect(await ui.find({ text: 'SESSION PATTERNS' })).toBeDefined()
      await ui.press({ key: 'tab-settings' })
      expect(await ui.find({ key: 'rebuild' })).toBeDefined()
      expect(await ui.find({ text: 'PROJECT NAMES' })).toBeDefined()
      expect(await variant('st-normal')).toBe('primary')
      // Terms help explains the token metrics and the inferred cache clock.
      await ui.press({ key: 'help' })
      expect(await ui.find({ text: /Activity tokens = uncached input/ })).toBeDefined()
      expect(await ui.find({ text: /inferred from request timing/ })).toBeDefined()
      await ui.press({ key: 'help' })
      await ui.press({ key: 'tab-overview' })
      await ui.unmount()
    }
  }
})

test('with no history, the pane says so instead of showing zeros', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 's9' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 2, mtimeMs: 1, isLink: false } }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'F:\\W' })
  const ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ text: /No history yet/ })).toBeDefined()
  await ui.unmount()
})
