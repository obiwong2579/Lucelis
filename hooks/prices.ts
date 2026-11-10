// Next-message pricing: one dated table, matched on exact model ids.
//
// SOURCE: https://platform.claude.com/docs/en/about-claude/pricing ("Model pricing"),
// read 2026-11-09; the Fable 5.2 row added from the same page on 2026-11-10. Claude Code writes 1-hour cache entries (the transcripts'
// usage.cache_creation.ephemeral_1h_input_tokens), so writes use the 1h price.
// Haiku 5.5 is priced by prompt length: a request whose prompt (all input, cache
// reads and writes included) is over 100,000 tokens pays the higher row.
//
// API-PRICE EQUIVALENT ESTIMATE, NOT YOUR BILL: input side only. Excluded: the
// text of your next message and every output token. On a subscription you are
// not billed per token.
//
// Whether a model's cache is warm is decided by cachewatch.ts (inferred from request
// timing: the engine reports no cache state).

import { CACHE_LIFE_MS } from './cachewatch'
import type { CacheMode } from './cachewatch'

export const PRICES_AS_OF = '2026-11-10'
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'

export type Mode = CacheMode

/** $ per million tokens. */
export type Rates = { input: number; write1h: number; read: number }
export type PriceEntry = { id: string; name: string; rates: Rates; over?: { above: number; rates: Rates } }

/** Exact model ids only: no family guessing, so an unlisted version is "unpriced", never mispriced. */
export const PRICE_TABLE: PriceEntry[] = [
  { id: 'claude-fable-5-2', name: 'Fable 5.2', rates: { input: 8, write1h: 16, read: 0.2 } },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', rates: { input: 10, write1h: 20, read: 0.25 } },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', rates: { input: 4, write1h: 8, read: 0.2 } },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', rates: { input: 2, write1h: 4, read: 0.1 } },
  {
    id: 'claude-haiku-5-5', name: 'Haiku 5.5',
    rates: { input: 0.1, write1h: 0.2, read: 0.01 },
    over: { above: 100_000, rates: { input: 0.5, write1h: 1, read: 0.05 } },
  },
]

/** claude-opus-5-5, claude-opus-5-5[1m], anthropic.claude-opus-5-5, claude-opus-5-5@20260101 all name one row. */
export const normalizeModel = (m: string | null | undefined): string =>
  (m ?? '').toLowerCase().trim().replace(/^anthropic\./, '').replace(/\[[^\]]*\]$/, '').replace(/[@-]\d{8}$/, '')

export const priceFor = (model: string | null | undefined): PriceEntry | null => {
  const id = normalizeModel(model)
  return PRICE_TABLE.find(p => p.id === id) ?? null
}

/** The rates a request of `prompt` tokens pays (Haiku 5.5's tier included). */
export const ratesFor = (p: PriceEntry, prompt: number): Rates => (p.over && prompt > p.over.above ? p.over.rates : p.rates)

/**
 * What the next request's prompt is made of.
 * measured: from the last main-thread request (uncached input, cache write,
 * cache read, output). Next prompt = that prompt + the reply it produced; the
 * prefix written or read last time (write + read) is now in cache, and the rest
 * (the uncached part plus the reply) is new tail that gets written.
 * assumed: no request on record yet: the whole re-sent context
 * is treated as the cached prefix, so the warm figure is a lower bound.
 */
export type Composition = { read: number; write: number; basis: 'measured' | 'assumed' }

export const compose = (last: { input: number; cacheWrite: number; cacheRead: number; output: number } | null, resend: number): Composition | null => {
  if (last && last.cacheRead + last.cacheWrite + last.input > 0) {
    return { read: last.cacheRead + last.cacheWrite, write: last.input + last.output, basis: 'measured' }
  }
  return resend > 0 ? { read: resend, write: 0, basis: 'assumed' } : null
}

/** Cost of one prompt: `read` tokens from cache, `write` tokens written to the 1h cache. */
export const promptCost = (p: PriceEntry, read: number, write: number): number => {
  const r = ratesFor(p, read + write)
  return (read * r.read + write * r.write1h) / 1e6
}
/** The same prompt fully cold: everything is written to the 1h cache. */
export const coldPromptCost = (p: PriceEntry, total: number): number => (total * ratesFor(p, total).write1h) / 1e6

export type CostRow = {
  id: string
  name: string
  isMine: boolean
  /** No price row for this model id: shown, never priced. */
  isUnpriced: boolean
  mode: Mode
  now: number
  cold: number
  saves: number
  isCheapest: boolean
}

/** A model's own cache: when it last served a request in this session, and the context then. */
export type ModelCache = Record<string, { at: number; ctx: number }>

/**
 * One row per priced model, plus the session's model when it has no price.
 * The cache is per model: a model is warm only within the cache lifetime of its own last
 * request; its warm prefix is what it held then (at most the prompt now).
 */
export const costTable = (c: Composition, mine: string | null, byModel: ModelCache, now: number): CostRow[] => {
  const total = c.read + c.write
  const mineId = normalizeModel(mine)
  const rows: CostRow[] = PRICE_TABLE.map(p => {
    const isMine = p.id === mineId
    const own = byModel[p.id]
    const warm = !!own && now - own.at < CACHE_LIFE_MS
    const cold = coldPromptCost(p, total)
    let cost = cold
    if (warm && isMine) cost = promptCost(p, c.read, c.write)
    else if (warm) { const read = Math.min(own!.ctx, total); cost = promptCost(p, read, total - read) }
    return { id: p.id, name: p.name, isMine, isUnpriced: false, mode: (warm ? 'warm' : 'cold') as Mode, now: cost, cold, saves: Math.max(0, cold - cost), isCheapest: false }
  })
  if (mineId && !rows.some(r => r.isMine)) {
    rows.unshift({ id: mineId, name: mineId, isMine: true, isUnpriced: true, mode: 'cold', now: 0, cold: 0, saves: 0, isCheapest: false })
  }
  const priced = rows.filter(r => !r.isUnpriced)
  const low = Math.min(...priced.map(r => r.now))
  for (const r of priced) r.isCheapest = priced.length > 1 && r.now === low
  return rows
}

export const usd = (n: number): string => (n < 0.995 ? '$' + n.toFixed(n < 0.01 && n > 0 ? 4 : 2) : n < 99.5 ? '$' + n.toFixed(2) : '$' + Math.round(n))
