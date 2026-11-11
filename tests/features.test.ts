// 1.1.0: low-quota warning, logo states, Check for updates, weekly summary, CSV export.

import { expect, mock, test } from 'claude-code/testing'

import { emptyAgg, ingest, makeResolver, weekRange } from '../hooks/agg'
import { envelope } from '../hooks/core'
import { exportName, field, toCsv } from '../hooks/csv'
import { compactParts } from '../hooks/bar'
import { GOOD, LOGO, LOGO_LOW, LOGO_WORKING, LOGO_WORKING_LOW, RED, YELLOW, adaptiveLogo, logoFor, quotaHealth } from '../hooks/fmt'
import { UPDATE_COMMANDS, compareVersions, parseVersion } from '../hooks/update'
import type { ClaimIo } from '../hooks/warn'
import { DEFAULT_LEVEL, LEVELS, claim, claimNames, claimScript, due, expiredKeys, forgetHandled, isClaimed, levelFor, lowAt, message, parseKey, resetMs, windowId, windowKey } from '../hooks/warn'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const WARN = { h5: 20, d7: 20, toast: true, notify: false, back: false }
/** Told by pop-up (off by default), at the default level. */
const TOLD = { warn: { h5: 30, d7: 30, toast: true, notify: false, back: false } }
const H5 = (used: number, resetsAt = '2026-11-11T12:30:00Z') => ({ kind: 'five_hour', percentUsed: used, resetsAt })
/** A 5-hour window as reported with no reset time, or an unreadable one. */
const H5R = (used: number, resetsAt?: string) => (resetsAt === undefined ? { kind: 'five_hour', percentUsed: used } : { kind: 'five_hour', percentUsed: used, resetsAt })
const D7 = (used: number, resetsAt = '2026-11-14T08:00:00Z') => ({ kind: 'seven_day', percentUsed: used, resetsAt })
const MIN = (iso: string) => Math.round(Date.parse(iso) / 60_000)

// ---------------------------------------------------------------- warning logic

test('due: at or under the level; each quota on its own; off and last-seen figures never', async () => {
  expect(due([H5(79), D7(10)], WARN).length).toBe(0) // 21% and 90% left
  expect(due([H5(80)], WARN).map(w => w.kind)).toEqual(['five_hour']) // exactly 20% left
  expect(due([H5(95), D7(85)], WARN).map(w => w.kind)).toEqual(['five_hour', 'seven_day'])
  expect(due([H5(85)], { ...WARN, h5: 10 }).length).toBe(0) // 15% left: above a 10% level
  expect(due([H5(91)], { ...WARN, h5: 10 }).length).toBe(1)
  expect(due([H5(95)], { ...WARN, h5: 0 }).length).toBe(0) // 5H off
  expect(due([{ ...H5(95), stale: true }], WARN).length).toBe(0) // a last-seen figure never warns
  expect(message(H5(85), NOW)).toBe('5-hour quota 15% left · resets in 2h 30m')
  expect(message(D7(82), NOW)).toBe('7-day quota 18% left · resets in 2d 22h')
  expect(message(H5R(85), NOW)).toBe('5-hour quota 15% left')
  expect(lowAt('seven_day', 19, WARN)).toBe(true)
  expect(lowAt('seven_day', 21, WARN)).toBe(false)
})

test('window identity: the real reset instant, any offset; minutes and seconds kept; no invented reset', async () => {
  // One instant, three spellings: one window.
  const z = windowKey(H5(90, '2026-11-11T12:30:00Z'))
  expect(windowKey(H5(90, '2026-11-11T20:30:00+08:00'))).toBe(z)
  expect(windowKey(H5(90, '2026-11-11T07:30:00-05:00'))).toBe(z)
  expect(z).toBe(`five_hour-${MIN('2026-11-11T12:30:00Z')}`)
  // A report a few seconds off rounds to the same minute.
  expect(windowKey(H5(90, '2026-11-11T12:30:04Z'))).toBe(z)
  expect(windowKey(H5(90, '2026-11-11T12:29:58.500Z'))).toBe(z)
  // Two windows in the same hour (and the old hour-cut ids) stay apart.
  expect(windowKey(H5(90, '2026-11-11T12:05:00Z'))).not.toBe(z)
  // Same instant, other quota: other window.
  expect(windowKey(D7(90, '2026-11-11T12:30:00Z'))).toBe(`seven_day-${MIN('2026-11-11T12:30:00Z')}`)
  // Missing or malformed reset: no shared identity, never a made-up one.
  for (const r of [undefined, '', 'soon', '2026-13-45T99:00:00Z']) {
    expect(resetMs(H5R(90, r))).toBe(null)
    expect(windowKey(H5R(90, r))).toBe(null)
    expect(windowId(H5R(90, r))).toBe('five_hour-noreset')
  }
  expect(windowKey({ kind: 'spend_limit', percentUsed: 90, resetsAt: '2026-11-11T12:30:00Z' })).toBe(null)
  expect(parseKey(z!)).toEqual({ kind: 'five_hour', minute: MIN('2026-11-11T12:30:00Z') })
  for (const bad of ['README.txt', 'five_hour@2026-11-11T12', 'five_hour-', 'other-123', 'five_hour-12x']) expect(parseKey(bad)).toBe(null)
})

test('claims: within two minutes is the same window; expiry uses the same instant, an hour after reset', async () => {
  const k = `five_hour-${MIN('2026-11-11T12:30:00Z')}`
  expect(isClaimed([k], `five_hour-${MIN('2026-11-11T12:32:00Z')}`)).toBe(true)
  expect(isClaimed([k], `five_hour-${MIN('2026-11-11T12:33:00Z')}`)).toBe(false)
  expect(isClaimed([k], `seven_day-${MIN('2026-11-11T12:30:00Z')}`)).toBe(false) // 5H never covers 7D
  expect(isClaimed(['README.txt', 'junk'], k)).toBe(false)
  const reset = Date.parse('2026-11-11T12:30:00Z')
  expect(expiredKeys([k], reset - 1)).toEqual([]) // future window
  expect(expiredKeys([k], reset + 3_600_000)).toEqual([]) // exactly an hour after: kept
  expect(expiredKeys([k], reset + 3_600_001)).toEqual([k]) // just past: removed
  expect(expiredKeys(['README.txt', 'five_hour@2026-11-11T08'], reset * 2)).toEqual([]) // never anything else
})

test('the claim script: removes expired claims, then three atomic mkdirs in ascending order; refuses paths cmd would misread', async () => {
  const m = MIN('2026-11-11T12:30:00Z')
  const k = `five_hour-${m}`
  const old = `seven_day-${MIN('2026-11-01T08:00:00Z')}`
  const dir = 'C:\\Users\\Test User\\.claude\\lucelis\\claims'
  expect(claimNames(k)).toEqual([`five_hour-${m - 1}`, k, `five_hour-${m + 1}`])
  expect(claimNames('junk')).toEqual([])
  const mk = (n: string) => `mkdir "${dir}\\${n}" 2>nul || if exist "${dir}\\${n}\\" (exit 2) else (exit 3)\r\n`
  expect(claimScript(dir, k, [old])).toBe(`@echo off\r\nrmdir "${dir}\\${old}" 2>nul\r\n${claimNames(k).map(mk).join('')}exit 0\r\n`)
  for (const bad of ['C:\\a%PATH%b', 'C:\\a"b', 'C:\\a&b', 'C:\\a^b', 'C:\\a!b', 'C:\\a|b', 'C:\\a>b', 'C:\\a\r\nb']) expect(claimScript(bad, k, [])).toBe(null)
  expect(claimScript(dir, 'five_hour-1 & del x', [])).toBe(null)
  expect(claimScript(dir, k, ['..\\..\\Windows'])).toBe(null)
})

/**
 * A claims folder shared by "sessions" in this test, run as the claim script does: each mkdir
 * succeeds for the first caller only, names in ascending order, stopping at the first taken.
 * `yields` lets other sessions run between two mkdirs (as separate processes may).
 */
const memIo = (dirs: Set<string>, opts: { fail?: 'list' | 'acquire' | 'error'; yields?: () => number } = {}): ClaimIo & { made: string[] } => {
  const io = {
    made: [] as string[],
    list: async () => { if (opts.fail === 'list') throw new Error('locked'); return [...dirs] },
    acquire: async (key: string, expired: readonly string[]) => {
      if (opts.fail === 'acquire') throw new Error('cmd missing')
      if (opts.fail === 'error') return 'error' as const
      for (const e of expired) dirs.delete(e)
      for (const n of claimNames(key)) {
        for (let i = opts.yields?.() ?? 0; i > 0; i--) await Promise.resolve()
        if (dirs.has(n)) return 'taken' as const
        dirs.add(n); io.made.push(n)
      }
      return 'won' as const
    },
  }
  return io
}
const allNames = (...keys: (string | null)[]) => keys.flatMap(k => claimNames(k!)).sort()

test('claim: one winner per window; 5H and 7D apart; never repeated in a session; restarts and failures', async () => {
  const shared = new Set<string>()
  forgetHandled()
  expect((await claim(memIo(shared), NOW, [H5(90), D7(90)], WARN)).map(w => w.kind)).toEqual(['five_hour', 'seven_day'])
  expect([...shared].sort()).toEqual(allNames(windowKey(D7(90)), windowKey(H5(90))))
  // The same session never repeats a window, whatever the folder says.
  expect((await claim(memIo(new Set()), NOW, [H5(90)], WARN)).length).toBe(0)
  // Another session (or this one after a restart): both windows are taken, so it stays quiet.
  forgetHandled()
  expect((await claim(memIo(shared), NOW, [H5(95), D7(95)], WARN)).length).toBe(0)
  // A report a minute off is still the same window.
  forgetHandled()
  expect((await claim(memIo(shared), NOW, [H5(95, '2026-11-11T12:31:00Z')], WARN)).length).toBe(0)
  // The next 5-hour window is a new one; the old 7-day claim is untouched.
  forgetHandled()
  const io = memIo(shared)
  expect((await claim(io, NOW, [H5(95, '2026-11-11T17:30:00Z')], WARN)).length).toBe(1)
  expect(shared.has(windowKey(D7(90))!)).toBe(true)
  // Expired claims are removed with the next claim; active ones are kept.
  forgetHandled()
  const later = Date.parse('2026-11-11T14:00:00Z')
  const io2 = memIo(shared)
  expect((await claim(io2, later, [H5(95, '2026-11-11T19:00:00Z')], WARN)).length).toBe(1)
  expect(shared.has(windowKey(H5(90))!)).toBe(false) // reset at 12:30, removed after 13:30
  expect(shared.has(windowKey(H5(95, '2026-11-11T17:30:00Z'))!)).toBe(true)
  expect(shared.has(windowKey(D7(90))!)).toBe(true)
  // Claims cannot be made at all: this session warns on its own (a rare duplicate over silence).
  for (const fail of ['acquire', 'error'] as const) {
    forgetHandled()
    expect((await claim(memIo(new Set(), { fail }), NOW, [H5(90)], WARN)).length).toBe(1)
  }
  // The folder cannot be listed: the atomic mkdir still decides.
  forgetHandled()
  expect((await claim(memIo(new Set([windowKey(H5(90))!]), { fail: 'list' }), NOW, [H5(90)], WARN)).length).toBe(0)
  // No reset time: warned once by this session, nothing written.
  forgetHandled()
  const io3 = memIo(new Set())
  expect((await claim(io3, NOW, [H5R(90)], WARN)).length).toBe(1)
  expect(io3.made).toEqual([])
  expect((await claim(io3, NOW, [H5R(91)], WARN)).length).toBe(0)
  // A last-seen figure never claims.
  forgetHandled()
  const io4 = memIo(new Set())
  expect((await claim(io4, NOW, [{ ...H5(99), stale: true }], WARN)).length).toBe(0)
  expect(io4.made).toEqual([])
  forgetHandled()
})

test('claim: many sessions at once, interleaved however the scheduler likes: exactly one mkdir wins per window', async () => {
  // Each "session" has its own handled set in reality; here each attempt starts fresh.
  for (let round = 0; round < 20; round++) {
    const shared = new Set<string>()
    const winners: string[] = []
    const attempts = Array.from({ length: 12 }, (_, i) => (async () => {
      // A different interleaving each round: some sessions list late, after others made the claim.
      if ((i + round) % 3 === 0) await Promise.resolve()
      const io = memIo(shared)
      const key5 = windowKey(H5(90))!, key7 = windowKey(D7(90))!
      const names = await io.list()
      for (const k of [key5, key7]) if (!isClaimed(names, k) && (await io.acquire(k, [])) === 'won') winners.push(`${i}:${k.split('-')[0]}`)
    })())
    await Promise.all(attempts)
    expect(winners.filter(w => w.endsWith('five_hour')).length).toBe(1)
    expect(winners.filter(w => w.endsWith('seven_day')).length).toBe(1)
  }
})

test('claim: sessions reporting one window up to 2 minutes apart still have exactly one winner, whatever the interleaving', async () => {
  // Reset times as different sessions might report one window: seconds of drift that round to
  // different minutes, and up to 2 minutes apart.
  const resets = ['2026-11-11T12:30:29Z', '2026-11-11T12:30:31Z', '2026-11-11T12:31:10Z', '2026-11-11T12:32:00Z', '2026-11-11T12:30:00Z']
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 4
  for (let round = 0; round < 200; round++) {
    const shared = new Set<string>()
    const won = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const w = H5(90, resets[(i + round) % resets.length])
      const io = memIo(shared, { yields: rand })
      for (let j = rand(); j > 0; j--) await Promise.resolve()
      const names = await io.list()
      return !isClaimed(names, windowKey(w)!) && (await io.acquire(windowKey(w)!, [])) === 'won'
    }))
    expect(won.filter(Boolean).length).toBe(1)
  }
  // Windows of one kind that are really different (hours apart) never block each other.
  const shared = new Set<string>()
  expect(await memIo(shared).acquire(windowKey(H5(90, '2026-11-11T12:30:00Z'))!, [])).toBe('won')
  expect(await memIo(shared).acquire(windowKey(H5(90, '2026-11-11T17:30:00Z'))!, [])).toBe('won')
  expect(await memIo(shared).acquire(windowKey(D7(90, '2026-11-11T12:31:00Z'))!, [])).toBe('won')
})

// ---------------------------------------------------------------- warning in a session

const bootWarn = async ($: any, on: any, opts: { claims?: string[]; claimFails?: boolean; listEmpty?: boolean; settings?: unknown; surface?: 'desktop' | 'terminal'; fetch?: { status: number; ok: boolean; text: string }; history?: boolean } = {}) => {
  forgetHandled()
  const dirs = new Set<string>(opts.claims ?? [])
  const calls = { toast: [] as string[], notify: [] as any[], cancel: [] as string[], fetch: [] as string[], copied: [] as string[], scripts: [] as string[], dirs }
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
  const claimOf = (p: string) => /\\claims\\([^\\]+)$/.exec(p)?.[1]
  on('fs.exists', (_: any, e: any) => { const p = String(e.path); const c = claimOf(p); return { value: c !== undefined ? dirs.has(c) : p.endsWith('\\claims') ? true : !!hist && p.endsWith('cache-a.json') } })
  on('fs.read', (_: any, e: any) => ({ value: String(e.path).endsWith('plugin.json') ? '{"version":"1.1.0"}' : hist }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: hist.length || 2, mtimeMs: 1, isLink: false } }))
  on('fs.list', (_: any, e: any) => ({ value: !opts.listEmpty && String(e.path).endsWith('\\claims') ? [...dirs].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) : [] }))
  // cmd.exe as Windows runs the claim script: rmdir each line; each mkdir stops the script with
  // exit 2 if that folder exists; exit 0 at the end.
  on('process.run', (_: any, e: any) => {
    const script = String(e.init?.stdin ?? e.stdin ?? '')
    calls.scripts.push(script)
    if (opts.claimFails) return { value: { exitCode: 9009, stdout: '', stderr: 'not found', isStdoutTruncated: false } }
    let code = 0
    for (const line of script.split('\r\n')) {
      const m = /^(rmdir|mkdir) "([^"]+)" 2>nul/.exec(line)
      if (!m) continue
      const name = claimOf(m[2])!
      if (m[1] === 'rmdir') dirs.delete(name)
      else if (dirs.has(name)) { code = 2; break }
      else dirs.add(name)
    }
    return { value: { exitCode: code, stdout: '', stderr: '', isStdoutTruncated: false } }
  })
  on('ui.toast', (_: any, e: any) => { calls.toast.push(e.text); return { value: undefined } })
  on('ui.notify', (_: any, e: any) => { calls.notify.push(e); return { value: { isSent: true, channel: 'client' } } })
  on('ui.cancelNotify', (_: any, e: any) => { calls.cancel.push(e.key); return { value: { isSent: true } } })
  on('http.fetch', (_: any, e: any) => {
    calls.fetch.push(e.url)
    if (String(e.url).endsWith('CHANGELOG.md') && !opts.fetch) return { value: { headers: {}, status: 200, ok: true, text: '# Changelog\n\n## 9.9.9 — 2027-01-01\n\n- **Faster bar.** Text.\n- **New tab.** Text.\n' } }
    return { value: { headers: {}, ...(opts.fetch ?? { status: 200, ok: true, text: '{"version":"9.9.9"}' }) } }
  })
  on('ui.copy', (_: any, e: any) => { calls.copied.push(e.text); return { value: { isCopied: true } } })
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: opts.surface ?? 'desktop', isInteractive: true, cwd: 'F:\\W\\Atlas' })
  const measure = async (...rateLimits: unknown[]) => {
    await $.session.measure({ context: { window: 1_000_000, tokens: 1000, percent: 0 }, rateLimits, changed: ['rateLimits'] })
    await clock.settle()
  }
  return { calls, clock, measure }
}

test('crossing the level: one pop-up, not repeated in the same window; 7D warns on its own; no Windows notification unless asked', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: TOLD })
  await measure(H5(65), D7(10))
  expect(calls.toast.length).toBe(0)
  expect(calls.scripts.length).toBe(0) // nothing due: no cmd run at all
  await measure(H5(75), D7(10))
  expect(calls.toast).toEqual(['Lucelis: 5-hour quota 25% left · resets in 2h 30m'])
  await measure(H5(90), D7(10))
  expect(calls.toast.length).toBe(1)
  await measure(H5(90), D7(85))
  expect(calls.toast.length).toBe(2)
  expect(calls.toast[1]).toContain('7-day quota 15% left')
  expect(calls.notify.length).toBe(0)
  expect([...calls.dirs].sort()).toEqual(allNames(windowKey(D7(85)), windowKey(H5(90))))
  expect(calls.scripts.length).toBe(2) // one claim per window, no more
})

test('a window another session already claimed stays quiet here; a failed claim still warns once', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: TOLD, claims: [windowKey(H5(90))!] })
  await measure(H5(90))
  expect(calls.toast.length).toBe(0)
})

test('another session won the same window with a reset time a minute apart: quiet here (cmd exit 2)', async ($, on) => {
  // The other session's claim, made from 12:31; this session reads 12:30. The folder list is
  // stale here (made after this session listed), so only the mkdir decides.
  const other = claimNames(windowKey(H5(90, '2026-11-11T12:31:00Z'))!)
  const { calls, measure } = await bootWarn($, on, { settings: TOLD, claims: other, listEmpty: true })
  await measure(H5(90))
  expect(calls.scripts.length).toBe(1)
  expect(calls.toast.length).toBe(0)
})

test('claims that cannot be made: the session warns on its own, once', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: TOLD, claimFails: true })
  await measure(H5(90))
  await measure(H5(92))
  expect(calls.toast.length).toBe(1)
})

test('by default: red, but no pop-up, no notification and no claim', async ($, on) => {
  const { calls, measure } = await bootWarn($, on)
  await measure(H5(90), D7(90))
  expect(calls.toast.length + calls.notify.length + calls.scripts.length).toBe(0)
})

test('Windows notification and "quota is back": booked at the reset time, taken back when the quota recovers', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: { warn: { ...WARN, toast: false, notify: true, back: true } } })
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await measure(H5(85))
  expect(calls.toast.length).toBe(0)
  expect(calls.notify.map(n => n.options?.key ?? n.key)).toEqual([`lucelis-low-${windowId(H5(85))}`, 'lucelis-back-five_hour'])
  const back = calls.notify[1]
  expect(back.options?.at ?? back.at).toBe(Date.parse('2026-11-11T12:30:00Z'))
  await measure(H5(5)) // recovered early (95% left)
  expect(calls.cancel).toEqual(['lucelis-back-five_hour'])
  await band.unmount()
})

test('both quotas off: nothing at all, and no red', async ($, on) => {
  const { calls, measure } = await bootWarn($, on, { settings: { warn: { h5: 0, d7: 0, toast: true, notify: true, back: true } } })
  await measure(H5(99), D7(99))
  expect(calls.toast.length + calls.notify.length + calls.scripts.length).toBe(0)
})

// ---------------------------------------------------------------- logo

test('logo states: still when idle, bars draw in while working, three bars, all red while low; the L still follows the theme', async () => {
  expect(logoFor(false, false)).toBe(LOGO)
  expect(logoFor(true, false)).toBe(LOGO_WORKING)
  expect(logoFor(false, true)).toBe(LOGO_LOW)
  expect(logoFor(true, true)).toBe(LOGO_WORKING_LOW)
  expect(LOGO.includes('<animate')).toBe(false)
  expect(LOGO_LOW.includes('<animate')).toBe(false)
  expect(LOGO_WORKING.includes('stroke-dashoffset') && LOGO_WORKING.includes('pathLength="1"')).toBe(true)
  expect(LOGO_LOW.includes('#ef5d58') && !LOGO.includes('#ef5d58')).toBe(true)
  // Three bars; when low, the bars are red too (not just the small glint), and no teal is left.
  expect((LOGO.match(/M13.6 /g) ?? []).length).toBe(3)
  expect((LOGO_WORKING.match(/<animate attributeName="stroke-dashoffset"/g) ?? []).length).toBe(3)
  for (const s of [LOGO_LOW, LOGO_WORKING_LOW]) expect(s.includes('#7EC9C3')).toBe(false)
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

test('one level for the figure, the logo and the warning: 30% left by default, 10-40 offered', async () => {
  expect(DEFAULT_LEVEL).toBe(30)
  expect([...LEVELS]).toEqual([10, 20, 30, 40])
  expect(levelFor('five_hour')).toBe(30)
  expect(levelFor('seven_day', { ...WARN, d7: 40 })).toBe(40)
  expect(levelFor('other', WARN)).toBe(null)
  expect([100, 70, 69, 31, 30, 0].map(n => quotaHealth(n, 30))).toEqual([GOOD, GOOD, YELLOW, YELLOW, RED, RED])
  expect(quotaHealth(40, 40)).toBe(RED)
  // Off (0): never red, the logo never low.
  expect([5, 0].map(n => quotaHealth(n, 0))).toEqual([YELLOW, YELLOW])
  expect(lowAt('five_hour', 1, { h5: 0, d7: 30, toast: false, notify: false, back: false })).toBe(false)
  expect(lowAt('five_hour', 28, { h5: 30, d7: 0, toast: false, notify: false, back: false })).toBe(true)
  // The bar figure turns red exactly where the logo does.
  const st = { show: { h5: true, d7: true }, warn: { ...WARN, h5: 40, d7: 30 } } as any
  const v = { quotas: [{ kind: 'five_hour', left: 40, resetIn: null }, { kind: 'seven_day', left: 31, resetIn: null }] } as any
  const colours = compactParts(v, st).map(p => p.forms[0][1][1])
  expect(colours).toEqual([RED, YELLOW])
})

test('with saved settings from before, the bar uses the 30% default', async ($, on) => {
  const { measure } = await bootWarn($, on, { settings: { isOn: true } })
  await measure(H5(72), D7(10))
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 160, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(JSON.stringify(await band.find({ key: 'glyph' }))).toContain('quota low')
  await band.unmount()
})

// ---------------------------------------------------------------- updates

test('versions compare by SemVer precedence; malformed versions are never newer', async () => {
  const gt = (x: string, y: string) => { expect(compareVersions(x, y)).toBe(1); expect(compareVersions(y, x)).toBe(-1) }
  gt('1.1.0-rc.10', '1.1.0-rc.9')
  gt('1.1.0', '1.1.0-rc.99')
  gt('1.2.0', '1.1.99')
  gt('2.0.0', '1.99.99')
  gt('1.1.0-beta', '1.1.0-alpha')
  gt('1.1.0-alpha.10', '1.1.0-alpha.2')
  gt('1.1.0-alpha.beta', '1.1.0-alpha.1') // words rank above numbers
  gt('1.1.0-alpha.1', '1.1.0-alpha') // more fields rank higher
  gt('1.1.0', '1.0.2')
  gt('v2.0.0', '1.9.9')
  expect(compareVersions('1.1.0+build.2', '1.1.0+build.9')).toBe(0)
  expect(compareVersions('1.1.0', '1.1.0')).toBe(0)
  for (const bad of ['', '1.1', '1.1.0.1', '01.1.0', '1.1.0-', '1.1.0-rc..1', 'latest', ' x', '1.1.0-01']) {
    expect(compareVersions(bad, '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', bad)).toBe(0)
  }
  // Numbers past 2^53 compare exactly (as digit strings), not as rounded floats.
  gt('1.0.0-rc.9007199254740993', '1.0.0-rc.9007199254740992')
  gt('1.0.0-99999999999999999999999', '1.0.0-99999999999999999999998')
  gt('1.0.0-100000000000000000000000', '1.0.0-99999999999999999999999')
  gt('9007199254740993.0.0', '9007199254740992.0.0')
  gt('1.9007199254740993.0', '1.9007199254740992.0')
  gt('1.0.18446744073709551617', '1.0.18446744073709551616')
  gt('1.0.0-alpha.99999999999999999999.1', '1.0.0-alpha.99999999999999999999.0')
  expect(compareVersions('1.0.0-rc.9007199254740993', '1.0.0-rc.9007199254740993')).toBe(0)
  expect(parseVersion('9007199254740993.0.0')).toEqual({ core: ['9007199254740993', '0', '0'], pre: [] })
  expect(parseVersion(42)).toBe(null)
  expect(UPDATE_COMMANDS).toBe('/plugin marketplace update lucelis\n/plugin update lucelis@lucelis')
})

const PANE = { plugin: 'lucelis', surface: 'desktop', component: 'Pane', requestId: 'lucelis', props: { title: 'Lucelis', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const

test('no network at all until Check for updates is pressed; a newer version turns the button into Update to X with what X brings', async ($, on) => {
  const { calls, clock, measure } = await bootWarn($, on, { history: true })
  await measure(H5(10))
  const band = await $.ui.mount({ plugin: 'lucelis', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  await clock.advance(5 * 60_000) // timers: the minute redraw
  const pane = await $.ui.mount(PANE)
  // About Lucelis, at the bottom of Overview (the tab the pane opens on).
  expect(calls.fetch.length).toBe(0)
  await pane.press({ key: 'check' })
  await clock.settle()
  // The version, then (only because it is newer) its notes.
  expect(calls.fetch).toEqual(['https://raw.githubusercontent.com/obiwong2579/Lucelis/main/.claude-plugin/plugin.json', 'https://raw.githubusercontent.com/obiwong2579/Lucelis/main/CHANGELOG.md'])
  // The same button now says what it updates to, and what that version brings.
  expect((await pane.find({ key: 'check' }))?.props.label).toBe('Update to 9.9.9')
  expect(await pane.find({ text: 'What 9.9.9 brings: Faster bar, New tab.' })).toBeDefined()
  expect(await pane.find({ text: /Lucelis 9\.9\.9 is available \(you have 1\.1\.0\)/ })).toBeDefined()
  await pane.press({ key: 'check' })
  expect(calls.copied).toEqual([UPDATE_COMMANDS])
  expect(calls.fetch.length).toBe(2) // pressing Update makes no request
  await pane.unmount()
  await band.unmount()
})

test('a failed check says so and changes nothing', async ($, on) => {
  const { clock } = await bootWarn($, on, { fetch: { status: 404, ok: false, text: 'no' }, history: true })
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'check' })
  await clock.settle()
  expect(await pane.find({ text: /Could not check: GitHub answered 404/ })).toBeDefined()
  expect((await pane.find({ key: 'check' }))?.props.label).toBe('Check for updates')
  expect(await pane.find({ text: /^Lucelis 1\.1\.0$/ })).toBeDefined()
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
