#!/bin/sh
# VPuppet MCP installer (macOS / Linux): registers the running VPuppet app's
# local MCP server with the AI clients found on this computer.
#
#   curl -fsSL <site>/mcp/install.sh | sh
#   curl -fsSL <site>/mcp/install.sh | sh -s -- --uninstall
#
# First turn on VPUPPET > VMC (N) > ALLOW AI AGENTS in the app: that creates
# the access token this script reads. Clients:
#   - Claude Code:    `claude mcp add --transport http --scope user vpuppet ...`
#   - Cursor:         ~/.cursor/mcp.json (url + Authorization header)
#   - Claude Desktop: claude_desktop_config.json, through the mcp-remote bridge
#                     (its config file only takes stdio servers; needs npx)
# JSON configs are merged, never replaced, and backed up before a change.
# Safe to run again (it updates the entries). Never prints the token.
#
# Environment: VPUPPET_CONFIG_DIR (VPuppet's config folder), VPUPPET_MCP_PORT,
# VPUPPET_MCP_CLIENTS="claude-code cursor claude-desktop" (subset to touch).
set -eu
# pipefail is not POSIX; use it where the shell has it.
(set -o pipefail) 2>/dev/null && set -o pipefail

NAME=vpuppet
APP_ID=com.spartangamestudios.vpuppet
MCP_REMOTE=mcp-remote@0.15.2
UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,21p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'vpuppet-mcp: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
want() { case " ${VPUPPET_MCP_CLIENTS:-claude-code cursor claude-desktop} " in *" $1 "*) return 0 ;; esac; return 1; }

case "$(uname -s)" in
  Darwin) OS=mac; CFG_DEFAULT="$HOME/Library/Application Support/$APP_ID"; DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  Linux) OS=linux; CFG_DEFAULT="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"; DESKTOP_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json" ;;
  *) warn "unsupported OS $(uname -s); on Windows use install.ps1"; exit 1 ;;
esac
CFG="${VPUPPET_CONFIG_DIR:-$CFG_DEFAULT}"

# ---------------------------------------------------------------- token + port
TOKEN=""
PORT="${VPUPPET_MCP_PORT:-}"
if [ "$UNINSTALL" = 0 ]; then
  if [ ! -r "$CFG/mcp-token" ]; then
    warn "no access token in $CFG"
    warn "Open VPuppet, press N (VMC OUT) and tick ALLOW AI AGENTS (LOCAL MCP SERVER), then run this again."
    exit 1
  fi
  TOKEN=$(tr -d ' \r\n\t' < "$CFG/mcp-token")
  case "$TOKEN" in
    ''|*[!0-9a-fA-F]*) warn "the token file $CFG/mcp-token is damaged: press NEW TOKEN in VPuppet, then run this again"; exit 1 ;;
  esac
  if [ -z "$PORT" ] && [ -r "$CFG/mcp.json" ]; then
    PORT=$(sed -n 's/.*"port"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$CFG/mcp.json" | head -n 1)
  fi
fi
PORT="${PORT:-39540}"
URL="http://127.0.0.1:$PORT/mcp"
export VPUPPET_TOKEN="$TOKEN" VPUPPET_URL="$URL" VPUPPET_REMOTE="$MCP_REMOTE" VPUPPET_UNINSTALL="$UNINSTALL"

DONE=0
SKIPPED=""

# ---------------------------------------------------------------- JSON merge
# merge_json <file> <cursor|desktop>: add/replace/remove mcpServers.vpuppet,
# keep everything else. Exit 0 changed, 10 unchanged. Uses node or python3.
# The token comes in through the environment, never the command line.
merge_json() {
  if have node; then
    node - "$1" "$2" <<'JS'
const fs = require('fs');
const [file, kind] = process.argv.slice(2);
const env = process.env;
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let cfg = {};
if (text.trim()) {
  try { cfg = JSON.parse(text); } catch (e) { console.error(`vpuppet-mcp: ${file} is not valid JSON; leaving it alone`); process.exit(3); }
}
if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) { console.error(`vpuppet-mcp: ${file}: unexpected content`); process.exit(3); }
const servers = (cfg.mcpServers && typeof cfg.mcpServers === 'object') ? cfg.mcpServers : {};
if (env.VPUPPET_UNINSTALL === '1') {
  if (!(('vpuppet') in servers)) process.exit(10);
  delete servers.vpuppet;
} else {
  servers.vpuppet = kind === 'cursor'
    ? { url: env.VPUPPET_URL, headers: { Authorization: `Bearer ${env.VPUPPET_TOKEN}` } }
    : { command: 'npx', args: ['-y', env.VPUPPET_REMOTE, env.VPUPPET_URL, '--header', 'Authorization:${VPUPPET_AUTH}'], env: { VPUPPET_AUTH: `Bearer ${env.VPUPPET_TOKEN}` } };
}
cfg.mcpServers = servers;
const out = JSON.stringify(cfg, null, 2) + '\n';
if (out === text) process.exit(10);
if (text) fs.copyFileSync(file, `${file}.vpuppet-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(require('path').dirname(file), { recursive: true });
const tmp = `${file}.vpuppet-tmp`;
fs.writeFileSync(tmp, out, { mode: 0o600 });
fs.renameSync(tmp, file);
JS
  elif have python3; then
    python3 - "$1" "$2" <<'PY'
import json, os, sys, shutil, datetime
file, kind = sys.argv[1], sys.argv[2]
env = os.environ
text = ''
try:
    with open(file, encoding='utf-8') as f: text = f.read()
except FileNotFoundError:
    pass
cfg = {}
if text.strip():
    try: cfg = json.loads(text)
    except ValueError:
        print(f'vpuppet-mcp: {file} is not valid JSON; leaving it alone', file=sys.stderr); sys.exit(3)
if not isinstance(cfg, dict):
    print(f'vpuppet-mcp: {file}: unexpected content', file=sys.stderr); sys.exit(3)
servers = cfg.get('mcpServers') if isinstance(cfg.get('mcpServers'), dict) else {}
if env.get('VPUPPET_UNINSTALL') == '1':
    if 'vpuppet' not in servers: sys.exit(10)
    del servers['vpuppet']
elif kind == 'cursor':
    servers['vpuppet'] = {'url': env['VPUPPET_URL'], 'headers': {'Authorization': 'Bearer ' + env['VPUPPET_TOKEN']}}
else:
    servers['vpuppet'] = {'command': 'npx', 'args': ['-y', env['VPUPPET_REMOTE'], env['VPUPPET_URL'], '--header', 'Authorization:${VPUPPET_AUTH}'], 'env': {'VPUPPET_AUTH': 'Bearer ' + env['VPUPPET_TOKEN']}}
cfg['mcpServers'] = servers
out = json.dumps(cfg, indent=2, ensure_ascii=False) + '\n'
if out == text: sys.exit(10)
if text:
    shutil.copyfile(file, file + '.vpuppet-backup-' + datetime.datetime.now().strftime('%Y-%m-%dT%H-%M-%S'))
os.makedirs(os.path.dirname(file), exist_ok=True)
tmp = file + '.vpuppet-tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f: f.write(out)
os.replace(tmp, file)
PY
  else
    return 4
  fi
}

# configure_json <label> <file> <cursor|desktop>
configure_json() {
  rc=0
  merge_json "$2" "$3" || rc=$?
  case "$rc" in
    0) if [ "$UNINSTALL" = 1 ]; then say "  $1: removed from $2"; else say "  $1: added to $2"; fi; DONE=$((DONE + 1)) ;;
    10) say "  $1: already up to date ($2)"; DONE=$((DONE + 1)) ;;
    4) SKIPPED="$SKIPPED\n  $1: needs node or python3 to edit $2 safely" ;;
    *) SKIPPED="$SKIPPED\n  $1: could not update $2" ;;
  esac
}

if [ "$UNINSTALL" = 1 ]; then say "Removing VPuppet from your MCP clients:"; else say "Registering VPuppet ($URL) with your MCP clients:"; fi

# ---------------------------------------------------------------- Claude Code
if want claude-code; then
  if have claude; then
    claude mcp remove --scope user "$NAME" >/dev/null 2>&1 || true
    if [ "$UNINSTALL" = 1 ]; then
      say "  Claude Code: removed (user scope)"; DONE=$((DONE + 1))
    elif claude mcp add --transport http --scope user "$NAME" "$URL" --header "Authorization: Bearer $TOKEN" >/dev/null 2>&1; then
      say "  Claude Code: added '$NAME' (user scope; check with: claude mcp get $NAME)"; DONE=$((DONE + 1))
    else
      SKIPPED="$SKIPPED\n  Claude Code: 'claude mcp add' failed (run it with a newer Claude Code)"
    fi
  else
    SKIPPED="$SKIPPED\n  Claude Code: not found (no 'claude' on PATH)"
  fi
fi

# ---------------------------------------------------------------- Cursor
if want cursor; then
  if [ -d "$HOME/.cursor" ] || have cursor; then
    configure_json Cursor "$HOME/.cursor/mcp.json" cursor
  else
    SKIPPED="$SKIPPED\n  Cursor: not found (~/.cursor)"
  fi
fi

# ---------------------------------------------------------------- Claude Desktop
if want claude-desktop; then
  if [ -d "$(dirname "$DESKTOP_CFG")" ]; then
    if [ "$UNINSTALL" = 0 ] && ! have npx; then
      SKIPPED="$SKIPPED\n  Claude Desktop: needs Node.js (npx) for the mcp-remote bridge; install Node, then run this again"
    else
      configure_json "Claude Desktop" "$DESKTOP_CFG" desktop
      [ "$UNINSTALL" = 1 ] || say "    (restart Claude Desktop to connect; it reaches VPuppet through npx $MCP_REMOTE)"
    fi
  else
    SKIPPED="$SKIPPED\n  Claude Desktop: not found"
  fi
fi

[ -z "$SKIPPED" ] || printf '%b\n' "Skipped:$SKIPPED"
if [ "$DONE" -eq 0 ]; then
  warn "no MCP client was configured."
  [ "$UNINSTALL" = 1 ] || warn "Other clients: add an HTTP MCP server at $URL with the header 'Authorization: Bearer <contents of $CFG/mcp-token>'."
  exit 1
fi
[ "$UNINSTALL" = 1 ] || say "Done. VPuppet must be running with ALLOW AI AGENTS on for the tools to answer."
