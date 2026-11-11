// Formatting and colours. Nothing here touches the engine.
//
// The palette is built on the Lucelis brand colours (deep navy, ivory, teal, gold):
// navy surfaces, ivory text, teal for a cold cache and gold as the accent.

/** Surfaces, darkest to lightest: text on a filled chip, the bar, rules, empty meter cells. */
export const INK = '#0b1016'
export const BG = '#111820'
export const LINE = '#243039'
export const EMPTY = '#3b4854'
/** Text: ivory, and a blue-grey for labels. */
export const TEXT = '#F5EFE4'
export const MUTED = '#8695a3'
/** Accent (brand gold) and the two cache states: amber while warm, brand teal when cold. */
export const ORANGE = '#D9B46A'
export const WARM = '#e8975c'
export const COLD = '#7EC9C3'
/** Health: plenty left, getting low, nearly out. */
export const GOOD = '#7fc98f'
export const YELLOW = '#ecc94b'
export const RED = '#ef5d58'

/** Health colour of a "what is left" percentage: green 70-100, yellow 30 to under 70, red under 30. */
export const health = (left: number): string => (left >= 70 ? GOOD : left >= 30 ? YELLOW : RED)

/** Colour of a quota figure: red at or under the warning level (the same level the logo and the
 * warning use, so they never disagree), green from 70%, yellow between. */
export const quotaHealth = (left: number, level: number): string => (left <= level ? RED : left >= 70 ? GOOD : YELLOW)

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
const L_PATH = '<path d="M7 5.5 V23.1 Q7 25.5 9.6 25.5 H23.5" fill="none" stroke="#F5EFE4" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>'
/** Three bars, shortest at the top, clear of the glint. */
const BAR_D = ['M13.6 10.6 H18.4', 'M13.6 15.7 H21.2', 'M13.6 20.8 H23.4']
const BAR_ATTR = (c: string) => `fill="none" stroke="${c}" stroke-width="2.9" stroke-linecap="round"`
const barsStill = (c: string) => `<path d="${BAR_D.join(' ')}" ${BAR_ATTR(c)}/>`
/** Working: each bar draws in from the left, top to bottom, holds, then fades back (2.6 s). */
const REVEAL: [string, string][] = [
  ['1;0;0;0', '0;0.25;0.85;1'],
  ['1;1;0;0;0', '0;0.15;0.4;0.85;1'],
  ['1;1;0;0;0', '0;0.3;0.55;0.85;1'],
]
const barsReveal = (c: string) => BAR_D.map((d, i) =>
  `<path d="${d}" ${BAR_ATTR(c)} pathLength="1" stroke-dasharray="1 2">` +
  `<animate attributeName="stroke-dashoffset" values="${REVEAL[i][0]}" keyTimes="${REVEAL[i][1]}" dur="2.6s" repeatCount="indefinite"/>` +
  '<animate attributeName="opacity" values="1;1;1;0" keyTimes="0;0.35;0.85;1" dur="2.6s" repeatCount="indefinite"/></path>').join('')
/** The four-point glint, a little higher and larger than in 1.0 so it reads at 16 px. */
const glint = (fill: string) => '<path d="M25.70 0.29 Q26.82 4.97 31.32 6.10 Q26.82 7.22 25.70 11.91 Q24.57 7.22 20.20 6.10 Q24.57 4.97 25.70 0.29Z" fill="' + fill + '"/>'
const mark = (bars: string, glintFill: string) => `${SVG_OPEN}${L_PATH}${bars}${glint(glintFill)}</svg>`
const TEAL = '#7EC9C3'
const GOLD = '#D9B46A'

/** The Lucelis mark (rounded L, three bars, glint). Drawn only where the surface has Svg. Still. */
export const LOGO = mark(barsStill(TEAL), GOLD)
/** While Claude is working on a turn: the bars draw in, one after the other. Still otherwise. */
export const LOGO_WORKING = mark(barsReveal(TEAL), GOLD)
/** A quota at or under its warning level: the bars and the glint turn red. No motion of its own. */
export const LOGO_LOW = mark(barsStill(RED), RED)
/** Low quota while working: the bars draw in, red, with a red glint. */
export const LOGO_WORKING_LOW = mark(barsReveal(RED), RED)
/** The mark for a state: idle or working, quota fine or low. */
export const logoFor = (working: boolean, low: boolean): string =>
  working ? (low ? LOGO_WORKING_LOW : LOGO_WORKING) : (low ? LOGO_LOW : LOGO)

/** The L's colour on a light app theme, when the bar has no background of its own: a text-dark. */
export const LOGO_ON_LIGHT = '#1f2328'
const L_STROKE = 'stroke="#F5EFE4"'
/**
 * The mark for a bar with no background: on a light app theme the ivory L would vanish, so
 * the L follows the theme (ivory on dark, text-dark on light). The stroke attribute stays as
 * the fallback, so a surface that ignores the style still draws the ivory L.
 */
export const adaptiveLogo = (svg: string): string =>
  svg.includes(L_STROKE)
    ? svg
        .replace(L_STROKE, `class="l" ${L_STROKE}`)
        .replace(/(<svg[^>]*>)/, `$1<style>@media (prefers-color-scheme: light){.l{stroke:${LOGO_ON_LIGHT}}}</style>`)
    : svg

/** 184K, 1.6M, 950. */
export const tok = (n: number): string => {
  const a = Math.abs(n)
  const s = n < 0 ? '-' : ''
  if (a >= 1e9) return s + trim(a / 1e9) + 'B'
  if (a >= 1e6) return s + trim(a / 1e6) + 'M'
  if (a >= 1e3) return s + (a >= 1e5 ? Math.round(a / 1e3) : trim(a / 1e3)) + 'K'
  return s + Math.round(a)
}
const trim = (x: number) => (x >= 100 ? String(Math.round(x)) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/0$/, '').replace(/\.0$/, ''))

export const signed = (n: number): string => (n >= 0 ? '+' : '') + tok(n)

/** 4d22h, 3h16m, 42m. */
export const dur = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

export const pct = (x: number, digits = 0): string => `${x.toFixed(digits)}%`

/** ↑18%, ↓4%, → for under 1%. Neutral: an arrow says direction, not good or bad. */
export const trend = (p: number | null): string => (p === null ? '' : Math.abs(p) < 1 ? '→0%' : `${p > 0 ? '↑' : '↓'}${Math.round(Math.abs(p))}%`)

/** claude-opus-5-5 -> Opus 5.5; claude-sonnet-5-5-20261101 -> Sonnet 5.5. */
export const modelName = (m: string | null | undefined): string => {
  if (!m) return ''
  const x = m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
  const parts = x.split('-')
  const fam = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : x
  const ver = parts.slice(1).filter(p => /^\d+$/.test(p)).join('.')
  return ver ? `${fam} ${ver}` : fam
}

/** A text meter `cells` wide for a 0-100 `percent`: the lit part and the rest, drawn in two colours. */
export const dots = (percent: number, cells: number): { on: string; off: string } => {
  const share = Number.isFinite(percent) ? percent / 100 : 0
  let lit = Math.round(share * cells)
  if (lit < 0) lit = 0
  if (lit > cells) lit = cells
  return { on: ''.padEnd(lit, '●'), off: ''.padEnd(cells - lit, '·') }
}

export const HOURS = (h: number) => `${String(h).padStart(2, '0')}:00`
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A local clock time from epoch ms and the machine's offset: 14:05. */
export const clock = (ms: number, tz: number): string => new Date(ms + tz * 60000).toISOString().slice(11, 16)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** When something started, with the day when it is not today: "14:05", "yesterday 20:07", "Nov 7 09:30". */
export const when = (ms: number, tz: number, now: number): string => {
  const day = (x: number) => new Date(x + tz * 60000).toISOString().slice(0, 10)
  const d = day(ms)
  if (d === day(now)) return clock(ms, tz)
  if (d === day(now - 86_400_000)) return `yesterday ${clock(ms, tz)}`
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))} ${clock(ms, tz)}`
}
