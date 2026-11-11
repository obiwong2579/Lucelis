import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ctx, Live, News, PaneView, Settings, TurnFacts, UpdateState, Window } from '../types'
import { barLayout, compactRow, snapshot } from './bar'
import type { CacheWatch } from './cachewatch'
import { contextMeasured, requestSent, sessionReturned, turnEnded } from './cachewatch'
import { exportName, toCsv } from './csv'
import { aggNow, ensureLoaded, paths, refresh } from './data'
import { localDay, makeResolver } from './agg'
import { MUTED } from './fmt'
import { view } from './model'
import { TAB_LABEL, paneTree } from './pane'
import { NOTES_URL, UPDATE_COMMANDS, compareVersions, installedVersion, latestVersion, whatsNew } from './update'
import { claim, due, fileIo, leftOf, levelFor, message, windowId } from './warn'

// Lucelis: a bar above the prompt (5H / 7D quota, prompt cache, context, the current
// session, today's project usage) that opens into a session summary, plus the Lucelis
// pane over the local history.
//
// Quota and context come from the engine (session.usage / session.measure). The cache
// state is inferred by cachewatch.ts from request timing. History comes from the
// transcripts, read on demand by a read-only extractor (data.ts). Nothing is sent
// anywhere, no model is called; the one network request is Check for updates (update.ts),
// made only when the person presses it.

const PANE = 'lucelis'
/** What a command answers when it could not run. */
const FAILED = (cmd: string) => `Lucelis: ${cmd} could not run this time. Nothing was changed; try it again, or start a new session.`
const TICK_MS = 60_000
const THROTTLE_MS = 60_000

const DEFAULTS: Settings = {
  isOn: true,
  mode: 'normal',
  wrap: true,
  logo: true,
  bg: false,
  period: '30d',
  heat: 'tokens',
  show: { h5: true, d7: true, cache: true, ctx: true, resets: true, today: true, session: true, elapsed: true, trend: true, project: true, model: true },
  aliases: [],
  warn: { on: true, h5: 30, d7: 30, toast: true, notify: false, back: false },
  exportDir: '',
}
const VIEW: PaneView = { period: null, heat: null, modelBy: 'tokens', project: null, tab: 'overview', help: false }

const windows = atom({ plugin: 'lucelis', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'lucelis', key: 'cachewatch' } as const, null as CacheWatch | null)
const ctx = atom({ plugin: 'lucelis', key: 'ctx' } as const, null as Ctx | null)
const live = atom({ plugin: 'lucelis', key: 'live' } as const, null as Live | null)
const turn = atom({ plugin: 'lucelis', key: 'turn' } as const, null as TurnFacts | null)
const expanded = atom({ plugin: 'lucelis', key: 'expanded' } as const, false)
const settings = atom({ plugin: 'lucelis', key: 'settings' } as const, DEFAULTS, { shape: 'settings-2' })
const rev = atom({ plugin: 'lucelis', key: 'rev' } as const, 0)
const note = atom({ plugin: 'lucelis', key: 'note' } as const, '')
const paneView = atom({ plugin: 'lucelis', key: 'view' } as const, VIEW, { shape: 'view-2' })
const upd = atom({ plugin: 'lucelis', key: 'update' } as const, { phase: 'idle', installed: '' } as UpdateState)
const news = atom({ plugin: 'lucelis', key: 'news' } as const, null as News | null)

/** The usage windows as plain values the state can hold (the engine's list is read-only). */
const plainWindows = (list: readonly Window[]): Window[] => {
  const out: Window[] = []
  for (const { kind, percentUsed, resetsAt } of list) out.push({ kind, percentUsed, resetsAt })
  return out
}
const ctxOf = (c: { tokens?: number; window: number; percent?: number }): Ctx | null =>
  c.tokens && c.tokens > 0 ? { tokens: c.tokens, window: c.window, percent: c.percent ?? null } : null

/** Settings from $.store, with any field a newer version added filled from the defaults. */
async function loadSettings($: EngineInterface): Promise<Settings> {
  const s = (await $.store.get('settings')) as Partial<Settings> | undefined
  return s && typeof s === 'object'
    ? { ...DEFAULTS, ...s, show: { ...DEFAULTS.show, ...(s.show ?? {}) }, warn: { ...DEFAULTS.warn, ...(s.warn ?? {}) }, aliases: Array.isArray(s.aliases) ? s.aliases : [] }
    : DEFAULTS
}

/**
 * Opens the Lucelis pane on `tab`, or switches an open one to it. The host may refuse
 * to raise a pane (a click in the band keeps the focus there), so an already-open pane
 * also gets a toast naming the tab it now shows: the press always has a visible effect.
 */
async function openPane($: EngineInterface, tab?: PaneView['tab']) {
  let wasOpen = false
  try { wasOpen = (await $.ui.panes()).some(p => p.id === PANE) } catch { wasOpen = false }
  if (tab) await update($, paneView, v => ({ ...v, tab, project: null }))
  const r = await $.ui.open({ id: PANE, title: 'Lucelis', rows: 32, columns: 110, focus: true })
  if (wasOpen && tab) { try { await $.ui.toast(`Lucelis pane: ${TAB_LABEL[tab]} tab`) } catch { /* no surface */ } }
  await update($, rev, n => n + 1)
  // Fresh history for the pane, but not a reader process per press: at most one a minute.
  void syncSoon($)
  return r
}

/** Whether the Lucelis pane is up and showing, by the engine's own record (never a remembered flag). */
async function paneShown($: EngineInterface): Promise<boolean> {
  try { return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced !== false && p.isShown !== false) } catch { return false }
}

/**
 * Details: a true toggle. Showing -> close it (the host's own $.ui.close, so the pane is
 * really gone, not hidden); closed, or open behind another pane's tab -> open it where it
 * was left. Only this plugin's pane is touched.
 */
async function toggleDetails($: EngineInterface) {
  if (await paneShown($)) {
    try { await $.ui.close({ id: PANE }) } catch { /* a hook refused: it stays open */ }
    await update($, rev, n => n + 1)
    return
  }
  await openPane($)
}

/**
 * The folder the session runs in NOW. The desktop app can start a session in a placeholder
 * ("spare-...") folder and point it at the real one afterwards, so the folder seen at
 * session.start is only a fallback.
 */
async function cwdNow($: EngineInterface): Promise<string | null> {
  try { const c = await $.session.cwd(); if (c) cwd = c } catch { /* keep the last known */ }
  return cwd
}

let cwd: string | null = null
/** The band's width at its last draw, so Settings can say which items fit (null: not drawn yet). */
let bandColumns: number | null = null
let lastRun = 0
let trailing = false
/** Reads new history, then tells every drawing (note + rev). */
async function sync($: EngineInterface, full = false): Promise<string> {
  try {
    lastRun = await $.clock.now()
    const msg = await refresh($, full)
    await update($, note, () => msg)
    await update($, rev, n => n + 1)
    return msg
  } catch (err) {
    // The session may have ended under a background refresh; nothing to tell then.
    return `refresh failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`
  }
}

/** The surface the band last drew on: a reset-time notification is booked only from the desktop app. */
let lastSurface: string | null = null
/** "Quota is back" notifications this session booked: window kind -> the window it was for. */
const booked = new Map<string, string>()

/**
 * Low-quota warning (warn.ts): one session claims each window that dropped to its level and
 * warns: the app's pop-up, and a Windows notification if the person turned that on. Never
 * throws, never awaited before the event goes on.
 */
async function checkWarn($: EngineInterface, list: readonly Window[]): Promise<void> {
  try {
    const st = await read($, settings)
    const w = st.warn ?? DEFAULTS.warn
    // A booked "quota is back" that is no longer right (a new window, or it recovered early) is taken back.
    for (const [kind, id] of [...booked]) {
      const now = list.find(x => x.kind === kind)
      const lvl = levelFor(kind, w) ?? 0
      if (!now || windowId(now) !== id || leftOf(now) > lvl + 10 || !(w.notify && w.back)) {
        booked.delete(kind)
        try { await $.ui.cancelNotify(`lucelis-back-${kind}`) } catch { /* no host */ }
      }
    }
    if (!w.on || !due(list, w, {}).length) return
    const lv = await read($, live)
    const now = await $.clock.now()
    const won = await claim(fileIo($, `${(await paths($)).dir}\\warned.json`), lv?.sid ?? 'unknown', now, list, w)
    for (const x of won) {
      const text = message(x, now)
      if (w.toast) { try { await $.ui.toast(`Lucelis: ${text}`, { timeoutMs: 10_000 }) } catch { /* no surface */ } }
      if (w.notify) {
        try { await $.ui.notify(text, { title: 'Lucelis', key: `lucelis-low-${windowId(x)}` }) } catch { /* turned off */ }
        const at = x.resetsAt ? Date.parse(x.resetsAt) : NaN
        if (w.back && lastSurface === 'desktop' && !Number.isNaN(at) && at > now) {
          try {
            await $.ui.notify(`Your ${x.kind === 'five_hour' ? '5-hour' : '7-day'} quota has reset.`, { title: 'Lucelis', key: `lucelis-back-${x.kind}`, at })
            booked.set(x.kind, windowId(x))
          } catch { /* not booked */ }
        }
      }
    }
  } catch { /* a warning never holds the session up */ }
}

/**
 * After an update: the first session of a new version shows a quiet line on Overview ("Updated
 * to X: ..."), from the CHANGELOG.md that ships with the plugin (no network). The first install
 * records its version and shows nothing; a downgrade is recorded silently.
 */
async function checkNews($: EngineInterface): Promise<void> {
  try {
    const installed = await installedVersion($)
    if (!installed) return
    const seen = await $.store.get('seenVersion')
    if (seen === installed) return
    await $.store.set('seenVersion', installed)
    if (typeof seen !== 'string' || compareVersions(installed, seen) <= 0) return
    let summary = ''
    try { summary = whatsNew(await $.fs.read(`${$.plugin.root}\\CHANGELOG.md`), installed) } catch { /* no notes shipped */ }
    await update($, news, () => ({ version: installed, summary, copied: false }))
  } catch { /* never holds the session up */ }
}

/** The last 5H / 7D figures, kept so a new session can show them as "last seen" until it has its own. */
let seenSig = ''
async function saveSeen($: EngineInterface, list: readonly Window[]): Promise<void> {
  try {
    const keep = list.filter(w => (w.kind === 'five_hour' || w.kind === 'seven_day') && w.resetsAt)
    // Written only when a whole-number figure or a window changes, not on every report.
    const sig = keep.map(w => `${w.kind}:${leftOf(w)}:${windowId(w)}`).join('|')
    if (!keep.length || sig === seenSig) return
    seenSig = sig
    await $.store.set('lastSeen', keep.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })))
  } catch { /* not kept this time */ }
}

/** The kept figures whose window has not reset yet, marked stale; none once the window has passed. */
async function loadSeen($: EngineInterface, now: number): Promise<Window[]> {
  try {
    const v = await $.store.get('lastSeen')
    if (!Array.isArray(v)) return []
    const out: Window[] = []
    for (const w of v as Window[]) {
      const at = typeof w?.resetsAt === 'string' ? Date.parse(w.resetsAt) : NaN
      if ((w.kind === 'five_hour' || w.kind === 'seven_day') && typeof w.percentUsed === 'number' && !Number.isNaN(at) && at > now)
        out.push({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt, stale: true })
    }
    return out
  } catch { return [] }
}

/** Check for updates: the one network request Lucelis makes, and only on the person's press. */
async function checkUpdate($: EngineInterface): Promise<void> {
  const installed = await installedVersion($)
  await update($, upd, () => ({ phase: 'checking', installed }))
  try {
    const latest = await latestVersion($)
    const newer = !!installed && compareVersions(latest, installed) > 0
    await update($, upd, () => ({ phase: newer ? 'newer' : 'latest', installed, latest }))
  } catch (err) {
    await update($, upd, () => ({ phase: 'failed', installed, detail: String((err as Error)?.message ?? err).slice(0, 120) }))
  }
}

/** Puts the two update commands on the clipboard; Lucelis never runs them itself. */
async function copyUpdate($: EngineInterface): Promise<void> {
  let ok = false
  try { ok = (await $.ui.copy({ text: UPDATE_COMMANDS })).isCopied } catch { ok = false }
  if (ok) await update($, upd, u => ({ ...u, phase: 'copied' }))
  else { try { await $.ui.toast(`Lucelis: copy did not work. Type these into the prompt: ${UPDATE_COMMANDS.replace('\n', '  then  ')}`, { timeoutMs: 15_000 }) } catch { /* no surface */ } }
}

/** Writes the CSV for [from, to] to the export folder and says where. */
async function exportCsv($: EngineInterface, from: string, to: string): Promise<void> {
  try {
    const a = aggNow()
    if (!a) { await $.ui.toast('Lucelis export: no history read yet. Press Refresh first.'); return }
    const st = await read($, settings)
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    const dir = (st.exportDir || `${home}\\Documents`).replace(/[\\/]+$/, '')
    const { text, rows } = toCsv(a, makeResolver(a, st.aliases ?? []), from, to)
    const path = `${dir}\\${exportName(localDay(await $.clock.now(), a.tz))}`
    await $.fs.write(path, text)
    await $.ui.toast(`Lucelis export: ${rows} rows saved to ${path}`, { timeoutMs: 10_000 })
  } catch (err) {
    try { await $.ui.toast(`Lucelis export failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`, { timeoutMs: 10_000 }) } catch { /* no surface */ }
  }
}

/** After a turn: sync at most once a minute; a skipped one runs once when the minute is up. */
async function syncSoon($: EngineInterface): Promise<void> {
  const wait = lastRun + THROTTLE_MS - (await $.clock.now())
  if (wait <= 0) { void sync($); return }
  if (trailing) return
  trailing = true
  $.clock.after(wait, () => { trailing = false; void sync($) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd ?? null
    const st = await loadSettings($)
    await update($, settings, () => st)
    const u = await $.session.usage()
    // No figures yet in a new session: show the last ones seen, marked so, while their window lasts.
    const own = plainWindows(u.rateLimits)
    const shown = own.length ? own : await loadSeen($, await $.clock.now())
    await update($, windows, () => shown)
    await update($, ctx, () => ctxOf(u.context))
    const sid = await $.session.id()
    await update($, live, () => ({ sid, startedAt: u.startedAt || null }))
    for (const [name, description] of [
      ['lucelis', 'Open the Lucelis Activity dashboard'],
      ['lucelis-refresh', 'Read new history into the Lucelis cache (incremental)'],
      ['lucelis-rebuild', 'Rebuild the Lucelis cache from all transcripts'],
      ['lucelis-settings', 'Open the Lucelis settings'],
    ] as const) await $.command.register({ name, description })
    await ensureLoaded($)
    void sync($)
    void checkNews($)
    // A redraw a minute keeps countdowns current; it reads no history.
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const list = plainWindows(e.rateLimits)
      await update($, windows, () => list)
      void checkWarn($, list)
      void saveSeen($, list)
    }
    if (e.changed.includes('context')) {
      const c = ctxOf(e.context)
      if (c) {
        await update($, ctx, () => c)
        await update($, cache, w => contextMeasured(w, c.tokens, e.context.window))
      }
    }
    return next(e)
  })

  // How the session came to be decides what is known about its cache: a cleared or
  // compacted one starts with nothing; a resumed or forked one reports its age and size.
  //
  // next(e) is called exactly once, outside any error handling: a failure beneath goes to the
  // caller as it is and is never retried. Only the bar's own work is guarded.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    try {
      const fresh = e.source === 'clear' || e.source === 'compact'
      const back = e.source === 'resume' || e.source === 'fork'
      if (fresh) {
        await update($, cache, () => null)
        await update($, turn, () => null)
        // /clear starts a new transcript under a new session id: the session's figures start over.
        if (e.source === 'clear') {
          const started = await $.clock.now()
          await update($, live, l => (l ? { ...l, sid: e.session_id, startedAt: started } : l))
        }
      } else if (back && typeof e.seconds_since_last_response === 'number') {
        const away = e.seconds_since_last_response
        const size = typeof e.context_tokens === 'number' ? e.context_tokens : 0
        const model = typeof e.model === 'string' ? e.model : await $.session.model()
        const usage = await $.session.usage()
        const now = await $.clock.now()
        await update($, cache, () => sessionReturned(now, away, size, usage.context.window, model || null))
      }
    } catch { /* the bar never holds a session up: it just starts without a cache reading */ }
    return result
  })

  // Sub-agents have caches of their own; only the main thread's requests move this clock.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, w => requestSent(w, now, e.model))
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    try { const sid = await $.session.id(); await update($, live, l => (l && sid && l.sid !== sid ? { ...l, sid } : l)) } catch { /* keep */ }
    const usage = await $.session.usage()
    const model = e.usage?.model ?? (await $.session.model())
    const now = await $.clock.now()
    await update($, ctx, c => ctxOf(usage.context) ?? c)
    // The first reply: "last seen" figures give way to this session's own (or to none).
    if ((await read($, windows)).some(w => w.stale)) await update($, windows, () => plainWindows(usage.rateLimits))
    await update($, cache, w => turnEnded(w, now, e.durationMs, { context: usage.context.tokens, window: usage.context.window, model }))
    const u = e.usage
    if (u) {
      await update($, turn, () => ({
        input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens, model: u.model ?? null,
      }))
    }
    void syncSoon($)
    return r
  })

  // The person's own close (the pane's X) or any other: redraw the band so Details shows the truth.
  // As above: one next(e), unguarded; only the redraw is guarded, so it never blocks a close.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) { try { await update($, rev, n => n + 1) } catch { /* session ending */ } }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    lastSurface = e.surface ?? lastSurface
    const st = await read($, settings)
    if (!st.isOn) return next(e)
    const ui = $.ui.resolve(e)
    await read($, rev)
    const lv = await read($, live)
    const now = await $.clock.now()
    const v = view({
      now,
      windows: await read($, windows),
      cache: await read($, cache),
      ctx: await read($, ctx),
      turn: await read($, turn),
      model: await $.session.model(),
      sid: lv?.sid ?? null,
      cwd: await cwdNow($),
      startedAt: lv?.startedAt ?? null,
      aliases: st.aliases ?? [],
      agg: aggNow(),
    })
    const { Box, Text } = ui
    if (v.quotas.length === 0 && !v.cache && !v.session?.tokens) {
      return (
        <Box paddingX={1}>
          <Text color={MUTED}>Lucelis · waiting for the first reply</Text>
        </Box>
      )
    }
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    if (bandColumns !== columns) {
      // Settings reports each item against this width: tell an open pane when it changes.
      const first = bandColumns === null
      bandColumns = columns
      if (!first) void update($, rev, n => n + 1).catch(() => undefined)
    }
    const isOpen = await read($, expanded)
    const paneOpen = await paneShown($)
    const toggle = () => update($, expanded, x => !x)
    const details = () => { void toggleDetails($) }
    const dashboard = () => { void openPane($, 'overview') }
    const sessionTab = () => { void openPane($, 'session') }
    const compare = () => { void openPane($, 'models') }
    const hasSecondRow = barLayout(v, st, columns, !!(ui as any).Svg).rows.length > 1
    const a = aggNow()
    return (
      <Box flexDirection="column">
        {compactRow(ui, v, st, columns, isOpen, paneOpen, toggle, details, !!e.props.isWorking)}
        {isOpen ? snapshot(ui, v, columns, a?.tz ?? 0, now, hasSecondRow, sessionTab, compare, dashboard, true) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    await read($, rev)
    const lv = await read($, live)
    const st = await read($, settings)
    const pv = await read($, paneView)
    const now = await $.clock.now()
    const a = aggNow()
    const v = view({
      now, windows: await read($, windows), cache: await read($, cache), ctx: await read($, ctx), turn: await read($, turn),
      model: await $.session.model(), sid: lv?.sid ?? null, cwd: await cwdNow($), startedAt: lv?.startedAt ?? null, aliases: st.aliases ?? [], agg: a,
    })
    const setSettings = (fn: (s: Settings) => Settings) => {
      void update($, settings, s => fn(s)).then(async () => { await $.store.set('settings', await read($, settings)) })
    }
    return paneTree(ui, a, v, pv, st, await read($, note), e.props.bodyColumns, now, bandColumns, {
      setView: fn => { void update($, paneView, x => fn(x)) },
      setSettings,
      refresh: () => { void sync($).then(m => $.ui.toast(`Lucelis refresh: ${m}`)).catch(() => undefined) },
      rebuild: () => { void sync($, true).then(m => $.ui.toast(`Lucelis rebuild: ${m}`)).catch(() => undefined) },
      checkUpdate: () => { void checkUpdate($) },
      copyUpdate: () => { void copyUpdate($) },
      update: await read($, upd),
      exportCsv: (from, to) => { void exportCsv($, from, to) },
      news: await read($, news),
      dismissNews: () => { void update($, news, () => null) },
      copyNotes: () => { void (async () => {
        let ok = false
        try { ok = (await $.ui.copy({ text: NOTES_URL })).isCopied } catch { ok = false }
        await update($, news, n => (n ? { ...n, copied: ok } : n))
      })() },
    })
  })

  on('command.run', { command: 'lucelis' }, async $ => {
    const r = await openPane($)
    return { text: r.isPlaced ? 'Activity dashboard opened.' : `Activity dashboard is open but not shown here: ${r.reason}` }
  }).catch(() => ({ text: FAILED('/lucelis') }))
  on('command.run', { command: 'lucelis-settings' }, async $ => {
    await openPane($, 'settings')
    return { text: 'Lucelis settings opened (Settings tab of the Lucelis pane). They are kept across sessions.' }
  }).catch(() => ({ text: FAILED('/lucelis-settings') }))
  on('command.run', { command: 'lucelis-refresh' }, async $ => {
    return { text: `Lucelis refresh: ${await sync($)}` }
  }).catch(() => ({ text: FAILED('/lucelis-refresh') }))
  on('command.run', { command: 'lucelis-rebuild' }, async $ => {
    return { text: `Lucelis rebuild: ${await sync($, true)}` }
  }).catch(() => ({ text: FAILED('/lucelis-rebuild') }))
}
