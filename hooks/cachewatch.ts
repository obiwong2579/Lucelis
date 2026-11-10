// Prompt-cache watch. Claude Code writes its prompt cache with a one-hour lifetime
// (the transcripts record it as usage.cache_creation.ephemeral_1h_input_tokens), and
// each model keeps a cache of its own. The engine reports no cache state, so Lucelis
// INFERS it: it notes when each model last served a main-thread request and how much
// context the conversation held then. Everything here is a pure function of that
// record; register.tsx feeds it from engine events and model.ts reads it.

import type { CacheWatch, ModelMark } from '../types'

/** How long a cache entry lives after the request that last read or wrote it. */
export const CACHE_LIFE_MIN = 60
export const CACHE_LIFE_MS = CACHE_LIFE_MIN * 60_000

export type CacheMode = 'warm' | 'cold'

export type { CacheWatch, ModelMark } from '../types'

const blank = (): CacheWatch => ({ models: {}, current: null, at: 0, context: 0, window: 0 })
const positive = (n: number | null | undefined): number | null => (typeof n === 'number' && n > 0 ? n : null)

/** A main-thread request is going out now: the model that serves it has a fresh hour. */
export const requestSent = (w: CacheWatch | null, now: number, model: string | null | undefined): CacheWatch => {
  const base = w ?? blank()
  const id = model || base.current
  const models = model ? { ...base.models, [model]: { at: now, ctx: base.context } } : base.models
  return { ...base, models, current: id ?? null, at: now }
}

/** The engine measured the context again. Nothing is known to have been sent, so no clock moves. */
export const contextMeasured = (w: CacheWatch | null, context: number | null | undefined, window: number | null | undefined): CacheWatch | null => {
  const size = positive(context)
  if (!w || size === null) return w
  return { ...w, context: size, window: positive(window) ?? w.window }
}

/**
 * A main-thread turn ended `tookMs` after it began. If a request of this turn was already
 * noted, its time stands; if none was (the turn was not seen starting), the end of the turn
 * is the latest moment the cache can have been touched.
 */
export const turnEnded = (
  w: CacheWatch | null,
  now: number,
  tookMs: number,
  facts: { context?: number | null; window?: number | null; model?: string | null },
): CacheWatch => {
  const base = w ?? blank()
  const seenThisTurn = base.at > 0 && base.at >= now - tookMs
  const at = seenThisTurn ? base.at : now
  const context = positive(facts.context) ?? base.context
  const current = facts.model || base.current
  const models = { ...base.models }
  // A model that already has a mark keeps its own request time; only what it holds is refreshed.
  if (current && models[current]) models[current] = { at: models[current].at, ctx: context }
  return { models, current: current ?? null, at, context, window: positive(facts.window) ?? base.window }
}

/** A session that was resumed or forked says how long ago its last reply was and how large it is. */
export const sessionReturned = (now: number, awaySeconds: number, context: number, window: number, model: string | null): CacheWatch => {
  const at = now - Math.max(0, awaySeconds) * 1000
  return { models: model ? { [model]: { at, ctx: context } } : {}, current: model, at, context, window }
}

/** Whether there is enough on record to say anything about the cache. */
export const isKnown = (w: CacheWatch | null): w is CacheWatch => !!w && w.at > 0 && w.context > 0

/** The inferred state at `now`: warm inside the lifetime, cold after it. */
export const stateAt = (w: CacheWatch, now: number): { mode: CacheMode; idleMs: number; minsLeft: number } => {
  const idleMs = now > w.at ? now - w.at : 0
  const mode: CacheMode = idleMs < CACHE_LIFE_MS ? 'warm' : 'cold'
  return { mode, idleMs, minsLeft: mode === 'warm' ? CACHE_LIFE_MIN - Math.floor(idleMs / 60_000) : 0 }
}

/** Every model's mark, with the session's current model at least as fresh as the last request. */
export const marksFor = (w: CacheWatch, fallbackModel: string | null): { mine: string | null; marks: Record<string, ModelMark> } => {
  const mine = w.current ?? fallbackModel
  const marks = { ...w.models }
  if (mine && (!marks[mine] || marks[mine].at < w.at)) marks[mine] = { at: w.at, ctx: w.context }
  return { mine, marks }
}
