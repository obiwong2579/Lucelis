// The history aggregate: what the extractor's rows add up to, kept small.
// Pure functions only; nothing here touches the engine.
//
// Counting rules (verified against the raw transcripts, see README):
// - A model response is one message.id. The transcript writes one row per content
//   block with the same usage, and forks/resumes copy rows into other session files
//   under the ORIGINAL sessionId. The extractor emits a response only from the file
//   that owns its sessionId and once per id per run; here the last ids of each file
//   (a message whose blocks straddle two refreshes) and orphan copies are deduped.
//   A rewound branch stays in the transcript and is counted: those requests ran.
// - Activity tokens = uncached input + cache write + output: the headline metric for
//   shares, trends and the heatmap. Cache reads are kept apart: they re-read the
//   same context on every request and would swamp everything else.
//   Processed tokens = activity tokens + cache reads (secondary).
// - Messages = your prompts + the main thread's responses (subagents' responses
//   count toward tokens, not messages).
// - Corruption guard: a response with any count over 5M tokens is excluded and
//   counted in `flagged`. Not a model limit: a single request cannot plausibly
//   report that much, so such a row is treated as damaged data.
// - Rows are keyed by working directory; projects are resolved at query time
//   (resolver below), so changing an alias needs no rebuild.

export const PARSER_VERSION = 3
const TAIL = 48
const RING = 32
const IDLE_GAP_MS = 30 * 60 * 1000
const IMPLAUSIBLE = 5_000_000

export type Sess = {
  title?: string
  /** The directory the session started in (its first recorded cwd). */
  root?: string
  /** The working directory of its last main-thread record. */
  cwd?: string
  first: number
  last: number
  /** Estimated active time: gaps under 30 minutes between main-thread events, summed. */
  act: number
  lastTs: number
  resp: number
  side: number
  prompts: number
  in: number
  out: number
  cw: number
  cr: number
  comp: number
  lastComp: number
  model: string
  /** Context of the last main-thread request: input + cache write + cache read. */
  cur: number
  /** The last main-thread request's [input, cache write, cache read, output]. */
  lu: [number, number, number, number]
  /** Context at the end of each recent turn, oldest first; -1 marks a compaction. */
  ring: number[]
  /** A main-thread request since the last ring entry: its context (cur) is still to be recorded. */
  pend?: boolean
}

/** [activity tokens, input, output, cacheWrite, cacheRead, responses, prompts] */
export type Row = number[]

export type Agg = {
  v: number
  built: number
  /** The machine's UTC offset in minutes and its local date, as the extractor saw them. */
  tz: number
  today: string
  files: Record<string, { o: number; t: string[] }>
  orphans: string[]
  sess: Record<string, Sess>
  /** `${sid}\t${day}\t${cwd}\t${model}` -> Row. Prompts carry model ''. */
  rows: Record<string, Row>
  /** day -> [activity tokens by hour 0-23, messages by hour 0-23] */
  hours: Record<string, number[]>
  /** cwd -> enclosing git repository root ('' = none), filled by the data layer. */
  git: Record<string, string>
  flagged: number
  parseErrors: number
}

export const emptyAgg = (): Agg => ({
  v: PARSER_VERSION, built: 0, tz: 0, today: '', files: {}, orphans: [], sess: {}, rows: {}, hours: {}, git: {}, flagged: 0, parseErrors: 0,
})

/** Is `x` a usable aggregate of this parser version? (A corrupt or old cache is rebuilt.) */
export const isAgg = (x: unknown): x is Agg => {
  const a = x as Agg
  return !!a && typeof a === 'object' && a.v === PARSER_VERSION && typeof a.files === 'object' && typeof a.sess === 'object'
    && typeof a.rows === 'object' && typeof a.hours === 'object' && typeof a.git === 'object' && Array.isArray(a.orphans)
}

// ---------------------------------------------------------------- projects

export const normPath = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '')
const lower = (p: string) => normPath(p).toLowerCase()
const base = (p: string) => normPath(p).split('\\').pop() || p
/** Is `child` the same as or inside `parent`? Case-insensitive (Windows). */
export const within = (child: string, parent: string): boolean => {
  const c = lower(child)
  const p = lower(parent)
  return c === p || c.startsWith(p + '\\')
}

export type Alias = { path: string; name: string }
export type Project = { key: string; name: string; source: 'alias' | 'git' | 'root' | 'cwd' }

/**
 * Resolves a working directory to a project, in this order:
 * 1. a configured alias (longest matching path wins);
 * 2. the enclosing git repository root;
 * 3. Claude's own launch directories: the outermost directory any session started
 *    in that contains the cwd. Working in it is the project named after it; working
 *    below it is the first folder under it (a session started in a sub-folder of a
 *    known launch directory joins the same project);
 * 4. fallback: the cwd itself.
 * Nothing here knows any project by name.
 */
export const makeResolver = (a: Agg, aliases: readonly Alias[]) => {
  const roots = [...new Set(Object.values(a.sess).map(s => s.root).filter((r): r is string => !!r).map(normPath))]
  const outer = roots.filter(r => !roots.some(o => o !== r && within(r, o) && lower(o) !== lower(r)))
  const al = [...aliases].filter(x => x.path && x.name).sort((x, y) => normPath(y.path).length - normPath(x.path).length)
  const memo = new Map<string, Project>()
  /** Detection without aliases: git root, else the folder under a start directory, else the folder. */
  const detect = (cwd: string): Project => {
    const git = a.git[cwd]
    const root = outer.find(r => within(cwd, r))
    if (git) return { key: lower(git), name: base(git), source: 'git' }
    if (root) {
      const rest = cwd.slice(normPath(root).length).replace(/^\\/, '')
      const top = rest ? normPath(root) + '\\' + rest.split('\\')[0] : normPath(root)
      return { key: lower(top), name: base(top), source: 'root' }
    }
    return { key: lower(cwd), name: base(cwd), source: 'cwd' }
  }
  // An alias NAMES a project: a folder aliased to the name of a project that already exists
  // joins that project (one key, one total), and aliases sharing a name are one project.
  // Without this, "Workspace" (detected) and "Workspace" (alias) were two projects
  // with one name, and Today / shares depended on which folder the session sat in.
  const byName = new Map<string, string>()
  if (al.length) {
    for (const cwd of knownCwds(a)) {
      if (al.some(x => within(cwd, x.path))) continue
      const d = detect(cwd)
      if (!byName.has(d.name.toLowerCase())) byName.set(d.name.toLowerCase(), d.key)
    }
    for (const x of [...al].sort((p, q) => lower(p.path).localeCompare(lower(q.path)))) {
      if (!byName.has(x.name.toLowerCase())) byName.set(x.name.toLowerCase(), lower(x.path))
    }
  }
  return (cwdIn: string | undefined | null): Project => {
    const cwd = normPath(cwdIn || '')
    if (!cwd) return { key: 'unknown', name: 'unknown', source: 'cwd' }
    const hit = memo.get(lower(cwd))
    if (hit) return hit
    const alias = al.find(x => within(cwd, x.path))
    const p: Project = alias ? { key: byName.get(alias.name.toLowerCase()) ?? lower(alias.path), name: alias.name, source: 'alias' } : detect(cwd)
    memo.set(lower(cwd), p)
    return p
  }
}

/** Every folder on record (rows and sessions), listed once per aggregate build. */
const cwdCache = new WeakMap<Agg, { built: number; list: string[] }>()
const knownCwds = (a: Agg): string[] => {
  const c = cwdCache.get(a)
  if (c && c.built === a.built) return c.list
  const s = new Set<string>()
  for (const k in a.rows ?? {}) s.add(normPath(k.split('\t')[2] ?? ''))
  for (const x of Object.values(a.sess ?? {})) if (x.cwd) s.add(normPath(x.cwd))
  const list = [...s].filter(Boolean)
  cwdCache.set(a, { built: a.built, list })
  return list
}
export type Resolver = ReturnType<typeof makeResolver>

/** A short label for the bar: "Project Atlas" -> "ATLAS". Generic, no names built in. */
export const shortProject = (p: string): string => {
  const s = p.replace(/^(project|proj|repo)[\s_-]+/i, '').trim() || p
  return (s.length > 14 ? s.slice(0, 13) + '…' : s).toUpperCase()
}

/** Every working directory on record (the data layer looks up git roots for new ones). */
export const cwdsOf = (a: Agg): string[] => {
  const s = new Set<string>()
  for (const k in a.rows) s.add(k.split('\t')[2])
  return [...s].filter(Boolean)
}

// ---------------------------------------------------------------- ingest

const newSess = (ms: number): Sess => ({
  first: ms, last: ms, act: 0, lastTs: 0, resp: 0, side: 0, prompts: 0, in: 0, out: 0, cw: 0, cr: 0,
  comp: 0, lastComp: 0, model: '', cur: 0, lu: [0, 0, 0, 0], ring: [],
})

const bump = (a: Agg, key: string, i: number, n: number) => {
  const r = a.rows[key] ?? (a.rows[key] = [0, 0, 0, 0, 0, 0, 0])
  r[i] += n
}
const hour = (a: Agg, day: string, h: number, tok: number, msg: number) => {
  const r = a.hours[day] ?? (a.hours[day] = new Array(48).fill(0))
  r[h] += tok
  r[24 + h] += msg
}
const touch = (s: Sess, ms: number, main: boolean) => {
  if (ms < s.first) s.first = ms
  if (ms > s.last) s.last = ms
  if (!main) return
  if (s.lastTs && ms > s.lastTs && ms - s.lastTs < IDLE_GAP_MS) s.act += ms - s.lastTs
  if (ms > s.lastTs) s.lastTs = ms
}
const ring = (s: Sess, v: number) => {
  if (v === -1 && s.ring[s.ring.length - 1] === -1) return
  s.ring.push(v)
  if (s.ring.length > RING) s.ring.splice(0, s.ring.length - RING)
}

export type FileTask = { p: string; o: number; owner: string }
export type IngestResult = { next: FileTask[]; rows: number; reset: string[] }

/**
 * Folds one extractor answer into `a` (mutating it) and says which files still
 * have bytes to read. `tasks` are the files that call was asked about.
 */
export const ingest = (a: Agg, text: string, tasks: FileTask[]): IngestResult => {
  const byPath = new Map(tasks.map(t => [t.p, t]))
  const reached = new Set<string>()
  const next: FileTask[] = []
  const reset: string[] = []
  const orphans = new Set(a.orphans)
  const tails = new Map<string, Set<string>>()
  const tailOf = (p: string) => {
    let t = tails.get(p)
    if (!t) { t = new Set(a.files[p]?.t ?? []); tails.set(p, t) }
    return t
  }
  let n = 0
  const pending: string[][] = []
  const flush = (task: FileTask) => {
    const tail = tailOf(task.p)
    for (const c of pending) {
      const k = c[0]
      const sid = c[1]
      if (k === 'T') { if (a.sess[sid]) a.sess[sid].title = c[2]; continue }
      const s = a.sess[sid] ?? (a.sess[sid] = newSess(Number(c[3]) || 0))
      const isOrphan = sid !== task.owner
      if (k === 'A') {
        const [, , id, msS, day, hS, model, inS, outS, cwS, crS, cwdRaw, sideS] = c
        if (tail.has(id) || (isOrphan && orphans.has(id))) continue
        tail.add(id)
        if (isOrphan) orphans.add(id)
        const ms = Number(msS); const h = Number(hS)
        const vin = Number(inS); const vout = Number(outS); const vcw = Number(cwS); const vcr = Number(crS)
        if ([vin, vout, vcw, vcr].some(v => !Number.isFinite(v) || v < 0 || v > IMPLAUSIBLE)) { a.flagged++; continue }
        const main = sideS !== '1'
        const cwd = normPath(cwdRaw || '')
        if (!s.root && cwd) s.root = cwd
        const tok = vin + vcw + vout
        touch(s, ms, main)
        s.in += vin; s.out += vout; s.cw += vcw; s.cr += vcr
        if (main) {
          s.resp++
          if (cwd) s.cwd = cwd
          s.model = model
          s.cur = vin + vcw + vcr
          s.pend = true
          s.lu = [vin, vcw, vcr, vout]
        } else s.side++
        const key = `${sid}\t${day}\t${cwd}\t${model}`
        bump(a, key, 0, tok); bump(a, key, 1, vin); bump(a, key, 2, vout); bump(a, key, 3, vcw); bump(a, key, 4, vcr)
        if (main) bump(a, key, 5, 1)
        hour(a, day, h, tok, main ? 1 : 0)
        n++
      } else if (k === 'P') {
        const [, , uuid, msS, day, hS, cwdRaw] = c
        if (tail.has(uuid)) continue
        tail.add(uuid)
        const ms = Number(msS)
        const cwd = normPath(cwdRaw || '')
        if (!s.root && cwd) s.root = cwd
        touch(s, ms, true)
        if (s.pend && s.cur > 0) ring(s, s.cur) // the previous turn ended at this context size
        s.pend = false
        s.prompts++
        if (cwd) s.cwd = cwd
        bump(a, `${sid}\t${day}\t${cwd}\t`, 6, 1)
        hour(a, day, Number(hS), 0, 1)
        n++
      } else if (k === 'C') {
        const [, , uuid, msS] = c
        if (tail.has(uuid)) continue
        tail.add(uuid)
        s.comp++
        s.lastComp = Math.max(s.lastComp, Number(msS))
        // The turn before the compaction ended at its own size: record it first, never after the marker.
        if (s.pend && s.cur > 0) ring(s, s.cur)
        s.pend = false
        ring(s, -1)
      }
    }
    pending.length = 0
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const c = line.split('\t')
    switch (c[0]) {
      case 'N':
        a.today = c[1]
        a.tz = Number(c[2]) || 0
        break
      case 'F': {
        const task = byPath.get(c[1])
        if (!task) { pending.length = 0; break }
        flush(task)
        reached.add(task.p)
        const off = Number(c[2])
        if (off < task.o) reset.push(task.p)
        const t = [...tailOf(task.p)].slice(-TAIL)
        a.files[task.p] = { o: off, t }
        tails.set(task.p, new Set(t))
        if (c[3] === '0') next.push({ ...task, o: off })
        break
      }
      case 'X':
        a.parseErrors++
        break
      default:
        pending.push(c)
    }
  }
  pending.length = 0 // rows of a file whose F never came (cut output): keep none; the file is re-read
  for (const t of tasks) if (!reached.has(t.p)) next.push(t)
  a.orphans = [...orphans].slice(-5000)
  return { next, rows: n, reset }
}

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z')
export const addDays = (d: string, n: number) => toDay(dayMs(d) + n * DAY_MS)
export const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / DAY_MS)
/** The local date of `now`, using the machine offset the extractor reported. */
export const localDay = (now: number, tz: number) => toDay(now + tz * 60_000)
export const weekday = (d: string) => new Date(dayMs(d)).getUTCDay()

export type Period = 'today' | '7d' | '30d' | '90d' | '1y' | 'all'
export const PERIODS: Period[] = ['today', '7d', '30d', '90d', '1y', 'all']
export const PERIOD_LABEL: Record<Period, string> = { today: 'Today', '7d': '7d', '30d': '30d', '90d': '90d', '1y': '1y', all: 'All' }
const SPAN: Record<Period, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: 0 }

/** Inclusive [from, to] of a period ending today, and the previous equivalent period (none for All). */
export const rangeOf = (p: Period, today: string, firstDay: string) => {
  if (p === 'all') return { from: firstDay || today, to: today, prev: null as null | { from: string; to: string } }
  const n = SPAN[p]
  const from = addDays(today, -(n - 1))
  return { from, to: today, prev: { from: addDays(from, -n), to: addDays(from, -1) } }
}

// ---------------------------------------------------------------- queries

export type Slice = {
  /** Activity tokens: uncached input + cache write + output. */
  tokens: number
  input: number; output: number; cw: number; cr: number
  /** Processed tokens: activity tokens + cache reads. */
  processed: number
  resp: number; prompts: number
  messages: number; sessions: Set<string>; days: Set<string>
}
const slice = (): Slice => ({ tokens: 0, input: 0, output: 0, cw: 0, cr: 0, processed: 0, resp: 0, prompts: 0, messages: 0, sessions: new Set(), days: new Set() })
const add = (s: Slice, sid: string, day: string, r: Row) => {
  s.tokens += r[0]; s.input += r[1]; s.output += r[2]; s.cw += r[3]; s.cr += r[4]; s.resp += r[5]; s.prompts += r[6]
  s.processed += r[0] + r[4]
  s.messages += r[5] + r[6]
  if (r[0] > 0 || r[5] + r[6] > 0) { s.sessions.add(sid); s.days.add(day) }
}

export type Stats = {
  all: Slice
  /** By project key. `names` gives each key's display name. */
  byProject: Map<string, Slice & { last: string }>
  names: Map<string, string>
  byModel: Map<string, Slice>
  byDay: Map<string, Slice>
  bySession: Map<string, Slice>
}

/** Everything in [from, to], optionally for one project key. */
export const stats = (a: Agg, resolve: Resolver, from: string, to: string, project?: string | null): Stats => {
  const out: Stats = { all: slice(), byProject: new Map(), names: new Map(), byModel: new Map(), byDay: new Map(), bySession: new Map() }
  for (const key in a.rows) {
    const [sid, day, cwd, model] = key.split('\t')
    if (day < from || day > to) continue
    const pr = resolve(cwd)
    if (project && pr.key !== project) continue
    const r = a.rows[key]
    add(out.all, sid, day, r)
    let p = out.byProject.get(pr.key)
    if (!p) { out.byProject.set(pr.key, (p = { ...slice(), last: '' })); out.names.set(pr.key, pr.name) }
    add(p, sid, day, r)
    if (day > p.last) p.last = day
    if (model) {
      let m = out.byModel.get(model)
      if (!m) out.byModel.set(model, (m = slice()))
      add(m, sid, day, r)
    }
    let d = out.byDay.get(day)
    if (!d) out.byDay.set(day, (d = slice()))
    add(d, sid, day, r)
    let s = out.bySession.get(sid)
    if (!s) out.bySession.set(sid, (s = slice()))
    add(s, sid, day, r)
  }
  return out
}

export const firstDay = (a: Agg): string => {
  let f = ''
  for (const d in a.hours) if (!f || d < f) f = d
  return f
}

/** Current streak (ending today, or yesterday when today has nothing yet) and the longest, in days. */
export const streaks = (a: Agg, today: string) => {
  const days = Object.keys(a.hours).filter(d => a.hours[d].some(v => v > 0)).sort()
  let longest = 0
  let run = 0
  let prev = ''
  for (const d of days) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = d
  }
  const set = new Set(days)
  let cur = 0
  let d = set.has(today) ? today : addDays(today, -1)
  while (set.has(d)) { cur++; d = addDays(d, -1) }
  return { current: cur, longest }
}

/** Hour and weekday histograms of a period (activity tokens or messages), local time. */
export const patterns = (a: Agg, from: string, to: string, by: 'tokens' | 'messages') => {
  const hours = new Array(24).fill(0)
  const week = new Array(7).fill(0)
  for (const d in a.hours) {
    if (d < from || d > to) continue
    const r = a.hours[d]
    for (let h = 0; h < 24; h++) {
      const v = by === 'tokens' ? r[h] : r[24 + h]
      hours[h] += v
      week[weekday(d)] += v
    }
  }
  const sum = (lo: number, hi: number) => hours.slice(lo, hi).reduce((x, y) => x + y, 0)
  const parts = { morning: sum(5, 12), afternoon: sum(12, 17), evening: sum(17, 22), night: sum(22, 24) + sum(0, 5) }
  const peak = (xs: number[]) => (xs.some(v => v > 0) ? xs.indexOf(Math.max(...xs)) : -1)
  return { hours, week, parts, peakHour: peak(hours), peakDay: peak(week) }
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0)

/**
 * Context growth over the last turns, from turn-end context sizes. A compaction
 * (-1) breaks the series: deltas across one are left out, never counted as shrink.
 */
export const growth = (ringIn: number[], live: number) => {
  const r = [...ringIn]
  if (live > 0 && r[r.length - 1] !== live) r.push(live)
  const deltas: number[] = [] // newest last; NaN where a compaction sits
  for (let i = 1; i < r.length; i++) deltas.push(r[i] === -1 || r[i - 1] === -1 ? NaN : r[i] - r[i - 1])
  const lastN = (n: number) => {
    const d = deltas.slice(-n)
    const ok = d.filter(x => !Number.isNaN(x))
    return { sum: ok.reduce((x, y) => x + y, 0), turns: ok.length, broken: ok.length < d.length }
  }
  const l5 = lastN(5)
  const l10 = lastN(10)
  const avg = l10.turns ? l10.sum / l10.turns : 0
  const prev = deltas.slice(-10, -5).filter(x => !Number.isNaN(x))
  const recent = deltas.slice(-5).filter(x => !Number.isNaN(x))
  let direction: 'rising' | 'steady' | 'easing' | null = null
  if (prev.length >= 3 && recent.length >= 3) {
    const a1 = mean(prev)
    const a2 = mean(recent)
    const d = a2 - a1
    direction = Math.abs(d) < Math.max(500, Math.abs(a1) * 0.25) ? 'steady' : d > 0 ? 'rising' : 'easing'
  }
  const pace = l10.turns < 2 ? null : avg < 2_000 ? 'Low' : avg < 10_000 ? 'Moderate' : 'Fast'
  return { l5, l10, avg, direction, pace }
}

/** Percent change from `prev` to `now`, or null when there is no base. */
export const change = (now: number, prev: number): number | null => (prev > 0 ? ((now - prev) / prev) * 100 : null)

/** The week holding `today`, Monday to Sunday (local dates), the week before, and how many days of this week have begun. */
export const weekRange = (today: string) => {
  const off = (weekday(today) + 6) % 7
  const from = addDays(today, -off)
  return { from, to: addDays(from, 6), prevFrom: addDays(from, -7), prevTo: addDays(from, -1), days: off + 1 }
}
