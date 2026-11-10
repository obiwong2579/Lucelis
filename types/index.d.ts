/** One usage window as the engine reports it: which, how much used (0-100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/** One model's last main-thread request: when (epoch ms) and the context it held. */
export type ModelMark = { at: number; ctx: number }

/**
 * What Lucelis has noted about the prompt cache (hooks/cachewatch.ts). INFERRED from
 * request timing; the engine reports no cache state.
 */
export type CacheWatch = {
  /** A mark per model id seen in this session. */
  models: Record<string, ModelMark>
  /** The model of the most recent request, when known. */
  current: string | null
  /** When the main thread last sent a request, whichever model served it. 0: not yet. */
  at: number
  /** Context tokens the next request carries, and the size of the window. */
  context: number
  window: number
}

/** The last main-thread turn's summed usage, from turn.complete. */
export type TurnFacts = { input: number; output: number; cacheRead: number; cacheWrite: number; model: string | null }

/** Settings the person changes in the pane; kept in $.store across sessions. */
export type Settings = {
  isOn: boolean
  mode: 'minimal' | 'normal' | 'detailed'
  /** Normal density: items that do not fit the first row go to a second one (v0.2.3). */
  wrap: boolean
  /** The Lucelis glyph at the start of the bar, where the surface can draw it and room is spare. */
  logo: boolean
  /** A filled (navy) background behind the bar. Off: the bar sits on the app's own background. */
  bg: boolean
  period: 'today' | '7d' | '30d' | '90d' | '1y' | 'all'
  heat: 'tokens' | 'sessions' | 'messages'
  /** One toggle per compact-bar item (bar.tsx ITEMS). `resets` and `elapsed` are new in v0.2.3. */
  show: { h5: boolean; d7: boolean; cache: boolean; ctx: boolean; resets: boolean; today: boolean; session: boolean; elapsed: boolean; trend: boolean; project: boolean; model: boolean }
  /** Project root -> display name, for when automatic detection is ambiguous. */
  aliases: { path: string; name: string }[]
}

/** What the Activity pane is showing. */
export type PaneView = {
  period: Settings['period'] | null
  heat: Settings['heat'] | null
  modelBy: 'tokens' | 'sessions' | 'messages'
  project: string | null
  tab: 'overview' | 'session' | 'projects' | 'models' | 'patterns' | 'settings'
  /** Show the help text on token terms and the cache clock. */
  help: boolean
}

/** The live context window, from session.measure: the engine's own figures. */
export type Ctx = { tokens: number; window: number; percent: number | null }

/** Facts about this session read once at its start. */
export type Live = { sid: string; startedAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    lucelis: {
      windows: Window[]
      cachewatch: CacheWatch | null
      ctx: Ctx | null
      live: Live | null
      turn: TurnFacts | null
      expanded: boolean
      /** Bumped after the history aggregate changes, so drawings that read it redraw. */
      rev: number
      /** A short line about the last refresh (or an error), shown in the pane. */
      note: string
      settings: Shaped<Settings>
      view: Shaped<PaneView>
    }
  }
}
