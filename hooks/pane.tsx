// The Lucelis pane (level 3): six tabs, Overview · Session · Projects · Models ·
// Patterns · Settings. Draws only; numbers come from agg.ts queries over the
// aggregate (memoised per aggregate build) and from the live View.
//
// Layout rules for the Desktop pane: no whitespace padding for alignment (the font
// is proportional): columns are fixed-width Boxes; metrics flow in a wrapping grid
// of fixed-width cells, so a narrow pane gets one column and a wide one several;
// tables switch to two-line rows when narrow. No inner scroll areas.

import type { News, PaneView, Settings, UpdateState } from '../types'
import type { Agg, Period, Resolver, Slice, Stats } from './agg'
import { FORMAT_NOTE, PERIODS, PERIOD_LABEL, addDays, formatSuspect, change, daysBetween, firstDay, localDay, makeResolver, mean, median, patterns, rangeOf, stats, streaks, weekRange, weekday } from './agg'
import type { ItemState } from './bar'
import { ITEMS, barLayout } from './bar'
import type { View } from './model'
import type { CostRow } from './prices'
import { PRICES_AS_OF, PRICES_SOURCE, usd } from './prices'
import { COLD, DAYS, EMPTY, GOOD, HOURS, INK, LINE, MUTED, ORANGE, WARM, dots, dur, modelName, pct, signed, tok, trend, when } from './fmt'
import { LEVELS } from './warn'

type El = { Box: any; Text: any; Button: any; Svg?: any; Input?: any }
type Act = {
  setView: (fn: (v: PaneView) => PaneView) => void
  setSettings: (fn: (s: Settings) => Settings) => void
  refresh: () => void
  rebuild: () => void
  /** Check for updates (one request to GitHub, only on this press) and its last result. */
  checkUpdate: () => void
  copyUpdate: () => void
  update: UpdateState
  /** Writes the CSV for the period shown. */
  exportCsv: (from: string, to: string) => void
  /** "Updated to X" after an update, until dismissed. Full notes copies the link (no pop-up). */
  news?: News | null
  dismissNews?: () => void
  copyNotes?: () => void
  notesCopied?: boolean
  /** The surface has a pointer (desktop app): descriptions open on hover instead of taking a line each. */
  hover?: boolean
}

/** Shown by the "? Terms" toggle: what the figures mean and how sure they are. */
export const HELP = [
  'Activity tokens = uncached input + cache writes + output. The headline figure for shares, trends and the heatmap. Cache reads are not in it.',
  'On the bar: "5H 14%" and "7D 7%" are the quota LEFT, "CTX 24%" is the context USED; all three are green with 70% or more left; 5H and 7D turn red at or under the low level in Settings (30% by default), CTX under 30% left, and are yellow between; figures in K / M are tokens; "◷" is time since the session started; "7d" is all projects over the last 7 days.',
  'Session activity ("Session" on the bar) = the activity tokens of the current session so far.',
  'Project today ("Today" on the bar) = the activity tokens of the current project since local midnight. It is not your account-wide usage.',
  'Output tokens = tokens Claude generated. "468K output" on a session is the total for the whole session so far, not the size of the last reply.',
  'Cache reads = previously cached context processed again on each request. Kept separate: it repeats the same context every turn and would swamp the rest.',
  'Processed tokens = activity tokens + cache reads (all tokens the model handled).',
  'None of these token totals is your subscription usage. The 5H and 7D quotas (and their reset times) come from Claude itself; CTX is how full this conversation is, a different thing.',
  "Messages = your prompts + the main thread's responses (subagent responses add tokens, not messages).",
  "Elapsed = now minus the session's first event. Active (est.) = the gaps under 30 minutes between events, added up.",
  "WARM / COLD is inferred from request timing (60 minutes after a model's last request), not reported by Claude. Each model has its own cache.",
  `Next-message costs are API-price equivalent estimates (input side only, excluding your new message and output), not your bill. Prices as of ${PRICES_AS_OF}: ${PRICES_SOURCE}.`,
  'Project = an alias you set, else the git repository root, else the first folder under the directory Claude sessions start in.',
  'Responses with any count over 5M tokens are treated as damaged data and left out (a corruption guard, not a model limit).',
  'A narrow bar goes tight before it leaves anything out: "5H 76 7D 52 WARM CTX 41" (no % signs), then one-letter labels ("W" warm, "C" cold, "C 41" context). Reset times and cache minutes are then in More.',
  'Dimmed 5H / 7D figures marked "last seen" are from an earlier session, shown until this one has its own. They are never coloured or warned about.',
]

export const TABS: PaneView['tab'][] = ['overview', 'session', 'projects', 'models', 'patterns', 'settings']
export const TAB_LABEL: Record<PaneView['tab'], string> = {
  overview: 'Overview', session: 'Session', projects: 'Projects', models: 'Models', patterns: 'Patterns', settings: 'Settings',
}
/** Metric cell width in columns: two fit a ~60-column pane, one a narrow one. */
const CELL = 28

const metricOf = (s: Slice, by: 'tokens' | 'sessions' | 'messages') => (by === 'tokens' ? s.tokens : by === 'sessions' ? s.sessions.size : s.messages)
const fmtMetric = (n: number, by: 'tokens' | 'sessions' | 'messages') => (by === 'tokens' ? tok(n) : String(n))

// Queries are pure over (aggregate build, aliases, range, project): memoised so a
// redraw (a tab press, the minute tick) does not recompute them.
const memo = new Map<string, Stats>()
let memoBuild = -1
const cachedStats = (a: Agg, resolve: Resolver, sig: string, from: string, to: string, project?: string | null): Stats => {
  if (a.built !== memoBuild || memo.size > 64) { memo.clear(); memoBuild = a.built }
  const k = `${sig}|${from}|${to}|${project ?? ''}`
  let s = memo.get(k)
  if (!s) { s = stats(a, resolve, from, to, project); memo.set(k, s) }
  return s
}

/** A GitHub-style calendar of the period (at least 13 weeks), one square per day, as SVG. */
export const heatSvg = (byDay: Map<string, Slice>, from: string, to: string, by: 'tokens' | 'sessions' | 'messages', width: number) => {
  const span = Math.max(91, Math.min(371, daysBetween(from, to) + 1))
  const start = addDays(to, -(span - 1) - weekday(addDays(to, -(span - 1))))
  const weeks = Math.ceil((daysBetween(start, to) + 1) / 7)
  const cell = Math.max(7, Math.min(12, Math.floor((width - 30) / weeks) - 2))
  const step = cell + 2
  const vals: number[] = []
  for (let d = start; d <= to; d = addDays(d, 1)) { const s = byDay.get(d); vals.push(s ? metricOf(s, by) : 0) }
  const nz = vals.filter(v => v > 0).sort((a, b) => a - b)
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4)
  const fill = ['', '0.28', '0.5', '0.75', '1']
  let g = ''
  let i = 0
  for (let d = start; d <= to; d = addDays(d, 1), i++) {
    const w = Math.floor(i / 7)
    const r = weekday(d)
    const lv = level(vals[i])
    const color = lv ? ORANGE : CHART_EMPTY
    const op = lv ? ` fill-opacity="${fill[lv]}"` : ''
    g += `<rect x="${24 + w * step}" y="${r * step}" width="${cell}" height="${cell}" rx="2" fill="${color}"${op}><title>${d}: ${fmtMetric(vals[i], by)} ${by}.</title></rect>`
  }
  for (const [r, n] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const)
    g += `<text x="0" y="${r * step + cell - 1}" font-size="9" fill="${MUTED}" font-family="sans-serif">${n}</text>`
  const W = 24 + weeks * step
  const H = 7 * step
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="none"/>${g}</svg>`,
    w: W, h: H,
    alt: `Daily ${by} from ${start} to ${to}: ${nz.length} active days, busiest ${fmtMetric(nz[nz.length - 1] ?? 0, by)}.`,
  }
}

/** Daily activity tokens over the last `n` days as bars (Overview), SVG with per-day tooltips. */
export const barsSvg = (byDay: Map<string, Slice>, to: string, n: number, width: number) => {
  const days: string[] = []
  for (let d = addDays(to, -(n - 1)); d <= to; d = addDays(d, 1)) days.push(d)
  const vals = days.map(d => byDay.get(d)?.tokens ?? 0)
  const max = Math.max(1, ...vals)
  const H = 48
  const CAP = 14
  const step = Math.max(4, Math.floor((width - 4) / n))
  const bw = Math.max(2, step - 2)
  let g = ''
  days.forEach((d, i) => {
    const h = vals[i] ? Math.max(2, Math.round((vals[i] / max) * (H - 2))) : 1
    g += `<rect x="${i * step}" y="${H - h}" width="${bw}" height="${h}" rx="1" fill="${vals[i] ? ORANGE : CHART_EMPTY}"><title>${d}: ${tok(vals[i])} activity tokens.</title></rect>`
  })
  const W = n * step
  const cap = (x: number, anchor: string, t: string) => `<text x="${x}" y="${H + CAP - 3}" font-size="10" fill="${MUTED}" font-family="sans-serif" text-anchor="${anchor}">${t}</text>`
  g += cap(0, 'start', days[0].slice(5)) + cap(W, 'end', 'today') + `<text x="2" y="9" font-size="10" fill="${MUTED}" font-family="sans-serif">max ${tok(max)}</text>`
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + CAP}" viewBox="0 0 ${W} ${H + CAP}"><rect width="${W}" height="${H + CAP}" fill="none"/>${g}</svg>`,
    w: W, h: H + CAP, alt: `Daily activity tokens for the last ${n} days, highest ${tok(max)}.`,
  }
}

/** Counts per bucket as labelled bars (hours of the day, weekdays), SVG with tooltips. */
export const histSvg = (vals: number[], labels: string[], tick: (i: number) => boolean, width: number, unit: string, titles?: string[]) => {
  const n = vals.length
  const max = Math.max(1, ...vals)
  const H = 44
  const CAP = 14
  const step = Math.max(6, Math.floor(width / n))
  const bw = Math.max(3, step - 2)
  let g = ''
  vals.forEach((v, i) => {
    const h = v ? Math.max(2, Math.round((v / max) * (H - 2))) : 1
    g += `<rect x="${i * step}" y="${H - h}" width="${bw}" height="${h}" rx="1" fill="${v ? ORANGE : CHART_EMPTY}"><title>${(titles ?? labels)[i]}: ${v} ${v === 1 ? unit.replace(/s$/, '') : unit}.</title></rect>`
    if (tick(i)) g += `<text x="${i * step}" y="${H + CAP - 3}" font-size="10" fill="${MUTED}" font-family="sans-serif">${labels[i]}</text>`
  })
  const W = n * step
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + CAP}" viewBox="0 0 ${W} ${H + CAP}"><rect width="${W}" height="${H + CAP}" fill="none"/>${g}</svg>`,
    w: W, h: H + CAP, alt: labels.map((l, i) => `${l} ${vals[i]}`).join(', '),
  }
}

/**
 * The pane sits on the app's own background (light or dark), so its main text takes the
 * app's own text colour: no colour is set for it.
 */
const TEXT = undefined as unknown as string
/** Empty chart cells: a translucent grey that reads on a light and on a dark background. */
const CHART_EMPTY = 'rgba(134,149,163,0.28)'
/** Where a project's name came from, in words. */
const HOW: Record<string, string> = { alias: 'your alias', git: 'its git repository', root: 'the folder the session started in', cwd: 'its working folder' }
/** Hover cards: dark with light text, readable on a light or a dark app theme (as tooltips usually are). */
const CARD_BG = '#1f2733'
const CARD_TEXT = '#e8e6e1'

export const paneTree = (ui: El, a: Agg | null, v: View, pv: PaneView, st: Settings, note: string, columns: number, now: number, bandColumns: number | null, act: Act) => {
  const { Box, Text, Button } = ui
  const Input = ui.Input
  const Svg = ui.Svg
  const cols = Math.max(30, columns || 60)
  const out: any[] = []

  // ---- building blocks
  /** A selectable control: a native button, the selected one drawn as primary. */
  const choice = (key: string, label: string, on: boolean, press: () => void) => (
    <Button key={key} variant={on ? 'primary' : 'secondary'} label={label} onPress={press} />
  )
  const row = (key: string, kids: any[]) => <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>{kids.filter(Boolean)}</Box>
  // The rule is drawn shorter than the column estimate: on a proportional font a full-width
  // rule wraps a stub onto a second line.
  const rule = '─'.repeat(Math.max(8, Math.min(Math.floor((cols - 2) * 0.7), 90)))
  /** A subtitle as a sentence: capital first letter, full stop. */
  const sentence = (t: string) => { const x = t.trim(); const y = x ? x[0].toUpperCase() + x.slice(1) : x; return /[.!?:]$/.test(y) ? y : y + '.' }
  // An ⓘ that opens `what` in a small dark card just above it, only while the pointer is on the
  // ⓘ itself (desktop app). The card sits above because a placed box covers what comes before
  // it, not what follows. `back`: columns the card reaches back to the left, to start under
  // its title. Without a pointer (terminal) there is no ⓘ and the caller shows a line instead.
  const CARD_W = Math.max(24, Math.min(56, cols - 4))
  const info = (key: string, what: string, back = 0) => act.hover ? (
    <Box key={`i-${key}`} flexDirection="row" flexShrink={0}>
      <Text color={MUTED}> ⓘ</Text>
      <Box position="absolute" bottom={1} left={-Math.min(back, 20)} width={CARD_W} display="none" hover={{ display: 'flex' }}
        borderStyle="round" borderColor={LINE} backgroundColor={CARD_BG} paddingX={1}>
        <Text color={CARD_TEXT}>{what}</Text>
      </Box>
    </Box>
  ) : null
  /** A note that, in the desktop app, lives behind an ⓘ instead (see `info`). */
  const aside = (key: string, text: string, color = MUTED) => (act.hover ? null : note1(key, text, color))
  /** `period`: the period choice sits under this heading (the part of the tab it changes). `gap`: lines above. `help`: an ⓘ. */
  const section = (key: string, title: string, sub?: string, o: { period?: boolean; gap?: number; help?: string } = {}) => (
    <Box key={key} flexDirection="column" marginTop={o.gap ?? 1}>
      {o.help && act.hover ? <Box flexDirection="row"><Text color={TEXT} bold>{title}</Text>{info(key, o.help, title.length)}</Box> : <Text color={TEXT} bold>{title}</Text>}
      {sub ? <Text color={MUTED}>{sentence(sub)}</Text> : null}
      <Text color={LINE}>{rule}</Text>
      {o.period && periodRow ? periodRow : null}
    </Box>
  )
  /** One metric: label over value, in a fixed-width cell of a wrapping grid. */
  // Narrow pane: one metric per line, label then value (half the height of label-over-value).
  // Wide pane: label over value in fixed-width cells that flow into columns.
  const narrowPane = cols < CELL * 2 + 4
  const metricLabel = (key: string, label: string, help?: string) => (help && act.hover
    ? <Box flexDirection="row"><Text color={MUTED}>{label}</Text>{info(key, help, label.length)}</Box>
    : <Text color={MUTED}>{label}</Text>)
  const metric = (key: string, label: string, value: string, color = TEXT, hint?: string, help?: string) => narrowPane ? (
    <Box key={key} flexDirection="row" flexWrap="wrap" width="100%">
      <Box width={19} flexShrink={0}>{metricLabel(key, label, help)}</Box>
      <Text color={color} bold>{value}</Text>{hint ? <Text color={MUTED}>{' ' + hint}</Text> : null}
    </Box>
  ) : (
    <Box key={key} width={CELL} flexShrink={0} flexDirection="column" marginBottom={0}>
      {metricLabel(key, label, help)}
      <Box flexDirection="row"><Text color={color} bold>{value}</Text>{hint ? <Text color={MUTED}>{' ' + hint}</Text> : null}</Box>
    </Box>
  )
  const grid = (key: string, cells: any[]) => <Box key={key} flexDirection="row" flexWrap="wrap">{cells.filter(Boolean)}</Box>
  const note1 = (key: string, text: string, color = MUTED) => <Text key={key} color={color}>{text}</Text>
  const cell = (k: string, t: string, w: number, c = TEXT, b = false) => <Box key={k} width={w} flexShrink={0}><Text color={c} bold={b}>{t}</Text></Box>

  // ---- tabs (and the help toggle)
  /** The period choice, drawn under the heading it applies to (section's `period`). */
  let periodRow: any = null
  const tabs = TABS.map(t => choice(`tab-${t}`, TAB_LABEL[t], pv.tab === t, () => act.setView(x => ({ ...x, tab: t, project: null }))))
  tabs.push(<Button key="help" plain dimColor={!pv.help} label={pv.help ? '? Terms ▴' : '? Terms ▾'} onPress={() => act.setView(x => ({ ...x, help: !x.help }))} />)
  out.push(row('tabs', tabs))
  if (pv.help) out.push(<Box key="help-box" flexDirection="column" marginTop={1}>{HELP.map((line, i) => <Text key={`help-${i}`} color={MUTED}>· {line}</Text>)}</Box>)

  if (!a || !a.today) {
    if (pv.tab === 'settings') out.push(note1('empty', 'No history read yet.'))
    out.push(<Text key="empty" color={MUTED}>No history yet. {note || 'Reading transcripts…'}</Text>)
    return <Box flexDirection="column" paddingX={1}>{out}</Box>
  }

  const period: Period = pv.period ?? st.period
  const today = localDay(now, a.tz)
  const rg = rangeOf(period, today, firstDay(a))
  const usesPeriod = pv.tab === 'overview' || pv.tab === 'projects' || pv.tab === 'models' || pv.tab === 'patterns'
  if (usesPeriod) {
    periodRow = (row('periods', [
      <Text key="pl" color={MUTED}>Period</Text>,
      ...PERIODS.map(p => choice(`p-${p}`, PERIOD_LABEL[p], p === period, () => act.setView(x => ({ ...x, period: p })))),
    ]))
  }
  const aliases = st.aliases ?? []
  const sig = aliases.map(x => `${x.path}=${x.name}`).join(';')
  const resolve = makeResolver(a, aliases)
  const q = (from: string, to: string, project?: string | null) => cachedStats(a, resolve, sig, from, to, project)
  const cur = q(rg.from, rg.to)
  const prev = rg.prev ? q(rg.prev.from, rg.prev.to) : null
  const nameOf = (key: string) => cur.names.get(key) ?? prev?.names.get(key) ?? resolve(key).name ?? key
  const sessionsOf = (s: Stats) => [...s.bySession.entries()]
  const nDays = daysBetween(rg.from, rg.to) + 1
  const tr = (n: number, p: number | undefined) => (p === undefined ? undefined : trend(change(n, p)) || undefined)
  const s = v.session

  // ---------------------------------------------------------------- Overview
  if (pv.tab === 'overview') {
    out.push(section('h-ov', `OVERVIEW · ${PERIOD_LABEL[period]}`, rg.prev ? `trend against the previous ${nDays === 1 ? 'day' : `${nDays} days`}` : undefined, { period: true }))
    const sk = streaks(a, today)
    const topModel = [...cur.byModel.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
    const topProject = [...cur.byProject.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
    out.push(grid('ov', [
      metric('ov-t', 'Activity tokens', tok(cur.all.tokens), TEXT, tr(cur.all.tokens, prev?.all.tokens), 'Uncached input + cache writes + output: the main measure of how much you used Claude. Cache reads are not in it.'),
      metric('ov-s', 'Sessions', String(cur.all.sessions.size), TEXT, tr(cur.all.sessions.size, prev?.all.sessions.size)),
      metric('ov-m', 'Messages', String(cur.all.messages), TEXT, tr(cur.all.messages, prev?.all.messages)),
      metric('ov-d', 'Active days', `${cur.all.days.size} of ${nDays}`, TEXT, undefined, 'Days in the period with at least one message.'),
      metric('ov-k', 'Streak', `${sk.current}d`, TEXT, `longest ${sk.longest}d`, 'Days in a row, up to today, with at least one message; and the longest run so far.'),
      metric('ov-r', 'Cache reads', tok(cur.all.cr), MUTED, `processed ${tok(cur.all.processed)}`, 'Context Claude read back from the prompt cache. Counted apart: the same context is re-read every turn and would swamp the rest. Processed = activity tokens + cache reads.'),
      topProject ? metric('ov-p', 'Top project', nameOf(topProject[0]), TEXT, cur.all.tokens ? pct((topProject[1].tokens / cur.all.tokens) * 100) : undefined) : null,
      topModel ? metric('ov-md', 'Top model', modelName(topModel[0]), TEXT, cur.all.tokens ? pct((topModel[1].tokens / cur.all.tokens) * 100) : undefined) : null,
    ]))
    // This week so far against the same days of last week (Monday start, local dates).
    const wk = weekRange(today)
    const tw = q(wk.from, today)
    const lw = q(wk.prevFrom, addDays(wk.prevFrom, wk.days - 1))
    const lwAll = q(wk.prevFrom, wk.prevTo)
    const busiest = [...tw.byDay.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
    const twProject = [...tw.byProject.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
    const twModel = [...tw.byModel.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
    out.push(section('h-wk', 'THIS WEEK', `Monday to today, against the same ${wk.days === 1 ? 'day' : `${wk.days} days`} of last week`))
    out.push(grid('wk', [
      metric('wk-t', 'Activity tokens', tok(tw.all.tokens), TEXT, tr(tw.all.tokens, lw.all.tokens) ?? `last week ${tok(lwAll.all.tokens)} in all`, 'Uncached input + cache writes + output: the main measure of how much you used Claude. Cache reads are not in it.'),
      metric('wk-s', 'Sessions', String(tw.all.sessions.size), TEXT, tr(tw.all.sessions.size, lw.all.sessions.size)),
      metric('wk-d', 'Active days', `${tw.all.days.size} of ${wk.days}`, TEXT, `last week ${lw.all.days.size} of ${wk.days}`),
      busiest ? metric('wk-b', 'Busiest day', `${DAYS[weekday(busiest[0])]} ${busiest[0].slice(5)}`, TEXT, tok(busiest[1].tokens)) : null,
      twProject ? metric('wk-p', 'Top project', tw.names.get(twProject[0]) ?? nameOf(twProject[0]), TEXT, tw.all.tokens ? pct((twProject[1].tokens / tw.all.tokens) * 100) : undefined) : null,
      twModel ? metric('wk-m', 'Top model', modelName(twModel[0]), TEXT, tw.all.tokens ? pct((twModel[1].tokens / tw.all.tokens) * 100) : undefined) : null,
    ]))
    out.push(section('h-da', 'DAILY ACTIVITY', 'activity tokens, last 30 days'))
    const last30 = q(addDays(today, -29), today)
    if (Svg) {
      const b = barsSvg(last30.byDay, today, 30, Math.min(cols * 7, 520))
      out.push(<Box key="bars"><Svg source={b.source} alt={b.alt} width={b.w} height={b.h} isInteractive /></Box>)
    } else {
      const days: number[] = []
      for (let d = addDays(today, -29); d <= today; d = addDays(d, 1)) days.push(last30.byDay.get(d)?.tokens ?? 0)
      const mx = Math.max(1, ...days)
      out.push(<Text key="bars-t" color={ORANGE}>{days.map(x => ' ▁▂▃▄▅▆▇█'[Math.ceil((x / mx) * 8)]).join('')}</Text>)
    }
    if (s) {
      out.push(section('h-now', 'THIS SESSION', 'the conversation you are in now'))
      out.push(row('now', [
        <Text key="t" color={MUTED}>{`${s.project?.name ?? 'This session'} · ${s.tokens !== null ? tok(s.tokens) + ' activity tokens' : ''}${v.ctx ? ` · context ${v.ctx.percent}%` : ''}`}</Text>,
        <Button key="go-session" plain label="Session ›" onPress={() => act.setView(x => ({ ...x, tab: 'session' }))} />,
      ]))
    }
    about()
  }

  // ---------------------------------------------------------------- Session
  if (pv.tab === 'session') {
    if (!s) out.push(note1('ns', 'No figures for this session yet: they appear after the first reply.'))
    else {
      out.push(section('h-id', 'THIS SESSION', s.project ? `project named from ${HOW[s.project.source] ?? s.project.source}` : undefined))
      out.push(grid('id', [
        s.project ? metric('id-p', 'Project', s.project.name) : null,
        s.model ? metric('id-m', 'Model', modelName(s.model)) : null,
        s.startedAt ? metric('id-s', 'Started', when(s.startedAt, a.tz, now)) : null,
        s.elapsedMs ? metric('id-e', 'Elapsed', dur(s.elapsedMs)) : null,
        s.activeMs ? metric('id-a', 'Active (est.)', dur(s.activeMs), TEXT, undefined, 'Time spent working: the gaps under 30 minutes between events, added up. Long breaks are left out.') : null,
        s.messages !== null ? metric('id-n', 'Messages', String(s.messages), TEXT, s.prompts !== null ? `${s.prompts} prompts` : undefined) : null,
      ]))
      out.push(section('h-tk', 'TOKENS'))
      out.push(grid('tk', [
        s.tokens !== null ? metric('tk-a', 'Activity tokens', tok(s.tokens), TEXT, undefined, 'Uncached input + cache writes + output: the main measure of how much you used Claude. Cache reads are not in it.') : null,
        s.input !== null ? metric('tk-i', 'Input (uncached)', tok(s.input), TEXT, undefined, 'Input that was new to the model: not read from the prompt cache.') : null,
        s.cacheWrite !== null ? metric('tk-w', 'Cache writes', tok(s.cacheWrite), TEXT, undefined, 'Input stored in the prompt cache, so later turns can read it back for less.') : null,
        s.output !== null ? metric('tk-o', 'Output tokens', tok(s.output)) : null,
        s.cacheRead !== null ? metric('tk-r', 'Cache reads', tok(s.cacheRead), MUTED, 'kept separate', 'Context Claude read back from the prompt cache. Counted apart: the same context is re-read every turn and would swamp the rest. Processed = activity tokens + cache reads.') : null,
      ]))
    }
    if (v.ctx) {
      const g = v.growth
      const d = dots(v.ctx.percent, 20)
      const col = v.ctx.isNearLimit ? WARM : TEXT
      out.push(section('h-ch', 'CONTEXT HEALTH', undefined, { help: "How full this conversation is. Near the model's limit, Claude compacts it: older turns are summarised to make room." }))
      out.push(<Box key="ch-m" flexDirection="row"><Text color={col}>{d.on}</Text><Text color={EMPTY}>{d.off}</Text><Text color={col} bold>{` ${v.ctx.percent}% used`}</Text></Box>)
      out.push(grid('ch', [
        metric('ch-u', 'Used', `${tok(v.ctx.tokens)} of ${tok(v.ctx.window)}`),
        metric('ch-l', 'Left', tok(v.ctx.left)),
        s?.compactions !== null && s?.compactions !== undefined ? metric('ch-c', 'Compactions', String(s.compactions), TEXT, s.lastCompactionAgo !== null ? `last ${dur(s.lastCompactionAgo)} ago` : undefined, 'Times this conversation was summarised to free room.') : null,
        g && g.l5.turns >= 2 ? metric('ch-5', 'Last 5 turns', signed(g.l5.sum)) : null,
        g && g.l10.turns > (g?.l5.turns ?? 0) ? metric('ch-10', 'Last 10 turns', signed(g.l10.sum)) : null,
        g && g.l10.turns >= 2 ? metric('ch-g', 'Avg growth', `${signed(g.avg)}/turn`, TEXT, [g.pace, g.direction].filter(Boolean).join(', '), 'How much the context grows per turn, on average over the last 10 turns.') : null,
      ]))
      if (g?.l10.broken) out.push(note1('ch-b', 'A compaction inside the last 10 turns is left out of growth.'))
      if (v.ctx.isNearLimit) out.push(note1('ch-w', "Within 10% of the model's context window: auto-compaction may run soon.", WARM))
    }
    const c = v.cache
    if (c) {
      const hue = c.mode === 'warm' ? WARM : COLD
      out.push(section('h-ca', 'CACHE', 'inferred from request timing', { help: "The prompt cache is taken as warm for 60 minutes after a model's last request (each model has its own). Claude does not report it; Lucelis works it out from timing." }))
      out.push(<Box key="ca-chip" flexDirection="row"><Text backgroundColor={hue} color={INK} bold>{` ${c.mode === 'warm' ? 'WARM' : 'COLD'} `}</Text><Text color={hue}>{c.mode === 'warm' ? `  cold in ~${c.minsLeft}m` : `  idle ${dur(c.idleMs)}`}</Text></Box>)
      out.push(grid('ca', [
        metric('ca-k', c.cached !== null ? 'Cached' : 'Context', tok(c.cached ?? c.resend)),
        c.reusable !== null ? metric('ca-r', 'Reusable next time', pct(c.reusable), TEXT, undefined, 'Share of this context the next request can read from the cache, if it is still warm.') : null,
        c.lastTurnHit !== null ? metric('ca-l', 'Last turn cached', pct(c.lastTurnHit), TEXT, undefined, "Share of the last request's input that came from the cache.") : null,
        c.sessionHit !== null ? metric('ca-s', 'Session cached', pct(c.sessionHit), TEXT, undefined, "Share of this session's input that came from the cache.") : null,
      ]))
      out.push(aside('ca-n', "The cache is taken as warm for 60 minutes after a model's last request (each model has its own). Claude does not report it."))
    }
    if (v.costs && v.cache) out.push(...costTable(ui, v, cols, 'ses'))
    const t = v.today
    const w = v.week
    const r = v.relative
    if (t?.project || w?.project || r) {
      out.push(section('h-pr', `THIS PROJECT${t?.project ? ' · ' + t.project.name : ''}`))
      out.push(grid('pt', [
        t?.project ? metric('pt-t', 'Project today', tok(t.project.tokens), TEXT, t.project.share !== null ? `${pct(t.project.share)} of today` : undefined) : null,
        t?.project ? metric('pt-s', 'Today: sessions / messages', `${t.project.sessions} / ${t.project.messages}`) : null,
        w?.project ? metric('pt-w', 'Last 7 days', tok(w.project.tokens), TEXT, w.project.change !== null ? trend(w.project.change) : undefined) : null,
        w?.share30 !== null && w?.share30 !== undefined ? metric('pt-3', '30-day share', pct(w.share30), TEXT, undefined, "This project's share of all your activity tokens in the last 30 days.") : null,
        r ? metric('pt-r', 'Tokens vs usual', `${tok(r.tokens[0])} vs ${tok(r.tokens[1])}`, TEXT, r.tokens[1] > 0 ? `${(r.tokens[0] / r.tokens[1]).toFixed(1)}×` : undefined, `This session against the usual one here: the median of this project's ${r.n} earlier sessions.`) : null,
        r && r.active[1] > 0 ? metric('pt-a', 'Active vs usual', `${dur(r.active[0])} vs ${dur(r.active[1])}`) : null,
        r ? metric('pt-m', 'Messages vs usual', `${r.messages[0]} vs ${Math.round(r.messages[1])}`) : null,
      ]))
      if (r) out.push(aside('pt-n', `"Usual" is the median of this project's ${r.n} earlier sessions.`))
      if (v.modelMix?.rows.length) out.push(note1('pt-mx', `30 days by model: ${v.modelMix.rows.map(x => `${modelName(x.model)} ${Math.round(x.share)}%`).join(' · ')}`))
    }
  }

  // ---------------------------------------------------------------- Projects
  if (pv.tab === 'projects') {
    if (pv.project) {
      const p = pv.project
      const ps = q(rg.from, rg.to, p)
      const pp = rg.prev ? q(rg.prev.from, rg.prev.to, p) : null
      out.push(<Box key="back-row" marginTop={1}><Button key="back" label="‹ All projects" variant="secondary" onPress={() => act.setView(x => ({ ...x, project: null }))} /></Box>)
      out.push(section('h-pd', `${nameOf(p)} · ${PERIOD_LABEL[period]}`, `named from ${HOW[resolve(p).source] ?? resolve(p).source}: ${p}`, { period: true }))
      const ss = sessionsOf(ps).map(([sid, x]) => ({ sid, x, s: a.sess[sid] }))
      const toks = ss.map(r => r.x.tokens)
      const msgs = ss.map(r => r.x.messages)
      const longest = ss.filter(r => r.s).sort((x, y) => y.s.act - x.s.act)[0]
      const topM = [...ps.byModel.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
      const busiest = [...ps.byDay.entries()].sort((x, y) => y[1].tokens - x[1].tokens)[0]
      out.push(grid('pd', [
        metric('pd-t', 'Activity tokens', tok(ps.all.tokens), TEXT, pp ? tr(ps.all.tokens, pp.all.tokens) : undefined),
        metric('pd-r', 'Cache reads', tok(ps.all.cr), MUTED),
        metric('pd-s', 'Sessions', String(ps.all.sessions.size)),
        metric('pd-m', 'Messages', String(ps.all.messages)),
        metric('pd-a', 'Tokens / session', `${tok(mean(toks))} avg`, TEXT, `${tok(median(toks))} median`),
        metric('pd-b', 'Messages / session', `${Math.round(mean(msgs))} avg`, TEXT, `${Math.round(median(msgs))} median`),
        longest ? metric('pd-l', 'Longest (active est.)', dur(longest.s.act), TEXT, (longest.s.title || longest.sid.slice(0, 8)).slice(0, 24), 'Time spent working: the gaps under 30 minutes between events, added up. Long breaks are left out.') : null,
        topM ? metric('pd-tm', 'Top model', modelName(topM[0])) : null,
        busiest ? metric('pd-bd', 'Busiest day', busiest[0], TEXT, DAYS[weekday(busiest[0])]) : null,
      ]))
      out.push(section('h-pdr', 'RECENT SESSIONS'))
      const recent = ss.filter(r => r.s).sort((x, y) => y.s.last - x.s.last).slice(0, 6)
      for (const r of recent) {
        out.push(
          <Box key={`pdr-${r.sid}`} flexDirection="column" marginBottom={0}>
            <Text color={TEXT}>{r.s.title || r.sid.slice(0, 8)}</Text>
            <Text color={MUTED}>{`${when(r.s.last, a.tz, now)} · ${tok(r.x.tokens)} tokens · ${r.x.messages} messages · ${dur(r.s.act)} active`}</Text>
          </Box>,
        )
      }
    } else {
      out.push(section('h-pr', `PROJECTS · ${PERIOD_LABEL[period]}`, 'ranked by activity tokens', { period: true, help: 'Share and trend use activity tokens. Select a project for its own breakdown. Names come from your aliases, git repositories or folders (Settings, Project names).' }))
      const rows = [...cur.byProject.entries()].sort((x, y) => y[1].tokens - x[1].tokens)
      const wide = cols >= 70
      if (wide) {
        const W = [22, 10, 7, 9, 9, 7, 9]
        out.push(<Box key="pr-h" flexDirection="row">{['Project', 'Tokens', 'Share', 'Trend', 'Sessions', 'Msgs', 'Days'].map((t, i) => cell(`ph${i}`, t, W[i], MUTED, true))}</Box>)
        for (const [p, x] of rows) {
          const pr = prev?.byProject.get(p)
          out.push(
            <Box key={`pr-${p}`} flexDirection="row" alignItems="center">
              <Box width={W[0]} flexShrink={0}><Button key={`open-${p}`} plain label={nameOf(p).length > 20 ? nameOf(p).slice(0, 19) + '…' : nameOf(p)} onPress={() => act.setView(y => ({ ...y, project: p }))} /></Box>
              {cell(`${p}1`, tok(x.tokens), W[1], TEXT, true)}
              {cell(`${p}2`, cur.all.tokens ? pct((x.tokens / cur.all.tokens) * 100) : '–', W[2], MUTED)}
              {cell(`${p}3`, prev ? (pr ? trend(change(x.tokens, pr.tokens)) : 'new') : '', W[3], MUTED)}
              {cell(`${p}4`, String(x.sessions.size), W[4])}
              {cell(`${p}5`, String(x.messages), W[5])}
              {cell(`${p}6`, String(x.days.size), W[6])}
            </Box>,
          )
        }
      } else {
        for (const [p, x] of rows) {
          const pr = prev?.byProject.get(p)
          const share = cur.all.tokens ? (x.tokens / cur.all.tokens) * 100 : 0
          const d = dots(share, 10)
          out.push(
            <Box key={`pr-${p}`} flexDirection="column" marginBottom={0}>
              <Box flexDirection="row" alignItems="center">
                <Button key={`open-${p}`} plain label={`${nameOf(p)} ›`} onPress={() => act.setView(y => ({ ...y, project: p }))} />
              </Box>
              <Box flexDirection="row" flexWrap="wrap">
                <Text color={ORANGE}>{d.on}</Text><Text color={EMPTY}>{d.off}</Text>
                <Text color={TEXT} bold>{` ${tok(x.tokens)}`}</Text>
                <Text color={MUTED}>{` · ${pct(share)} · ${x.sessions.size} sessions · ${x.messages} messages${prev ? ' · ' + (pr ? trend(change(x.tokens, pr.tokens)) : 'new') : ''}`}</Text>
              </Box>
            </Box>,
          )
        }
      }
      out.push(aside('pr-n', 'Share and trend use activity tokens. Select a project for its details. Project names come from your aliases, git repositories or folders (see Settings).'))
    }
  }

  // ---------------------------------------------------------------- Models
  if (pv.tab === 'models') {
    const by = pv.modelBy
    // First on this tab: "Compare models" in the band lands here.
    if (v.costs && v.cache) out.push(...costTable(ui, v, cols, 'mod'))
    else out.push(section('h-nm-none', 'NEXT MESSAGE', 'by model'), note1('nm-none', 'No estimate yet: it needs the first reply of this session (the context size and the cache clock).'))
    out.push(section('h-md', `MODELS · ${PERIOD_LABEL[period]}`, undefined, { period: true }))
    out.push(row('md-m', [<Text key="l" color={MUTED}>Compare by</Text>, ...(['tokens', 'sessions', 'messages'] as const).map(m => choice(`md-${m}`, m[0].toUpperCase() + m.slice(1), by === m, () => act.setView(x => ({ ...x, modelBy: m }))))]))
    const rows = [...cur.byModel.entries()].map(([m, x]) => ({ m, x, n: metricOf(x, by) })).sort((x, y) => y.n - x.n)
    const total = rows.reduce((x, y) => x + y.n, 0) || 1
    for (const r of rows) {
      const share = (r.n / total) * 100
      const d = dots(share, Math.max(8, Math.min(20, cols - 34)))
      out.push(
        <Box key={`md-${r.m}`} flexDirection="row" flexWrap="wrap">
          {cell(`${r.m}n`, modelName(r.m), 12, TEXT)}
          {cell(`${r.m}v`, fmtMetric(r.n, by), 9, TEXT, true)}
          {cell(`${r.m}p`, pct(share), 6, MUTED)}
          <Text color={ORANGE}>{d.on}</Text><Text color={EMPTY}>{d.off}</Text>
        </Box>,
      )
    }
    if (by === 'sessions') out.push(note1('md-n', 'A session that used two models counts for both.'))
    out.push(section('h-mc', 'CACHE USE BY MODEL', undefined, { help: 'Writes: input stored in the cache. Reads: input read back from it. From cache: reads as a share of all input the model received in the period.' }))
    const W = [12, 9, 9, 9]
    out.push(<Box key="mc-h" flexDirection="row">{['Model', 'Writes', 'Reads', 'From cache'].map((t, i) => cell(`mch${i}`, t, W[i], MUTED, true))}</Box>)
    for (const r of rows) {
      const inAll = r.x.input + r.x.cw + r.x.cr
      out.push(
        <Box key={`mc-${r.m}`} flexDirection="row">
          {cell(`${r.m}a`, modelName(r.m), W[0])}
          {cell(`${r.m}b`, tok(r.x.cw), W[1])}
          {cell(`${r.m}c`, tok(r.x.cr), W[2], MUTED)}
          {cell(`${r.m}d`, inAll ? pct((r.x.cr / inAll) * 100) : '–', W[3])}
        </Box>,
      )
    }
    out.push(aside('mc-n', 'From cache = cache reads as a share of all input the model received in the period.'))
  }

  // ---------------------------------------------------------------- Patterns
  if (pv.tab === 'patterns') {
    const by = pv.heat ?? st.heat
    out.push(section('h-hm', 'ACTIVITY HEATMAP', 'one square per day, darker is more', { period: true, help: 'Each square is one day; darker means more of the metric chosen below. Point at a square to see its date and value.' }))
    out.push(row('hm-m', [<Text key="l" color={MUTED}>Metric</Text>, ...(['tokens', 'sessions', 'messages'] as const).map(m => choice(`hm-${m}`, m[0].toUpperCase() + m.slice(1), by === m, () => act.setView(x => ({ ...x, heat: m }))))]))
    const all = q(addDays(today, -370), today)
    if (Svg) {
      const hm = heatSvg(all.byDay, period === 'today' || period === '7d' || period === '30d' ? addDays(today, -90) : rg.from, today, by, Math.min(cols * 8, 760))
      out.push(<Box key="hm"><Svg source={hm.source} alt={hm.alt} width={hm.w} height={hm.h} isInteractive /></Box>)
    } else {
      const days: string[] = []
      for (let d = addDays(today, -27); d <= today; d = addDays(d, 1)) days.push(d)
      const max = Math.max(1, ...days.map(d => (all.byDay.get(d) ? metricOf(all.byDay.get(d)!, by) : 0)))
      out.push(<Text key="hm-t" color={ORANGE}>{days.map(d => ' ░▒▓█'[Math.ceil(((all.byDay.get(d) ? metricOf(all.byDay.get(d)!, by) : 0) / max) * 4)]).join('')}</Text>)
    }
    const sk = streaks(a, today)
    out.push(grid('hm-s', [
      metric('hm-d', 'Active days', `${cur.all.days.size} of ${nDays}`),
      metric('hm-k', 'Current streak', `${sk.current}d`),
      metric('hm-l', 'Longest streak', `${sk.longest}d`),
    ]))
    const pt = patterns(a, rg.from, rg.to, 'messages')
    const tt = patterns(a, rg.from, rg.to, 'tokens')
    out.push(section('h-tp', `TIME PATTERNS · ${PERIOD_LABEL[period]}`, 'local time', { help: 'When you use Claude, by hour and by weekday, in your local time. Hours and weekdays count messages.' }))
    const hourLabels = pt.hours.map((_, h) => String(h).padStart(2, '0'))
    if (Svg) {
      const hs = histSvg(pt.hours, hourLabels, i => i % 6 === 0, Math.min(cols * 7, 480), 'messages', pt.hours.map((_, h) => `${String(h).padStart(2, '0')}:00 to ${String((h + 1) % 24).padStart(2, '0')}:00`))
      out.push(<Box key="tp-h"><Svg source={hs.source} alt={hs.alt} width={hs.w} height={hs.h} isInteractive /></Box>)
    } else {
      const mx = Math.max(1, ...pt.hours)
      out.push(<Text key="tp-h" color={ORANGE}>{pt.hours.map(h => ' ▁▂▃▄▅▆▇█'[Math.ceil((h / mx) * 8)]).join('')}</Text>)
    }
    const sumP = Object.values(pt.parts).reduce((x, y) => x + y, 0) || 1
    out.push(grid('tp', [
      pt.peakHour >= 0 ? metric('tp-ph', 'Peak hour, messages', HOURS(pt.peakHour)) : null,
      tt.peakHour >= 0 ? metric('tp-pt', 'Peak hour, tokens', HOURS(tt.peakHour)) : null,
      pt.peakDay >= 0 ? metric('tp-pd', 'Peak weekday', DAYS[pt.peakDay], TEXT, 'by messages') : null,
      metric('tp-m', 'Morning (05–12)', pct((pt.parts.morning / sumP) * 100)),
      metric('tp-a', 'Afternoon (12–17)', pct((pt.parts.afternoon / sumP) * 100)),
      metric('tp-e', 'Evening (17–22)', pct((pt.parts.evening / sumP) * 100)),
      metric('tp-n', 'Night (22–05)', pct((pt.parts.night / sumP) * 100)),
    ]))
    if (Svg) {
      const ws = histSvg(pt.week, DAYS, () => true, Math.min(cols * 7, 300), 'messages', ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'])
      out.push(<Box key="tp-w" marginTop={1}><Svg source={ws.source} alt={ws.alt} width={ws.w} height={ws.h} isInteractive /></Box>)
    } else {
      const wmx = Math.max(1, ...pt.week)
      for (const [i, n] of pt.week.entries()) out.push(<Box key={`tp-w${i}`} flexDirection="row"><Box width={5} flexShrink={0}><Text color={MUTED}>{DAYS[i]}</Text></Box><Text color={ORANGE}>{'▮'.repeat(Math.max(n ? 1 : 0, Math.round((n / wmx) * 10)))}</Text></Box>)
    }
    out.push(aside('tp-x', 'Hours and weekdays count messages.'))
    out.push(section('h-sp', 'SESSION PATTERNS'))
    const ss = sessionsOf(cur).map(([sid, x]) => ({ sid, x, s: a.sess[sid] })).filter(r => r.s)
    const acts = ss.map(r => r.s.act).filter(x => x > 0)
    const toks = ss.map(r => r.x.tokens)
    const msgs = ss.map(r => r.x.messages)
    out.push(grid('sp', [
      acts.length ? metric('sp-a', 'Active / session', dur(median(acts)), TEXT, `median · avg ${dur(mean(acts))}`, 'Time spent working: the gaps under 30 minutes between events, added up. Long breaks are left out.') : null,
      metric('sp-t', 'Tokens / session', tok(median(toks)), TEXT, `median · avg ${tok(mean(toks))}`),
      metric('sp-m', 'Messages / session', String(Math.round(median(msgs))), TEXT, `median · avg ${Math.round(mean(msgs))}`),
      metric('sp-b', 'Sessions over 100K', String(toks.filter(x => x > 100_000).length), TEXT, undefined, 'Sessions with more than 100K activity tokens in the period.'),
    ]))
    const longest = [...ss].sort((x, y) => y.x.tokens - x.x.tokens).slice(0, 5)
    if (longest.length) out.push(note1('sp-h', 'Largest sessions in the period:'))
    for (const r of longest) {
      out.push(
        <Box key={`sp-${r.sid}`} flexDirection="column">
          <Text color={TEXT}>{r.s.title || r.sid.slice(0, 8)}</Text>
          <Text color={MUTED}>{`${tok(r.x.tokens)} tokens · ${r.x.messages} messages · ${dur(r.s.act)} active · ${resolve(r.s.cwd ?? '').name}`}</Text>
        </Box>,
      )
    }
  }

  // ---------------------------------------------------------------- Settings
  // Groups, in this order: how the bar looks, what it shows, the low-quota warning, how this
  // pane opens, how projects are named, and the history data. Each group has a heading, a
  // line on what it is for, and space above it; each control a line saying what it does.
  if (pv.tab === 'settings') {
    const group = (key: string, title: string, sub: string) => section(key, title, sub, { gap: 2 })
    // A setting: its title, its choices, and what it does: behind the ⓘ in the desktop app
    // (`info`), a line under the setting elsewhere.
    const setting = (key: string, label: string, choices: any[], what: string) => act.hover ? (
      <Box key={key} flexDirection="column" marginBottom={1}>
        {row(`${key}-r`, [
          <Box key="lw" width={20} flexShrink={0} flexDirection="row">
            <Text bold>{label}</Text>{info(key, what, label.length)}
          </Box>, ...choices])}
      </Box>
    ) : (
      <Box key={key} flexDirection="column" marginBottom={1}>
        {row(`${key}-r`, [<Box key="lw" width={20} flexShrink={0}><Text bold>{label}</Text></Box>, ...choices])}
        <Text key="w" color={MUTED}>{what}</Text>
      </Box>
    )
    const onOff = (key: string, value: boolean, set: (v: boolean) => void) => [
      choice(`${key}-on`, 'On', value, () => set(true)),
      choice(`${key}-off`, 'Off', !value, () => set(false)),
    ]

    // ---- 1. Appearance
    out.push(section('h-st', 'APPEARANCE', 'How the bar above the prompt looks', { gap: 1 }))
    out.push(setting('st1', 'Show bar', onOff('st', st.isOn, v => act.setSettings(x => ({ ...x, isOn: v }))), 'Turns the whole Lucelis bar above the prompt on or off.'))
    if (!st.isOn) out.push(note1('st-offn', 'The bar is off. The row above the prompt is left to Claude Code or another plugin. Turn it on again here, or with /lucelis-settings.', WARM))
    out.push(setting('st1b', 'Display mode', (['minimal', 'normal', 'detailed'] as const).map(m => choice(`st-${m}`, m[0].toUpperCase() + m.slice(1), st.mode === m, () => act.setSettings(x => ({ ...x, mode: m })))),
      st.mode === 'minimal' ? 'Minimal: only the 5H and 7D quotas.'
        : st.mode === 'normal' ? 'Normal: one row with every enabled item that fits, usage first.'
        : 'Detailed: always two rows. The second row holds project, session, today, elapsed, trend and model.'))
    out.push(setting('st1c', 'Second row', onOff('wr', !!st.wrap, v => act.setSettings(x => ({ ...x, wrap: v }))), 'In Normal mode, items that do not fit on the first row move to a second row. A wide window stays on one row.'))
    out.push(setting('st1d', 'Lucelis logo', onOff('lg', !!st.logo, v => act.setSettings(x => ({ ...x, logo: v }))), 'The logo at the start of the bar (desktop app). Its bars draw in while Claude is working, and it turns red while a quota is low.'))
    out.push(setting('st1e', 'Bar background', onOff('bg', !!st.bg, v => act.setSettings(x => ({ ...x, bg: v }))), "On: a navy fill behind the bar items. Off: the bar uses the app's own background and text colour."))

    // ---- 2. Compact bar items
    out.push(group('h-sh', 'COMPACT BAR ITEMS', 'What the bar shows. In priority order: placed first, dropped last'))
    // Each item's real state on the bar right now (the same layout code the bar draws with).
    const lay = st.isOn && bandColumns ? barLayout(v, st, bandColumns) : null
    const SAY: Record<ItemState, [string, string]> = {
      shown: ['Shown', GOOD],
      off: ['Off', EMPTY],
      density: ['On, hidden in Minimal mode (quotas only)', ORANGE],
      width: ['On, no room at this width', ORANGE],
      nodata: ['On, no data yet', MUTED],
    }
    for (const it of ITEMS) {
      const on = st.show[it.key]
      const state: ItemState | null = !on ? 'off' : lay ? lay.state[it.key] : null
      const [text, color] = state ? SAY[state] : ['On', MUTED]
      out.push(
        <Box key={`it-${it.key}`} flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
          <Box width={24} flexShrink={0} flexDirection="row">{choice(`sh-${it.key}`, `${on ? '✓' : '○'} ${it.label}`, on, () => act.setSettings(x => ({ ...x, show: { ...x.show, [it.key]: !x.show[it.key] } })))}</Box>
          <Text key="state" color={color}>{state === 'nodata' ? `${text}: ${it.nodata}` : text}</Text>
        </Box>,
      )
    }
    if (lay) {
      const waiting = ITEMS.filter(it => lay.state[it.key] === 'width').map(it => it.label)
      out.push(<Box key="st-wb" marginTop={1}>{note1('st-w', `The bar is ${bandColumns} columns wide now${waiting.length ? `: no room for ${waiting.join(', ')}. This pane narrows the bar while it is open. Close it (Details) or widen the window and they appear, in the order above. Turning an item off gives its room to the next one.` : ' and every enabled item with data fits.'}`, waiting.length ? ORANGE : MUTED)}</Box>)
    } else if (!st.isOn) out.push(note1('st-w', 'The bar is off, so no item is drawn.'))
    out.push(note1('st-e', 'A toggle always wins: nothing is forced onto the bar. With every item off the bar says so and keeps its two buttons.'))

    // ---- 3. Low-quota warning: one choice per quota
    const w = st.warn
    out.push(group('h-wn', 'LOW-QUOTA WARNING', 'When a quota is low, its figure and the logo turn red. You can also be told about it'))
    for (const [k, label, name] of [['h5', '5H quota', '5-hour'], ['d7', '7D quota', '7-day']] as const) {
      const lvl = w[k] ?? 30
      out.push(setting(`wn-${k}`, label, [
        choice(`wn-${k}-0`, 'Off', lvl === 0, () => act.setSettings(x => ({ ...x, warn: { ...x.warn, [k]: 0 } }))),
        ...LEVELS.map(n => choice(`wn-${k}-${n}`, `${n}%`, lvl === n, () => act.setSettings(x => ({ ...x, warn: { ...x.warn, [k]: n } })))),
      ], lvl
        ? `At ${lvl}% left or less, the ${name} figure and the logo turn red.`
        : `Off: the ${name} figure is never red and you are never told about it.`))
    }
    const setWarn = (p: Partial<Settings['warn']>) => act.setSettings(x => ({ ...x, warn: { ...x.warn, ...p } }))
    out.push(<Box key="wn-how" marginTop={1}><Text bold>How to tell you</Text></Box>)
    out.push(note1('wn-how-n', 'Once per quota window, in one open session only. All off unless you turn them on.'))
    out.push(<Box key="wn-gap" marginTop={1} />)
    out.push(setting('wn2', 'Pop-up in the app', onOff('wt', !!w.toast, v => setWarn({ toast: v })), 'A small box in the conversation for about ten seconds: "5-hour quota 25% left · resets in 2h 30m".'))
    out.push(setting('wn3', 'Windows notification', onOff('wf', !!w.notify, v => setWarn({ notify: v })), 'The same words as a Windows notification, so it reaches you when the app is in the background.'))
    if (w.notify) out.push(setting('wn4', 'Quota is back', onOff('wb', !!w.back, v => setWarn({ back: v })), 'After a warning, a Windows notification is booked for the moment that quota resets (desktop app only).'))

    // ---- 4. This pane
    out.push(group('h-sd', 'DASHBOARD', 'How this pane opens'))
    out.push(setting('st3', 'Default period', PERIODS.map(p => choice(`dp-${p}`, PERIOD_LABEL[p], st.period === p, () => act.setSettings(x => ({ ...x, period: p })))),
      'The period Overview, Projects, Models and Patterns open on. Each of those tabs can still change it for a while.'))
    out.push(setting('st4', 'Heatmap counts', (['tokens', 'sessions', 'messages'] as const).map(m => choice(`dh-${m}`, m[0].toUpperCase() + m.slice(1), st.heat === m, () => act.setSettings(x => ({ ...x, heat: m })))),
      'What each square of the heatmap on the Patterns tab counts.'))

    // ---- 5. Project names
    out.push(group('h-al', 'PROJECT NAMES', 'How the folders in your history are grouped into projects'))
    out.push(note1('al-n', 'Each folder Claude worked in is named after its git repository, or else the folder the session started in. If a name is wrong, or two folders should count as one project, add an alias: that folder and everything under it get the name you give. The longest matching folder wins.'))
    for (const [i, al] of aliases.entries()) {
      out.push(
        <Box key={`al-${i}`} flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" marginTop={1}>
          <Text color={TEXT} bold>{al.name}</Text>
          <Text color={MUTED}>{'← ' + al.path}</Text>
          <Button key={`al-rm-${i}`} variant="secondary" label="Remove" onPress={() => act.setSettings(x => ({ ...x, aliases: (x.aliases ?? []).filter((_, j) => j !== i) }))} />
        </Box>,
      )
    }
    if (Input) {
      out.push(<Box key="alias-box" marginTop={1}><Input key="alias-add" label="Add alias" value="" placeholder="C:\path\to\folder => Name" submitLabel="Add" onSubmit={(text: string) => {
        const m = /^(.+?)\s*=>\s*(.+)$/.exec(text.trim())
        if (m) act.setSettings(x => ({ ...x, aliases: [...(x.aliases ?? []).filter(y => y.path.toLowerCase() !== m[1].trim().toLowerCase()), { path: m[1].trim(), name: m[2].trim() }] }))
      }} /></Box>)
    }
    const seen = new Map<string, { name: string; source: string }>()
    for (const k in a.rows) { const pr = resolve(k.split('\t')[2]); if (!seen.has(pr.key)) seen.set(pr.key, { name: pr.name, source: pr.source }) }
    out.push(<Box key="dp-t" marginTop={1}><Button key="dp-toggle" plain label={`${pv.folders ? 'Hide' : 'Show'} the ${seen.size} project${seen.size === 1 ? '' : 's'} found ${pv.folders ? '▴' : '▾'}`} onPress={() => act.setView(x => ({ ...x, folders: !x.folders }))} /></Box>)
    if (pv.folders) {
      for (const [k, e] of [...seen.entries()].sort()) {
        out.push(
          <Box key={`dp-${k}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row"><Text color={TEXT} bold>{e.name}</Text><Text color={MUTED}>{`  named from ${HOW[e.source] ?? e.source}`}</Text></Box>
            <Text color={MUTED}>{k}</Text>
          </Box>,
        )
      }
    }

    // ---- 6. History data and export
    out.push(group('h-dd', 'HISTORY DATA', 'What Lucelis has read from your Claude transcripts'))
    out.push(setting('st5', 'Read history', [
      <Button key="refresh" variant="secondary" label="Refresh" onPress={act.refresh} />,
      <Button key="rebuild" variant="secondary" label="Rebuild cache" onPress={act.rebuild} />,
    ], 'Refresh reads what is new since the last read. Rebuild reads every transcript again (a few seconds); use it after moving or renaming folders.'))
    out.push(note1('dd-s', note ? `Last result: ${note}` : 'Last result: none yet.', note.startsWith('Refresh failed') ? WARM : TEXT))
    out.push(note1('dd-n', `Cache: ~/.claude/lucelis/cache-a.json and cache-b.json · parser v${a.v} · built ${new Date(a.built).toISOString().slice(0, 16).replace('T', ' ')} UTC${a.parseErrors ? ` · ${a.parseErrors} unreadable lines skipped` : ''}${a.shape ? ` · ${a.shape} replies in an unknown format` : ''}${a.flagged ? ` · ${a.flagged} damaged records left out` : ''}`))
    out.push(<Box key="ex-gap" marginTop={1}>{setting('ex1', 'Export', [
      <Button key="export" variant="secondary" label={`Export CSV · ${PERIOD_LABEL[period]}`} onPress={() => act.exportCsv(rg.from, rg.to)} />,
    ], `One row per day, project and model with token counts, for the default period; no conversation text. Saved to ${st.exportDir || 'your Documents folder'}.`)}</Box>)
    if (Input) {
      out.push(<Input key="export-dir" label="Export folder" value={st.exportDir ?? ''} placeholder="C:\Users\you\Documents" submitLabel="Set" onSubmit={(text: string) => act.setSettings(x => ({ ...x, exportDir: text.trim().replace(/[\\/]+$/, '') }))} />)
    }
    out.push(<Box key="st-svb" marginTop={2}>{note1('st-sv', `Settings are saved at once and kept across sessions.${act.hover ? ' Point at a title with ⓘ to see what it does.' : ''} Version and updates: About Lucelis, at the bottom of Overview.`)}</Box>)
  }

  if (pv.tab !== 'settings' && note) out.push(<Box key="foot" marginTop={1}><Text color={MUTED}>{`History: ${note}`}</Text></Box>)
  if (formatSuspect(a)) out.push(<Box key="format" marginTop={note && pv.tab !== 'settings' ? 0 : 1}><Text color={WARM}>{FORMAT_NOTE}</Text></Box>)
  return <Box flexDirection="column" paddingX={1}>{out}</Box>

  // ---- About Lucelis: the bottom of Overview
  function about() {
    out.push(section('h-ab', 'ABOUT LUCELIS', 'Version, updates and what is new', { gap: 2 }))
    const u = act.update
    // One button: Check for updates; once a check finds a newer version it becomes Update to X,
    // with what X brings underneath. Lucelis never installs anything itself: Update copies the
    // two commands that do, for the person to paste.
    const found = u.phase === 'newer' || u.phase === 'copied'
    out.push(row('up1', [
      <Text key="v" color={TEXT} bold>{`Lucelis ${u.installed || ''}`.trim()}</Text>,
      found
        ? <Button key="check" variant="primary" label={`Update to ${u.latest}`} onPress={act.copyUpdate} />
        : <Button key="check" variant="secondary" label={u.phase === 'checking' ? 'Checking…' : 'Check for updates'} onPress={act.checkUpdate} />,
    ]))
    if (found) out.push(note1('up-w', `What ${u.latest} brings: ${u.notes ? `${u.notes}.` : 'see the full notes.'}`, TEXT))
    const UPD: Record<UpdateState['phase'], string> = {
      idle: 'Check for updates asks GitHub for the latest version number, only when you press it.',
      checking: 'Asking GitHub…',
      latest: `You have the latest version${u.latest ? ` (${u.latest})` : ''}.`,
      newer: `Lucelis ${u.latest} is available (you have ${u.installed}). Update copies the two commands that install it: paste them into the prompt and send, then start a new session.`,
      failed: `Could not check: ${u.detail ?? 'no answer'}. Nothing was changed.`,
      copied: 'Copied. Paste into the prompt and send, then start a new session to load the new version.',
    }
    out.push(note1('up-n', UPD[u.phase], u.phase === 'failed' ? WARM : u.phase === 'newer' ? GOOD : MUTED))
    const n = act.news
    if (n) {
      out.push(<Box key="news-b" marginTop={1} flexDirection="column">
        <Text key="h" color={TEXT} bold>{`New in ${n.version}`}</Text>
        {row('news', [
          <Text key="t" color={MUTED}>{n.summary ? `${n.summary}.` : 'See the full notes.'}</Text>,
          <Button key="news-notes" plain label={n.copied ? 'Link copied' : 'Full notes'} onPress={() => act.copyNotes?.()} />,
          <Button key="news-x" plain label="Dismiss" onPress={() => act.dismissNews?.()} />,
        ])}
      </Box>)
    } else {
      out.push(row('ab-cl', [<Button key="ab-notes" plain label={act.notesCopied ? 'Changelog link copied' : 'Copy the changelog link'} onPress={() => act.copyNotes?.()} />]))
    }
    out.push(<Box key="ab-p" marginTop={1} flexDirection="column">
      <Text key="p1" color={MUTED}>Local-only • No telemetry • No model calls • Network only when you press Check for updates</Text>
      <Text key="p2" color={MUTED}>For Claude Code on Windows · PolyForm Noncommercial License 1.0.0</Text>
    </Box>)
  }

  // ---- the next-message cost table (Session and Models)
  function costTable(ui2: El, v2: View, width: number, k: string) {
    const { Box: B, Text: T } = ui2
    const rows2 = v2.costs ?? []
    const wide = width >= 46
    const W = wide ? [13, 9, 9, 9] : [12, 8, 8]
    const head = wide ? ['Model', 'Now', 'If cold', 'Saves'] : ['Model', 'Now', 'If cold']
    const items: any[] = [section(`h-nm-${k}`, 'NEXT MESSAGE', 'API-price equivalent estimate, not your bill', { help: 'What sending your next prompt would cost at API prices, on each model: now (cache warm) and if the cache had gone cold. Each model has its own cache, so switching starts cold. Not your bill: a subscription is not charged per message.' })]
    items.push(<B key={`nm-h-${k}`} flexDirection="row">{head.map((t, i) => cell(`nmh${k}${i}`, t, W[i], MUTED, true))}</B>)
    for (const r of rows2 as CostRow[]) {
        if (r.isUnpriced) {
        items.push(<B key={`nm-${k}-${r.id}`} flexDirection="column"><T color={TEXT} bold>{`${r.name} ◂ yours`}</T><T color={MUTED}>No price on record for this model id: not estimated.</T></B>)
        continue
      }
      items.push(
        <B key={`nm-${k}-${r.id}`} flexDirection="row">
          {cell(`${k}${r.id}n`, `${r.mode === 'warm' ? '●' : '○'} ${r.name}`, W[0], r.isMine ? TEXT : MUTED, r.isMine)}
          {cell(`${k}${r.id}a`, usd(r.now), W[1], r.isMine ? TEXT : MUTED, r.isMine)}
          {cell(`${k}${r.id}b`, usd(r.cold), W[2], MUTED)}
          {wide ? cell(`${k}${r.id}c`, r.saves > 0.0049 ? usd(r.saves) : '–', W[3], r.saves > 0.0049 ? GOOD : EMPTY) : null}
        </B>,
      )
    }
    const mine = rows2.find(r => r.isMine)
    const cheapest = rows2.find(r => r.isCheapest)
    items.push(<T key={`nm-k-${k}`} color={MUTED}>{`● warm  ○ cold (each model has its own cache: another model starts cold)${mine ? ` · yours: ${mine.name} (bold)` : ''}${cheapest && !cheapest.isMine ? ` · lowest now: ${cheapest.name}` : ''}`}</T>)
    items.push(<T key={`nm-n-${k}`} color={MUTED}>{v2.composition?.basis === 'measured'
      ? `Next prompt ≈ ${tok(v2.composition.read)} read from cache + ${tok(v2.composition.write)} new tail written (measured from your last request). Excludes your new message and all output. Prices as of ${PRICES_AS_OF}.`
      : `Assumes all ${tok(v2.cache?.resend ?? 0)} of context is a cache hit (no request on record yet), so warm is a lower bound. Excludes your new message and all output. Prices as of ${PRICES_AS_OF}.`}</T>)
    return items
  }
}
