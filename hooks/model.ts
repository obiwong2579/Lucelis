// What the bar and the cockpit show, computed from the engine's live figures
// and the history aggregate. Pure: no engine calls. A field that cannot be
// known is null, and the drawing then leaves it out.

import type { Ctx, TurnFacts, Window } from '../types'
import type { Agg, Alias, Project, Sess } from './agg'
import { addDays, change, growth, localDay, makeResolver, median, stats } from './agg'
import type { Composition, CostRow, Mode } from './prices'
import { compose, costTable } from './prices'
import type { CacheWatch } from './cachewatch'
import { isKnown, marksFor, stateAt } from './cachewatch'

/** `stale`: last seen in an earlier session, not this one's own figure yet. */
export type Quota = { kind: string; left: number; resetIn: number | null; stale?: boolean }

export type View = {
  quotas: Quota[]
  cache: null | {
    /** Inferred from request timing (60 min after the last main-thread request), not reported by the engine. */
    mode: Mode
    idleMs: number
    minsLeft: number
    /** Context the next request re-sends (the engine's context tokens). */
    resend: number
    /** Tokens of the last main-thread request now in the cache (written + read), from history. */
    cached: number | null
    /** cached / that request's whole prompt, 0-100. */
    reusable: number | null
    /** Of the last turn's input, the share served from cache, 0-100. */
    lastTurnHit: number | null
    /** Of this session's input, the share served from cache, 0-100. */
    sessionHit: number | null
  }
  composition: Composition | null
  costs: CostRow[] | null
  ctx: null | { percent: number; tokens: number; window: number; left: number; isNearLimit: boolean }
  session: null | {
    project: Project | null
    model: string | null
    /** now - the session's first recorded event (or its start). */
    elapsedMs: number | null
    /** Estimated active time: gaps under 30 minutes between events, summed. */
    activeMs: number | null
    startedAt: number | null
    messages: number | null
    prompts: number | null
    input: number | null
    output: number | null
    cacheWrite: number | null
    cacheRead: number | null
    /** Activity tokens: uncached input + cache write + output. */
    tokens: number | null
    compactions: number | null
    lastCompactionAgo: number | null
  }
  growth: ReturnType<typeof growth> | null
  today: null | {
    tokens: number
    project: null | { name: string; tokens: number; sessions: number; messages: number; share: number | null }
  }
  week: null | { tokens: number; change: number | null; project: null | { tokens: number; change: number | null }; share30: number | null }
  relative: null | { n: number; tokens: [number, number]; active: [number, number]; messages: [number, number] }
  modelMix: null | { project: string; rows: { model: string; share: number }[] }
}

const leftOf = (w: Window) => Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
const ORDER: Record<string, number> = { five_hour: 0, seven_day: 1 }

export type Inputs = {
  now: number
  windows: readonly Window[]
  cache: CacheWatch | null
  ctx: Ctx | null
  turn: TurnFacts | null
  model: string | null
  sid: string | null
  /** The session's working directory: names the project before history has it. */
  cwd: string | null
  /** When the engine says this session began (ms), for elapsed time before history has it. */
  startedAt: number | null
  aliases: readonly Alias[]
  agg: Agg | null
}

export const view = (i: Inputs): View => {
  const a = i.agg
  const s: Sess | null = a && i.sid ? a.sess[i.sid] ?? null : null
  const resolve = makeResolver(a ?? { sess: {}, git: {} } as unknown as Agg, i.aliases)
  const quotas = [...i.windows]
    .sort((x, y) => (ORDER[x.kind] ?? 9) - (ORDER[y.kind] ?? 9))
    .map(w => ({ kind: w.kind, left: leftOf(w), resetIn: w.resetsAt && !Number.isNaN(Date.parse(w.resetsAt)) ? Date.parse(w.resetsAt) - i.now : null, ...(w.stale ? { stale: true } : {}) }))

  // Cache: the inferred warm/cold state; the cached/reusable split from the last request on record.
  let cache: View['cache'] = null
  let costs: CostRow[] | null = null
  let composition: Composition | null = null
  const w = i.cache
  if (isKnown(w)) {
    const { mode, idleMs, minsLeft } = stateAt(w, i.now)
    const lu = s?.lu
    const prompt = lu ? lu[0] + lu[1] + lu[2] : 0
    const t = i.turn
    const tIn = t ? t.input + t.cacheRead + t.cacheWrite : 0
    const sIn = s ? s.in + s.cw + s.cr : 0
    cache = {
      mode,
      idleMs,
      minsLeft,
      resend: w.context,
      cached: lu && prompt > 0 ? lu[1] + lu[2] : null,
      reusable: lu && prompt > 0 ? ((lu[1] + lu[2]) / prompt) * 100 : null,
      lastTurnHit: t && tIn > 0 ? (t.cacheRead / tIn) * 100 : null,
      sessionHit: s && sIn > 0 ? (s.cr / sIn) * 100 : null,
    }
    // Measured composition only when the last request on record is this session's latest
    // (history may lag a turn behind the live context); otherwise the whole context is
    // assumed to be the cached prefix.
    const fresh = !!lu && prompt > 0 && Math.abs(prompt - w.context) <= Math.max(2_000, w.context * 0.02)
    composition = compose(fresh && lu ? { input: lu[0], cacheWrite: lu[1], cacheRead: lu[2], output: lu[3] } : null, w.context)
    const { mine, marks } = marksFor(w, i.model)
    if (composition) costs = costTable(composition, mine, normalizeKeys(marks), i.now)
  }

  const x = i.ctx
  const ctx = x && x.window > 0 && x.tokens > 0
    ? {
        percent: x.percent ?? Math.round((x.tokens / x.window) * 100),
        tokens: x.tokens,
        window: x.window,
        left: Math.max(0, x.window - x.tokens),
        // Concrete risk only: within 10% of the model's real window.
        isNearLimit: x.tokens / x.window >= 0.9,
      }
    : null

  const project = s?.cwd || i.cwd ? resolve(s?.cwd || i.cwd) : null
  const first = s?.first || i.startedAt || null
  const session: View['session'] = {
    project,
    model: i.model,
    elapsedMs: first ? Math.max(0, i.now - first) : null,
    activeMs: s ? s.act : null,
    startedAt: first,
    messages: s ? s.resp + s.prompts : null,
    prompts: s ? s.prompts : null,
    input: s ? s.in : null,
    output: s ? s.out : null,
    cacheWrite: s ? s.cw : null,
    cacheRead: s ? s.cr : null,
    tokens: s ? s.in + s.cw + s.out : null,
    compactions: s ? s.comp : null,
    lastCompactionAgo: s && s.lastComp ? i.now - s.lastComp : null,
  }

  const g = s ? growth(s.ring, x?.tokens ?? 0) : null

  let today: View['today'] = null
  let week: View['week'] = null
  let relative: View['relative'] = null
  let modelMix: View['modelMix'] = null
  if (a && a.today) {
    const day = localDay(i.now, a.tz)
    const td = stats(a, resolve, day, day)
    const key = project?.key
    const tp = key ? td.byProject.get(key) : undefined
    today = {
      tokens: td.all.tokens,
      project: project
        ? {
            name: project.name,
            tokens: tp?.tokens ?? 0,
            sessions: tp?.sessions.size ?? 0,
            messages: tp?.messages ?? 0,
            share: td.all.tokens > 0 ? ((tp?.tokens ?? 0) / td.all.tokens) * 100 : null,
          }
        : null,
    }
    const w = stats(a, resolve, addDays(day, -6), day)
    const wp = stats(a, resolve, addDays(day, -13), addDays(day, -7))
    const m30 = stats(a, resolve, addDays(day, -29), day)
    const p7 = key ? w.byProject.get(key)?.tokens ?? 0 : 0
    const pp7 = key ? wp.byProject.get(key)?.tokens ?? 0 : 0
    week = {
      tokens: w.all.tokens,
      change: change(w.all.tokens, wp.all.tokens),
      project: key ? { tokens: p7, change: change(p7, pp7) } : null,
      share30: key && m30.all.tokens > 0 ? ((m30.byProject.get(key)?.tokens ?? 0) / m30.all.tokens) * 100 : null,
    }
    if (key && project) {
      // This session against the project's other sessions (by each one's latest project); 5 at least.
      const others = Object.entries(a.sess).filter(([id, o]) => id !== i.sid && o.resp > 0 && resolve(o.cwd).key === key)
      if (others.length >= 5 && s) {
        relative = {
          n: others.length,
          tokens: [s.in + s.cw + s.out, median(others.map(([, o]) => o.in + o.cw + o.out))],
          active: [s.act, median(others.map(([, o]) => o.act))],
          messages: [s.resp + s.prompts, median(others.map(([, o]) => o.resp + o.prompts))],
        }
      }
      const pm = stats(a, resolve, addDays(day, -29), day, key)
      if (pm.all.tokens > 0) {
        modelMix = {
          project: project.name,
          rows: [...pm.byModel.entries()]
            .map(([model, sl]) => ({ model, share: (sl.tokens / pm.all.tokens) * 100 }))
            .sort((p, q) => q.share - p.share),
        }
      }
    }
  }
  return { quotas, cache, composition, costs, ctx, session, growth: g, today, week, relative, modelMix }
}

const normalizeKeys = (m: Record<string, { at: number; ctx: number }>) => {
  const out: Record<string, { at: number; ctx: number }> = {}
  for (const [k, v] of Object.entries(m)) {
    const id = k.toLowerCase().replace(/^anthropic\./, '').replace(/\[[^\]]*\]$/, '').replace(/[@-]\d{8}$/, '')
    if (!out[id] || out[id].at < v.at) out[id] = v
  }
  return out
}
