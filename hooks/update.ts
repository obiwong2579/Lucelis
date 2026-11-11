import type { EngineInterface } from 'claude-code'

// Check for updates, only when the person presses the button: one request to GitHub for the
// published plugin.json and, only if that version is newer, one for its CHANGELOG.md. Both go to
// fixed raw.githubusercontent.com addresses. Nothing is installed or run: a newer version gets
// the two update commands copied for the person to paste into the prompt.
//
// The host's fetch cannot be cancelled and always reads the whole body. So each request is
// bounded by a 10-second timeout (the request itself may finish later, unseen), and an answer
// larger than expected is refused rather than parsed.

export const LATEST_URL = 'https://raw.githubusercontent.com/obiwong2579/Lucelis/main/.claude-plugin/plugin.json'
/** The published notes, read only after a check found a newer version, to say what it brings. */
export const LATEST_NOTES_URL = 'https://raw.githubusercontent.com/obiwong2579/Lucelis/main/CHANGELOG.md'
export const UPDATE_COMMANDS = '/plugin marketplace update lucelis\n/plugin update lucelis@lucelis'
export const NOTES_URL = 'https://github.com/obiwong2579/Lucelis/blob/main/CHANGELOG.md'
const TIMEOUT_MS = 10_000
/** Largest answers read: the manifest is under 1 KB, the changelog a few KB. */
const MAX_MANIFEST = 64 * 1024
const MAX_NOTES = 512 * 1024

/** A fetch raced against the timeout; resolves the answer or 'timeout', never rejects late. */
async function fetchBounded($: EngineInterface, url: string, accept: string) {
  const timer = $.clock.sleep(TIMEOUT_MS).then(() => 'timeout' as const, () => 'timeout' as const)
  return Promise.race([$.http.fetch(url, { headers: { accept } }), timer])
}

/** Semantic Versioning 2.0.0 (an optional leading "v" allowed): core, pre-release, build. */
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** Numbers are kept as digit strings, so any size compares exactly (no float rounding). */
export type SemVer = { core: [string, string, string]; pre: string[] }
/** A version string read by SemVer rules, or null when it is not one (empty, "1.2", "1.0.0-", ...). */
export const parseVersion = (v: unknown): SemVer | null => {
  if (typeof v !== 'string' || v.length > 256) return null
  const m = SEMVER.exec(v.trim())
  return m ? { core: [m[1], m[2], m[3]], pre: m[4] ? m[4].split('.') : [] } : null
}

/** Compares two digit strings without leading zeros (as SemVer requires): longer is larger. */
const cmpDigits = (p: string, q: string): number =>
  p.length !== q.length ? (p.length > q.length ? 1 : -1) : p === q ? 0 : p > q ? 1 : -1

/**
 * -1, 0 or 1 for a < b, a = b, a > b by SemVer precedence: core numbers numerically; a release
 * above its pre-releases; pre-release fields left to right, numbers numerically and below words,
 * words by ASCII, fewer fields lower; build metadata ignored. 0 when either is not a version
 * (so a malformed version is never "newer").
 */
export const compareVersions = (a: string, b: string): number => {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) { const c = cmpDigits(x.core[i], y.core[i]); if (c) return c }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return cmpDigits(p, q)
    if (pn !== qn) return pn ? -1 : 1
    return p > q ? 1 : -1
  }
  return 0
}

/** The version of the copy that is running, from its own manifest. */
export async function installedVersion($: EngineInterface): Promise<string> {
  try {
    const m = JSON.parse(await $.fs.read(`${$.plugin.root}\\.claude-plugin\\plugin.json`))
    return typeof m.version === 'string' ? m.version : ''
  } catch { return '' }
}

/** Asks GitHub for the latest published version. Resolves the version, or throws a short reason. */
export async function latestVersion($: EngineInterface): Promise<string> {
  const r = await fetchBounded($, LATEST_URL, 'application/json')
  if (r === 'timeout') throw new Error('no answer within 10 seconds')
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
  if (typeof r.text !== 'string' || r.text.length > MAX_MANIFEST) throw new Error('the answer was not readable')
  let v: unknown
  try { v = JSON.parse(r.text)?.version } catch { throw new Error('the answer was not readable') }
  if (!parseVersion(v)) throw new Error('the answer had no valid version')
  return (v as string).trim()
}

/**
 * One line for "Updated to X": the bold lead of each bullet in the version's CHANGELOG section
 * ("Low-quota warning, Logo states, ..."), else its first bullet, cut to `max` characters.
 */
export const whatsNew = (changelog: string, version: string, max = 110): string => {
  const lines = changelog.split(/\r?\n/)
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const at = lines.findIndex(l => new RegExp(`^##\\s+v?${esc}(\\s|$)`).test(l))
  if (at < 0) return ''
  const body: string[] = []
  for (const l of lines.slice(at + 1)) { if (/^##\s/.test(l)) break; if (/^\s*-\s+/.test(l)) body.push(l.replace(/^\s*-\s+/, '')) }
  const leads = body.map(b => /^\*\*(.+?)\*\*/.exec(b)?.[1].replace(/[.:]\s*$/, '')).filter((x): x is string => !!x)
  const text = leads.length ? leads.join(', ') : (body[0] ?? '').replace(/\*\*/g, '')
  return text.length > max ? text.slice(0, max - 1).replace(/[\s,]+\S*$/, '') + '…' : text
}

/** What a newer version brings, from its published notes ("Low-quota warning, Logo, ..."); '' if they cannot be read. */
export async function latestNotes($: EngineInterface, version: string): Promise<string> {
  try {
    const r = await fetchBounded($, LATEST_NOTES_URL, 'text/plain')
    return r !== 'timeout' && r.ok && typeof r.text === 'string' && r.text.length <= MAX_NOTES ? whatsNew(r.text, version, 160) : ''
  } catch { return '' }
}
