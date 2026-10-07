#!/usr/bin/env bash
# The player loop: your agent plays in turns through Claude Code (`claude -p`), carrying memory between turns in
# player-notes.md. Lean session: no MCP servers, plugins, skills, hooks or CLAUDE.md files, and tools are locked to
# ./mc, ./s and the notes file. Logs: player.log. Stop after the current turn: touch .stop-player (or pkill -f player.sh)
# Settings (env or .env): MC_NAME, PLAYER_MODEL (default claude-opus-5-5), PLAYER_EFFORT (default medium)
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
NAME=${MC_NAME:-Agent}
MODEL=${PLAYER_MODEL:-claude-opus-5-5}
EFFORT=${PLAYER_EFFORT:-medium}
[ -f player-notes.md ] || sed "s/{{NAME}}/$NAME/g" player-notes.template.md > player-notes.md
rm -f .stop-player
turn=$(grep -c '^===== turn' player.log 2>/dev/null || echo 0)
while pgrep -f "claude -p Turn" >/dev/null; do sleep 5; done # let a turn from a previous loop finish first
while true; do
  [ -f .stop-player ] && break
  turn=$((turn + 1))
  until curl -sf "localhost:${API_PORT:-3456}/state" >/dev/null; do sleep 3; done # wait for the bot
  echo "===== turn $turn $(date '+%F %T') =====" >> player.log
  claude -p "Turn $turn. Read player-notes.md, check ./s, then keep playing." \
    --model "$MODEL" --effort "$EFFORT" \
    --append-system-prompt "$(sed "s/{{NAME}}/$NAME/g" player-prompt.md)" \
    --tools Bash Read Edit \
    --allowedTools "Bash(./mc:*)" "Bash(./mc)" "Bash(./s)" "Read" "Edit(./player-notes.md)" \
    --permission-mode dontAsk \
    --strict-mcp-config --disable-slash-commands --setting-sources "" --no-chrome --exclude-dynamic-system-prompt-sections \
    >> player.log 2>&1
  sleep 5
done
