// 1.1.0: low-quota warning, logo states, Check for updates, weekly summary, CSV export.

import { expect, mock, test } from 'claude-code/testing'

import { emptyAgg, ingest, makeResolver, weekRange } from '../hooks/agg'
import { envelope } from '../hooks/core'
import { exportName, field, toCsv } from '../hooks/csv'
import { LOGO, LOGO_LOW, LOGO_WORKING, LOGO_WORKING_LOW, adaptiveLogo, logoFor } from '../hooks/fmt'
import { UPDATE_COMMANDS, compareVersions } from '../hooks/update'
import type { ClaimIo, Warned } from '../hooks/warn'
import { claim, due, forgetHandled, isLow, message, prune, windowId } from '../hooks/warn'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const WARN = { on: true, h5: 20, d7: 20, toast: true, notify: false, back: false }
const H5 = (used: number, resetsAt = '2026-11-11T12:30:00Z') => ({ kind: 'five_hour', percentUsed: used, resetsAt })
const D7 = (used: number, resetsAt = '2026-11-14T08:00:00Z') => ({ kind: 'seven_day', percentUsed: used, resetsAt })

// ---------------------------------------------------------------- warning logic

test('due: at or under the level, once per window; each window on its own', async () => {
  expect(due([H5(79), D7(10)], WARN, {}).length).toBe(0) // 21% and 90% left
  expect(due([H5(80)], WARN, {}).map(w => w.kind)).toEqual(['five_hour']) // exactly 20% left
  expect(due([H5(95), D7(85)], WARN, {}).map(w => w.kind)).toEqual(['five_hour', 'seven_day'])
  expect(due([H5(85)], { ...WARN, h5: 10 }, {}).length).toBe(0) // 15% left: above a 10% level
  expect(due([H5(91)], { ...WARN, h5: 10 }, {}).length).toBe(1)
  expect(due([H5(95)], { ...WARN, on: false }, {}).length).toBe(0)
  const warned: Warned = { [windowId(H5(95))]: { by: 'x', at: 1 } }
  expect(due([H5(95)], WARN, warned).length).toBe(0)
  // A reset time reported a few seconds off is the same window; a new reset hour is a new one.
  expect(windowId(H5(95, '2026-11-11T12:30:04Z'))).toBe(windowId(H5(95)))
  expect(due([H5(95, '2026-11-11T17:30:00Z')], WARN, warned).length).toBe(1)
})

test('prune drops windows that have reset; message says what is left and when it resets', async () => {
  const warned: Warned = { 'five_hour@2026-11-11T08': { by: 'a', at: 1 }, 'five_hour@2026-11-11T12': { by: 'a', at: 2 } }
  expect(Object.keys(prune(warned, NOW))).toEqual(['five_hour@2026-11-11T12'])
  expect(message(H5(85), NOW)).toBe('5-hour quota 15% left · resets in 2h 30m')
  expect(message(D7(82), NOW)).toBe('7-day quota 18% left · resets in 2d 22h')
  expect(isLow([H5(50), D7(81)], WARN)).toBe(true)
  expect(isLow([H5(50), D7(79)], WARN)).toBe(false)
})

const memIo = (file: Warned, opts: { onSleep?: (f: Warned) => void; failWrite?: boolean } = {}): ClaimIo & { file: Warned } => {
  const io = {
    file,
    read: async () => JSON.parse(JSON.stringify(io.file)),
    write: async (w: Warned) => { if (opts.failWrite) throw new Error('locked'); io.file = JSON.parse(JSON.stringify(w)) },
    sleep: async () => { opts.onSleep?.(io.file) },
    random: () => 0.5,
  }
  return io
}

test('claim: one session wins; a claim taken over during the wait loses; a failed write still warns once', async () => {
  forgetHandled()
  const io = memIo({})
  expect((await claim(io, 's1', NOW, [H5(90)], WARN)).length).toBe(1)
  expect(io.file[windowId(H5(90))].by).toBe('s1')
  // The same session never repeats, even with an empty file.
  expect((await claim(memIo({}), 's1', NOW, [H5(90)], WARN)).length).toBe(0)

  forgetHandled()
  const other = memIo({ [windowId(H5(90))]: { by: 's2', at: NOW } })
  expect((await claim(other, 's1', NOW, [H5(90)], WARN)).length).toBe(0) // already claimed elsewhere

  forgetHandled()
  const race = memIo({}, { onSleep: f => { f[windowId(H5(90))] = { by: 's2', at: NOW } } })
  // s2 wrote over our claim while we waited: s2 warns, we do not.
  race.sleep = async () => { race.file = { ...race.file, [windowId(H5(90))]: { by: 's2', at: NOW } } }
  expect((await claim(race, 's1', NOW, [H5(90)], WARN)).length).toBe(0)

  forgetHandled()
  expect((await claim(memIo({}, { failWrite: true }), 's1', NOW, [H5(90)], WARN)).length).toBe(1)
  forgetHandled()
})

// ---------------------------------------------------------------- warning in a session

const bootWarn = async ($: any, on: any, opts: { warned?: Warned; settings?: unknown; surface?: 'desktop' | 'terminal'; fetch?: { status: number; ok: boolean; text: string }; history?: boolean } = {}) => {
  forgetHandled()
  const files: Record<string, string> = {}
  if (opts.warned) files.warned = JSON.stringify(opts.warned)
  const calls = { toast: [] as string[], notify: [] as any[], cancel: [] as string[], fetch: [] as string[], copied: [] as string[], files }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, opts.settings ? { settings: opts.settings } : {})
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW - 3600e3, context: { window: 1_000_000, tokens: 1000, percent: 0 }, rateLimits: [H5(10), D7(10)] } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\t' : undefined }))
  const hist = opts.history ? envelope(agg(), 1) : ''
  on('fs.exists', (_: any, e: any) => ({ value: String(e.path).endsWith('warned.json') ? 'warned' in calls.files : !!hist && String(e.path).endsWith('cache-a.json') }))
  on('fs.read', (_: any, e: any) => ({ value: String(e.path).endsWith('warned.json') ? calls.files.warned : String(e.path).endsWith('plugin.json') ? '{"version":"1.1.0"}' : hist }))
  on('fs.write', (_: any, e: any) => { if (String(e.path).endsWith('warned.json')) calls.files.warned = e.text; return { value: undefined } })
  on('fs.stat', () => ({ value: { kind: 'file', size: hist.length || 2, mtimeMs: 1, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('ui.toast', (_: any, e: any) => { calls.toast.push(e.text); return { value: undefined } })
  on('ui.notify', (_: any, e: any) => { calls.notify.push(e); return { value: { isSent: true, channel: 'client' } } })
  on('ui.cancelNotify', (_: any, e: any) => { calls.cancel.push(e.key); return { value: { isSent: true } } })
  on('http.fetch', (_: any, e: any) => { calls.fetch.push(e.url); return { value: { headers: {}, ...(opts.fetch ?? { status: 200, ok: true, text: '{"version":"9.9.9"}' }) } } })
  on('ui.copy', (_: any, e: any) => { calls.copied.push(e.text); return { value: { isCopied: true } } })
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: opts.surface ?? 'desktop', isInteractive: true, cwd: 'F:\\W\\Atlas' })
  const measure = async (...rateLimits: unknown[]) => {
    await $.session.measure({ context: { window: 1_000_000, tokens: 1000, percent: 0 }, rateLimits, changed: ['rateLimits'] })
    await clock.advance(1500) // past the claim's wait
  }
  return { calls, clock, measure }
}

test('crossing the level: one pop-up, not repeated in the same window; 7D warns on its own; no notification when off', async ($, on) => {
  const { calls, measure } = await bootWarn($, on)
  await measure(H5(70), D7(10))
  expect(calls.toast.length).toBe(0)
  await measure(H5(85), D7(10))
  expect(calls.toast).toEqual(['Lucelis: 5-hour quota 15% left · resets in 2h 30m'])
  await measure(H5(90), D7(10))
  expect(calls.toast.length).toBe(1)
  await measure(H5(90), D7(85))
  expect(calls.toast.length).toBe(2)
  expect(calls.toast[1]).toContain('7-day quota 15% left')
  expect(calls.notify.length).toBe(0)
  expect(JSON.parse(calls.files.warned)[windowId(H5(90))].by).toBe('s1')
})

test('a window another session already warned about stays quiet here', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { warned: { [windowId(H5(90))]: { by: 's2', at: NOW } } })
  await measure(H5(90))
  expect(calls.toast.length).toBe(0)
})

test('Windows notification and "quota is back": booked at the reset time, taken back when the quota recovers', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: { warn: { ...WARN, notify: true, back: true } } })
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await measure(H5(85))
  expect(calls.notify.map(n => n.options?.key ?? n.key)).toEqual([`lucelis-low-${windowId(H5(85))}`, 'lucelis-back-five_hour'])
  const back = calls.notify[1]
  expect(back.options?.at ?? back.at).toBe(Date.parse('2026-11-11T12:30:00Z'))
  await measure(H5(5)) // recovered early (95% left)
  expect(calls.cancel).toEqual(['lucelis-back-five_hour'])
  await band.unmount()
})

test('warning off: nothing at all', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: { warn: { ...WARN, on: false } } })
  await measure(H5(99), D7(99))
  expect(calls.toast.length + calls.notify.length).toBe(0)
})

// ---------------------------------------------------------------- logo

test('logo states: still when idle, bars draw in while working, red glint while low; the L still follows the theme', async () => {
  expect(logoFor(false, false)).toBe(LOGO)
  expect(logoFor(true, false)).toBe(LOGO_WORKING)
  expect(logoFor(false, true)).toBe(LOGO_LOW)
  expect(logoFor(true, true)).toBe(LOGO_WORKING_LOW)
  expect(LOGO.includes('<animate')).toBe(false)
  expect(LOGO_LOW.includes('<animate')).toBe(false)
  expect(LOGO_WORKING.includes('stroke-dashoffset') && LOGO_WORKING.includes('pathLength="1"')).toBe(true)
  expect(LOGO_LOW.includes('#ef5d58') && !LOGO.includes('#ef5d58')).toBe(true)
  for (const s of [LOGO, LOGO_WORKING, LOGO_LOW, LOGO_WORKING_LOW]) expect(adaptiveLogo(s)).toContain('class="l"')
})

test('the bar draws the low-quota logo when a quota is under its level', async ($, on) => {
  const { measure } = await bootWarn($, on)
  await measure(H5(90), D7(10))
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 40, bodyColumns: 160, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  const glyph = JSON.stringify(await band.find({ key: 'glyph' }))
  expect(glyph).toContain('quota low')
  expect(glyph).toContain('working')
  await band.unmount()
})

// ---------------------------------------------------------------- updates

test('versions compare by number; a pre-release is below its release', async () => {
  expect(compareVersions('1.1.0', '1.0.2')).toBe(1)
  expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
  expect(compareVersions('1.0.2', '1.0.2')).toBe(0)
  expect(compareVersions('1.0.0-rc.2', '1.0.0')).toBe(-1)
  expect(compareVersions('v2.0.0', '1.9.9')).toBe(1)
  expect(UPDATE_COMMANDS).toBe('/plugin marketplace update lucelis\n/plugin update lucelis@lucelis')
})

const PANE = { plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { title: 'Lucelis', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const

test('no network at all until Check for updates is pressed; then one request, and a newer version offers the commands', async ($, on) => {
  const { calls, clock, measure } = await bootWarn($, on, { history: true })
  await measure(H5(10))
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await clock.advance(5 * 60_000) // timers: the minute redraw
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-settings' })
  expect(calls.fetch.length).toBe(0)
  await pane.press({ key: 'check' })
  await clock.settle()
  expect(calls.fetch).toEqual(['https://raw.githubusercontent.com/obiwong2579/Lucelis/main/.claude-plugin/plugin.json'])
  expect(await pane.find({ text: /Version 9\.9\.9 is available/ })).toBeDefined()
  await pane.press({ key: 'copy' })
  expect(calls.copied).toEqual([UPDATE_COMMANDS])
  expect(calls.fetch.length).toBe(1)
  await pane.unmount()
  await band.unmount()
})

test('a failed check says so and changes nothing', async ($, on) => {
  const { clock } = await bootWarn($, on, { fetch: { status: 404, ok: false, text: 'no' }, history: true })
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: 'check' })
  await clock.settle()
  expect(await pane.find({ text: /Could not check: GitHub answered 404/ })).toBeDefined()
  expect(await pane.find({ key: 'copy' })).toBeUndefined()
  await pane.unmount()
})

// ---------------------------------------------------------------- weekly summary and CSV

test('weeks run Monday to Sunday', async () => {
  expect(weekRange('2026-11-11')).toEqual({ from: '2026-11-09', to: '2026-11-15', prevFrom: '2026-11-02', prevTo: '2026-11-08', days: 3 }) // a Wednesday
  expect(weekRange('2026-11-09').days).toBe(1) // Monday
  expect(weekRange('2026-11-15')).toEqual({ from: '2026-11-09', to: '2026-11-15', prevFrom: '2026-11-02', prevTo: '2026-11-08', days: 7 }) // Sunday
})

const agg = () => {
  const a = emptyAgg()
  const t = { p: 'X\\s1.jsonl', o: 0, owner: 's1' }
  const at = (d: string) => Date.parse(`${d}T09:00:00Z`)
  ingest(a, [
    'N\t2026-11-11\t0',
    ['A', 's1', 'm1', at('2026-11-10'), '2026-11-10', 9, 'claude-opus-5-5', 10, 500, 20_000, 1_000, 'F:\\W\\Atlas, "North"', 0].join('\t'),
    ['A', 's1', 'm2', at('2026-11-10') + 1, '2026-11-10', 9, 'claude-opus-5-5', 5, 200, 0, 9_000, 'F:\\W\\Atlas, "North"', 0].join('\t'),
    ['A', 's2', 'm3', at('2026-11-03'), '2026-11-03', 9, 'claude-sonnet-5-5', 1, 100, 0, 0, 'F:\\W\\Beta', 0].join('\t'),
    `F\t${t.p}\t999\t1`,
  ].join('\n'), [t])
  return a
}

test('CSV: one row per day, project and model; quoted names; BOM and CRLF; no conversation text', async () => {
  const a = agg()
  const { text, rows } = toCsv(a, makeResolver(a, []), '2026-11-01', '2026-11-11')
  expect(rows).toBe(2)
  expect(text.startsWith('\uFEFFDate,Project,Model,')).toBe(true)
  const lines = text.slice(1).split('\r\n')
  expect(lines.length).toBe(4) // head, 2 rows, final empty
  expect(lines[1].startsWith('2026-11-03,Beta,claude-sonnet-5-5,')).toBe(true)
  expect(lines[2]).toContain('"Atlas, ""North"""')
  expect(field('plain')).toBe('plain')
  expect(field('a"b')).toBe('"a""b"')
  expect(toCsv(a, makeResolver(a, []), '2027-01-01', '2027-01-02').rows).toBe(0)
  expect(exportName('2026-11-11')).toBe('Lucelis-export-2026-11-11.csv')
})

test('Overview shows this week against the same days of last week', async ($, on) => {
  const text = envelope(agg(), 1)
  mock.clock(on, { now: NOW })
  mock.store(on, {})
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 0, percent: 0 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 's9' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', (_: any, e: any) => ({ value: String(e.path).endsWith('cache-a.json') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'F:\\W' })
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: 'THIS WEEK' })).toBeDefined()
  expect(await pane.find({ text: /against the same 3 days of last week/ })).toBeDefined()
  expect(await pane.find({ text: /^Tue 11-10$/ })).toBeDefined()
  await pane.unmount()
})
