# session-toc: extract a compact table of contents from a Claude Code session transcript (JSONL).
# Works under PowerShell 7 (pwsh) and Windows PowerShell 5.1. Writes one JSON object to stdout.
# Keep this file ASCII-only (5.1 reads BOM-less scripts as ANSI).
param(
  [Parameter(Mandatory = $true)][string]$SessionId,
  [string]$TranscriptPath,
  [string]$After,
  [int]$MaxChars = 300
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ELLIPSIS = [string][char]0x2026

function JStr($s) {
  if ($null -eq $s) { return 'null' }
  $s = [string]$s
  $sb = New-Object System.Text.StringBuilder ($s.Length + 2)
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($ch -eq '"') { [void]$sb.Append('\"') }
    elseif ($ch -eq '\') { [void]$sb.Append('\\') }
    elseif ($c -lt 0x20 -or $c -eq 0x2028 -or $c -eq 0x2029) { [void]$sb.Append('\u' + $c.ToString('x4')) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Fail([string]$msg) {
  [Console]::Out.Write('{"error":' + (JStr $msg) + '}')
  [Console]::Out.Flush()
  exit 2
}

# PS7's ConvertFrom-Json turns ISO strings into DateTime; normalize back to ISO UTC text.
function AsText($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [DateTime]) { return $v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }
  return [string]$v
}

function Clip([string]$s) {
  if ($null -eq $s) { return '' }
  $s = ($s -replace '\s+', ' ').Trim()
  if ($s.Length -gt $MaxChars) {
    $n = [Math]::Max(0, $MaxChars - 1)
    if ($n -gt 0 -and [char]::IsHighSurrogate($s[$n - 1])) { $n-- }
    $s = $s.Substring(0, $n) + $ELLIPSIS
  }
  return $s
}

function ParseTime([string]$s) {
  $d = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($s, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$d)) { return $d }
  return $null
}

# ---- locate transcript ----
if (-not $TranscriptPath) {
  if ($SessionId -notmatch '^[A-Za-z0-9_-]+$') { Fail "invalid SessionId: $SessionId" }
  $base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  $projects = Join-Path $base 'projects'
  $hit = $null
  if (Test-Path -LiteralPath $projects) {
    $hit = Get-ChildItem -Path (Join-Path (Join-Path $projects '*') "$SessionId.jsonl") -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }
  if (-not $hit) { Fail "transcript not found for session $SessionId under $projects" }
  $TranscriptPath = $hit.FullName
}
elseif (-not (Test-Path -LiteralPath $TranscriptPath -PathType Leaf)) { Fail "transcript not found: $TranscriptPath" }
$TranscriptPath = (Resolve-Path -LiteralPath $TranscriptPath).ProviderPath

$afterT = $null
if ($After) {
  $afterT = ParseTime $After
  if ($null -eq $afterT) { Fail "invalid -After timestamp: $After" }
}

$skipPrefixes = @('<local-command-caveat', '<local-command-stdout', '<local-command-stderr', '<system-reminder',
  '<task-notification', '[SYSTEM NOTIFICATION', 'Another Claude session sent a message', '[Request interrupted')
function IsSkipped([string]$t) {
  foreach ($p in $skipPrefixes) { if ($t.StartsWith($p, [StringComparison]::Ordinal)) { return $true } }
  return $false
}

$reTs = [regex]'"timestamp"\s*:\s*"(\d{4}-\d\d-\d\dT[^"]+)"'
$reSysRem = [regex]'(?s)<system-reminder>.*?</system-reminder>'
$reCmdName = [regex]'(?s)<command-name>\s*(.*?)\s*</command-name>'
$reCmdArgs = [regex]'(?s)<command-args>(.*?)</command-args>'

$firstAt = $null; $lastAt = $null
$entries = New-Object System.Collections.Generic.List[object]
$cur = $null   # entry currently collecting reply / anchor
$queued = New-Object 'System.Collections.Generic.HashSet[string]'

try { $lines = [IO.File]::ReadLines($TranscriptPath) } catch { Fail "cannot read transcript: $($_.Exception.Message)" }

foreach ($line in $lines) {
  if ($line.Length -lt 2) { continue }
  $m = $reTs.Match($line)
  if ($m.Success) { if ($null -eq $firstAt) { $firstAt = $m.Groups[1].Value }; $lastAt = $m.Groups[1].Value }

  $isUser = $line.Contains('"type":"user"')
  $isAsst = $line.Contains('"type":"assistant"')
  $isQueued = $line.Contains('"queued_command"')
  if (-not ($isUser -or $isAsst -or $isQueued)) { continue }
  try { $o = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $o) { continue }
  $type = [string]$o.type
  if ($o.isSidechain -eq $true) { continue }

  # A message typed while Claude is mid-turn is stored as a queued_command attachment, not a user row.
  if ($type -eq 'attachment') {
    $a = $o.attachment
    if ($null -eq $a -or $a.type -ne 'queued_command' -or $a.origin.kind -ne 'human') { continue }
    $qts = AsText $o.timestamp
    if ($null -ne $afterT) {
      $qt = ParseTime $qts
      if ($null -eq $qt -or $qt -le $afterT) { continue }
    }
    $qtext = $reSysRem.Replace((AsText $a.prompt), ' ').Trim()
    if ($qtext.Length -eq 0) { continue }
    [void]$queued.Add(($qtext -replace '\s+', ' '))
    $qsrc = [string]$o.entrypoint
    if ($qsrc -eq 'claude-desktop') { $qsrc = 'app' }
    $cur = [ordered]@{ at = $qts; role = 'user'; uuid = (AsText $o.uuid); text = (Clip $qtext); source = $qsrc; reply = $null; anchor = $null }
    $entries.Add($cur)
    continue
  }
  if ($type -ne 'user' -and $type -ne 'assistant') { continue }

  $ts = AsText $o.timestamp
  if ($ts) { if ($null -eq $firstAt) { $firstAt = $ts } }
  if ($null -ne $afterT) {
    $t = ParseTime $ts
    if ($null -eq $t -or $t -le $afterT) { continue }
  }
  $content = $null
  if ($o.message) { $content = $o.message.content }

  if ($type -eq 'user') {
    if ($o.isMeta -eq $true -or $o.isCompactSummary -eq $true -or $o.isVisibleInTranscriptOnly -eq $true) { continue }
    $texts = New-Object System.Collections.Generic.List[string]
    $images = 0
    if ($content -is [string]) { $texts.Add($content) }
    elseif ($null -ne $content) {
      foreach ($b in @($content)) {
        if ($null -eq $b) { continue }
        if ($b.type -eq 'text') { $texts.Add((AsText $b.text)) }
        elseif ($b.type -eq 'image') { $images++ }
      }
    }
    $role = 'user'; $txt = $null
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($t in $texts) {
      if ($null -eq $t) { continue }
      $tt = $t.TrimStart()
      $cm = $reCmdName.Match($tt)
      if ($tt.StartsWith('<command-name>') -or ($tt.StartsWith('<command-message>') -and $cm.Success)) {
        $role = 'command'
        $name = $cm.Groups[1].Value.Trim()
        if (-not $name.StartsWith('/')) { $name = '/' + $name }
        $am = $reCmdArgs.Match($tt)
        $args2 = if ($am.Success) { $am.Groups[1].Value.Trim() } else { '' }
        $parts.Clear(); $parts.Add((($name + ' ' + $args2).Trim()))
        break
      }
      if (IsSkipped $tt) { continue }
      $tt = $reSysRem.Replace($tt, ' ').Trim()
      if ($tt.Length -gt 0) { $parts.Add($tt) }
    }
    if ($role -eq 'user') {
      if ($parts.Count -eq 0 -and $images -eq 0) { continue }
      $prefix = ''
      for ($k = 0; $k -lt $images; $k++) { $prefix += '[image] ' }
      $txt = $prefix + ($parts -join ' ')
      if ($queued.Remove(($txt -replace '\s+', ' ').Trim())) { continue }
    }
    else { $txt = $parts[0] }

    $src = [string]$o.entrypoint
    if ($src -eq 'claude-desktop') { $src = 'app' } elseif ($src -eq 'cli') { $src = 'cli' }
    $cur = [ordered]@{ at = $ts; role = $role; uuid = (AsText $o.uuid); text = (Clip $txt); source = $src; reply = $null; anchor = $null }
    $entries.Add($cur)
    continue
  }

  # assistant
  if ($null -eq $cur -or $null -eq $content -or $content -is [string]) {
    if ($null -ne $cur -and $content -is [string] -and $null -eq $cur.reply -and $content.Trim().Length -gt 0) {
      $cur.reply = [ordered]@{ at = $ts; uuid = (AsText $o.uuid); text = (Clip $content) }
    }
    continue
  }
  foreach ($b in @($content)) {
    if ($null -eq $b) { continue }
    if ($b.type -eq 'text' -and $null -eq $cur.reply) {
      $bt = AsText $b.text
      if ($bt -and $bt.Trim().Length -gt 0) { $cur.reply = [ordered]@{ at = $ts; uuid = (AsText $o.uuid); text = (Clip $bt) } }
    }
    elseif ($b.type -eq 'tool_use' -and $null -eq $cur.anchor) { $cur.anchor = AsText $b.id }
  }
}

# ---- emit ----
$sb = New-Object System.Text.StringBuilder 65536
[void]$sb.Append('{"path":').Append((JStr $TranscriptPath))
[void]$sb.Append(',"sessionId":').Append((JStr $SessionId))
[void]$sb.Append(',"firstAt":').Append((JStr $firstAt))
[void]$sb.Append(',"lastAt":').Append((JStr $lastAt))
[void]$sb.Append(',"entries":[')
for ($i = 0; $i -lt $entries.Count; $i++) {
  $e = $entries[$i]
  if ($i -gt 0) { [void]$sb.Append(',') }
  [void]$sb.Append('{"i":').Append($i)
  [void]$sb.Append(',"at":').Append((JStr $e.at))
  [void]$sb.Append(',"role":').Append((JStr $e.role))
  [void]$sb.Append(',"uuid":').Append((JStr $e.uuid))
  [void]$sb.Append(',"text":').Append((JStr $e.text))
  [void]$sb.Append(',"source":').Append((JStr $e.source))
  [void]$sb.Append(',"reply":')
  if ($null -eq $e.reply) { [void]$sb.Append('null') }
  else {
    [void]$sb.Append('{"at":').Append((JStr $e.reply.at)).Append(',"uuid":').Append((JStr $e.reply.uuid)).Append(',"text":').Append((JStr $e.reply.text)).Append('}')
  }
  [void]$sb.Append(',"anchor":').Append((JStr $e.anchor)).Append('}')
}
[void]$sb.Append(']}')
[Console]::Out.Write($sb.ToString())
[Console]::Out.Flush()
exit 0
