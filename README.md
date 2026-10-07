# Minecraft Agent Kit

Put your own AI agent into a shared Minecraft survival world as a real player. Your agent gets a body (a
[Mineflayer](https://github.com/PrismarineJS/mineflayer) bot), a set of commands to act with (`./mc`, `./s`), a live
dashboard with a 3D follow-cam, and a turn loop that lets Claude Code play on its own, with memory between turns.

It's the same setup behind the "Claude plays Minecraft" stream, packaged so you can bring your own agent into that
world and live next to Claude.

```
your AI (Claude Code, or any agent that can run shell commands)
   │  runs ./mc goto x=.. / ./mc dig .. / ./s
   ▼
bot.js  ── Mineflayer bot, local HTTP API on :3456, dashboard on :3007
   │
   ▼
the host's Minecraft server (1.21.4 survival)
```

---

## 1. What you need

- **Node.js 20+** (`node -v`). macOS or Linux. On Windows, use WSL.
- **An AI to play.** The built-in loop uses **[Claude Code](https://claude.com/claude-code)** (`claude` CLI, logged
  in with a Claude plan). Keep it current: `claude update`. Other agents work too (see section 8).
- **The server address** from the host, and the host adding your agent's name to the whitelist.
- Optional: a free **Cloudflare** account for Clef, the cheap helper model (section 6).

## 2. Install

```bash
git clone <this repo> minecraft-agent-kit
cd minecraft-agent-kit
npm install          # also builds the dashboard's 3D view into web/view (takes a minute)
cp .env.example .env
```

Edit `.env`:

| Setting | What to put |
|---|---|
| `MC_HOST` | The server address the host gives you (see section 3) |
| `MC_PORT` | Usually `25565` |
| `MC_NAME` | Your agent's in-game name: unique, 3–16 letters/digits/underscores. Tell the host this name. |
| `PLAYER_MODEL` | `claude-opus-5-5` (best) or `claude-sonnet-5-5` (uses less of your plan) |
| `CLOUDFLARE_*` | Only for Clef, see section 6. Leave empty to skip. |

`.env` is private and gitignored. Never commit or share it.

## 3. Joining the world

The world runs on the host's computer. How you reach it depends on where you are:

- **Same Wi-Fi as the host:** use the host's local address, e.g. `MC_HOST=192.168.1.110`. Guest Wi-Fi networks
  often block this; use the main network.
- **Anywhere else:** the host needs a tunnel (for example [playit.gg](https://playit.gg) or Tailscale) and gives you
  that address instead. A `192.168.x.x` address only works on the host's own network.

Before your first join, send the host your `MC_NAME` so they can whitelist it. The host runs:

```
whitelist add <MC_NAME>
```

The server is **Minecraft Java 1.21.4**. The bot picks the right version on its own.

**House rules** (your agent's brief already includes them):
- Legit survival: no commands, no cheats. Your bot isn't op, so commands are blocked anyway.
- Build your own base at least 150 blocks from spawn, where the host's base is.
- Never take from other players' chests or farms, break their builds, or attack them. Trading and helping are welcome.

## 4. Start the bot

```bash
./run-bot.sh          # keeps the bot running (restarts it 5s after a crash or kick). Ctrl+C to stop.
```

Or in the background: `nohup ./run-bot.sh >> bot.log 2>&1 &` (stop with `pkill -f run-bot.sh; pkill -f "node bot.js"`).

When it prints `spawned at (...)`, your agent is in the world. Check:

```bash
./s                   # status: position, health, food, inventory, nearby blocks, mobs, chat
```

Open the dashboard at **http://localhost:3007** to watch: a 3D follow-cam, vitals, inventory, the action log and
chat. Click **Sound** and **Music** to turn on game sounds and background music.

## 5. Let the AI play

```bash
./player.sh           # Claude Code plays in turns, forever. Logs: player.log
```

Each turn, Claude Code reads `player-notes.md` (its memory), checks `./s`, takes 15–30 actions, then rewrites its
notes for the next turn. Its instructions are in `player-prompt.md` (`{{NAME}}` becomes your `MC_NAME`).
`player-notes.md` is created from `player-notes.template.md` on the first run.

- **Watch:** the dashboard (http://localhost:3007), or `tail -f player.log`.
- **Stop after the current turn:** `touch .stop-player`. **Stop now:** `pkill -f player.sh; pkill -f "claude -p Turn"`.
- **Cost:** every turn is a Claude Code session on your plan. Opus plays best; Sonnet goes further on the same plan.
- The AI can only run `./mc`, `./s` and edit `player-notes.md`. It can't touch other files.

### Talk to your agent

```bash
./tell "build a bridge across the river"     # shows at the top of ./s for 30 minutes
```

People in the world can also talk to it in game chat. It sees that as PLAYER CHAT and replies with `./mc chat`.

### Drive it yourself

Everything the AI does, you can do by hand:

```bash
./mc goto x=100 y=64 z=-200      # pathfind there (digs, jumps, bridges, climbs ladders)
./mc collect block=oak_log count=8
./mc craft item=stone_pickaxe count=1
./mc goto_player player=Claude
./mc chat text="hello neighbour!"
./mc think text="Heading west to find a spot for my base."   # narration on the dashboard
./mc stop
./mc eval <<< 'return bot.inventory.items().map(i=>i.name+" x"+i.count)'   # read state / chain normal inputs
```

Full list: the **Commands** section of `player-prompt.md`.

## 6. Clef: the cheap helper (optional)

Clef is a small, fast decision model on Cloudflare Workers AI (`@cf/cloudflare/clef-flash`). Your AI hands it
repetitive chores (chopping trees, strip-mining, hunting, fighting its way home), and Clef presses "buttons" in a loop
until the job is done. It costs almost nothing, saves your main AI's turns, and keeps the body moving.

Setup:
1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) (a free account works).
2. **Account ID:** copy it from your account's home page (it's also in the dashboard URL).
3. **API token:** *My Profile → API Tokens → Create Token*, and use the **Workers AI** template.
4. Put both in `.env`:
   ```
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_API_TOKEN=...
   ```
5. Restart the bot (`pkill -f "node bot.js"`; `run-bot.sh` brings it back in 5s) and test:
   ```bash
   ./mc clef task="chop down trees" buttons="go_to:oak_log,break:oak_log,pickup" until="oak_log>=8"
   ./mc clef            # shows usage and every button
   ```

Always quote `buttons=` and `until=` values: unquoted `|` and `>` are shell pipes and redirects.

## 7. Voice (optional)

Every `./mc think` line can be read aloud on the dashboard (handy if you stream your agent):

- **Mac, zero setup:** set `TTS=1` and `TTS_ENGINE=say` in `.env`. `TTS_VOICE` picks the voice (`say -v '?'` lists them).
- **Better, free and local:** [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open-source voice model:
  ```bash
  cd tts && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && mkdir -p models && cd models
  curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
  curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
  cd ../.. && echo am_michael > tts/voice.txt && nohup tts/.venv/bin/python tts/server.py >> tts/server.log 2>&1 &
  ```
  Then set `TTS=1` and `TTS_ENGINE=kokoro`, and restart the bot. Change voices live by editing `tts/voice.txt`
  (`am_puck`, `bm_george`, `am_santa`, ... or a Mac voice name like `Fred`).

Turn the dashboard's **Sound** on to hear it.

## 8. Using a different AI agent

Any agent that can run shell commands can play. Run it in this folder, give it `player-prompt.md` as its
instructions (replace `{{NAME}}` with your bot's name), and allow it to run `./mc` and `./s` and to edit
`player-notes.md`. Then prompt it each turn with: *"Read player-notes.md, check ./s, then keep playing."*

The bot's API also works without the scripts: `GET http://localhost:3456/state` and
`POST http://localhost:3456/act` with JSON like `{"action":"goto","x":10,"y":64,"z":-20}`.

## 9. Join as a human too

Open Minecraft Java **1.21.4** → Multiplayer → Direct Connection → the same address as `MC_HOST` (add `:port` if
it isn't 25565). Your Minecraft name also needs to be whitelisted.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `ECONNREFUSED` / connection timed out | Wrong `MC_HOST`/`MC_PORT`, the server is off, or you're not on the host's network. Ask the host. |
| Kicked: "You are not whitelisted" | Ask the host to run `whitelist add <MC_NAME>`. |
| Your bot and another player keep kicking each other ("logged in from another location") | Two players share a name. Change `MC_NAME`. |
| Chests, beds and crafting tables won't open | The server thinks the bot is crouching. Restart the bot: `pkill -f "node bot.js"`. |
| Walks fail with "Took to long to decide path" | The target is far or unreachable. Walk in shorter hops (50 blocks or less) to a standing spot (air with solid ground below). |
| The bot keeps getting stuck in one place | It tries escape moves and reroutes automatically. If it still can't, give it a different target, or dig/place a block by hand. |
| Dashboard 3D view is black | Reload the page (it reloads itself after a bot restart). |
| `EADDRINUSE` on 3456 or 3007 | Something else uses that port: change `API_PORT`/`VIEWER_PORT` in `.env` (and use `API_PORT=... ./s`). |
| Clef: "missing CLOUDFLARE_ACCOUNT_ID" | Fill in `.env` (section 6) and restart the bot. |
| `claude: unknown option` in player.log | Update Claude Code: `claude update`. |

## For the host

To let a friend's agent in:
1. In `server.properties` set `white-list=true` and `enforce-whitelist=true`, then restart the server (or run
   `whitelist on`). Add your own players first (`whitelist add Claude`, `whitelist add <your name>`).
2. `whitelist add <their MC_NAME>` for each friend's agent (and their own Minecraft name if they'll join by hand).
3. Give them the address: your LAN IP (`ipconfig getifaddr en0` on a Mac) if they're on your Wi-Fi, or a tunnel
   address if they're remote. Share it privately.
4. Every extra player loads chunks too, so expect a bit more server load.

## Files

| File | What it is |
|---|---|
| `bot.js` | The body: Mineflayer bot, actions, stuck/ladder handling, legit-survival guard, HTTP API |
| `autopilot.js` | Clef: the button-pressing helper loop |
| `dashboard.js`, `web/` | Dashboard + 3D follow-cam (`web/view` is built by `npm install`) |
| `sounds.js` | Real Minecraft sounds for the dashboard |
| `village.js` | Extra survival builders (find a village, build/furnish a villa, harvest wheat) |
| `mc`, `s`, `tell` | Command line: act, status, message your agent |
| `player.sh`, `player-prompt.md`, `player-notes.template.md` | The Claude Code turn loop, its instructions and starting memory |
| `run-bot.sh` | Keeps the bot running |
| `tts/` | Optional local voice server (Kokoro) |
