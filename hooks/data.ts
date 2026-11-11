// The engine side of the history pipeline: builds an Io over $ and runs core.ts.
// Runs only when asked: at session start, after a main-thread turn (throttled),
// on pane open and on the commands. Never on a timer while idle; never writes a
// transcript. Holds no session state: callers put the returned note into $.state.

import type { EngineInterface } from 'claude-code'

import type { Agg, FileTask } from './agg'
import type { Io, Mem, Paths } from './core'
import { loadCore, refreshCore } from './core'

/** Output budget per extractor call, in characters (stdout is cut at 4 MiB). */
const MAX_OUT = 2_000_000

const mem: Mem = { held: null, seq: 0 }
let running: Promise<string> | null = null

export const aggNow = (): Agg | null => mem.held

const join = (...p: string[]) => p.join('\\').replace(/[\\/]+/g, '\\')

export async function paths($: EngineInterface): Promise<Paths> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const claude = cfg || join(home, '.claude')
  return { projects: join(claude, 'projects'), dir: join(claude, 'lucelis') }
}

export function makeIo($: EngineInterface): Io {
  return {
    now: () => $.clock.now(),
    exists: async p => { try { return await $.fs.exists(p) } catch { return false } },
    read: p => $.fs.read(p),
    write: (p, text) => $.fs.write(p, text),
    list: async p => (await $.fs.list(p)).map(e => ({ name: e.name, kind: e.kind, size: e.size })),
    extract: async (root: string, tasks: FileTask[], own: string[]) => {
      const script = join($.plugin.root, 'scripts', 'extract.ps1')
      const r = await $.process.run(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdin: JSON.stringify({ root, max: MAX_OUT, files: tasks, own }), timeoutMs: 600_000 },
      )
      if (r.exitCode !== 0) throw new Error(`extractor exit ${r.exitCode}: ${r.stderr.slice(0, 300)}`)
      if (r.isStdoutTruncated) throw new Error('extractor output was cut')
      return r.stdout
    },
  }
}

/** Refreshes once at a time; `full` rebuilds from nothing. Resolves a one-line note; never rejects. */
export async function refresh($: EngineInterface, full = false): Promise<string> {
  if (running) { const r = await running; if (!full) return r }
  const p = await paths($)
  running = refreshCore(makeIo($), p, mem, full)
    .catch(err => `Refresh failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
    .finally(() => { running = null })
  return running
}

/** Loads the newest cache snapshot if nothing is held yet (no extraction). */
export async function ensureLoaded($: EngineInterface): Promise<void> {
  if (mem.held) return
  try { await loadCore(makeIo($), await paths($), mem) } catch { mem.held = null }
}
