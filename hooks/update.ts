import type { EngineInterface } from 'claude-code'

// Check for updates: one request to GitHub for the published plugin.json, made only when the
// person presses the button. Nothing is installed or run: a newer version gets the two update
// commands copied for the person to paste into the prompt.

export const LATEST_URL = 'https://raw.githubusercontent.com/obiwong2579/Lucelis/main/.claude-plugin/plugin.json'
export const UPDATE_COMMANDS = '/plugin marketplace update lucelis\n/plugin update lucelis@lucelis'
export const NOTES_URL = 'https://github.com/obiwong2579/Lucelis/blob/main/CHANGELOG.md'
const TIMEOUT_MS = 10_000

/** -1, 0 or 1 for a < b, a = b, a > b, by dotted numbers; a pre-release (1.0.0-rc.2) is below its release. */
export const compareVersions = (a: string, b: string): number => {
  const [ma, pa = ''] = a.trim().replace(/^v/, '').split('-', 2)
  const [mb, pb = ''] = b.trim().replace(/^v/, '').split('-', 2)
  const na = ma.split('.').map(n => Number(n) || 0)
  const nb = mb.split('.').map(n => Number(n) || 0)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  if (pa === pb) return 0
  if (!pa) return 1
  if (!pb) return -1
  return pa < pb ? -1 : 1
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
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => { throw new Error('no answer within 10 seconds') })
  const r = await Promise.race([$.http.fetch(LATEST_URL, { headers: { accept: 'application/json' } }), timeout])
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
  let v: unknown
  try { v = JSON.parse(r.text).version } catch { throw new Error('the answer was not readable') }
  if (typeof v !== 'string' || !/^\d+(\.\d+)*(-[\w.]+)?$/.test(v)) throw new Error('the answer had no version')
  return v
}

/**
 * One line for "Updated to X": the bold lead of each bullet in the version's CHANGELOG section
 * ("Low-quota warning, Logo states, ..."), else its first bullet, cut to `max` characters.
 */
export const whatsNew = (changelog: string, version: string, max = 110): string => {
  const lines = changelog.split(/\r?\n/)
  const at = lines.findIndex(l => new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(\\s|$)`).test(l))
  if (at < 0) return ''
  const body: string[] = []
  for (const l of lines.slice(at + 1)) { if (/^##\s/.test(l)) break; if (/^\s*-\s+/.test(l)) body.push(l.replace(/^\s*-\s+/, '')) }
  const leads = body.map(b => /^\*\*(.+?)\*\*/.exec(b)?.[1].replace(/[.:]\s*$/, '')).filter((x): x is string => !!x)
  const text = leads.length ? leads.join(', ') : (body[0] ?? '').replace(/\*\*/g, '')
  return text.length > max ? text.slice(0, max - 1).replace(/[\s,]+\S*$/, '') + '…' : text
}
