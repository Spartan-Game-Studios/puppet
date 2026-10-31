# VPuppet MCP installer (Windows): registers the running VPuppet app's local
# MCP server with the AI clients found on this computer.
#
#   irm <site>/mcp/install.ps1 | iex
#   $env:VPUPPET_MCP_UNINSTALL = 1; irm <site>/mcp/install.ps1 | iex     # remove
#
# First turn on VPUPPET > VMC (N) > ALLOW AI AGENTS in the app: that creates
# the access token this script reads. Clients:
#   - Claude Code:    claude mcp add --transport http --scope user vpuppet ...
#   - Cursor:         %USERPROFILE%\.cursor\mcp.json (url + Authorization header)
#   - Claude Desktop: %APPDATA%\Claude\claude_desktop_config.json, through the
#                     mcp-remote bridge (stdio only there; needs npx / Node.js)
# JSON configs are merged, never replaced, and backed up before a change.
# Safe to run again. Never prints the token. No admin rights needed.
#
# Environment: VPUPPET_CONFIG_DIR, VPUPPET_MCP_PORT,
# VPUPPET_MCP_CLIENTS="claude-code cursor claude-desktop", VPUPPET_MCP_UNINSTALL=1.

& {
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'

  $Name = 'vpuppet'
  $AppId = 'com.spartangamestudios.vpuppet'
  $McpRemote = 'mcp-remote@0.15.2'
  $Uninstall = $env:VPUPPET_MCP_UNINSTALL -eq '1'
  $Clients = if ($env:VPUPPET_MCP_CLIENTS) { $env:VPUPPET_MCP_CLIENTS -split '[ ,]+' } else { @('claude-code', 'cursor', 'claude-desktop') }
  $Utf8 = New-Object System.Text.UTF8Encoding $false

  function Say([string]$m) { Write-Host $m }
  function Fail([string]$m) { throw "vpuppet-mcp: $m" }
  function Have([string]$c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
  # A native command, quiet; returns its exit code. (With 'Stop', Windows
  # PowerShell 5.1 turns a redirected stderr line into a terminating error.)
  function Run-Quiet([scriptblock]$b) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $b *> $null } catch { } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
  }

  # Add/replace/remove mcpServers.vpuppet, keep everything else.
  # Returns 'changed', 'unchanged' or 'invalid'.
  function Merge-Config([string]$File, [hashtable]$Entry) {
    $text = if (Test-Path -LiteralPath $File) { [IO.File]::ReadAllText($File) } else { '' }
    $cfg = $null
    if ($text.Trim()) {
      try { $cfg = $text | ConvertFrom-Json } catch { return 'invalid' }
      if ($cfg -isnot [pscustomobject]) { return 'invalid' }
    } else { $cfg = [pscustomobject]@{} }
    if ($null -eq $cfg.PSObject.Properties['mcpServers'] -or $cfg.mcpServers -isnot [pscustomobject]) {
      $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $servers = $cfg.mcpServers
    if ($null -eq $Entry) {
      if ($null -eq $servers.PSObject.Properties[$Name]) { return 'unchanged' }
      $servers.PSObject.Properties.Remove($Name)
    } else {
      $servers | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]$Entry) -Force
    }
    $out = ($cfg | ConvertTo-Json -Depth 32) + "`n"
    if ($out -eq $text) { return 'unchanged' }
    if ($text) { Copy-Item -LiteralPath $File -Destination ("$File.vpuppet-backup-" + (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss')) }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $File) | Out-Null
    $tmp = "$File.vpuppet-tmp"
    [IO.File]::WriteAllText($tmp, $out, $Utf8)
    Move-Item -LiteralPath $tmp -Destination $File -Force
    return 'changed'
  }

  try {
    $cfgDir = if ($env:VPUPPET_CONFIG_DIR) { $env:VPUPPET_CONFIG_DIR } else { Join-Path $env:APPDATA $AppId }
    $token = ''
    $port = $env:VPUPPET_MCP_PORT
    if (-not $Uninstall) {
      $tokenFile = Join-Path $cfgDir 'mcp-token'
      if (-not (Test-Path -LiteralPath $tokenFile)) {
        Fail "no access token in $cfgDir`nOpen VPuppet, press N (VMC OUT) and tick ALLOW AI AGENTS (LOCAL MCP SERVER), then run this again."
      }
      $token = ([IO.File]::ReadAllText($tokenFile)).Trim()
      if ($token -notmatch '^[0-9a-fA-F]{32,}$') { Fail "the token file $tokenFile is damaged: press NEW TOKEN in VPuppet, then run this again" }
      $info = Join-Path $cfgDir 'mcp.json'
      if (-not $port -and (Test-Path -LiteralPath $info)) {
        try { $port = [string](([IO.File]::ReadAllText($info) | ConvertFrom-Json).port) } catch { $port = $null }
      }
    }
    if (-not $port) { $port = '39540' }
    $url = "http://127.0.0.1:$port/mcp"
    $done = 0
    $skipped = New-Object System.Collections.Generic.List[string]

    if ($Uninstall) { Say 'Removing VPuppet from your MCP clients:' } else { Say "Registering VPuppet ($url) with your MCP clients:" }

    # ------------------------------------------------------------ Claude Code
    if ($Clients -contains 'claude-code') {
      if (Have 'claude') {
        Run-Quiet { claude mcp remove --scope user $Name } | Out-Null
        if ($Uninstall) { Say '  Claude Code: removed (user scope)'; $done++ }
        else {
          $rc = Run-Quiet { claude mcp add --transport http --scope user $Name $url --header "Authorization: Bearer $token" }
          if ($rc -eq 0) { Say "  Claude Code: added '$Name' (user scope; check with: claude mcp get $Name)"; $done++ }
          else { $skipped.Add("  Claude Code: 'claude mcp add' failed (update Claude Code and run this again)") }
        }
      } else { $skipped.Add("  Claude Code: not found (no 'claude' on PATH)") }
    }

    # ------------------------------------------------------------ Cursor and Claude Desktop
    $targets = @(
      @{ id = 'cursor'; label = 'Cursor'; file = (Join-Path $HOME '.cursor\mcp.json'); dir = (Join-Path $HOME '.cursor');
         entry = @{ url = $url; headers = @{ Authorization = "Bearer $token" } } },
      @{ id = 'claude-desktop'; label = 'Claude Desktop'; file = (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'); dir = (Join-Path $env:APPDATA 'Claude');
         entry = @{ command = 'npx'; args = @('-y', $McpRemote, $url, '--header', 'Authorization:${VPUPPET_AUTH}'); env = @{ VPUPPET_AUTH = "Bearer $token" } } }
    )
    foreach ($t in $targets) {
      if (-not ($Clients -contains $t.id)) { continue }
      if (-not (Test-Path -LiteralPath $t.dir)) { $skipped.Add("  $($t.label): not found"); continue }
      if ($t.id -eq 'claude-desktop' -and -not $Uninstall -and -not (Have 'npx')) {
        $skipped.Add('  Claude Desktop: needs Node.js (npx) for the mcp-remote bridge; install Node, then run this again'); continue
      }
      $r = Merge-Config $t.file $(if ($Uninstall) { $null } else { $t.entry })
      switch ($r) {
        'changed' { if ($Uninstall) { Say "  $($t.label): removed from $($t.file)" } else { Say "  $($t.label): added to $($t.file)" }; $done++ }
        'unchanged' { Say "  $($t.label): already up to date ($($t.file))"; $done++ }
        default { $skipped.Add("  $($t.label): $($t.file) is not valid JSON; left it alone") }
      }
      if ($t.id -eq 'claude-desktop' -and $r -ne 'invalid' -and -not $Uninstall) { Say "    (restart Claude Desktop to connect; it reaches VPuppet through npx $McpRemote)" }
    }

    if ($skipped.Count) { Say 'Skipped:'; $skipped | ForEach-Object { Say $_ } }
    if ($done -eq 0) {
      $msg = 'no MCP client was configured.'
      if (-not $Uninstall) { $msg += " Other clients: add an HTTP MCP server at $url with the header 'Authorization: Bearer <contents of $cfgDir\mcp-token>'." }
      Fail $msg
    }
    if (-not $Uninstall) { Say 'Done. VPuppet must be running with ALLOW AI AGENTS on for the tools to answer.' }
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $global:LASTEXITCODE = 1
    # Run as a file: exit non-zero. Piped into iex: don't close the user's shell.
    if ($PSCommandPath) { exit 1 }
  }
}
