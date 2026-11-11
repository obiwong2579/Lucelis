# Lucelis extractor: read-only, on demand, local only.
#
# Reads Claude Code session transcripts (*.jsonl) from given byte offsets and
# prints one compact TSV row per countable record. It opens files read-only
# with FileShare.ReadWrite, never writes, and makes no network calls. Called by
# the Lucelis plugin only when it refreshes (session start, after a turn at
# most every few minutes, /lucelis-refresh, /lucelis-rebuild).
#
# stdin (JSON): { root, max, files: [{ p, o, owner }], own: [sessionId...] }
#   p      path relative to root;  o  byte offset to start at
#   owner  the session that owns the file (its name, or a subagents dir's parent)
#   own    every session id that has its own transcript file
# stdout rows (tab separated):
#   N  localToday  utcOffsetMinutes   (first row: the machine's local time zone)
#   F  path  newOffset  done(0|1)
#   A  sid  msgId  epochMs  localDay  localHour  model  in  out  cacheWrite  cacheRead  cwd  sidechain(0|1)
#   P  sid  uuid  epochMs  localDay  localHour  cwd
#   C  sid  uuid  epochMs
#   T  sid  title
#   X  path  reason        (a line that did not parse, reason 'parse'; or a reply record
#                           whose shape is not the one this extractor knows, reason 'shape':
#                           counted, never fatal, so a format change is noticed, not silent)
# A record is emitted only from the file that owns its sessionId (forks and
# resumes copy earlier records into new files under the ORIGINAL sessionId),
# unless that session has no file of its own (an orphan copy).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue
$json.RecursionLimit = 512

$req = $json.DeserializeObject([Console]::In.ReadToEnd())
$root = [string]$req['root']
$max = [int]$req['max']
$own = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($s in $req['own']) { [void]$own.Add([string]$s) }

$out = New-Object System.Text.StringBuilder
$utf8 = New-Object System.Text.UTF8Encoding($false)
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)

function Clean([string]$s) { if ($null -eq $s) { return '' }; return ($s -replace '[\t\r\n]', ' ') }
function Num($v) { if ($null -eq $v) { return [long]0 }; return [long]$v }
function TimeCols([string]$ts) {
  $d = [DateTime]::Parse($ts, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
  $ms = [long]($d - $epoch).TotalMilliseconds
  $l = $d.ToLocalTime()
  return "$ms`t$($l.ToString('yyyy-MM-dd'))`t$($l.Hour)"
}

$nowL = [DateTime]::Now
[void]$out.Append("N`t$($nowL.ToString('yyyy-MM-dd'))`t$([int][TimeZoneInfo]::Local.GetUtcOffset($nowL).TotalMinutes)`n")
$full = $false
# One read buffer and one carry stream for the whole run (allocating them per file left a
# 4 MB block of garbage per transcript and set the peak memory).
$buf = New-Object byte[] (1MB)
$carry = New-Object IO.MemoryStream
$sinceGc = 0
foreach ($f in $req['files']) {
  $rel = [string]$f['p']; $offset = [long]$f['o']; $owner = [string]$f['owner']
  $path = [IO.Path]::Combine($root, $rel)
  $fs = $null
  try {
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
  } catch { [void]$out.Append("X`t$rel`topen`n"); [void]$out.Append("F`t$rel`t$offset`t1`n"); continue }
  try {
    if ($offset -gt $fs.Length) { $offset = 0 }   # file was replaced or truncated: start over
    [void]$fs.Seek($offset, 'Begin')
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $title = $null
    $carry.SetLength(0)
    $pos = $offset            # byte offset just past the last complete line handled
    $stopped = $false
    while (-not $stopped) {
      $n = $fs.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      # Decoded lines are short-lived garbage; the runtime lets it pile up to a few hundred MB
      # before it collects. Collect every 16 MB read so the peak stays small.
      $sinceGc += $n
      if ($sinceGc -ge 16MB) { [GC]::Collect(); $sinceGc = 0 }
      $start = 0
      while ($true) {
        $nl = [Array]::IndexOf($buf, [byte]10, $start, $n - $start)
        if ($nl -lt 0) { $carry.Write($buf, $start, $n - $start); break }
        if ($carry.Length -gt 0) {
          $carry.Write($buf, $start, $nl - $start)
          $bytes = $carry.ToArray(); $carry.SetLength(0)
          $line = $utf8.GetString($bytes); $len = $bytes.Length + 1
        } else {
          $line = $utf8.GetString($buf, $start, $nl - $start); $len = $nl - $start + 1
        }
        $start = $nl + 1
        $pos += $len

        # A cheap prefilter on quoted words only (no assumption about JSON spacing or
        # key order); the full parse below decides what the line really is.
        $isA = $line.Contains('"assistant"') -and $line.Contains('"usage"')
        $isP = $line.Contains('"human"')
        $isC = $line.Contains('"compact_boundary"')
        $isT = $line.Contains('"custom-title"')
        if (-not ($isA -or $isP -or $isC -or $isT)) { continue }
        try { $o = $json.DeserializeObject($line) } catch { [void]$out.Append("X`t$rel`tparse`n"); continue }
        if ($o -isnot [Collections.Generic.Dictionary[string, object]]) { continue }
        $t = [string]$o['type']; $sid = [string]$o['sessionId']
        $mine = ($sid -eq $owner) -or (-not $own.Contains($sid))
        if ($t -eq 'custom-title') { if ($sid -eq $owner -and $o['customTitle']) { $title = Clean ([string]$o['customTitle']) }; continue }
        if (-not $mine) { continue }
        if ($t -eq 'assistant') {
          $m = $o['message']
          if ($m -isnot [Collections.Generic.Dictionary[string, object]]) { [void]$out.Append("X`t$rel`tshape`n"); continue }
          # One reply is several lines (one per content block): judge and count it once, by its id.
          $id = [string]$m['id']; if (-not $id) { $id = [string]$o['requestId'] }
          if ($id -and $seen.Contains($id)) { continue }
          $u = $m['usage']
          if ($u -isnot [Collections.Generic.Dictionary[string, object]]) { [void]$out.Append("X`t$rel`tshape`n"); continue }
          $model = [string]$m['model']; if ($model -eq '<synthetic>') { continue }
          if (-not ($u.ContainsKey('input_tokens') -or $u.ContainsKey('output_tokens'))) { if ($id) { [void]$seen.Add($id) }; [void]$out.Append("X`t$rel`tshape`n"); continue }
          if (-not $id -or -not $sid) { [void]$out.Append("X`t$rel`tshape`n"); continue }
          try { $tc = TimeCols ([string]$o['timestamp']) } catch { [void]$seen.Add($id); [void]$out.Append("X`t$rel`tshape`n"); continue }
          $in = Num $u['input_tokens']; $op = Num $u['output_tokens']; $cw = Num $u['cache_creation_input_tokens']; $cr = Num $u['cache_read_input_tokens']
          if (($in + $op + $cw + $cr) -eq 0) { continue }   # streaming placeholder copy
          if (-not $seen.Add($id)) { continue }              # one row per content block: count the message once
          $side = if ($o['isSidechain']) { 1 } else { 0 }
          [void]$out.Append("A`t$sid`t$id`t$tc`t$(Clean $model)`t$in`t$op`t$cw`t$cr`t$(Clean ([string]$o['cwd']))`t$side`n")
        } elseif ($t -eq 'user') {
          $org = $o['origin']
          if ($org -is [Collections.Generic.Dictionary[string, object]] -and [string]$org['kind'] -eq 'human' -and -not $o.ContainsKey('toolUseResult') -and -not $o['isSidechain']) {
            [void]$out.Append("P`t$sid`t$([string]$o['uuid'])`t$(TimeCols ([string]$o['timestamp']))`t$(Clean ([string]$o['cwd']))`n")
          }
        } elseif ($t -eq 'system' -and [string]$o['subtype'] -eq 'compact_boundary') {
          [void]$out.Append("C`t$sid`t$([string]$o['uuid'])`t$((TimeCols ([string]$o['timestamp'])).Split(""`t"")[0])`n")
        }
        if ($out.Length -gt $max) { $stopped = $true; $full = $true; break }
      }
    }
    if ($title) { [void]$out.Append("T`t$owner`t$title`n") }
    $done = if ($stopped) { 0 } else { 1 }
    [void]$out.Append("F`t$rel`t$pos`t$done`n")
  } finally { $fs.Dispose() }
  $sinceGc += 512KB
  if ($full) { break }
}
[Console]::Out.Write($out.ToString())
