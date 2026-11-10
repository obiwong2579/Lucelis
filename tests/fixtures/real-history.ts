// Optional private fixture: the owner's own history in the extractor's output format, with an
// independently made count. It is never distributed, so this file ships as `null`.
//
// When it is null, the two "real history" tests in fixtures.test.ts are not registered: they
// are reported as "(skip)" and are not counted as passes. The same checks always run on the
// synthetic history in synthetic-history.ts.
//
// Shape when present: { out: string, tasks: { p, o, owner }[], expect: { responses_all, activity, cacheReads, prompts } }
export const REAL: any = null
