// A made-up history in the extractor's output format, with the answer counted separately.
//
// Nothing here comes from a real transcript: folders, session ids and figures are invented
// and deterministic (a fixed seed). It stands in for the optional private fixture
// (real-history.ts), so the same checks always run: totals against an independent count,
// duplicate copies counted once, a corrupt row left out, and project detection.

export type History = {
  out: string
  tasks: { p: string; o: number; owner: string }[]
  expect: { responses_all: number; activity: number; cacheReads: number; prompts: number; flagged: number; compactions: number; sessions: number }
}

const TZ = 480 // minutes east of UTC, as the extractor reports it
const START = Date.parse('2026-09-01T01:00:00Z')
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
/** Where sessions are launched, and the folders they move through afterwards. */
const LAUNCHES: { root: string; moves: string[] }[] = [
  { root: 'D:\\Work\\Atlas', moves: ['D:\\Work\\Atlas', 'D:\\Work\\Atlas\\web', 'D:\\Work\\Atlas\\web\\src'] },
  { root: 'D:\\Work\\Borealis', moves: ['D:\\Work\\Borealis', 'D:\\Work\\Borealis\\api'] },
  { root: 'D:\\Work', moves: ['D:\\Work', 'D:\\Work\\Cygnus', 'D:\\Work\\Cygnus\\docs'] },
  { root: 'E:\\Sandbox', moves: ['E:\\Sandbox'] },
]

export const makeHistory = (sessions = 48, seed = 20261110): History => {
  // A small fixed-seed generator: the same history on every run and every machine.
  let state = seed >>> 0
  const rnd = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n }
  const stamp = (ms: number) => { const d = new Date(ms + TZ * 60000).toISOString(); return [d.slice(0, 10), Number(d.slice(11, 13))] as const }

  const lines: string[] = [`N\t2026-11-10\t${TZ}`]
  const tasks: History['tasks'] = []
  const expect = { responses_all: 0, activity: 0, cacheReads: 0, prompts: 0, flagged: 0, compactions: 0, sessions: 0 }
  let msg = 0
  let carried: string | null = null // a deleted session's reply, present in two files

  for (let i = 0; i < sessions; i++) {
    const sid = `syn-${String(i).padStart(3, '0')}`
    const launch = LAUNCHES[i % LAUNCHES.length]
    const model = MODELS[rnd(MODELS.length)]
    let ms = START + i * 86_400_000 + rnd(3_600_000)
    let context = 5_000 + rnd(20_000)
    const file = `projects\\syn\\${sid}.jsonl`
    tasks.push({ p: file, o: 0, owner: sid })
    expect.sessions++

    // A session whose own file is gone lives on as copies inside the files of sessions resumed
    // or forked from it. Its reply appears in two files here and must be counted once.
    if (carried) { lines.push(carried); carried = null }
    else if (i % 5 === 0) {
      const [day, hour] = stamp(ms)
      const gone = ['A', `syn-gone-${i}`, `msg_syn_${++msg}`, ms, day, hour, model, 7, 70, 700, 7_000, launch.root, 0].join('\t')
      lines.push(gone)
      carried = gone
      expect.responses_all++; expect.activity += 777; expect.cacheReads += 7_000; expect.sessions++
    }

    const turns = 2 + rnd(6)
    for (let t = 0; t < turns; t++) {
      const cwd = launch.moves[Math.min(t, launch.moves.length - 1)]
      ms += 20_000 + rnd(240_000)
      const [pd, ph] = stamp(ms)
      lines.push(['P', sid, `${sid}-u${t}`, ms, pd, ph, cwd].join('\t'))
      expect.prompts++

      const replies = 1 + rnd(3)
      for (let r = 0; r < replies; r++) {
        ms += 5_000 + rnd(90_000)
        const [day, hour] = stamp(ms)
        const side = r > 0 && rnd(4) === 0 ? 1 : 0 // a sub-agent's reply
        const vin = 1 + rnd(400); const vout = 50 + rnd(4_000); const vcw = rnd(6_000); const vcr = side ? rnd(30_000) : context
        const row = ['A', sid, `msg_syn_${++msg}`, ms, day, hour, model, vin, vout, vcw, vcr, cwd, side].join('\t')
        lines.push(row)
        expect.responses_all++
        expect.activity += vin + vout + vcw
        expect.cacheReads += vcr
        if (!side) context += vin + vcw
        // The same reply written twice in one file (several content blocks): counted once.
        if (rnd(7) === 0) lines.push(row)
      }

      if (t === 3) { // one compaction in the longer sessions
        ms += 1_000
        lines.push(['C', sid, `${sid}-c${t}`, ms].join('\t'))
        expect.compactions++
        context = 8_000
      }
    }

    // One session in twelve carries a corrupt row (a negative count): flagged, never counted.
    if (i % 12 === 7) {
      const [day, hour] = stamp(ms + 1)
      lines.push(['A', sid, `msg_syn_bad_${i}`, ms + 1, day, hour, model, -5, 10, 10, 10, launch.root, 0].join('\t'))
      expect.flagged++
    }
    lines.push(['F', file, 1_000 + lines.length, 1].join('\t'))
  }
  return { out: lines.join('\n') + '\n', tasks, expect }
}
