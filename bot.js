// Your agent's Minecraft body: a Mineflayer bot controlled over a local HTTP API (the ./mc and ./s commands use it).
// GET  /state         -> what the bot sees/has
// POST /act {action}  -> do something (see ACTIONS below)
const http = require('http')
const fs = require('fs')
// load .env (server address, bot name, Clef credentials - see .env.example) without printing anything
try {
  for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '') // drop inline # comments
  }
} catch {}
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const { Vec3 } = require('vec3')

const API_PORT = Number(process.env.API_PORT || 3456)
const VIEWER_PORT = Number(process.env.VIEWER_PORT || 3007)
const chatLog = []
const actionLog = [] // what the bot has been doing, shown on the dashboard
let lastThink = '' // latest ./mc think line: labels custom eval scripts on the dashboard instead of raw code
let goal = ''
let logId = 0
let manualBusy = 0
let home = null // set by build_house / the home action; the autopilot heads here at night
let castle = null // (unused in the kit; kept so state.json from older bots still loads)
let village = null // centre of the real village the luxury quarter is built beside
let villas = [] // [{ origin: {x,y,z}, bed: bool }] built by hand next to it
const SAVE = __dirname + '/state.json' // survives bot restarts
try {
  const saved = JSON.parse(fs.readFileSync(SAVE, 'utf8'))
  if (saved.home) home = new Vec3(saved.home.x, saved.home.y, saved.home.z)
  if (saved.castle) castle = new Vec3(saved.castle.x, saved.castle.y, saved.castle.z)
  if (saved.village) village = new Vec3(saved.village.x, saved.village.y, saved.village.z)
  if (Array.isArray(saved.villas)) villas = saved.villas
} catch {}
const saveState = () => { try { fs.writeFileSync(SAVE, JSON.stringify({ home, castle, village, villas }, null, 1)) } catch {} }
let autopilot = null
function logAction(e) {
  const entry = { id: ++logId, t: new Date().toISOString().slice(11, 19), ...e }
  actionLog.push(entry); if (actionLog.length > 200) actionLog.shift()
  return entry
}
let mcData

process.on('unhandledRejection', (e) => console.log('unhandled rejection (ignored):', e?.message || e))

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_NAME || 'Agent',
  version: '1.21.4',
  viewDistance: Number(process.env.VIEW_DISTANCE || 10),
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)

// Legit survival: the bot may only play like a normal player. Every chat command (/fill, /setblock,
// /summon, /gamemode, /tp...) is dropped before it reaches the server. LEGIT=0 turns this off.
const LEGIT = process.env.LEGIT !== '0'
function installLegitGuard() { // bot.chat only exists once mineflayer's chat plugin has loaded
  const rawChat = bot.chat.bind(bot)
  bot.chat = (message) => {
    if (LEGIT && String(message).trim().startsWith('/')) {
      logAction({ action: 'legit', args: {}, status: 'error', result: `blocked command: ${String(message).slice(0, 80)}` })
      return
    }
    rawChat(message)
  }
}

bot.once('spawn', () => {
  installLegitGuard()
  // mineflayer only notices a dismount when the server sends vehicle id -1, but vanilla sends the vehicle's new
  // passenger list without us in it. Without this the bot thinks it's still seated: physics off, body frozen in place.
  bot._client.on('set_passengers', ({ entityId, passengers }) => {
    if (bot.vehicle?.id !== entityId || passengers.includes(bot.entity.id)) return
    const v = bot.vehicle
    bot.vehicle = null; bot.entity.vehicle = null
    v.passengers = v.passengers.filter((p) => p !== bot.entity)
    bot.emit('dismount', v)
  })
  if (bot.registry.version['<']('1.21.6')) {
    const rawSetControl = bot.setControlState
    bot.setControlState = (control, state) => {
      const was = bot.controlState[control]
      rawSetControl(control, state)
      if (control === 'sneak' && was !== state) bot._client.write('entity_action', { entityId: bot.entity.id, actionId: state ? 0 : 1, jumpBoost: 0 })
    }
  }
  // Every dig (actions, eval scripts, Clef, pathfinder) first switches to the best tool in the inventory - no bare-fist mining.
  const rawDig = bot.dig.bind(bot)
  bot.dig = async (block, ...rest) => {
    try { if (block && block.name !== 'air') await bot.tool.equipForBlock(block, {}) } catch (e) { /* keep whatever is held */ }
    // Server datapacks fell a whole tree / mine a whole vein when you crouch-break a log with an axe or an ore with a
    // pickaxe, same as for human players. Crouch for those digs (and a couple of ticks after, so the pack sees it).
    const held = (bot.heldItem && bot.heldItem.name) || '', name = (block && block.name) || ''
    const vein = (/_axe$/.test(held) && /_(log|wood|stem|hyphae)$/.test(name)) || (/_pickaxe$/.test(held) && /(_ore|^ancient_debris)$/.test(name))
    if (!vein) return rawDig(block, ...rest)
    bot.setControlState('sneak', true)
    try { await bot.waitForTicks(2); return await rawDig(block, ...rest) } finally { await bot.waitForTicks(3).catch(() => {}); bot.setControlState('sneak', false) }
  }
  mcData = require('minecraft-data')(bot.version)
  const moves = new Movements(bot)
  moves.allowParkour = true
  // the pathfinder only towers/bridges with dirt + cobblestone; underground the bot mostly carries deepslate & co,
  // so without these it can't climb out of a cave and jumps in place until the watchdog cancels
  for (const n of ['cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'deepslate']) {
    const id = bot.registry.itemsByName[n]?.id
    if (id != null && !moves.scafoldingBlocks.includes(id)) moves.scafoldingBlocks.push(id)
  }
  const baseGetBlock = moves.getBlock.bind(moves)
  moves.getBlock = (pos, dx, dy, dz) => {
    const b = baseGetBlock(pos, dx, dy, dz)
    if (b?.name === 'snow' && b.shapes?.[0]?.[4] > 0.2) { b.physical = true; b.safe = false; b.replaceable = false } // deep snow = solid
    return b
  }
  bot.pathfinder.setMovements(moves)
  bot.pathMoves = moves // pathfinder 2.4 doesn't expose its movements; goto toggles parkour on it
  moves.exclusionAreasStep.push((b) => avoidSpots.some((a) => a.until > Date.now() && b.position.distanceTo(a.pos) < 1.5) ? 40 : 0) // spots where a walk got stuck (stuckWatchdog)
  bot.pathfinder.thinkTimeout = 10000
  // can't sprint at hunger <= 6, so sprint-jump/parkour paths fail and the bot loops in place
  bot.on('health', () => {
    const canSprint = bot.food > 6
    if (moves.allowSprinting !== canSprint) { moves.allowSprinting = canSprint; moves.allowParkour = canSprint; bot.pathfinder.setMovements(moves) }
  })
  require('./dashboard')(bot, { viewDistance: Number(process.env.VIEWER_DISTANCE || 6), port: VIEWER_PORT, getState: () => ({ goal, ...state() }), getLog: () => actionLog.slice(-40) })
  console.log(`spawned at ${bot.entity.position} | viewer http://localhost:${VIEWER_PORT} | api http://localhost:${API_PORT}`)
  setInterval(reflexes, 500)
  setInterval(stuckWatchdog, 1000)
  autopilot = require('./autopilot')(bot, {
    ACTIONS, inventory, deadline, mcData: () => mcData, getGoal: () => goal, setGoal: (g) => { goal = g }, getHome: () => home, getCastle: () => castle,
    getVillage: () => village, setVillage: (v) => { village = v; saveState() }, getVillas: () => villas,
    isManualBusy: () => manualBusy > 0, log: logAction,
  })
  if (process.env.AUTOPILOT === 'on') autopilot.set(true)
})

// pathfinder sometimes "moves" forever without going anywhere (stuck on leaves, ledges, wall gaps, desync).
// Two signs: it claims to be moving but the bot hasn't budged for 8s, or the bot twitches in place without getting
// 1 block closer to the goal for 15s (the twitching hid the first sign). Then: cancel, try different escape moves
// until one actually moves the bot, and mark the spot so the retried path (see goto) goes around it.
let stuckSince = null, stuckPos = null, idleSince = null, lastStuckCancel = 0
let progressGoal = null, progressBest = Infinity, progressAt = 0, wiggling = false
const avoidSpots = [] // { pos, until }: the pathfinder treats these as very expensive to step on
const goalPos = (g) => (g?.x !== undefined ? new Vec3(g.x, g.y ?? bot.entity.position.y, g.z) : g?.entity?.position ?? null)
async function wiggleFree(target) {
  const start = bot.entity.position.clone()
  if (target) await bot.lookAt(new Vec3(target.x, start.y + 1.6, target.z), true).catch(() => {})
  const side = Math.random() < 0.5 ? ['left', 'right'] : ['right', 'left'] // vary it, the same wiggle can land in the same spot
  for (const keys of [['forward', 'jump'], [side[0], 'forward', 'jump'], [side[1], 'forward', 'jump'], [side[0], 'jump'], [side[1], 'jump'], ['back', 'jump']]) {
    for (const k of keys) bot.setControlState(k, true)
    await bot.waitForTicks(10)
    bot.clearControlStates()
    await bot.waitForTicks(2)
    if (bot.entity.position.distanceTo(start) > 0.8) return keys.join('+')
  }
  // last resort, like a player: break what's in the way toward the goal (head + feet height) and push through.
  // Never containers, beds, doors, ladders, glass or logs (an axe on a log fells the whole tree, e.g. the treehouse).
  if (!target) return null
  const KEEP = /chest|barrel|shulker|furnace|smoker|bed$|door|ladder|torch|lantern|glass|pane|crafting|anvil|enchant|bookshelf|sign|log|wood|stem|obsidian|bedrock|spawner|lava|water/
  const ax = target.x - start.x, az = target.z - start.z
  const [dx, dz] = Math.abs(ax) > Math.abs(az) ? [Math.sign(ax), 0] : [0, Math.sign(az)]
  let broke = 0
  for (const dy of [1, 0]) {
    const b = bot.blockAt(start.floored().offset(dx, dy, dz))
    if (b && b.boundingBox === 'block' && b.diggable && !KEEP.test(b.name)) { try { await deadline(bot.dig(b, true), 10000); broke++ } catch {} }
  }
  if (!broke) return null
  await bot.lookAt(start.floored().offset(dx + 0.5, 1.6, dz + 0.5), true).catch(() => {})
  bot.setControlState('forward', true); bot.setControlState('jump', true)
  await bot.waitForTicks(12)
  bot.clearControlStates()
  return bot.entity.position.distanceTo(start) > 0.8 ? `breaking through ${broke} block(s)` : null
}
async function stuckWatchdog() {
  if (!bot.entity) return
  // a goal the pathfinder has given up on without saying so: goal set, but not moving/digging/building for 15s
  const busy = bot.pathfinder.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding() || bot.targetDigBlock
  if (bot.pathfinder.goal && !busy) {
    idleSince ??= Date.now()
    if (Date.now() - idleSince > 15000) {
      idleSince = null
      logAction({ action: 'watchdog', args: {}, status: 'error', result: 'walk had stalled (goal set, not moving for 15s) - cancelled it' })
      bot.pathfinder.setGoal(null)
    }
  } else idleSince = null
  const pos = bot.entity.position, goal = bot.pathfinder.goal
  // progress toward the goal (digging/building through something gets 30s instead of 15s)
  let why = null
  const target = goalPos(goal)
  if (!goal || !target || !bot.pathfinder.isMoving()) progressGoal = null
  else {
    const d = pos.distanceTo(target)
    if (progressGoal !== goal) { progressGoal = goal; progressBest = d; progressAt = Date.now() }
    else if (d < progressBest - 1) { progressBest = d; progressAt = Date.now() }
    else if (Date.now() - progressAt > (bot.pathfinder.isMining() || bot.pathfinder.isBuilding() ? 30000 : 15000)) why = 'no progress toward the goal for 15s'
  }
  // claims to be moving but hasn't budged for 8s. (Both stuckPos and stuckSince reset whenever we're not walking,
  // so a new walk that starts where the last one ended isn't mistaken for "stuck since forever".)
  if (!why) {
    if (!bot.pathfinder.isMoving() || bot.targetDigBlock || bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) { stuckSince = null; stuckPos = null; return }
    if (!stuckPos || pos.distanceTo(stuckPos) > 0.3) { stuckPos = pos.clone(); stuckSince = Date.now(); return }
    if (Date.now() - stuckSince < 8000) return
    why = 'not moving for 8s'
  }
  stuckSince = null; stuckPos = null; progressGoal = null
  avoidSpots.splice(0, avoidSpots.length, ...avoidSpots.filter((a) => a.until > Date.now()), { pos: pos.floored(), until: Date.now() + 60000 })
  lastStuckCancel = Date.now() // goto sees this and retries instead of failing
  wiggling = true
  bot.pathfinder.setGoal(null)
  let moved = null
  try { moved = await wiggleFree(target) } finally { wiggling = false; lastStuckCancel = Date.now() }
  logAction({ action: 'watchdog', args: {}, status: 'error', result: `stuck at ${pos.floored()} (${why}) - cancelled path, ${moved ? `got free with ${moved}` : 'escape moves did not help'}, rerouting around this spot` })
}

// survival reflexes that run on their own: fight back against close hostiles, eat when hungry
let reflexBusy = false
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'diamond_axe', 'iron_axe', 'stone_axe']
async function reflexes() {
  if (reflexBusy || !bot.entity) return
  reflexBusy = true
  try {
    const mob = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 4)
    if (bot.oxygenLevel < 12 && (bot.entity.isInWater || bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.name === 'water')) {
      bot.pathfinder.setGoal(null)
      await bot.look(bot.entity.yaw, Math.PI / 2, true) // look up
      bot.setControlState('jump', true); bot.setControlState('forward', false)
      await bot.waitForTicks(10)
      bot.setControlState('jump', false)
      logAction({ action: 'reflex', args: {}, status: 'ok', result: `low on air (${bot.oxygenLevel}) - swimming up` })
    } else if (mob) {
      const weapon = WEAPONS.map((w) => bot.inventory.items().find((i) => i.name === w)).find(Boolean)
      if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand')
      await bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true)
      bot.attack(mob)
    } else if (bot.food < 15 && !bot.targetDigBlock) {
      const bad = bot.food > 6 ? /rotten|spider_eye|poisonous|^chicken$/ : /rotten|spider_eye|poisonous/ // raw chicken can poison
      const food = bot.inventory.items().filter((i) => mcData.foodsByName[i.name] && !bad.test(i.name))
        .sort((a, b) => (mcData.foodsByName[b.name].saturation || 0) - (mcData.foodsByName[a.name].saturation || 0))[0] // best food first
      if (food) { await bot.equip(food, 'hand'); await bot.consume() }
    }
  } catch (e) { /* reflexes are best-effort */ }
  reflexBusy = false
}
bot.on('messagestr', (msg) => {
  chatLog.push({ t: new Date().toISOString().slice(11, 19), msg })
  if (chatLog.length > 30) chatLog.shift()
})
bot.on('death', () => chatLog.push({ t: new Date().toISOString().slice(11, 19), msg: `*** ${bot.username} died ***` }))
bot.on('kicked', (r) => { console.log('kicked', r); process.exit(1) })
bot.on('error', (e) => console.log('error', e.message))
bot.on('end', () => { console.log('disconnected'); process.exit(1) })

const round = (p) => p && { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }
const dist = (p) => Math.round(bot.entity.position.distanceTo(p) * 10) / 10

function inventory() {
  const inv = {}
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
  return inv
}

const INTERESTING = /(_log|_ore|crafting_table|furnace|chest|water|lava|bed|wheat|sugar_cane|pumpkin|melon)$/

function state() {
  const pos = bot.entity.position
  const blockIds = Object.values(mcData.blocksByName).filter((b) => INTERESTING.test(b.name)).map((b) => b.id)
  const nearbyBlocks = {}
  for (const p of bot.findBlocks({ matching: blockIds, maxDistance: 24, count: 200 })) {
    const name = bot.blockAt(p).name
    const d = dist(p)
    if (!nearbyBlocks[name] || d < nearbyBlocks[name].dist) nearbyBlocks[name] = { dist: d, at: p, count: (nearbyBlocks[name]?.count || 0) + 1 }
    else nearbyBlocks[name].count++
  }
  const entities = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(pos) < 32)
    .map((e) => ({ id: e.id, name: e.username || e.name, type: e.type, dist: dist(e.position), at: round(e.position) }))
    .sort((a, b) => a.dist - b.dist).slice(0, 15)
  const below = bot.blockAt(pos.offset(0, -1, 0))
  const looking = bot.blockAtCursor(5)
  return {
    goal, autopilot: autopilot?.status(), pos: round(pos), dimension: bot.game.dimension, health: bot.health, food: bot.food,
    timeOfDay: bot.time.timeOfDay, isDay: bot.time.isDay, raining: bot.isRaining,
    holding: bot.heldItem?.name || null, standingOn: below?.name, lookingAt: looking && { name: looking.name, at: looking.position },
    name: bot.username, busy: bot.pathfinder.isMoving(), inventory: inventory(), nearbyBlocks, entities, chat: chatLog.slice(-15),
  }
}

function itemByName(name) {
  const item = mcData.itemsByName[name] || mcData.blocksByName[name]
  if (!item) throw new Error(`unknown item/block: ${name}`)
  return item
}

function blockByName(name) {
  const block = mcData.blocksByName[name]
  if (!block) throw new Error(`unknown block: ${name}`)
  return block
}

// a block is in reach if its centre is within 4.5 blocks of the bot's eyes (no need to walk anywhere)
function inReach(pos) {
  return bot.entity.position.offset(0, 1.62, 0).distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)) <= 4.5
}

// Like a player holding shift: when the bot is on a ladder/vine and not walking anywhere, sneak so it stays put
// instead of sliding back down between actions.
const CLIMBABLE = /^(ladder|vine|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/
let ladderGrip = false, ladderBusy = false
setInterval(() => {
  if (!bot.entity) return
  const onClimbable = CLIMBABLE.test(bot.blockAt(bot.entity.position)?.name || '')
  const want = onClimbable && !ladderBusy && !bot.pathfinder?.isMoving() && !bot.controlState.jump && !bot.controlState.forward
  if (want !== ladderGrip) { ladderGrip = want; bot.setControlState('sneak', want) }
}, 100)

// Ladders by hand, like a player: the pathfinder plugin can't climb them (it stalls, "moving" with no keys held).
// Up: hold jump until the ladder ends (or toY), then step forward onto the floor beside the top.
// Down: let go and slide until the ladder ends (or toY), then grab on again.
const onLadder = () => CLIMBABLE.test(bot.blockAt(bot.entity.position)?.name || '')
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
// A missing rung stops a climb dead (you can't jump off a ladder, you just slide back), so before climbing, look
// up the column for gaps and fill each one like a player would: climb to just below it, hang on, place a ladder.
const FACING = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
async function fillLadderGaps(toY) {
  const x = Math.floor(bot.entity.position.x), z = Math.floor(bot.entity.position.z), y0 = Math.floor(bot.entity.position.y)
  let facing = bot.blockAt(new Vec3(x, y0, z))?.getProperties().facing
  for (let gy = y0 + 1; gy <= Math.min(toY ?? Infinity, y0 + 40); gy++) {
    const b = bot.blockAt(new Vec3(x, gy, z))
    if (!b) return
    if (CLIMBABLE.test(b.name)) { facing = b.getProperties().facing ?? facing; continue }
    const above = bot.blockAt(new Vec3(x, gy + 1, z))
    if (b.boundingBox !== 'empty' || !above || !CLIMBABLE.test(above.name)) return // the real top (or a block in the way)
    const item = bot.inventory.items().find((i) => i.name === 'ladder')
    if (!item) throw new Error(`the ladder is missing a rung at y ${gy} and you can't climb past a gap: bring a ladder and climb again (it gets placed for you)`)
    const dir = FACING[facing]
    if (!dir) throw new Error(`the ladder is missing a rung at y ${gy}: place a ladder there against the wall`)
    bot.setControlState('jump', true)
    const t = Date.now() + 15000
    while (onLadder() && bot.entity.position.y < gy - 0.6 && Date.now() < t) await pause(50)
    bot.setControlState('jump', false); bot.setControlState('sneak', true) // hang on below the gap
    await bot.waitForTicks(4)
    await bot.equip(item, 'hand')
    await bot.placeBlock(bot.blockAt(new Vec3(x - dir[0], gy, z - dir[2])), new Vec3(...dir))
    bot.setControlState('sneak', false)
  }
}
async function climbLadder(toY) {
  if (!onLadder()) return 'not on a ladder'
  bot.pathfinder.setGoal(null); bot.clearControlStates(); ladderBusy = true
  const y0 = bot.entity.position.y, up = toY === undefined || toY > y0, until = Date.now() + 25000
  try {
    if (up) {
      await fillLadderGaps(toY)
      bot.setControlState('jump', true)
      while (onLadder() && (toY === undefined || bot.entity.position.y < toY) && Date.now() < until) await pause(50)
      if (!onLadder()) { // reached the top: step off onto a floor block next to the ladder
        const p = bot.entity.position.floored()
        const exit = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p.offset(dx, 0, dz)).find((q) =>
          bot.blockAt(q.offset(0, -1, 0))?.boundingBox === 'block' && bot.blockAt(q)?.boundingBox === 'empty' && bot.blockAt(q.offset(0, 1, 0))?.boundingBox === 'empty')
        if (exit) {
          await bot.lookAt(exit.offset(0.5, 0.6, 0.5), true)
          bot.setControlState('forward', true)
          const centre = exit.offset(0.5, 0, 0.5), t = Date.now() + 1500 // short: never walk on across the platform
          while (Date.now() < t) {
            const p = bot.entity.position
            if (bot.entity.onGround && !onLadder() && Math.hypot(p.x - centre.x, p.z - centre.z) < 0.5) break
            await pause(50)
          }
        }
      }
    } else {
      while (onLadder() && bot.entity.position.y > toY + 0.2 && Date.now() < until) await pause(50) // slide
    }
  } finally { bot.clearControlStates(); ladderBusy = false }
  return `climbed ${up ? 'up' : 'down'} from y ${Math.floor(y0)} to y ${Math.floor(bot.entity.position.y)}`
}

// pathfinder.goto, but if the bot ends up hanging on a ladder with no keys pressed for 1.5s, cancel it
// (throws { ladderStall }) so the caller can climb by hand and try again
async function pathAvoidingLadderStalls(goal) {
  let idle = 0, stalled = false
  const iv = setInterval(() => {
    const keys = ['forward', 'back', 'left', 'right', 'jump'].some((k) => bot.controlState[k])
    if (onLadder() && bot.pathfinder.isMoving() && !keys) { if (++idle >= 6) { stalled = true; bot.pathfinder.setGoal(null) } } else idle = 0
  }, 250)
  try { await bot.pathfinder.goto(goal) } catch (e) {
    if (stalled) throw Object.assign(new Error('stalled on a ladder'), { ladderStall: true })
    throw e
  } finally { clearInterval(iv) }
}

function nearestBlock(name, maxDistance = 64) {
  const b = bot.findBlock({ matching: blockByName(name).id, maxDistance })
  if (!b) throw new Error(`no ${name} within ${maxDistance} blocks`)
  return b
}

const ACTIONS = {
  camera: async ({ mode = 'auto', secs = 30 }) => bot.camera.set(mode, secs),
  autopilot: async ({ on = 'status' }) => (on === 'status' ? autopilot.status() : autopilot.set(on === 'on' || on === true)),
  // hand Clef a small task + the buttons it may press:
  //   ./mc clef task="chop down a tree" buttons=go_to:oak_log,break:oak_log,pickup until=*_log>=12
  clef: async ({ task, buttons = '', steps = 25, done, until }) => {
    if (!task) return { usage: 'clef task="..." buttons=go_to:X,break:X,pickup,craft:X,place:X [until=item>=N] [done=surface|daytime|fed] [steps=25]', tasks: autopilot.buttons() }
    return autopilot.runTask({ task, buttons: String(buttons).split(',').map((b) => b.trim()), steps, done, until })
  },
  // dig a 1-wide staircase upward in the direction the bot faces (snapped to N/E/S/W)
  stairs_up: async ({ steps = 10 }) => {
    const i = ((Math.round(bot.entity.yaw / (Math.PI / 2)) % 4) + 4) % 4
    const [dx, dz] = [[0, -1], [-1, 0], [0, 1], [1, 0]][i] // mineflayer yaw 0 faces -z, +pi/2 faces -x
    const solid = (p) => bot.blockAt(p)?.boundingBox === 'block'
    const nearLiquid = (p) => [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => /water|lava/.test(bot.blockAt(p.offset(a, b, c))?.name || ''))
    const FILL = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone']
    const y0 = Math.floor(bot.entity.position.y)
    let climbed = 0
    for (let n = 0; n < steps; n++) {
      if ((bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.skyLight ?? 0) >= 14) break // open sky
      const me = bot.entity.position.floored()
      const fwd = me.offset(dx, 0, dz)
      for (const p of [me.offset(0, 2, 0), fwd.offset(0, 1, 0), fwd.offset(0, 2, 0)]) {
        for (let k = 0; k < 8 && solid(p); k++) { // gravel/sand can fall back in
          if (nearLiquid(p)) throw new Error(`liquid next to ${p}, stopped after ${climbed} steps`)
          await bot.tool.equipForBlock(bot.blockAt(p), {}); await deadline(bot.dig(bot.blockAt(p), true), 15000)
          await bot.waitForTicks(3)
        }
      }
      if (!solid(fwd)) { // need a step to stand on
        const f = bot.inventory.items().find((it) => FILL.includes(it.name))
        const ref = [[0, -1, 0], [dx, 0, dz], [-dz, 0, dx], [dz, 0, -dx]].map(([a, b, c]) => new Vec3(a, b, c)).find((o) => solid(fwd.plus(o)))
        if (!f) throw new Error('out of filler blocks')
        await bot.equip(f, 'hand')
        if (!ref) { // open air ahead (cave): pillar straight up one block instead - jump, place under feet
          await deadline(bot.pathfinder.goto(new goals.GoalBlock(me.x, me.y + 1, me.z)), 8000) // pathfinder's own 1x1 tower move
          climbed++
          continue
        }
        await bot.placeBlock(bot.blockAt(fwd.plus(ref)), ref.scaled(-1))
      }
      await deadline(bot.pathfinder.goto(new goals.GoalBlock(fwd.x, fwd.y + 1, fwd.z)), 8000)
      climbed++
    }
    return `climbed ${climbed} steps, y ${y0} -> ${Math.floor(bot.entity.position.y)}`
  },
  home: async ({ x, y, z }) => { home = x === undefined ? bot.entity.position.floored() : new Vec3(x, y, z); saveState(); return `home set to ${home}` },
  goal: async ({ text }) => { goal = String(text); return `goal: ${goal}` },
  think: async ({ text }) => { lastThink = String(text).slice(0, 200); bot.speak?.(lastThink); return lastThink }, // the bot's reasoning, shown in the dashboard log and spoken aloud for viewers
  chat: async ({ text }) => {
    if (LEGIT && String(text).trim().startsWith('/')) throw new Error('commands are blocked in legit survival')
    bot.chat(String(text)); return 'said it'
  },
  // get out of a minecart/boat/horse: crouch, like a player (mineflayer's own dismount sends a jump, which does nothing)
  dismount: async () => {
    if (!bot.vehicle) return 'not riding anything'
    bot.setControlState('sneak', true); await pause(400); bot.setControlState('sneak', false); await pause(300)
    return bot.vehicle ? 'still riding - try again' : 'got off'
  },
  climb: async ({ y }) => climbLadder(y === undefined ? undefined : Number(y)), // up/down the ladder you're on
  goto: async ({ x, y, z, range = 1 }) => {
    // the pathfinder walks fine but stalls on ladders: climb those by hand, then let it carry on. If the stuck
    // watchdog cancels the walk, wiggle free and retry (twice, without parkour jumps) instead of failing right away.
    const moves = bot.pathMoves, parkour = moves.allowParkour
    let stuckRetries = 0
    try {
      for (let attempt = 0; ; attempt++) {
        if (onLadder() && Math.abs(y - bot.entity.position.y) > 1) await climbLadder(y > bot.entity.position.y ? undefined : y)
        const budget = Math.max(30000, bot.entity.position.distanceTo(new Vec3(x, y, z)) * 1500)
        try { await deadline(pathAvoidingLadderStalls(new goals.GoalNear(x, y, z, range)), budget); break } catch (e) {
          if (e.ladderStall && attempt < 3) continue
          if (Date.now() - lastStuckCancel < 3000 && stuckRetries++ < 2) {
            do await bot.waitForTicks(5); while (wiggling) // let the escape moves finish
            moves.allowParkour = false; bot.pathfinder.setMovements(moves)
            continue
          }
          throw e
        }
      }
    } finally { if (moves.allowParkour !== parkour) { moves.allowParkour = parkour; bot.pathfinder.setMovements(moves) } }
    return `arrived at ${JSON.stringify(round(bot.entity.position))}${stuckRetries ? ` (got stuck ${stuckRetries}x, recovered)` : ''}`
  },
  goto_block: async ({ block, range = 2 }) => {
    const b = nearestBlock(block)
    await bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, range))
    return `next to ${block} at ${b.position}`
  },
  goto_player: async ({ player, range = 2 }) => {
    const p = bot.players[player]?.entity
    if (!p) throw new Error(`can't see player ${player}`)
    await bot.pathfinder.goto(new goals.GoalNear(p.position.x, p.position.y, p.position.z, range))
    return `next to ${player}`
  },
  follow: async ({ player, range = 3 }) => {
    const p = bot.players[player]?.entity
    if (!p) throw new Error(`can't see player ${player}`)
    bot.pathfinder.setGoal(new goals.GoalFollow(p, range), true)
    return `following ${player} (use stop to end)`
  },
  stop: async () => { bot.pathfinder.setGoal(null); bot.pvp?.stop?.(); bot.clearControlStates(); return 'stopped' },
  collect: async ({ block, count = 1 }) => {
    // block may be a comma list, e.g. iron_ore,deepslate_iron_ore
    // nearest-first; each block gets a time budget and is skipped if unreachable
    const ids = String(block).split(',').map((b) => blockByName(b.trim()).id)
    // budget: ~12s per block (max 3 min) and give up after 4 misses in a row, so a stuck collect returns
    // what it got instead of grinding on unreachable blocks (e.g. logs high up in a tree)
    const skip = new Set()
    let got = 0, misses = 0, why = ''
    const until = Date.now() + Math.min(180000, 20000 + count * 12000)
    for (let tries = 0; got < count && tries < count * 3; tries++) {
      if (Date.now() > until) { why = ' (time budget used up)'; break }
      if (misses >= 4) { why = ' (4 unreachable in a row - move somewhere else or build up to them)'; break }
      const p = bot.findBlocks({ matching: ids, maxDistance: 64, count: 64 }).find((q) => !skip.has(q.toString()))
      if (!p) break
      try {
        await deadline(bot.pathfinder.goto(new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 })), 30000)
        const b = bot.blockAt(p)
        if (!ids.includes(b.type)) continue
        await bot.tool.equipForBlock(b, { requireHarvest: true })
        await deadline(bot.dig(b, true), 20000)
        got++; misses = 0
        await deadline(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)), 6000).catch(() => {}) // walk over the drop
      } catch (e) {
        skip.add(p.toString()); misses++
        bot.pathfinder.setGoal(null)
      }
    }
    if (!got) throw new Error(`couldn't get any ${block}${why || ' (none reachable within 64 blocks)'}`)
    return `got ${got}/${count} ${block}${why}. inventory: ${JSON.stringify(inventory())}`
  },
  dig: async ({ x, y, z }) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b || b.name === 'air') throw new Error('nothing to dig there')
    if (!inReach(b.position)) await bot.pathfinder.goto(new goals.GoalLookAtBlock(b.position, bot.world))
    await bot.tool?.equipForBlock?.(b)
    await bot.dig(b)
    return `dug ${b.name}`
  },
  place: async ({ item, x, y, z }) => {
    let target = x === undefined ? null : new Vec3(x, y, z)
    if (!target) { // pick a free spot next to the bot with solid ground under it
      const me = bot.entity.position.floored()
      const spots = []
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, -1, 1]) {
        if (dx === 0 && dz === 0) continue // not where the bot is standing
        const t = me.offset(dx, dy, dz)
        if (bot.blockAt(t)?.name === 'air' && bot.blockAt(t.offset(0, -1, 0))?.boundingBox === 'block') spots.push(t)
      }
      target = spots.sort((p, q) => p.distanceTo(me) - q.distanceTo(me))[0]
      if (!target) throw new Error('no free spot next to me')
    }
    const faces = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map((f) => new Vec3(...f))
    const face = faces.find((f) => { const b = bot.blockAt(target.plus(f)); return b && b.boundingBox === 'block' })
    if (!face) throw new Error('no solid block next to that spot to place against')
    const ref = bot.blockAt(target.plus(face))
    if (!inReach(target)) await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3))
    await bot.equip(itemByName(item).id, 'hand')
    await bot.placeBlock(ref, face.scaled(-1))
    return `placed ${item} at ${target}`
  },
  craft: async ({ item, count = 1 }) => {
    const id = itemByName(item).id
    let table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 })
    let recipe = bot.recipesFor(id, null, 1, null)[0]
    if (!recipe && table) {
      await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
      recipe = bot.recipesFor(id, null, 1, table)[0]
    } else table = null
    if (!recipe) throw new Error(`can't craft ${item} with current inventory${table ? '' : ' (and no crafting table nearby)'}`)
    await bot.craft(recipe, count, table)
    await bot.waitForTicks(4) // let the inventory update arrive before anything uses the new item
    return `crafted ${item}. inventory: ${JSON.stringify(inventory())}`
  },
  smelt: async ({ item, fuel, count = 1 }) => {
    // fuel: coal if we have it, else charcoal / planks / logs
    fuel ??= ['coal', 'charcoal'].find((f) => inventory()[f]) ?? Object.keys(inventory()).find((n) => /_planks$|_log$/.test(n))
    if (!fuel) throw new Error('no fuel (coal, charcoal, planks or logs)')
    const furnaceBlock = nearestBlock('furnace', 32)
    await bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2))
    const furnace = await bot.openFurnace(furnaceBlock)
    try {
      const fuelNeeded = Math.min(inventory()[fuel] || 0, /_planks$|_log$/.test(fuel) ? Math.ceil(count / 1.5) : Math.ceil(count / 8))
      if (!furnace.fuelItem()) await furnace.putFuel(itemByName(fuel).id, null, fuelNeeded)
      await furnace.putInput(itemByName(item).id, null, count)
      const deadline = Date.now() + count * 10500 + 3000
      let got = 0
      while (got < count && Date.now() < deadline) {
        await bot.waitForTicks(20)
        if (furnace.outputItem()) got += (await furnace.takeOutput()).count
      }
      return `smelted ${got} ${item}. inventory: ${JSON.stringify(inventory())}`
    } finally { furnace.close() }
  },
  // ---- legit luxury village (see village.js): real village, gathered materials, hand-placed blocks ----
  find_village: async ({ steps = 6 }) => {
    const V = require('./village')
    for (let i = 0; i < steps; i++) {
      const found = V.detectVillage(bot, mcData)
      if (found) { village = found; saveState(); bot.chat(`Found a village at ${found.x}, ${found.z}. The luxury quarter goes here.`); return `village at ${found}` }
      const p = bot.entity.position
      const a = Math.random() * Math.PI * 2
      await deadline(bot.pathfinder.goto(new goals.GoalXZ(p.x + Math.cos(a) * 80, p.z + Math.sin(a) * 80)), 90000).catch(() => bot.pathfinder.setGoal(null))
    }
    throw new Error('no village found yet (explored and saw no villagers or bell)')
  },
  build_villa: async () => {
    if (!village) throw new Error('find a village first')
    if (bot.entity.position.distanceTo(village) > 40) {
      await deadline(bot.pathfinder.goto(new goals.GoalNear(village.x, village.y, village.z, 12)), 240000)
    }
    const r = await require('./village').buildVilla(bot, { ACTIONS, inventory, deadline, mcData: () => mcData }, {
      village, taken: villas.map((v) => new Vec3(v.origin.x, v.origin.y, v.origin.z)),
    })
    villas.push({ origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z }, bed: !!r.bed })
    home = r.origin.offset(4, 1, 3); saveState()
    return `villa ${villas.length} at ${r.origin} (${JSON.stringify(r.stats)})`
  },
  furnish_villa: async () => {
    const v = villas.find((x) => !x.bed)
    if (!v) return 'every villa already has a bed'
    const origin = new Vec3(v.origin.x, v.origin.y, v.origin.z)
    await deadline(bot.pathfinder.goto(new goals.GoalNear(origin.x + 4, origin.y + 1, origin.z + 3, 2)), 90000)
    const r = await require('./village').furnishVilla(bot, { ACTIONS, inventory, deadline, mcData: () => mcData }, origin)
    v.bed = !!r.bed; saveState()
    return v.bed ? `bed placed in villa at ${origin}` : 'still no bed (need 3 matching wool + planks)'
  },
  harvest_wheat: async () => require('./village').harvestWheat(bot, { inventory, deadline, mcData: () => mcData }, { center: village ?? bot.entity.position }),
  feed_villagers: async () => {
    if ((inventory().bread || 0) < 3 && (inventory().wheat || 0) >= 3) await ACTIONS.craft({ item: 'bread', count: Math.floor(inventory().wheat / 3) })
    return require('./village').feedVillagers(bot, { inventory, deadline, mcData: () => mcData }, { center: village ?? bot.entity.position })
  },
  // build a small house next to the bot: level the plot, floor, walls (doorway + windows), roof, door, torches
  build_house: async ({ size = 7, walls = 3, material = 'cobblestone' }) => {
    const mat = itemByName(material).id
    const o = bot.entity.position.floored()
    const x0 = o.x + 2, z0 = o.z - Math.floor(size / 2), y0 = o.y // footprint starts 2 blocks east of the bot
    const mid = Math.floor(size / 2)
    const edge = (dx, dz) => dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1
    const isDoor = (dx, dz, h) => dx === 0 && dz === mid && h < 2 // west wall, facing where the bot stood
    const isWindow = (dx, dz, h) => h === 1 && ((dz === 0 || dz === size - 1) && dx === mid || dx === size - 1 && dz === mid)
    const P = (dx, h, dz) => new Vec3(x0 + dx, y0 + h, z0 + dz)
    const stats = { dug: 0, placed: 0, failed: 0 }
    const need = size * size * 2 + 4 * (size - 1) * walls
    if ((inventory()[material] || 0) < need * 0.8) throw new Error(`need ~${need} ${material}, have ${inventory()[material] || 0}`)
    bot.camera?.set('wide', 900, new Vec3(x0 + size / 2, y0 + walls / 2, z0 + size / 2)) // orbit the house, not the bot
    bot.chat(`Building a ${size}x${size} house. Watch this.`)

    const digAt = async (p) => {
      const b = bot.blockAt(p)
      if (!b || b.boundingBox !== 'block') return
      try {
        await deadline(bot.pathfinder.goto(new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 })), 20000)
        await bot.tool.equipForBlock(b, {}); await deadline(bot.dig(b, true), 15000); stats.dug++
      } catch { stats.failed++ }
    }
    const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map((f) => new Vec3(...f))
    const placeAt = async (p, id = mat) => {
      if (bot.blockAt(p)?.boundingBox === 'block') return
      const f = FACES.find((f) => bot.blockAt(p.plus(f))?.boundingBox === 'block')
      if (!f) { stats.failed++; return }
      try {
        await deadline(bot.pathfinder.goto(new goals.GoalPlaceBlock(p, bot.world, { range: 4.5 })), 20000).catch(() =>
          deadline(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3)), 15000))
        const me = bot.entity.position.floored()
        if (me.equals(p) || me.offset(0, 1, 0).equals(p)) { stats.failed++; return } // standing in the spot
        await bot.equip(id, 'hand')
        await bot.placeBlock(bot.blockAt(p.plus(f)), f.scaled(-1)); stats.placed++
      } catch { stats.failed++ }
    }
    const cells = []
    for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) cells.push([dx, dz])

    // 1. clear the plot, top layer first
    for (let h = walls; h >= 0; h--) for (const [dx, dz] of cells) await digAt(P(dx, h, dz))
    // 2. floor
    for (const [dx, dz] of cells) await placeAt(P(dx, -1, dz))
    bot.chat('Foundation down.')
    // 3. walls, layer by layer
    for (let h = 0; h < walls; h++) for (const [dx, dz] of cells) if (edge(dx, dz) && !isDoor(dx, dz, h) && !isWindow(dx, dz, h)) await placeAt(P(dx, h, dz))
    bot.chat('Walls up.')
    // 4. roof from the edges inward so every block has something to stick to
    const ring = ([dx, dz]) => Math.min(dx, dz, size - 1 - dx, size - 1 - dz)
    for (const c of cells.slice().sort((a, b) => ring(a) - ring(b))) await placeAt(P(c[0], walls, c[1]))
    bot.chat('Roof on.')
    // 5. door + torches
    try {
      if (!inventory().oak_door) {
        if ((inventory().oak_planks || 0) < 6 && inventory().oak_log) await ACTIONS.craft({ item: 'oak_planks', count: 2 })
        await ACTIONS.craft({ item: 'oak_door' })
      }
      await placeAt(P(0, 0, mid), itemByName('oak_door').id)
    } catch { stats.failed++ }
    try {
      if (!inventory().torch && inventory().coal && inventory().stick) await ACTIONS.craft({ item: 'torch' })
      if (inventory().torch) { await placeAt(P(1, 0, 1), itemByName('torch').id); await placeAt(P(size - 2, 0, size - 2), itemByName('torch').id) }
    } catch {}
    bot.camera?.set('auto')
    home = new Vec3(x0 + mid, y0, z0 + mid); saveState()
    bot.chat(`House done! ${stats.placed} blocks placed.`)
    return `house at x=${x0}..${x0 + size - 1} z=${z0}..${z0 + size - 1} y=${y0}. ${JSON.stringify(stats)}`
  },
  equip: async ({ item, dest = 'hand' }) => { await bot.equip(itemByName(item).id, dest); return `equipped ${item}` },
  attack: async ({ target }) => {
    const e = bot.nearestEntity((e) => e !== bot.entity && (e.name === target || e.username === target))
    if (!e) throw new Error(`no ${target} nearby`)
    for (let i = 0; i < 20 && e.isValid; i++) {
      if (bot.entity.position.distanceTo(e.position) > 3) await bot.pathfinder.goto(new goals.GoalFollow(e, 2)).catch(() => {})
      await bot.lookAt(e.position.offset(0, e.height * 0.8, 0))
      bot.attack(e)
      await bot.waitForTicks(12)
    }
    return e.isValid ? `${target} still alive` : `killed ${target}`
  },
  eat: async ({ item }) => {
    const food = item ? bot.inventory.items().find((i) => i.name === item)
      : bot.inventory.items().find((i) => mcData.foodsByName?.[i.name])
    if (!food) throw new Error('no food in inventory')
    await bot.equip(food, 'hand'); await bot.consume()
    return `ate ${food.name}. food=${bot.food}`
  },
  look: async ({ x, y, z }) => { await bot.lookAt(new Vec3(x, y, z)); return 'looking' },
  sleep: async () => { const bed = bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 8 }); if (!bed) throw new Error('no bed within 8 blocks'); await bot.sleep(bed); return 'sleeping' },
  // escape hatch: run arbitrary JS with bot, mcData, goals, Vec3 in scope
  eval: async ({ code }) => {
    // legit: eval is for reading state and chaining normal player inputs, not moving/flying the body by hand
    if (LEGIT && /creative|\bentity\.(position|velocity)\s*(\.(set|add|translate|[xyz])\b\s*[-+*/]?=?|=)|\.velocity\.[xyz]\s*[-+*/]?=|physicsEnabled\s*=(?!=)|_client\.write|game\.gameMode\s*=(?!=)/.test(String(code))) {
      throw new Error('eval blocked: that would move/teleport/fly the body or change game mode - not allowed in legit survival')
    }
    const fn = new Function('bot', 'mcData', 'goals', 'Vec3', 'inventory', `return (async () => { ${code} })()`)
    const r = await fn(bot, mcData, goals, Vec3, inventory)
    return r === undefined ? 'ok' : r
  },
}
function deadline(promise, ms) {
  let t
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => { bot.pathfinder.setGoal(null); rej(new Error('timed out')) }, ms) })])
    .finally(() => clearTimeout(t))
}

function withTimeout(promise, secs) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(`still running after ${secs}s (continuing in background)`), secs * 1000))])
}

http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)) }
  try {
    if (!mcData) return send(503, { error: 'bot not spawned yet' })
    if (req.method === 'GET' && req.url === '/state') return send(200, state())
    if (req.method === 'POST' && req.url === '/act') {
      let raw = ''; for await (const c of req) raw += c
      const { action, timeout = 300, ...args } = JSON.parse(raw)
      if (!ACTIONS[action]) return send(400, { error: `unknown action ${action}`, actions: Object.keys(ACTIONS) })
      const entry = logAction({ action: action === 'eval' ? 'script' : action, args: action === 'eval' ? { doing: lastThink || 'custom script' } : args, status: 'running' })
      if (action === 'eval') entry.code = String(args.code).trim().slice(0, 400) // kept for debugging, not shown
      const quick = ['autopilot', 'goal', 'camera', 'chat', 'think'].includes(action) // these don't pause the autopilot
      if (!quick) { manualBusy++; if (autopilot?.status().running) bot.pathfinder.setGoal(null) }
      const run = Promise.resolve().then(() => ACTIONS[action](args))
      run.then((r) => { entry.status = 'ok'; entry.result = (typeof r === 'string' ? r : JSON.stringify(r) ?? '').slice(0, 200) },
        (e) => { entry.status = 'error'; entry.result = e.message })
        .finally(() => { if (!quick) manualBusy-- })
      const result = await withTimeout(run, timeout)
      return send(200, { ok: true, result, pos: round(bot.entity.position), health: bot.health, food: bot.food })
    }
    send(404, { error: 'GET /state or POST /act', actions: Object.keys(ACTIONS) })
  } catch (e) {
    send(200, { ok: false, error: e.message, pos: round(bot.entity.position) })
  }
}).listen(API_PORT, '127.0.0.1')
