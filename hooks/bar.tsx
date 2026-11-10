// The band above the prompt. Level 1: the compact bar (one row; two in Detailed).
// Level 2 ("More"): a session snapshot of at most six fitted lines that never wrap,
// so the band fits the Desktop band area without an inner scroll. Everything longer
// lives in the Lucelis pane (pane.tsx). Draws only; every figure comes from model.ts.
//
// WHAT DECIDES WHAT THE BAR SHOWS (v0.2.3), in this order:
//   1. The item's toggle (Settings > Compact bar items): off = never drawn, no room kept.
//   2. Data: an item with nothing to show yet is left out ("no data yet").
//   3. Density: Minimal draws the two quotas only. Normal draws every enabled item
//      on one row (with "Second line" on, what does not fit goes to a second row).
//      Detailed always draws two rows: usage on the first, the session's items on
//      the second. No item is forced on: a toggle always wins.
// Labels are as short as they stay clear: "5H 14%" is what is LEFT (green from 70%,
// yellow from 30%, red below), "CTX 24%" is what is USED, K / M figures are tokens, "Today" is this project.
//   4. Width: items are placed in priority order (ITEMS below) and the ones that do
//      not fit are left out; turning an item off gives its room to the next ones.
// barLayout() reports each item's state, and Settings shows it.

import type { Settings } from '../types'
import { shortProject } from './agg'
import type { View } from './model'
import { BG, COLD, EMPTY, INK, LINE, LOGO, LOGO_WORKING, MUTED, adaptiveLogo, TEXT, WARM, dots, health, dur, modelName, signed, tok, trend, when } from './fmt'
import { usd } from './prices'

type El = { Box: any; Text: any; Button: any }
/** One run of text: [text, color, bold?]. */
export type Seg = [string, string, boolean?]
export type ItemKey = keyof Settings['show']
/** A part of a row: its forms, longest first, and how much it matters (1 = kept longest). */
export type Part = { key: string; prio: number; forms: Seg[][]; after?: string; floor?: number; item?: ItemKey; row?: 1 | 2 }
export type Shown = { key: string; segs: Seg[]; after?: string }

/** The compact bar's items, in priority order (the order Settings lists them in). */
export const ITEMS: { key: ItemKey; label: string; what: string; nodata: string }[] = [
  { key: 'h5', label: '5H quota', what: '5-hour quota left', nodata: 'Claude has not reported it yet' },
  { key: 'd7', label: '7D quota', what: '7-day quota left', nodata: 'Claude has not reported it yet' },
  { key: 'cache', label: 'Cache', what: 'WARM / COLD and minutes until cold', nodata: 'known after the first reply' },
  { key: 'ctx', label: 'Context', what: 'context window used', nodata: 'known after the first reply' },
  { key: 'resets', label: 'Reset times', what: 'time until each quota resets', nodata: 'needs the 5H or 7D quota on, and a reset time from Claude' },
  { key: 'project', label: 'Project', what: 'current project', nodata: 'no project found' },
  { key: 'session', label: 'Session activity', what: "this session's activity tokens", nodata: 'no reply recorded yet' },
  { key: 'today', label: 'Project today', what: "this project's activity tokens today", nodata: 'no history read yet' },
  { key: 'elapsed', label: 'Elapsed', what: 'time since the session started', nodata: 'start time unknown' },
  { key: 'trend', label: '7-day trend', what: 'all projects, last 7 days', nodata: 'no history read yet' },
  { key: 'model', label: 'Model', what: 'current model', nodata: 'model unknown' },
]
/** off: toggled off. shown: drawn now. density: on, but this density leaves it out. width: on, no room. nodata: on, nothing to show. */
export type ItemState = 'off' | 'shown' | 'density' | 'width' | 'nodata'

/** Columns the Lucelis glyph takes, with its gap. On by default; its room is reserved first. */
const GLYPH = 3
const QNAME: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: 'SPEND' }
const SEP = 3 // " │ "
/** The More / Details buttons at the end of the compact row, in columns (full labels / glyphs). */
const BUTTONS = 20
const BUTTONS_NARROW = 6
/** Below this many columns the band's buttons become glyphs and the snapshot's labels short. */
export const NARROW = 56
/** The label column of the snapshot (bold labels must not wrap on a proportional font). */
const LABEL = 15
const LABEL_NARROW = 11

const width = (segs: Seg[]) => segs.reduce((n, s) => n + s[0].length, 0)

/**
 * Chooses a form for each part so the row fits `room` columns: every part that
 * can be placed gets its shortest form, in priority order (parts with prio <= `keep`
 * always do); then parts grow to longer forms, again in priority order, while room
 * is left. Returns the chosen parts in their original order.
 */
export const fit = (parts: Part[], room: number, keep = 0): Shown[] => {
  const order = [...parts].sort((a, b) => a.prio - b.prio)
  const pick = new Map<string, number>()
  let used = 0
  for (const p of order) {
    // An attached part (a quota's reset time) follows its parent with no separator, and only with it.
    if (p.after && !pick.has(p.after)) continue
    const sep = p.after || !pick.size ? 0 : SEP
    // `floor`: the shortest form normally used; forms below it only for a kept part with no room.
    const floor = Math.min(p.floor ?? p.forms.length - 1, p.forms.length - 1)
    const w = width(p.forms[floor]) + sep
    if (used + w <= room) { pick.set(p.key, floor); used += w }
    else if (p.prio <= keep) {
      let i = floor
      while (i < p.forms.length - 1 && used + width(p.forms[i]) + sep > room) i++
      pick.set(p.key, i); used += width(p.forms[i]) + sep
    }
  }
  for (const p of order) {
    let i = pick.get(p.key)
    if (i === undefined) continue
    while (i > 0) {
      const extra = width(p.forms[i - 1]) - width(p.forms[i])
      if (used + extra > room) break
      used += extra
      i--
    }
    pick.set(p.key, i)
  }
  return parts.filter(p => pick.has(p.key)).map(p => ({ key: p.key, segs: p.forms[pick.get(p.key)!], after: p.after }))
}

/** `plain`: no bar background, so main text takes the app's own text colour (readable in any theme). */
const segsEl = (ui: El, key: string, segs: Seg[], plain = false) => {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="row" flexShrink={0}>
      {segs.map(([t, c, b], i) => <Text key={`${key}-${i}`} color={plain && c === TEXT ? undefined : c} bold={!!b}>{t}</Text>)}
    </Box>
  )
}

/**
 * Every part the bar could draw from this view: one or more per ITEM that is toggled
 * on AND has data, in display order. Density is not applied here (barLayout does).
 * Priorities follow the usage-first order: 5H, 7D, cache + countdown, context, reset
 * times, project, session activity, project today, then the rest.
 */
export const compactParts = (v: View, st: Settings): Part[] => {
  const show = st.show
  const parts: Part[] = []
  for (const q of v.quotas) {
    const isH5 = q.kind === 'five_hour'
    const item: ItemKey | undefined = isH5 ? 'h5' : q.kind === 'seven_day' ? 'd7' : undefined
    if (item && !show[item]) continue
    const name = QNAME[q.kind] ?? q.kind.toUpperCase()
    // The engine reports what is used; the bar shows what is LEFT. No "left" / "LOW" words:
    // the figure is green from 70%, yellow from 30%, red below.
    const core: Seg[] = [[`${name} `, MUTED, true], [`${q.left}%`, health(q.left), true]]
    parts.push({ key: q.kind, item, row: 1, prio: isH5 ? 1 : 2, forms: [core] })
    // The reset time is its own part, attached to its quota: placed after cache and context.
    if (show.resets && q.resetIn !== null) {
      const t = q.resetIn <= 0 ? 'resetting' : dur(q.resetIn)
      parts.push({ key: `${q.kind}-reset`, item: 'resets', row: 1, after: q.kind, prio: isH5 ? 6 : 6.5, forms: [[[` · ${t}`, MUTED]]] })
    }
  }
  // The cache clock is INFERRED from request timing (prices.ts); the pane and More say so.
  const c = v.cache
  if (c && show.cache) {
    const hue = c.mode === 'warm' ? WARM : COLD
    const word: Seg = [c.mode === 'warm' ? 'WARM' : 'COLD', hue, true]
    parts.push({ key: 'cache', item: 'cache', row: 1, prio: 3, floor: c.mode === 'warm' ? 0 : 1, forms: c.mode === 'warm'
      ? [[word, [` ${c.minsLeft}m`, hue]], [word]]
      : [[word, [` · idle ${dur(c.idleMs)}`, hue]], [word]] })
  }
  if (v.ctx && show.ctx) {
    // Context is what is USED, so its health is read from what is left of the window.
    const col = health(100 - v.ctx.percent)
    parts.push({ key: 'ctx', item: 'ctx', row: 1, prio: 5, forms: [[['CTX ', MUTED, true], [`${v.ctx.percent}%`, col, true]]] })
  }
  const s = v.session
  if (s?.project && show.project) parts.push({ key: 'proj', item: 'project', row: 2, prio: 7, forms: [[[shortProject(s.project.name), TEXT, true]]] })
  if (s && s.tokens !== null && show.session) parts.push({ key: 'sess', item: 'session', row: 2, prio: 8, forms: [[['Session ', MUTED], [tok(s.tokens), TEXT, true]], [['Sess ', MUTED], [tok(s.tokens), TEXT, true]]] })
  if (v.today?.project && show.today) parts.push({ key: 'today', item: 'today', row: 2, prio: 9, forms: [[['Today ', MUTED], [tok(v.today.project.tokens), TEXT, true]]] })
  if (s && s.elapsedMs !== null && s.elapsedMs > 0 && show.elapsed) parts.push({ key: 'dur', item: 'elapsed', row: 2, prio: 10, forms: [[['◷ ', MUTED], [dur(s.elapsedMs), TEXT]]] })
  if (v.week && show.trend) {
    const t = v.week.change !== null ? ` ${trend(v.week.change)}` : ''
    parts.push({ key: 'trend', item: 'trend', row: 2, prio: 11, forms: [[['7d ', MUTED], [`${tok(v.week.tokens)}${t}`, TEXT]]] })
  }
  if (s?.model && show.model) parts.push({ key: 'model', item: 'model', row: 2, prio: 12, forms: [[[modelName(s.model), MUTED]]] })
  return parts
}

export type Layout = { rows: Shown[][]; narrow: boolean; state: Record<ItemKey, ItemState>; glyph: boolean }

/** What the compact bar draws at `columns`, and each item's state (for Settings). */
export const barLayout = (v: View, st: Settings, columns: number, canGlyph = true): Layout => {
  const narrow = columns < NARROW
  const all = compactParts(v, st)
  const inDensity = (p: Part) => st.mode !== 'minimal' || p.item === 'h5' || p.item === 'd7' || p.item === undefined
  const cand = all.filter(inDensity)
  const two = st.mode === 'detailed'
  const first = two ? cand.filter(p => p.row !== 2) : cand
  // The mark leads the bar whenever it is on and the surface can draw it; only a very narrow
  // bar (glyph buttons) drops it, so 5H and 7D always keep their place.
  const glyph = !!st.logo && canGlyph && !narrow
  const room = columns - (narrow ? BUTTONS_NARROW : BUTTONS) - 2 - (glyph ? GLYPH : 0)
  const top = fit(first, room, 2)
  // Second row: Detailed's session items; or, in Normal with "Second line" on, whatever the
  // first row had no room for (a reset time stays with its quota, so it never moves down).
  const onTop = new Set(top.map(p => p.key))
  const second = two ? fit(cand.filter(p => p.row === 2), columns - 2)
    : st.wrap && st.mode === 'normal' ? fit(cand.filter(p => !onTop.has(p.key) && !p.after), columns - 2) : []
  const rows = second.length ? [top, second] : [top]
  const drawn = new Set(rows.flat().map(p => p.key))
  const state = {} as Record<ItemKey, ItemState>
  for (const it of ITEMS) {
    const mine = all.filter(p => p.item === it.key)
    state[it.key] = !st.show[it.key] ? 'off'
      : !mine.length ? 'nodata'
      : !mine.some(inDensity) ? 'density'
      : mine.some(p => drawn.has(p.key)) ? 'shown' : 'width'
  }
  return { rows, narrow, state, glyph }
}

export const compactRow = (ui: El, v: View, st: Settings, columns: number, expanded: boolean, paneOpen: boolean, onMore: () => void, onDetails: () => void, working = false) => {
  const { Box, Text, Button } = ui
  const Svg = (ui as any).Svg
  const L = barLayout(v, st, columns, !!Svg)
  const line = (shown: Shown[], k: string): any[] => {
    const row: any[] = []
    shown.forEach((p, i) => {
      if (i > 0 && !p.after) row.push(<Text key={`sep-${k}-${p.key}`} color={EMPTY}> │ </Text>)
      row.push(segsEl(ui, p.key, p.segs, !st.bg))
    })
    return row
  }
  const top = line(L.rows[0], 'a')
  // Only where the surface draws SVG (not the terminal): no text stand-in, no image hack.
  if (L.glyph && Svg) top.unshift(<Box key="glyph" marginRight={1} flexShrink={0}><Svg source={st.bg ? (working ? LOGO_WORKING : LOGO) : adaptiveLogo(working ? LOGO_WORKING : LOGO)} alt={working ? 'Lucelis, working' : 'Lucelis'} width={16} height={16} /></Box>)
  // Every item off (or nothing to show yet): say so instead of drawing a blank row.
  if (!L.rows[0].length) top.push(<Text key="none" color={MUTED}>{L.narrow ? 'No bar items' : 'No bar items to show (see Settings)'}</Text>)
  // The optional fill sits behind the items only. More / Details are the app's own buttons and
  // take the app's text colour, so they stay on the app's background and read in any theme.
  const fill = st.bg ? BG : undefined
  return (
    <Box key="bar" flexDirection="column">
      <Box key="row" flexDirection="row" alignItems="center">
        <Box key="items" flexDirection="row" alignItems="center" paddingX={1} backgroundColor={fill} flexShrink={0}>{top}</Box>
        <Box key="grow" flexGrow={1} />
        <Button key="more" plain label={L.narrow ? (expanded ? '▴' : '▾') : expanded ? 'Less ▴' : 'More ▾'} onPress={onMore} />
        <Text key="gap">  </Text>
        <Button key="details" plain label={L.narrow ? (paneOpen ? '✕' : '›') : paneOpen ? 'Details ✕' : 'Details ›'} onPress={onDetails} />
        <Text key="end"> </Text>
      </Box>
      {L.rows[1] ? (
        <Box key="row2" flexDirection="row">
          <Box key="items2" flexDirection="row" paddingX={1} backgroundColor={fill} flexShrink={0}>{line(L.rows[1], 'b')}</Box>
        </Box>
      ) : null}
    </Box>
  )
}

export type SnapLine = { key: string; label: string; chip?: Seg; segs: Seg[] }

/**
 * Level 2: the session snapshot, grouped SESSION / ACTIVITY / CONTEXT / CACHE /
 * NEXT MESSAGE (+ IF SWITCHED: the same prompt on the other models). Values in a
 * line are separated by " │ ". Each line is fitted to the width (never wraps).
 * No quota repeat and no history: those are on the bar and in the pane.
 */
export const snapshotLines = (v: View, columns: number, tz: number, now: number): SnapLine[] => {
  const short = columns < 60
  const room = Math.max(20, columns - (short ? LABEL_NARROW : LABEL) - 2)
  const out: SnapLine[] = []
  const line = (key: string, label: string, parts: Part[], chip?: Seg) => {
    const chosen = fit(parts, room - (chip ? width([chip]) + 1 : 0))
    if (!chosen.length && !chip) return
    const segs: Seg[] = []
    chosen.forEach((p, i) => { if (i > 0) segs.push([' │ ', EMPTY]); segs.push(...p.segs) })
    out.push({ key, label, chip, segs })
  }
  const s = v.session
  if (s) {
    line('who', 'SESSION', [
      s.project ? { key: 'p', prio: 1, forms: [[[s.project.name, TEXT, true]]] } : null,
      s.model ? { key: 'm', prio: 2, forms: [[[modelName(s.model), TEXT]]] } : null,
      s.activeMs ? { key: 'a', prio: 3, forms: [[['~', MUTED], [dur(s.activeMs), TEXT, true], [' active', MUTED]]] } : null,
      s.elapsedMs ? { key: 'e', prio: 4, forms: [[[dur(s.elapsedMs), TEXT], [' elapsed', MUTED]]] } : null,
      s.startedAt ? { key: 's', prio: 6, forms: [[['since ', MUTED], [when(s.startedAt, tz, now), TEXT]]] } : null,
    ].filter(Boolean) as Part[])
    line('act', 'ACTIVITY', [
      s.tokens !== null ? { key: 't', prio: 1, forms: [[[tok(s.tokens), TEXT, true], [' activity tokens', MUTED]], [[tok(s.tokens), TEXT, true], [' tokens', MUTED]]] } : null,
      s.messages !== null ? { key: 'n', prio: 2, forms: [[[String(s.messages), TEXT, true], [' messages', MUTED]], [[String(s.messages), TEXT, true], [' msgs', MUTED]]] } : null,
      // Output tokens of the whole session so far, not of the last reply.
      s.output !== null ? { key: 'o', prio: 3, forms: [[[tok(s.output), TEXT], [' output', MUTED]]] } : null,
      s.cacheWrite !== null ? { key: 'w', prio: 4, forms: [[[tok(s.cacheWrite), TEXT], [' cache writes', MUTED]]] } : null,
      s.compactions ? { key: 'c', prio: 5, forms: [[[String(s.compactions), TEXT], [s.compactions === 1 ? ' compaction' : ' compactions', MUTED]]] } : null,
    ].filter(Boolean) as Part[])
  }
  if (v.ctx) {
    const col = v.ctx.isNearLimit ? WARM : TEXT
    const d = dots(v.ctx.percent ?? 0, 10)
    const g = v.growth
    line('ctx', 'CONTEXT', [
      { key: 'u', prio: 1, forms: [[[d.on, col], [d.off, EMPTY], [` ${v.ctx.percent}%`, col, true], [' used', MUTED]], [[`${v.ctx.percent}%`, col, true], [' used', MUTED]]] },
      { key: 'l', prio: 2, forms: [[[tok(v.ctx.left), TEXT, true], [' remaining', MUTED]], [[tok(v.ctx.left), TEXT, true], [' left', MUTED]]] },
      g && g.l10.turns >= 2 ? { key: 'g', prio: 3, forms: [[[`${signed(g.avg)}/turn`, TEXT], [g.pace ? ` (${g.pace})` : '', MUTED]], [[`${signed(g.avg)}/turn`, TEXT]]] } : null,
      v.ctx.isNearLimit ? { key: 'w', prio: 1, forms: [[['near limit', WARM, true]]] } : null,
    ].filter(Boolean) as Part[])
  }
  const c = v.cache
  if (c) {
    const hue = c.mode === 'warm' ? WARM : COLD
    line('cache', 'CACHE', [
      c.mode === 'warm'
        ? { key: 't', prio: 1, forms: [[[`~${c.minsLeft}m`, hue, true], [' until cold', MUTED]]] }
        : { key: 't', prio: 1, forms: [[['idle ', MUTED], [dur(c.idleMs), hue, true]]] },
      { key: 'k', prio: 3, forms: [[[tok(c.cached ?? c.resend), TEXT, true], [c.cached !== null ? ' cached' : ' context', MUTED]]] },
      c.reusable !== null ? { key: 'r', prio: 4, forms: [[[`${Math.round(c.reusable)}%`, TEXT], [' reusable', MUTED]]] } : null,
      // Never presented as Claude's own report: the state is inferred from request timing.
      { key: 'i', prio: 2, forms: [[['inferred from timing', MUTED]], [['inferred', MUTED]]] },
    ].filter(Boolean) as Part[], [` ${c.mode === 'warm' ? 'WARM' : 'COLD'} `, hue, true])
  }
  const mine = v.costs?.find(r => r.isMine)
  if (mine) {
    line('cost', short ? 'NEXT MSG' : 'NEXT MESSAGE', mine.isUnpriced
      ? [{ key: 'u', prio: 1, forms: [[[mine.name, TEXT], [': no price on record, not estimated', MUTED]], [[mine.name, TEXT], [': no price', MUTED]]] }]
      : [
          { key: 'm', prio: 2, forms: [[[mine.name, TEXT]]] },
          { key: 'n', prio: 1, forms: [[[`~${usd(mine.now)}`, TEXT, true], [mine.mode === 'warm' ? ' now' : ' now (cache cold)', MUTED]], [[`~${usd(mine.now)}`, TEXT, true], [' now', MUTED]]] },
          mine.mode === 'warm' ? { key: 'c', prio: 3, forms: [[[`~${usd(mine.cold)}`, TEXT], [' if cold', MUTED]]] } : null,
          { key: 'e', prio: 4, forms: [[['API-price estimate, not your bill', MUTED]], [['estimate', MUTED]]] },
        ].filter(Boolean) as Part[])
  }
  // The same prompt on each other model, by that model's OWN cache clock (cold unless it
  // served this session within the hour). The full table is one press away (Compare models).
  const others = (v.costs ?? []).filter(r => !r.isMine && !r.isUnpriced)
  if (others.length) {
    line('alt', short ? 'SWITCH TO' : 'IF SWITCHED', others.map((r, i) => ({
      key: r.id, prio: i + 1,
      forms: [[[`${r.name} `, MUTED], [`~${usd(r.now)}`, TEXT], [r.mode === 'warm' ? ' warm' : ' cold', r.mode === 'warm' ? WARM : MUTED]], [[`${r.name} `, MUTED], [`~${usd(r.now)}`, TEXT]]],
    })))
  }
  return out
}

export const snapshot = (ui: El, v: View, columns: number, tz: number, now: number, hasSecondRow: boolean, onSession: () => void, onCompare: () => void, onDashboard: () => void, plain = false) => {
  const { Box, Text, Button } = ui
  const short = columns < 60
  const rows = snapshotLines(v, columns, tz, now).map(l => (
    <Box key={`snap-${l.key}`} flexDirection="row">
      <Box key="label" width={short ? LABEL_NARROW : LABEL} flexShrink={0}><Text color={MUTED} bold>{l.label}</Text></Box>
      {l.chip ? <Text key="chip" backgroundColor={l.chip[1]} color={INK} bold>{l.chip[0]}</Text> : null}
      {l.chip ? <Text key="chip-gap">{" "}</Text> : null}
      {segsEl(ui, 'v', l.segs, plain)}
    </Box>
  ))
  const gap = columns < 40 ? ' ' : short ? '  ' : '    '
  return (
    <Box key="snapshot" flexDirection="column" paddingX={1}>
      {hasSecondRow ? null : <Text key="rule" color={LINE}>{'─'.repeat(Math.max(8, Math.min(Math.floor((columns - 2) * 0.7), 100)))}</Text>}
      {rows.length ? rows : [<Text key="none" color={MUTED}>No session figures yet: they appear after the first reply.</Text>]}
      <Box key="actions" flexDirection="row" marginTop={0}>
        <Button key="open-session" plain label={short ? 'Session ›' : 'Session details ›'} onPress={onSession} />
        <Text key="g1">{gap}</Text>
        <Button key="open-compare" plain label={short ? 'Compare ›' : 'Compare models ›'} onPress={onCompare} />
        <Text key="g2">{gap}</Text>
        <Button key="open-dashboard" plain label={short ? 'Dashboard ›' : 'Activity dashboard ›'} onPress={onDashboard} />
      </Box>
    </Box>
  )
}
