# Installing Lucelis

Local-only • No telemetry • No model calls • No external server

## Requirements

- Windows 10 or 11
- Claude Code 2.1.317 or newer with mod/plugin support

## Install from GitHub

Type this in a Claude Code session, then start a new session:

```
/plugin install lucelis --marketplace obiwong2579/Lucelis
```

## Install from a downloaded folder

1. Extract Lucelis somewhere permanent. Claude Code reads the plugin from this folder each time, so do not delete or move it afterwards.
2. Run:

   ```bash
   claude plugin marketplace add "C:\path\to\Lucelis"
   ```

3. Run:

   ```bash
   claude plugin install lucelis
   ```

4. Start a new Claude Code / Desktop Code session.

The bar appears after the first reply. The first start reads your local history once (a few seconds); later starts read only what is new.

In the desktop app you can do the same from **+** next to the prompt, **Plugins**, **Add marketplace**, then **Add plugin**.

## Check it

```bash
claude plugin list
```

`lucelis@lucelis` should be listed as enabled. In a session, `/lucelis` opens the dashboard and `/lucelis-settings` opens Settings.

## If another usage bar is installed

Only one plugin can draw the row above the prompt, and the one that comes first in your plugin list wins. If another bar shows instead of Lucelis, disable that plugin:

```bash
claude plugin disable <plugin>@<marketplace>
```

## Update

From GitHub: `claude plugin update lucelis@lucelis`, then start a new session.

From a folder: replace the folder's files with the new version and start a new session.

## Uninstall

```bash
claude plugin uninstall lucelis@lucelis
```

```bash
claude plugin marketplace remove lucelis
```

Then delete `~/.claude/lucelis/` if you also want the history cache gone. Your transcripts are never modified.
