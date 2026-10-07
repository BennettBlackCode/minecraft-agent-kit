#!/usr/bin/env bash
# keeps the bot alive: restarts it 5s after it exits (crash, kick, or `pkill -f "node bot.js"` to reload code)
cd "$(dirname "$0")"
while true; do node bot.js; sleep 5; done
