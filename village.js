// Legit luxury village: everything here is done the survival way. the bot digs to clear land, places
// every block by hand from its own inventory, and never uses commands. Villagers come from a real
// village: the villas go up right next to one, and the new beds let its villagers breed into them.
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const W = 9 // villa width (x)
const D = 7 // villa depth (z)
const H = 4 // wall height above the floor
const MAX_VILLAS = 6

// material groups, best first; anything later in a list is an acceptable substitute
const MAT = {
  floor: ['birch_planks', 'oak_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks'],
  wall: ['smooth_stone', 'stone', 'stone_bricks', 'polished_diorite', 'polished_andesite', 'cobblestone'],
  glass: ['glass'],
  pillar: ['dark_oak_log', 'spruce_log', 'birch_log', 'oak_log', 'jungle_log', 'acacia_log', 'cherry_log', 'mangrove_log'],
  roof: ['smooth_stone', 'stone', 'stone_bricks', 'birch_planks', 'oak_planks', 'spruce_planks', 'cobblestone'],
}
// blocks a plot may contain: natural terrain and plants. Anything else (houses, paths, farms) is the
// village's or someone's build, and the plot is skipped.
const NATURAL = /^(air|cave_air|grass_block|dirt|coarse_dirt|rooted_dirt|podzol|stone|granite|diorite|andesite|tuff|sand|red_sand|gravel|clay|snow|snow_block|short_grass|tall_grass|fern|large_fern|dead_bush|sweet_berry_bush|.*_log|.*_leaves|.*_sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|moss_block|moss_carpet|vine|brown_mushroom|red_mushroom)$/

// ---------------------------------------------------------------------------
// Village detection
// ---------------------------------------------------------------------------

function villagersNear(bot, center, r = 64) {
  return Object.values(bot.entities).filter((e) => e.name === 'villager' && e.position.distanceTo(center) < r)
}

// A village is real villagers, or a bell (the meeting point). Returns its centre or null.
function detectVillage(bot, mcData) {
  const me = bot.entity.position
  const people = villagersNear(bot, me, 96)
  const bell = bot.findBlock({ matching: mcData.blocksByName.bell.id, maxDistance: 96 })
  if (bell) return bell.position.offset(0, 0, 0)
  if (people.length >= 2) {
    const c = people.reduce((s, e) => s.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / people.length)
    return c.floored()
  }
  return null
}

// ---------------------------------------------------------------------------
// Villa blueprint (relative to the floor's north-west corner at floor level)
// ---------------------------------------------------------------------------

// Returns the build steps in order: floor, corner pillars, walls, glass, roof with a 1-block overhang,
// door, then furniture. Front (z = 0) faces north toward the village path.
function villaPlan() {
  const steps = []
  const mid = Math.floor(W / 2)
  const edge = (x, z) => x === 0 || z === 0 || x === W - 1 || z === D - 1
  const corner = (x, z) => (x === 0 || x === W - 1) && (z === 0 || z === D - 1)
  const isDoor = (x, z, h) => z === 0 && x === mid && h <= 2
  // big glass panels: two tall windows on the front, a panoramic back wall, a window on each side
  const isGlass = (x, z, h) => h >= 2 && h <= 3 && (
    (z === 0 && (x === 1 || x === 2 || x === W - 3 || x === W - 2)) ||
    (z === D - 1 && x >= 1 && x <= W - 2) ||
    ((x === 0 || x === W - 1) && z >= 2 && z <= D - 3))

  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) steps.push({ x, y: 0, z, kind: 'floor' })
  for (let h = 1; h <= H; h++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    if (!edge(x, z) || isDoor(x, z, h)) continue
    steps.push({ x, y: h, z, kind: corner(x, z) ? 'pillar' : isGlass(x, z, h) ? 'glass' : 'wall' })
  }
  // roof from the walls inward, then the overhang ring outward (each block leans on the one before)
  const roof = []
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) roof.push({ x, y: H + 1, z, kind: 'roof', ring: Math.min(x, z, W - 1 - x, D - 1 - z) })
  roof.sort((a, b) => a.ring - b.ring)
  steps.push(...roof)
  for (let x = -1; x <= W; x++) for (let z = -1; z <= D; z++) {
    if (x >= 0 && x < W && z >= 0 && z < D) continue
    steps.push({ x, y: H + 1, z, kind: 'roof' })
  }
  steps.push({ x: mid, y: 1, z: 0, kind: 'door' })
  steps.push({ x: 1, y: 1, z: D - 2, kind: 'bed' })
  steps.push({ x: W - 2, y: 1, z: D - 2, kind: 'job' })
  steps.push({ x: 1, y: 1, z: 1, kind: 'torch' }, { x: W - 2, y: 1, z: 1, kind: 'torch' })
  return steps
}

function villaNeeds() {
  const need = {}
  for (const s of villaPlan()) if (MAT[s.kind]) need[s.kind] = (need[s.kind] || 0) + 1
  return need // { floor, pillar, wall, glass, roof }
}

// how many of each material group the inventory covers (substitutes count; roof shares wall/planks stock)
function stock(inv, kind) { return MAT[kind].reduce((t, n) => t + (inv[n] || 0), 0) }

// What is still missing for one villa, in plain words, or [] if ready.
function shoppingList(inv) {
  const n = villaNeeds()
  const out = []
  const logs = MAT.pillar.reduce((t, l) => t + (inv[l] || 0), 0)
  const planks = stock(inv, 'floor') + 4 * Math.max(0, logs - n.pillar) // spare logs can become planks
  const stone = stock(inv, 'wall')
  if (logs < n.pillar) out.push(`${n.pillar} logs for pillars (have ${logs})`)
  if (planks < n.floor) out.push(`${n.floor} planks for the floor (have ~${planks} incl. spare logs)`)
  if (stone < n.wall + n.roof) out.push(`${n.wall + n.roof} stone/cobblestone (have ${stone})`)
  if ((inv.glass || 0) < n.glass) out.push(`${n.glass} glass (have ${inv.glass || 0})`)
  return out
}

// ---------------------------------------------------------------------------
// Plot selection: next to the village, on untouched ground
// ---------------------------------------------------------------------------

function groundY(bot, x, z, fromY) {
  for (let y = fromY + 12; y > fromY - 12; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return null
    if (b.boundingBox === 'block' && !/_leaves$|_log$/.test(b.name)) return y
  }
  return null
}

function choosePlot(bot, village, taken) {
  const candidates = []
  for (let r = 22; r <= 52; r += 6) for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2
    candidates.push(new Vec3(Math.round(village.x + Math.cos(a) * r - W / 2), village.y, Math.round(village.z + Math.sin(a) * r - D / 2)))
  }
  let best = null
  for (const o of candidates) {
    if (taken.some((t) => Math.abs(t.x - o.x) < W + 4 && Math.abs(t.z - o.z) < D + 4)) continue
    const heights = []
    let bad = false
    for (let x = -1; x <= W && !bad; x++) for (let z = -1; z <= D && !bad; z++) {
      const gy = groundY(bot, o.x + x, o.z + z, village.y)
      if (gy === null) { bad = true; break }
      heights.push(gy)
      for (let y = gy - 1; y <= gy + 8; y++) {
        const b = bot.blockAt(new Vec3(o.x + x, y, o.z + z))
        if (!b || !NATURAL.test(b.name)) { bad = true; break } // water, paths, farms, houses...
      }
    }
    if (bad) continue
    heights.sort((a, b) => a - b)
    const floorY = heights[Math.floor(heights.length / 2)] + 1
    const work = heights.reduce((t, h) => t + Math.abs(h + 1 - floorY), 0)
    const score = work + o.distanceTo(village) * 0.3
    if (!best || score < best.score) best = { origin: new Vec3(o.x, floorY, o.z), score, spread: heights[heights.length - 1] - heights[0] }
  }
  return best && best.spread <= 5 ? best.origin : null
}

// ---------------------------------------------------------------------------
// Survival builder
// ---------------------------------------------------------------------------

const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map((f) => new Vec3(...f))

function makeBuilder(bot, { deadline, inventory, ACTIONS, mcData }) {
  const stats = { dug: 0, placed: 0, failed: 0, skipped: 0 }
  const solid = (p) => bot.blockAt(p)?.boundingBox === 'block'

  async function digAt(p) {
    const b = bot.blockAt(p)
    if (!b || b.name === 'air' || b.name === 'cave_air') return
    if (b.boundingBox !== 'block' && !/grass|fern|flower|bush|petals|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily|sapling|mushroom|vine|snow$/.test(b.name)) return
    try {
      await deadline(bot.pathfinder.goto(new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 })), 25000)
      await bot.tool.equipForBlock(b, {}).catch(() => {})
      await deadline(bot.dig(bot.blockAt(p), true), 15000); stats.dug++
    } catch { stats.failed++; bot.pathfinder.setGoal(null) }
  }

  async function placeAt(p, names) {
    if (solid(p)) return true
    const inv = inventory()
    const name = names.find((n) => (inv[n] || 0) > 0)
    if (!name) { stats.skipped++; return false }
    const f = FACES.find((f) => solid(p.plus(f)))
    if (!f) { stats.failed++; return false }
    try {
      await deadline(bot.pathfinder.goto(new goals.GoalPlaceBlock(p, bot.world, { range: 4.5 })), 25000).catch(() =>
        deadline(bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3)), 15000))
      const me = bot.entity.position.floored()
      if (me.equals(p) || me.offset(0, 1, 0).equals(p)) { stats.failed++; return false }
      await bot.equip(mcData.itemsByName[name].id, 'hand')
      await bot.placeBlock(bot.blockAt(p.plus(f)), f.scaled(-1)); stats.placed++
      return true
    } catch { stats.failed++; bot.pathfinder.setGoal(null); return false }
  }
  return { digAt, placeAt, stats }
}

// make sure the planks needed exist, crafting them from logs (keeping the pillar logs)
async function preparePlanks(bot, ctx, needPlanks, keepLogs) {
  const inv = ctx.inventory()
  const have = stock(inv, 'floor')
  if (have >= needPlanks) return
  let logs = MAT.pillar.reduce((t, l) => t + (inv[l] || 0), 0) - keepLogs
  const want = Math.ceil((needPlanks - have) / 4)
  for (const log of MAT.pillar) {
    if (logs <= 0) break
    const n = Math.min(inv[log] || 0, want, logs)
    if (n > 0) { await ctx.ACTIONS.craft({ item: log.replace('_log', '_planks'), count: n }).catch(() => {}); logs -= n }
  }
}

async function buildVilla(bot, ctx, { village, taken }) {
  const inv = ctx.inventory()
  const missing = shoppingList(inv)
  if (missing.length) throw new Error(`not enough materials for a villa: need ${missing.join('; ')}`)
  const origin = choosePlot(bot, village, taken)
  if (!origin) throw new Error('no clear, flat, untouched plot next to the village (all candidates hit houses, paths, farms or water)')

  const n = villaNeeds()
  await preparePlanks(bot, ctx, n.floor, n.pillar)
  const { digAt, placeAt, stats } = makeBuilder(bot, ctx)
  const P = (s) => origin.offset(s.x, s.y, s.z)
  const centre = origin.offset(W / 2, 2, D / 2)
  bot.camera?.set('wide', 1800, centre)
  bot.chat(`Building a modern villa next to the village at ${origin.x}, ${origin.z}. All hand-placed.`)

  // 1. clear the site (footprint + overhang ring) from the top down, by hand
  for (let y = H + 1; y >= 0; y--) for (let x = -1; x <= W; x++) for (let z = -1; z <= D; z++) {
    const inside = x >= 0 && x < W && z >= 0 && z < D
    if (inside || y === H + 1) await digAt(origin.offset(x, y, z)) // the overhang ring only needs roof height clear
  }
  // 2. fill any dips under the floor with dirt/cobblestone so it has support
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    const below = origin.offset(x, -1, z)
    if (!bot.blockAt(below) || bot.blockAt(below).boundingBox !== 'block') await placeAt(below, ['dirt', 'cobblestone', 'cobbled_deepslate'])
  }
  bot.chat('Site cleared and levelled.')

  const steps = villaPlan()
  const phase = async (kinds, label) => {
    for (const s of steps.filter((s) => kinds.includes(s.kind))) {
      const names = s.kind === 'roof' ? MAT.roof : MAT[s.kind] ?? []
      // glass ran out -> keep the wall solid rather than leave a hole
      const ok = await placeAt(P(s), names)
      if (!ok && s.kind === 'glass') await placeAt(P(s), MAT.wall)
    }
    if (label) bot.chat(label)
  }
  await phase(['floor'], 'Floor down.')
  await phase(['pillar', 'wall', 'glass'], 'Walls and glass up.')
  await phase(['roof'], 'Flat roof on.')

  // 3. door, bed, job block, torches (crafted if we have the ingredients)
  const furnish = await furnishVilla(bot, ctx, origin, placeAt)
  bot.camera?.set('auto')
  bot.chat(`Villa done: ${stats.placed} blocks placed by hand.${furnish.bed ? ' Bed in - room for a villager.' : ' Needs a bed (wool from sheep).'}`)
  return { origin, bed: furnish.bed, stats }
}

// Door, bed, composter (farmer job site) and torches. Safe to call again later to add a missing bed.
async function furnishVilla(bot, ctx, origin, placeAt) {
  placeAt ??= makeBuilder(bot, ctx).placeAt
  const inv = () => ctx.inventory()
  const mid = Math.floor(W / 2)
  const tryCraft = async (item, count = 1) => ctx.ACTIONS.craft({ item, count }).catch(() => null)
  const plank = () => MAT.floor.find((p) => (inv()[p] || 0) > 0)

  // door
  const doorPos = origin.offset(mid, 1, 0)
  if (!/_door$/.test(bot.blockAt(doorPos)?.name || '')) {
    let door = Object.keys(inv()).find((n) => /_door$/.test(n) && !/iron/.test(n))
    if (!door && plank() && (inv()[plank()] || 0) >= 6) { await tryCraft(plank().replace('_planks', '_door')); door = Object.keys(inv()).find((n) => /_door$/.test(n)) }
    if (door) await placeAt(doorPos, [door])
  }
  // bed: any colour; craft one from 3 matching wool + 3 planks if we can
  const bedPos = origin.offset(1, 1, D - 2)
  let bed = /_bed$/.test(bot.blockAt(bedPos)?.name || '')
  if (!bed) {
    let item = Object.keys(inv()).find((n) => /_bed$/.test(n))
    if (!item) {
      const wool = Object.entries(inv()).find(([n, c]) => /_wool$/.test(n) && c >= 3)
      if (wool && plank()) { await tryCraft(wool[0].replace('_wool', '_bed')); item = Object.keys(inv()).find((n) => /_bed$/.test(n)) }
    }
    if (item) bed = await placeAt(bedPos, [item])
  }
  // composter = farmer's job site (7 wooden slabs)
  const jobPos = origin.offset(W - 2, 1, D - 2)
  if (bot.blockAt(jobPos)?.name !== 'composter') {
    if (!inv().composter && plank()) {
      const slab = plank().replace('_planks', '_slab')
      if ((inv()[slab] || 0) < 7) await tryCraft(slab, 3)
      await tryCraft('composter')
    }
    if (inv().composter) await placeAt(jobPos, ['composter'])
  }
  if (!inv().torch && inv().coal && inv().stick) await tryCraft('torch')
  for (const t of [origin.offset(1, 1, 1), origin.offset(W - 2, 1, 1)]) if (inv().torch) await placeAt(t, ['torch'])
  return { bed }
}

// ---------------------------------------------------------------------------
// Food for breeding: harvest ripe village wheat, replant, bake bread, hand it to villagers
// ---------------------------------------------------------------------------

async function harvestWheat(bot, ctx, { center, max = 24 }) {
  const wheatId = ctx.mcData().blocksByName.wheat.id
  const ripe = bot.findBlocks({ matching: (b) => b.type === wheatId && b.getProperties().age === 7, maxDistance: 64, count: max, point: center })
  let got = 0
  for (const p of ripe) {
    try {
      await ctx.deadline(bot.pathfinder.goto(new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 })), 20000)
      await ctx.deadline(bot.dig(bot.blockAt(p), true), 5000)
      got++
      // replant: the farmland is still there, seeds go back in
      if ((ctx.inventory().wheat_seeds || 0) > 0 && bot.blockAt(p.offset(0, -1, 0))?.name === 'farmland') {
        await bot.equip(ctx.mcData().itemsByName.wheat_seeds.id, 'hand')
        await bot.placeBlock(bot.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0)).catch(() => {})
      }
    } catch { bot.pathfinder.setGoal(null) }
  }
  await bot.waitForTicks(10).catch(() => {})
  if (!got) throw new Error('no ripe wheat near the village right now')
  return `harvested ${got} wheat and replanted`
}

// Villagers pick up bread thrown near them; with free beds nearby, well-fed villagers breed.
async function feedVillagers(bot, ctx, { center }) {
  const people = villagersNear(bot, center, 48)
  if (!people.length) throw new Error('no villagers nearby to feed')
  const bread = ctx.mcData().itemsByName.bread.id
  let given = 0
  for (const v of people.slice(0, 4)) {
    if ((ctx.inventory().bread || 0) < 3) break
    try {
      await ctx.deadline(bot.pathfinder.goto(new goals.GoalNear(v.position.x, v.position.y, v.position.z, 2)), 20000)
      await bot.lookAt(v.position.offset(0, 1.5, 0))
      await bot.toss(bread, null, 3)
      given++
    } catch { bot.pathfinder.setGoal(null) }
  }
  return `tossed bread to ${given} villagers (${people.length} live here)`
}

module.exports = { W, D, MAX_VILLAS, detectVillage, villagersNear, villaNeeds, shoppingList, choosePlot, buildVilla, furnishVilla, harvestWheat, feedVillagers }
