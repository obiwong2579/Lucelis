# Changelog

## 1.1.0 — 2026-11-11

- **Low-quota warning.** When what is left of the 5-hour or 7-day quota drops to your level (30% by default; 10, 20, 30 or 40% offered), Lucelis tells you once per quota window with a short pop-up, and optionally a Windows notification and a "quota is back" notification at the reset time. Only one open session warns. Settings: on/off, level per quota, pop-up, notification.
- **Logo states.** While Claude works, the logo's two bars draw in one after the other (replacing the breathing glint). While a quota is at or under its warning level, the glint is red. Still otherwise.
- **One low level.** The 5H and 7D figures on the bar now turn red at the same level as the logo and the warning (was: under 30%), so they never disagree. Green from 70%, yellow between.
- **This week** on the Overview tab: this week so far against the same days of last week, with busiest day, top project and top model.
- **Export CSV** in Settings: one row per day, project and model with token counts, for the period shown.
- **Check for updates** in Settings: the one network request Lucelis makes, only when pressed. A newer version gets its two update commands copied for you to paste; nothing is installed automatically.
- **What's new.** After an update, one quiet line at the top of Overview names the main changes, from the notes shipped with the plugin. Full notes copies the link; Dismiss hides it. Never a pop-up.
- **Last seen.** After a restart, the last 5H and 7D figures show dimmed and marked "last seen" until the first reply, while their window lasts. Never coloured or warned about.
- **Tight bar.** On a narrow window the bar shortens its items (no % signs, then one-letter labels) before it leaves out 5H, 7D, cache or context.
- **Format guard.** If many replies in your history are in a shape Lucelis does not recognise, the pane says totals may be low, instead of showing them as if complete.
- README and plugin description updated for the update check.

## 1.0.2 — 2026-11-10

- Maintenance release: documentation and packaging details tidied. No change to the plugin's behaviour.

## 1.0.1 — 2026-11-10

- README: pictures of the bar, More and the dashboard, drawn from the plugin's own output with sample data. No change to the plugin's behaviour.

## 1.0.0 — 2026-11-10

Initial public/shareable release.

### Features
- 5-hour and 7-day Claude usage windows, with reset countdowns
- Health colours on the percentages: green with 70% or more left, yellow from 30%, red below
- Prompt-cache warm/cold state and countdown
- Context usage
- Configurable one- or two-line compact bar, with a toggle per item
- Lucelis mark at the start of the bar, with a slow glint while Claude is working (can be switched off)
- Optional filled bar background
- Current-session summary
- Next-message API-price-equivalent estimates
- Cross-model cost comparison
- Local Activity Dashboard
- Project, model and usage history analytics
- Heatmaps and usage patterns
- Persistent settings
- Project aliases
- Commands: `/lucelis`, `/lucelis-settings`, `/lucelis-refresh`, `/lucelis-rebuild`

### Reliability
- The session-start and pane-close hooks pass the event on exactly once. A failure in Lucelis' own work never holds up a session or a pane; a failure in another plugin or in Claude Code is passed on as it is and never retried.
- A command that cannot run answers with a plain message instead of an engine error.

### Privacy
- Local transcript processing only
- No telemetry
- No network analytics
- No model calls
- No external database or server

### Platform
- Windows 10/11
- Claude Code 2.1.317+

### License
- PolyForm Noncommercial 1.0.0: free for noncommercial use; commercial use is not permitted

### Tests
- 61 tests, all on made-up data. Whole-history checks (totals against a separate count, duplicates, corrupt rows, project detection) run on a synthetic history.
- Two further tests need a private fixture built from a machine's own transcripts. Without it they are reported as skipped, not as passed.

### Notes
- Next-message costs are API-price-equivalent estimates, not charges to your Claude subscription.
