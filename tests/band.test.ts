import { expect, mock, test } from 'claude-code/testing'
import { BG, GOOD, LOGO, LOGO_ON_LIGHT, LOGO_WORKING, RED, YELLOW, adaptiveLogo, health } from '../hooks/fmt'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 64, resetsAt: '2099-01-01T01:16:00Z' },
  { kind: 'seven_day', percentUsed: 68, resetsAt: '2099-01-05T20:00:00Z' },
]
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 160, scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

/** A test that stands in for session.cwd starts in a placeholder folder, as the desktop app can. */
const startCwd = (extra: unknown) => (extra && String(extra).includes('session.cwd') ? 'C:\\Temp\\spare-3AbCdE' : 'F:\\Work\\Project Atlas')
const boot = async ($: any, on: any, store: Record<string, unknown> = {}, extra?: (on: any) => void) => {
  mock.store(on, store)
  mock.clock(on, { now: NOW })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 680_000, percent: 68 }, rateLimits: WINDOWS } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  // No history on this machine: the extractor is never reached, the cache file is absent.
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 2, mtimeMs: 1, isLink: false } }))
  on('classic.SessionStart', () => ({}))
  extra?.(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: startCwd(extra) })
}

test('quota matches the engine reading on every surface, with no history', async ($, on) => {
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'lucelis', surface, component: 'AbovePrompt', props: PROPS })
    expect(await band.find({ text: '36%' })).toBeDefined() // 5H: 100 - 64
    expect(await band.find({ text: '32%' })).toBeDefined() // 7D: 100 - 68
    expect(await band.find({ text: / · (resets )?3h16m$/ })).toBeDefined()
    expect(await band.find({ text: / · (resets )?4d22h$/ })).toBeDefined()
    expect(await band.find({ text: '68%' })).toBeDefined() // CTX from the engine
    expect(await band.find({ text: 'ATLAS' })).toBeDefined() // from the session's folder, no history needed
    const all = JSON.stringify(await band.find({ type: 'Box' }))
    expect(all.indexOf('5H')).toBeLessThan(all.indexOf('7D'))
    await band.unmount()
  }
})

test('a narrow band keeps 5H and 7D and drops lower priorities first', async ($, on) => {
  await boot($, on, { settings: { wrap: false } })
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 60 } })
  expect(await band.find({ text: '36%' })).toBeDefined()
  expect(await band.find({ text: '32%' })).toBeDefined()
  expect(await band.find({ text: 'ATLAS' })).toBeUndefined()
  await band.unmount()
})

test('warm cache after a resume: More shows a short snapshot with the next-message cost of your model', async ($, on) => {
  await boot($, on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 100_000, model: 'claude-opus-5-5' })
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'WARM' })).toBeDefined()
  expect(await band.find({ text: ' left' })).toBeUndefined() // v0.2.3: no "left" word; the figure is what is left
  await band.press({ key: 'more' })
  expect(await band.find({ text: 'NEXT MESSAGE' })).toBeDefined()
  // No request on record yet: all 100K assumed a cache hit. Opus 5.5 warm read $0.20/M = $0.02; cold 1h write $8/M = $0.80.
  expect(await band.find({ text: '~$0.02' })).toBeDefined()
  expect(await band.find({ text: '~$0.80' })).toBeDefined()
  expect(await band.find({ text: /not your bill/ })).toBeDefined()
  // Level 2 never repeats the quota row; the other models get one line, the full table is in the pane.
  expect((await band.findAll({ type: 'Text' })).filter((t: any) => t.text === '36%').length).toBe(1)
  expect(await band.find({ text: 'IF SWITCHED' })).toBeDefined()
  expect(await band.find({ text: 'Sonnet 5.5 ' })).toBeDefined()
  expect(await band.find({ key: 'open-compare' })).toBeDefined()
  expect(await band.find({ key: 'open-session' })).toBeDefined()
  expect(await band.find({ key: 'open-dashboard' })).toBeDefined()
  await band.press({ key: 'more' })
  expect(await band.find({ text: 'NEXT MESSAGE' })).toBeUndefined()
  await band.unmount()
})

test('turned off in settings, the band leaves the slot to the engine', async ($, on) => {
  // The engine's own drawing of the slot is stood in for beneath the plugin.
  await boot($, on, { settings: { isOn: false } }, o => o('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return h(Text, null, 'engine') }))
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: '36%' })).toBeUndefined()
  expect(await band.find({ text: 'engine' })).toBeDefined()
  await band.unmount()
})

test('the project follows the folder the session runs in now, not the placeholder it started in', async ($, on) => {
  // The desktop app can start a session in a "spare-..." folder and re-point it afterwards.
  await boot($, on, {}, o => o('session.cwd', () => ({ value: 'F:\\Work\\Project Atlas' })))
  expect(startCwd((o: any) => o('session.cwd'))).toBe('C:\\Temp\\spare-3AbCdE')
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: 'ATLAS' })).toBeDefined()
  await band.unmount()
})

test('percentages are coloured by what is left: green from 70, yellow from 30, red below', async ($, on) => {
  await boot($, on)
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await band.find({ text: '36%' }))).toContain(YELLOW) // 5H 36% left: yellow
  expect(JSON.stringify(await band.find({ text: '68%' }))).toContain(YELLOW) // CTX 68% used = 32% left: yellow
  await band.unmount()
  expect([100, 70, 69.9, 30, 29.9, 0].map(health)).toEqual([GOOD, GOOD, YELLOW, YELLOW, RED, RED])
})

test('the bar background is a setting: off by default (no fill), on fills the bar', async ($, on) => {
  await boot($, on)
  const off = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await off.find({ type: 'Box' }))).not.toContain(BG)
  await off.unmount()
})

test('with the bar background on, the bar is filled', async ($, on) => {
  await boot($, on, { settings: { bg: true } })
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await band.find({ type: 'Box' }))).toContain(BG)
  await band.unmount()
})

test('with no bar background the L of the mark follows the app theme; with one it stays ivory', async () => {
  for (const src of [LOGO, LOGO_WORKING]) {
    const a = adaptiveLogo(src)
    expect(a).toContain(`@media (prefers-color-scheme: light){.l{stroke:${LOGO_ON_LIGHT}}}`)
    expect(a).toContain('class="l" stroke="#F5EFE4"') // ivory stays as the dark-theme colour and the fallback
    expect(a.startsWith('<svg') && a.endsWith('</svg>')).toBe(true)
    expect(src).not.toContain('prefers-color-scheme')
  }
})
