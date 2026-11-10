// Hook safety: classic.SessionStart and ui.close pass the event on exactly once, a failure
// in Lucelis' own work never reaches the caller, and a failure beneath is never swallowed
// or retried.
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 64, resetsAt: '2099-01-01T01:16:00Z' },
  { kind: 'seven_day', percentUsed: 68, resetsAt: '2099-01-05T20:00:00Z' },
]
const RESUME = { source: 'resume', seconds_since_last_response: 60, context_tokens: 100_000 } as const

type Beneath = { start?: () => unknown; close?: () => unknown; brokenModel?: () => boolean }

/** Boots the plugin over stand-ins. `calls` counts how often the hooks beneath Lucelis ran. */
const boot = async ($: any, on: any, beneath: Beneath = {}) => {
  const calls = { start: 0, close: 0, model: 0 }
  mock.store(on, {})
  mock.clock(on, { now: NOW })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 680_000, percent: 68 }, rateLimits: WINDOWS } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => {
    calls.model++
    if (beneath.brokenModel?.()) throw new Error('model lookup failed')
    return { value: 'claude-opus-5-5' }
  })
  on('session.repo', () => ({ value: null }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 2, mtimeMs: 1, isLink: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('classic.SessionStart', () => { calls.start++; return beneath.start ? beneath.start() : {} })
  on('ui.close', () => { calls.close++; return beneath.close ? beneath.close() : { value: undefined } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'F:\\Work\\Project Atlas' })
  return calls
}

/** Runs a call that is expected to fail; resolves to the failure's text, or null if it did not fail. */
const failure = async (run: () => Promise<unknown>): Promise<string | null> => {
  try { await run() } catch (err) { return String((err as any)?.message ?? err) }
  return null
}

// ---------------------------------------------------------------- classic.SessionStart

test('SessionStart, normal: the hooks beneath run once and their answer is passed up unchanged', async ($, on) => {
  const answer = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'from beneath' } }
  const calls = await boot($, on, { start: () => answer })
  for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
    const before = calls.start
    const r = await $.classic.SessionStart({ ...RESUME, source })
    expect(calls.start - before).toBe(1)
    expect(r).toEqual(answer)
  }
})

test('SessionStart, Lucelis-owned failure: the session still starts, beneath ran once, its answer stands', async ($, on) => {
  let broken = false
  const answer = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'from beneath' } }
  const calls = await boot($, on, { start: () => answer, brokenModel: () => broken })
  broken = true
  const modelBefore = calls.model
  // A resume with no model in the event makes Lucelis ask for the model, which fails here.
  const r = await $.classic.SessionStart({ ...RESUME })
  expect(calls.model - modelBefore).toBe(1) // Lucelis' own work did run and did fail
  expect(calls.start).toBe(1)
  expect(r).toEqual(answer)
})

test('SessionStart, a hook beneath throws: it ran exactly once and the failure is not swallowed', async ($, on) => {
  const calls = await boot($, on, { start: () => { throw new Error('beneath-start-threw') } })
  const msg = await failure(() => $.classic.SessionStart({ ...RESUME }))
  expect(calls.start).toBe(1)
  expect(msg).not.toBe(null) // the caller sees a failure, not a made-up answer
})

test('SessionStart, a hook beneath rejects: it ran exactly once and the rejection is not swallowed', async ($, on) => {
  const calls = await boot($, on, { start: () => Promise.reject(new Error('beneath-start-rejected')) })
  const msg = await failure(() => $.classic.SessionStart({ ...RESUME, source: 'clear' }))
  expect(calls.start).toBe(1)
  expect(msg).not.toBe(null)
})

// ---------------------------------------------------------------- ui.close

/**
 * A second plugin that closes a pane the way any plugin or the host does, and reports what
 * came back. A Notification event carries the pane id in and the outcome out to the test.
 */
const PROBE = {
  name: 'probe',
  register(on: any) {
    on('classic.Notification', async ($: any, e: any, next: any) => {
      if (!String(e.message).startsWith('close:')) return next(e)
      let outcome = 'closed'
      try { await $.ui.close({ id: String(e.message).slice(6) }) } catch (err) { outcome = 'failed: ' + String((err as any)?.message ?? err) }
      return next({ ...e, message: outcome })
    })
  },
}
const closeVia = async ($: any, seen: string[], id: string): Promise<string> => {
  seen.length = 0
  await $.classic.Notification({ message: 'close:' + id, notification_type: 'probe' })
  return seen[0] ?? ''
}

test('ui.close, normal: the hooks beneath run once, for the Lucelis pane and for any other', { plugins: [PROBE] }, async ($, on) => {
  const seen: string[] = []
  on('classic.Notification', (_: any, e: any) => { seen.push(e.message); return {} })
  const calls = await boot($, on)
  expect(await closeVia($, seen, 'lucelis')).toBe('closed')
  expect(calls.close).toBe(1)
  expect(await closeVia($, seen, 'someone-elses-pane')).toBe('closed')
  expect(calls.close).toBe(2)
})

test('ui.close, a hook beneath throws: it ran exactly once and the failure is not swallowed', { plugins: [PROBE] }, async ($, on) => {
  const seen: string[] = []
  on('classic.Notification', (_: any, e: any) => { seen.push(e.message); return {} })
  const calls = await boot($, on, { close: () => { throw new Error('beneath-close-threw') } })
  const outcome = await closeVia($, seen, 'lucelis')
  expect(calls.close).toBe(1)
  expect(outcome.startsWith('failed: ')).toBe(true)
})

test('ui.close, a hook beneath rejects: it ran exactly once and the rejection is not swallowed', { plugins: [PROBE] }, async ($, on) => {
  const seen: string[] = []
  on('classic.Notification', (_: any, e: any) => { seen.push(e.message); return {} })
  const calls = await boot($, on, { close: () => Promise.reject(new Error('beneath-close-rejected')) })
  const outcome = await closeVia($, seen, 'someone-elses-pane')
  expect(calls.close).toBe(1)
  expect(outcome.startsWith('failed: ')).toBe(true)
})
