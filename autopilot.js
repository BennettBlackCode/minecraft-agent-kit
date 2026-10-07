// Autopilot: a fast decision loop so the player keeps playing between prompts.
// Each tick: rules decide which tasks make sense right now -> Cloudflare's Clef-flash decision model picks
// one from a plain-English game state -> the task runs -> repeat. the player (the strategist) sets `goal`,
// which Clef sees; manual /act commands pause the loop until they finish.
const { goals } = require('mineflayer-pathfinder')
const V = require('./village')

const MODEL = process.env.CLEF_MODEL || '@cf/cloudflare/clef-flash'
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit']
const RAW_SMELTABLE = ['raw_iron', 'raw_gold', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit']
const ARMOR = [['iron_helmet', 'head', 5], ['iron_chestplate', 'torso', 6], ['iron_leggings', 'legs', 7], ['iron_boots', 'feet', 8]]

module.exports = (bot, ctx) => {
  // ctx: { ACTIONS, inventory, deadline, getGoal, isManualBusy, log, mcData }
  const ap = { enabled: false, running: null, recent: [], cooldown: {}, lastDecision: null, visited: [] }
  const count = (re) => Object.entries(ctx.inventory()).filter(([n]) => re.test(n)).reduce((s, [, c]) => s + c, 0)
  const has = (name) => (ctx.inventory()[name] || 0) > 0
  const nearestMob = (r) => bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < r)
  const nearestAnimal = (r) => bot.nearestEntity((e) => FOOD_ANIMALS.includes(e.name) && e.position.distanceTo(bot.entity.position) < r)
  const findBlock = (names, r = 32) => bot.findBlock({ matching: names.map((n) => ctx.mcData().blocksByName[n]?.id).filter(Boolean), maxDistance: r })
  const isFood = (n) => ctx.mcData().foodsByName[n] && !/rotten|spider_eye|poisonous/.test(n)

  async function ensureStation(name) { // crafting_table / furnace within reach, placing or crafting one if needed
    if (findBlock([name], 24)) return
    if (!has(name)) {
      if (name === 'furnace') await ensureStation('crafting_table')
      else if (count(/_planks$/) < 4) await ctx.ACTIONS.craft({ item: plankFor(), count: 1 })
      await ctx.ACTIONS.craft({ item: name })
    }
    await ctx.ACTIONS.place({ item: name })
  }
  const plankFor = () => (Object.keys(ctx.inventory()).find((n) => n.endsWith('_log')) || 'oak_log').replace('_log', '_planks')
  // luxury-village helpers
  const village = () => ctx.getVillage?.()
  const villas = () => ctx.getVillas?.() ?? []
  const building = () => !!village() && villas().length < V.MAX_VILLAS
  const nearVillage = (r = 96) => village() && bot.entity.position.distanceTo(village()) < r
  const fuel = () => count(/^(coal|charcoal)$/)
  const woolPile = () => Math.max(0, ...Object.entries(ctx.inventory()).filter(([n]) => /_wool$/.test(n)).map(([, c]) => c))
  const needBed = () => villas().some((v) => !v.bed)
  const furnaceReady = () => has('furnace') || findBlock(['furnace'], 24) || count(/^cobblestone$/) >= 8

  function craftable(item) {
    const id = ctx.mcData().itemsByName[item]?.id
    return id !== undefined && bot.recipesFor(id, null, 1, true).length > 0
  }
  const wornIn = (slot) => bot.inventory.slots[slot]
  const anyPick = () => count(/_pickaxe$/) > 0
  function gearWanted() {
    const want = []
    if (!anyPick() && craftable('wooden_pickaxe')) want.push('wooden_pickaxe')
    if (!has('stone_pickaxe') && !has('iron_pickaxe') && !has('diamond_pickaxe') && craftable('stone_pickaxe')) want.push('stone_pickaxe')
    if (!count(/_sword$/) && craftable('stone_sword')) want.push('stone_sword')
    else if (!count(/_sword$/) && craftable('wooden_sword')) want.push('wooden_sword')
    if (!count(/_axe$/) && craftable('stone_axe')) want.push('stone_axe')
    for (const [item, , slot] of ARMOR) if (!wornIn(slot) && !has(item) && craftable(item)) want.push(item)
    if (!has('diamond_pickaxe') && craftable('diamond_pickaxe')) want.push('diamond_pickaxe')
    if (!has('diamond_sword') && craftable('diamond_sword')) want.push('diamond_sword')
    if (!has('iron_pickaxe') && !has('diamond_pickaxe') && craftable('iron_pickaxe')) want.push('iron_pickaxe')
    if (!has('shield') && craftable('shield')) want.push('shield')
    if (count(/^torch$/) < 16 && has('coal') && craftable('torch')) want.push('torch')
    return want
  }

  // ---- tasks: when they make sense (gate), how Clef sees them (desc), and what they do (run) ----
  const TASKS = {
    fight: {
      desc: 'Attack the hostile mob that is close by (the player is healthy and armed).',
      gate: () => nearestMob(12) && bot.health > 8,
      run: async () => ctx.ACTIONS.attack({ target: nearestMob(12).name }),
    },
    flee: {
      desc: 'Run away from hostile mobs because health is low or there are too many.',
      gate: () => nearestMob(16) && (bot.health <= 10 || countMobs(12) >= 3),
      run: async () => {
        const mob = nearestMob(16)
        await ctx.deadline(bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalFollow(mob, 20))), 10000).catch(() => {})
        return 'got some distance'
      },
    },
    eat: {
      desc: 'Eat food from the inventory because hunger is getting low.',
      gate: () => (bot.food < 18 && bot.inventory.items().some((i) => isFood(i.name))) || (bot.food <= 4 && has('rotten_flesh')),
      run: async () => ctx.ACTIONS.eat(bot.inventory.items().some((i) => isFood(i.name)) ? {} : { item: 'rotten_flesh' }),
    },
    hunt: {
      desc: 'Kill a nearby food animal (cow, pig, sheep, chicken) to get food.',
      gate: () => nearestAnimal(32) && bot.inventory.items().filter((i) => isFood(i.name)).reduce((s, i) => s + i.count, 0) < 10,
      run: async () => {
        const a = nearestAnimal(32)
        const r = await ctx.ACTIONS.attack({ target: a.name })
        // collect what it dropped where it actually died (a.position is its last known spot)
        await bot.waitForTicks(10)
        const loot = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(a.position) < 5)
        for (const d of loot) await ctx.deadline(bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5)), 6000).catch(() => {})
        return `${r}; picked up ${loot.length} drops`
      },
    },
    gather_wood: {
      desc: 'Chop trees for wood (needed for crafting tables, sticks, tools, torches).',
      gate: () => count(/_log$/) + count(/_planks$/) / 4 < (building() ? 40 : 8) && findBlock(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'], 48),
      run: async () => ctx.ACTIONS.collect({ block: 'oak_log,birch_log,spruce_log,jungle_log,acacia_log,dark_oak_log,cherry_log,mangrove_log', count: 6 }),
    },
    mine_coal: {
      desc: 'Mine coal ore for fuel and torches.',
      gate: () => anyPick() && count(/^coal$/) < (building() ? 28 : 16) && findBlock(['coal_ore', 'deepslate_coal_ore']),
      run: async () => ctx.ACTIONS.collect({ block: 'coal_ore,deepslate_coal_ore', count: 8 }),
    },
    mine_iron: {
      desc: 'Mine iron ore to make armor and tools.',
      gate: () => (has('stone_pickaxe') || has('iron_pickaxe') || has('diamond_pickaxe')) && count(/^(iron_ingot|raw_iron)$/) < 24 && findBlock(['iron_ore', 'deepslate_iron_ore']),
      run: async () => ctx.ACTIONS.collect({ block: 'iron_ore,deepslate_iron_ore', count: 8 }),
    },
    mine_diamond: {
      desc: 'Mine the diamond ore that is visible nearby. Diamonds are the most valuable resource.',
      gate: () => (has('iron_pickaxe') || has('diamond_pickaxe')) && findBlock(['diamond_ore', 'deepslate_diamond_ore']),
      run: async () => ctx.ACTIONS.collect({ block: 'diamond_ore,deepslate_diamond_ore', count: 4 }),
    },
    mine_gold: {
      desc: 'Mine gold ore (useful for bartering with piglins in the Nether).',
      gate: () => has('iron_pickaxe') && count(/^(gold_ingot|raw_gold)$/) < 12 && findBlock(['gold_ore', 'deepslate_gold_ore']),
      run: async () => ctx.ACTIONS.collect({ block: 'gold_ore,deepslate_gold_ore', count: 6 }),
    },
    smelt: {
      desc: 'Smelt raw ores or raw meat in a furnace using coal.',
      gate: () => (has('coal') || has('charcoal') || count(/_planks$|_log$/) > 0) && RAW_SMELTABLE.some(has) && (has('furnace') || findBlock(['furnace'], 24) || count(/^cobblestone$/) >= 8),
      run: async () => {
        const item = RAW_SMELTABLE.find(has)
        await ensureStation('furnace')
        return ctx.ACTIONS.smelt({ item, count: Math.min(ctx.inventory()[item], 16) })
      },
    },
    craft_gear: {
      desc: 'Craft better gear (armor, diamond tools, shield, torches) and put armor on.',
      gate: () => gearWanted().length > 0 || (!anyPick() && count(/_log$/) + count(/_planks$/) / 4 >= 3) || ARMOR.some(([item, , slot]) => has(item) && !wornIn(slot)) || (has('shield') && bot.inventory.slots[45]?.name !== 'shield'),
      run: async () => {
        const made = []
        if (count(/_planks$/) < 8 && count(/_log$/) > 0) await ctx.ACTIONS.craft({ item: plankFor(), count: 2 }).catch(() => {})
        if (count(/^stick$/) < 4 && count(/_planks$/) >= 2) await ctx.ACTIONS.craft({ item: 'stick', count: 2 }).catch(() => {})
        for (const item of gearWanted()) {
          await ensureStation('crafting_table')
          try { await ctx.ACTIONS.craft({ item, count: item === 'torch' ? 4 : 1 }); made.push(item) } catch {}
        }
        for (const [item, dest] of ARMOR) if (has(item)) await bot.equip(ctx.mcData().itemsByName[item].id, dest).catch(() => {})
        if (has('shield') && bot.inventory.slots[45]?.name !== 'shield') await bot.equip(ctx.mcData().itemsByName.shield.id, 'off-hand').catch(() => {})
        return made.length ? `crafted ${made.join(', ')}` : 'equipped armor'
      },
    },
    go_deeper: {
      desc: 'Dig down toward diamond level (y = -58) to look for diamonds. Good when geared up with an iron pickaxe.',
      gate: () => has('iron_pickaxe') && bot.entity.position.y > -50 && bot.game.dimension.includes('overworld'),
      run: async () => {
        const y = Math.max(-58, Math.floor(bot.entity.position.y) - 16)
        await ctx.deadline(bot.pathfinder.goto(new goals.GoalY(y)), 60000)
        return `now at y=${Math.round(bot.entity.position.y)}`
      },
    },
    climb_up: {
      desc: 'Dig a staircase upward about 10 blocks, toward the surface (only when deep underground).',
      gate: () => !outdoors() && bot.entity.position.y < 70 && !(ctx.getHome() && bot.entity.position.distanceTo(ctx.getHome()) < 12),
      run: async () => ctx.ACTIONS.stairs_up({ steps: 10 }),
    },
    mine_stone: {
      desc: 'Mine stone for cobblestone (stone tools, furnace, and building material for a house).',
      gate: () => anyPick() && count(/^(cobblestone|stone)$/) < (building() ? 175 : ctx.getHome() ? 32 : 190) && findBlock(['stone'], 48),
      run: async () => ctx.ACTIONS.collect({ block: 'stone', count: 16 }),
    },
    build_house: {
      desc: 'Build a cobblestone house here (a safe home base for nights). Needs about 170 cobblestone.',
      gate: () => !ctx.getHome() && !village() && count(/^cobblestone$/) >= 140 && bot.time.isDay && bot.game.dimension.includes('overworld'),
      run: async () => ctx.ACTIONS.build_house({}),
    },
    go_home: {
      desc: "It's night: walk back home to the house where it's safe.",
      gate: () => !bot.time.isDay && ctx.getHome() && bot.entity.position.distanceTo(ctx.getHome()) > 3 && bot.game.dimension.includes('overworld'),
      run: async () => {
        const h = ctx.getHome()
        await ctx.deadline(bot.pathfinder.goto(new goals.GoalNear(h.x, h.y, h.z, 1)), 90000)
        return 'home'
      },
    },
    wait_for_day: {
      desc: "It's night and the player is safe at home: wait inside until morning.",
      gate: () => !bot.time.isDay && ctx.getHome() && bot.entity.position.distanceTo(ctx.getHome()) <= 3,
      run: async () => { await bot.waitForTicks(200); return `waiting (time ${bot.time.timeOfDay})` },
    },
    // ---- the luxury village: everything gathered, crafted and placed by hand ----
    find_village: {
      desc: 'Explore far and wide to find a natural village (villagers and a bell). The luxury village gets built right beside it.',
      gate: () => !village() && anyPick() && foodCount() >= 4 && bot.game.dimension.includes('overworld'),
      timeoutMs: 10 * 60000,
      run: async () => ctx.ACTIONS.find_village({ steps: 6 }),
    },
    gather_sand: {
      desc: 'Dig sand. It smelts into glass for the big glass walls of the modern villas.',
      gate: () => building() && count(/^(sand|glass)$/) < 40 && findBlock(['sand'], 64),
      run: async () => ctx.ACTIONS.collect({ block: 'sand', count: 16 }),
    },
    smelt_glass: {
      desc: 'Smelt sand into glass in a furnace (glass walls and windows for the villas).',
      gate: () => building() && count(/^sand$/) >= 8 && count(/^glass$/) < 40 && (fuel() >= 2 || count(/_log$|_planks$/) >= 8) && furnaceReady(),
      timeoutMs: 8 * 60000,
      run: async () => { await ensureStation('furnace'); return ctx.ACTIONS.smelt({ item: 'sand', count: Math.min(ctx.inventory().sand, 24) }) },
    },
    smelt_stone: {
      desc: 'Smelt cobblestone into smooth stone for clean modern walls and roofs.',
      gate: () => building() && count(/^cobblestone$/) >= 24 && count(/^stone$/) < 160 && fuel() >= 4 && furnaceReady(),
      timeoutMs: 8 * 60000,
      run: async () => { await ensureStation('furnace'); return ctx.ACTIONS.smelt({ item: 'cobblestone', count: Math.min(ctx.inventory().cobblestone - 8, 24) }) },
    },
    build_villa: {
      desc: 'Build a modern luxury villa next to the village, every block by hand: glass walls, flat stone roof, bed for a villager.',
      gate: () => building() && bot.time.isDay && V.shoppingList(ctx.inventory()).length === 0 && bot.game.dimension.includes('overworld'),
      timeoutMs: 60 * 60000,
      run: async () => ctx.ACTIONS.build_villa({}),
    },
    get_wool: {
      desc: 'Kill a sheep for wool: 3 matching wool + 3 planks make a bed, so a villager can move into a villa.',
      gate: () => needBed() && woolPile() < 3 && !count(/_bed$/) && bot.nearestEntity((e) => e.name === 'sheep' && e.position.distanceTo(bot.entity.position) < 32),
      run: async () => {
        const sheep = bot.nearestEntity((e) => e.name === 'sheep' && e.position.distanceTo(bot.entity.position) < 32)
        const r = await ctx.ACTIONS.attack({ target: 'sheep' })
        await bot.waitForTicks(10)
        for (const d of drops().filter((e) => e.position.distanceTo(sheep.position) < 6)) await ctx.deadline(bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5)), 6000).catch(() => {})
        return `${r}; wool now ${woolPile()}`
      },
    },
    furnish_villa: {
      desc: 'Put a bed (and a composter job block) into a finished villa so a villager can move in.',
      gate: () => needBed() && (count(/_bed$/) > 0 || (woolPile() >= 3 && count(/_planks$|_log$/) >= 3)),
      timeoutMs: 5 * 60000,
      run: async () => ctx.ACTIONS.furnish_villa({}),
    },
    harvest_wheat: {
      desc: "Harvest ripe wheat from the village farms (and replant it) to bake bread for the villagers.",
      gate: () => nearVillage() && villas().some((v) => v.bed) && count(/^bread$/) + count(/^wheat$/) / 3 < 9 && bot.findBlock({ matching: (b) => b.name === 'wheat' && b.getProperties().age === 7, maxDistance: 48 }),
      timeoutMs: 5 * 60000,
      run: async () => ctx.ACTIONS.harvest_wheat({}),
    },
    feed_villagers: {
      desc: 'Give bread to the villagers. Well-fed villagers with free beds nearby breed and fill the new villas.',
      gate: () => nearVillage(64) && villas().some((v) => v.bed) && (count(/^bread$/) >= 3 || count(/^wheat$/) >= 3) && V.villagersNear(bot, bot.entity.position, 48).length > 0,
      timeoutMs: 4 * 60000,
      run: async () => ctx.ACTIONS.feed_villagers({}),
    },
    explore: {
      desc: 'Travel about 60 blocks somewhere new (unvisited direction) to find animals, trees, caves or ores.',
      gate: () => true,
      run: async () => {
        const p = bot.entity.position.clone()
        ap.visited.push({ x: p.x, z: p.z }); if (ap.visited.length > 40) ap.visited.shift()
        // pick the direction whose target is farthest from everywhere we've already been
        let best = null
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + Math.random() * 0.3
          const t = { x: p.x + Math.cos(a) * 60, z: p.z + Math.sin(a) * 60 }
          const novelty = Math.min(...ap.visited.map((v) => Math.hypot(v.x - t.x, v.z - t.z)))
          if (!best || novelty > best.novelty) best = { ...t, novelty }
        }
        await ctx.deadline(bot.pathfinder.goto(new goals.GoalXZ(best.x, best.z)), 60000).catch(() => {})
        const moved = Math.round(bot.entity.position.distanceTo(p))
        const seen = Object.values(bot.entities).filter((e) => FOOD_ANIMALS.includes(e.name) && e.position.distanceTo(bot.entity.position) < 32).map((e) => e.name)
        if (moved < 5) throw new Error('could not get anywhere in that direction')
        return `travelled ${moved} blocks to ${bot.entity.position.floored()}${seen.length ? `; animals nearby: ${[...new Set(seen)].join(', ')}` : ''}`
      },
    },
  }
  // ---- micro buttons for task mode, written verb:target (target may be a|b alternatives) ----
  //   go_to:oak_log  break:oak_log|birch_log  pickup  craft:oak_planks  place:oak_sapling  done  (+ any TASKS name)
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const ids = (names) => names.split('|').map((n) => ctx.mcData().blocksByName[n]?.id).filter((x) => x !== undefined)
  const inReach = (names) => bot.findBlocks({ matching: ids(names), maxDistance: 6, count: 40 }).map((p) => bot.blockAt(p))
    .filter((b) => b && b.position.offset(0.5, 0.5, 0.5).distanceTo(eye()) <= 4.5).sort((a, b) => a.position.y - b.position.y)
  const drops = () => Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 10)
  function micro(button) {
    if (TASKS[button]) return TASKS[button]
    const [verb, arg = ''] = button.split(':')
    const pretty = arg.replace(/\|/g, ' or ').replace(/_/g, ' ')
    switch (verb) {
      case 'go_to': return {
        desc: `Walk to the nearest ${pretty} (use when none is within reach).`,
        gate: () => !inReach(arg).length && findBlock(arg.split('|'), 48),
        run: async () => {
          const b = findBlock(arg.split('|'), 48)
          await ctx.deadline(bot.pathfinder.goto(new goals.GoalLookAtBlock(b.position, bot.world, { reach: 4 })), 30000)
          return `walked to ${b.name} at ${b.position}`
        },
      }
      case 'break': return {
        desc: `Break a ${pretty} block that is within reach right now (it drops on the ground and must be picked up to count).`,
        gate: () => inReach(arg).length > 0,
        run: async () => {
          const b = inReach(arg)[0]
          await bot.tool.equipForBlock(b, {}); await ctx.deadline(bot.dig(b, true), 15000)
          return `broke ${b.name}`
        },
      }
      case 'pickup': return {
        desc: 'Walk over the dropped items lying on the ground nearby to pick them up into the inventory.',
        gate: () => drops().length > 0,
        run: async () => {
          for (const d of drops().slice(0, 6)) await ctx.deadline(bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.8)), 6000).catch(() => {})
          return 'picked up items'
        },
      }
      case 'craft': return { desc: `Craft ${pretty}.`, gate: () => craftable(arg), run: () => ctx.ACTIONS.craft({ item: arg }) }
      case 'place': return { desc: `Place a ${pretty} next to the player.`, gate: () => has(arg), run: () => ctx.ACTIONS.place({ item: arg }) }
      case 'done': return { desc: 'Stop pressing buttons: the task is finished.', gate: () => true, run: async () => 'done', done: true }
    }
    return null
  }
  // until="oak_log|birch_log>=12" or "*_log>=12": inventory target that ends the task
  function untilCheck(until) {
    const m = String(until).match(/^([\w|*]+)\s*>=\s*(\d+)$/)
    if (!m) throw new Error(`bad until "${until}" (use e.g. oak_log>=12 or *_log>=12)`)
    const res = m[1].split('|').map((a) => new RegExp('^' + a.replace(/\*/g, '.*') + '$'))
    const have = () => Object.entries(ctx.inventory()).filter(([n]) => res.some((r) => r.test(n))).reduce((t, [, c]) => t + c, 0)
    return { have, want: Number(m[2]), label: m[1] }
  }

  const outdoors = () => (bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.skyLight ?? 0) >= 14
  // hard checks for task mode, so Clef doesn't have to guess when some tasks are finished
  const DONE = { surface: outdoors, daytime: () => bot.time.isDay, fed: () => bot.food >= 18 }
  const countMobs = (r) => Object.values(bot.entities).filter((e) => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < r).length

  function describe(options, task, extra = []) {
    const s = bot.entity.position
    const inv = Object.entries(ctx.inventory()).map(([n, c]) => `${n} x${c}`).join(', ') || 'empty'
    const armor = ARMOR.filter(([, , slot]) => wornIn(slot)).map(([n]) => n).join(', ') || 'none'
    const mobs = Object.values(bot.entities).filter((e) => e !== bot.entity && e.type !== 'object' && e.type !== 'orb' && e.position.distanceTo(s) < 24)
      .map((e) => `${e.name || e.username} (${Math.round(e.position.distanceTo(s))}m${e.type === 'hostile' ? ', hostile' : ''})`).slice(0, 8).join(', ') || 'none'
    const sky = outdoors() ? 'outdoors (open sky)' : 'underground / under cover'
    return [
      task ? `Minecraft survival. The player's CURRENT TASK: ${task}. (Long-term goal: ${ctx.getGoal() || 'beat Minecraft in legit survival: gear up, reach the Nether, find a stronghold, kill the Ender Dragon'}.)`
        : `Minecraft survival. The player's long-term goal: ${ctx.getGoal() || 'beat Minecraft in legit survival: gear up, reach the Nether, find a stronghold, kill the Ender Dragon'}.`,
      `Health ${Math.round(bot.health)}/20, hunger ${bot.food}/20. ${bot.time.isDay ? 'Daytime' : 'Night'}, ${sky}, y=${Math.round(s.y)}, ${bot.game.dimension}.`,
      `Holding ${bot.heldItem?.name || 'nothing'}. Armor worn: ${armor}.`,
      `Inventory: ${inv}.`,
      `Nearby creatures: ${mobs}.`,
      `Recent tasks: ${ap.recent.slice(-5).map((r) => `${r.task} (${r.ok ? 'ok' : 'failed: ' + r.msg})`).join('; ') || 'none'}.`,
      ...extra,
      `Available ${task ? 'buttons' : 'tasks'} right now: ${options.join(', ')}.`,
    ].join('\n')
  }

  async function askClef(stateText, options, task = null, descs = null) {
    const { CLOUDFLARE_ACCOUNT_ID: acct, CLOUDFLARE_API_TOKEN: token } = process.env
    if (!acct || !token) throw new Error('missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env (see README: Clef setup)')
    const desc = (o) => (descs ?? TASKS)[o].desc
    const criteria = Object.fromEntries(options.map((o) => [o, desc(o)]))
    const t0 = Date.now()
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${MODEL}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL.split('/').pop(),
        state: stateText,
        questions: {
          next: { type: 'choice', instructions: task ? `Which button should the player press next to accomplish the task: ${task}?` : 'What should the player do next to survive and make progress toward the goal?', criteria },
          ...(task ? { done: { type: 'noul', instructions: `Has the player already accomplished this task: ${task}?` } } : {}),
        },
      }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.success === false) throw new Error(`clef ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 500)}`)
    if (!ap.loggedShape) { console.log('clef response shape:', JSON.stringify(body).slice(0, 600)); ap.loggedShape = true }
    // shape: { answers: { next: { type: 'choice', choice: 'fight', probabilities: { fight: 0.8, ... }, confidence } } }
    const answers = (body.result ?? body).answers ?? {}
    const ans = answers.next ?? {}
    const probs = ans.probabilities ?? {}
    let pick = typeof ans.choice === 'string' ? ans.choice : null
    const valid = (k) => !!(descs ?? TASKS)[k]
    if (!valid(pick)) pick = Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0]
    if (!pick || !valid(pick)) throw new Error(`couldn't read clef answer: ${JSON.stringify(ans).slice(0, 200)}`)
    const conf = probs[pick] ?? ans.confidence
    return { pick, conf, ms: Date.now() - t0, done: answers.done?.noul }
  }

  // A normal player's progression. The first unmet objective becomes the goal Clef sees.
  const foodCount = () => bot.inventory.items().filter((i) => isFood(i.name)).reduce((t, i) => t + i.count, 0)
  const OBJECTIVES = [ // only used when the autopilot runs on its own; normally the player (the player) sets the goal
    { goal: 'Punch trees for wood, then craft a crafting table and a wooden pickaxe', done: () => anyPick() },
    { goal: 'Mine stone and craft stone tools (pickaxe, sword, axe)', done: () => has('stone_pickaxe') || has('iron_pickaxe') || has('diamond_pickaxe') },
    { goal: 'Stock up on food: hunt animals and cook the meat in a furnace', done: () => foodCount() >= 8 },
    { goal: 'Get iron armor and an iron sword: mine iron ore, smelt it, craft gear', done: () => ARMOR.every(([, , slot]) => wornIn(slot)) && (has('iron_sword') || has('diamond_sword')) },
    { goal: 'Make 16 torches and gather coal', done: () => count(/^torch$/) >= 16 },
    { goal: 'Mine diamonds (y -58) for a diamond pickaxe', done: () => has('diamond_pickaxe') },
    { goal: 'Build a nether portal and get blaze rods and ender pearls', done: () => count(/^ender_eye$/) >= 12 },
    { goal: 'Find the stronghold, fill the end portal, kill the Ender Dragon', done: () => false },
  ]
  function updateObjective() {
    if (!village() && bot.game.dimension.includes('overworld')) {
      const found = V.detectVillage(bot, ctx.mcData())
      if (found) { ctx.setVillage(found); ctx.log({ action: 'village', args: {}, status: 'ok', result: `found a village at ${found}` }); bot.chat(`Found a village at ${found.x}, ${found.z}!`) }
    }
    const next = OBJECTIVES.find((o) => { try { return !o.done() } catch { return true } })
    const g = next ? next.goal : 'Kill the Ender Dragon'
    if (g !== ctx.getGoal()) { ctx.setGoal(g); ctx.log({ action: 'objective', args: {}, status: 'ok', result: g }); bot.chat(`New objective: ${g}`) }
  }

  // Paced with a plain timer: waitForTicks throws while the bot is dead (no ticks), which used to kill this loop.
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function loop() {
    while (true) {
      try { await loopOnce() } catch (e) {
        ctx.log({ action: 'autopilot', args: {}, status: 'error', result: `loop recovered: ${e.message}` })
        ap.running = null
        await pause(3000)
      }
    }
  }

  async function loopOnce() {
    {
      await pause(1000)
      if (!ap.enabled || !bot.entity || bot.health <= 0 || ctx.isManualBusy()) return
      updateObjective()
      const now = Date.now()
      let options = Object.keys(TASKS).filter((k) => !(ap.cooldown[k] > now) && safeGate(k))
      // survival rules first: starving -> only food-related choices; hurt at night -> get home
      const SURVIVAL = { starving: ['hunt', 'explore', 'smelt', 'eat', 'fight', 'flee'], hurtNight: ['go_home', 'wait_for_day', 'eat', 'fight', 'flee'] }
      const rule = bot.food <= 8 && foodCount() === 0 ? 'starving' : (!bot.time.isDay && bot.health < 10 && ctx.getHome()) ? 'hurtNight' : null
      if (rule) { const f = options.filter((k) => SURVIVAL[rule].includes(k)); if (f.length) options = f }
      let decision
      try {
        decision = options.length === 1 ? { pick: options[0], conf: 1, ms: 0 } : await askClef(describe(options), options)
      } catch (e) {
        ap.lastDecision = { error: e.message }
        ctx.log({ action: 'autopilot', args: {}, status: 'error', result: e.message })
        await pause(5000)
        return
      }
      await step(decision, 'auto', TASKS[decision.pick])
    }
  }

  async function step(decision, tag, btn) {
    ap.lastDecision = decision
    const entry = ctx.log({ action: `${tag}:${decision.pick}`, args: { clef: decision.conf != null ? `${Math.round(decision.conf * 100)}%` : '?', ms: decision.ms }, status: 'running' })
    ap.running = decision.pick
    try {
      const r = await ctx.deadline(btn.run(), btn.timeoutMs ?? 120000)
      entry.status = 'ok'; entry.result = String(r ?? 'done').slice(0, 200)
      ap.recent.push({ task: decision.pick, ok: true })
    } catch (e) {
      entry.status = 'error'; entry.result = e.message
      ap.recent.push({ task: decision.pick, ok: false, msg: e.message.slice(0, 60) })
      const fails = ap.recent.slice(-2).filter((r) => r.task === decision.pick && !r.ok).length
      if (fails >= 2) ap.cooldown[decision.pick] = Date.now() + 90000 // stop retrying something that keeps failing
      bot.pathfinder.setGoal(null)
    }
    if (ap.recent.length > 20) ap.recent.shift()
    ap.running = null
  }

  // Task mode: the player hands Clef one small task + the buttons it may press; Clef presses them until done.
  async function runTask({ task, buttons, steps = 25, done, until }) {
    const btns = {}
    for (const b of buttons) { const m = micro(b); if (m) btns[b.replace(/[^\w]/g, '_')] = { ...m, name: b } }
    if (!Object.keys(btns).length) throw new Error('no valid buttons (use go_to:X break:X pickup craft:X place:X done, or a task name)')
    if (!Object.values(btns).some((b) => b.done)) btns.done = { ...micro('done'), name: 'done' }
    const goal = until ? untilCheck(until) : null
    const pressed = []
    for (let i = 0; i < steps; i++) {
      if (goal && goal.have() >= goal.want) return `DONE: ${goal.label} ${goal.have()}/${goal.want} after ${i} presses (${pressed.join(' > ')})`
      if (done && DONE[done]?.()) return `DONE (${done}) after ${i} presses (${pressed.join(' > ') || 'none needed'})`
      const options = Object.keys(btns).filter((k) => !(ap.cooldown['task:' + k] > Date.now()) && gateOf(btns[k]))
      const extra = []
      for (const b of Object.values(btns)) {
        const [verb, arg] = b.name.split(':')
        if (verb === 'break' || verb === 'go_to') {
          const near = findBlock(arg.split('|'), 48)
          extra.push(`${arg}: ${inReach(arg).length} within reach, nearest ${near ? Math.round(near.position.distanceTo(bot.entity.position)) + 'm away' : 'none within 48m'}.`)
        }
      }
      const dropCounts = {}
      for (const d of drops()) { const it = d.getDroppedItem?.(); if (it) dropCounts[it.name] = (dropCounts[it.name] || 0) + it.count }
      extra.push(`Dropped items lying on the ground within 10m (NOT in inventory until picked up): ${Object.entries(dropCounts).map(([n, c]) => `${n} x${c}`).join(', ') || 'none'}.`)
      if (goal) extra.push(`Progress: ${goal.label} ${goal.have()}/${goal.want}.`)
      const real = options.filter((k) => !btns[k].done)
      if (!real.length) return `stopped: no usable buttons after ${i} presses (${pressed.join(' > ')})`
      const d = options.length === 1 ? { pick: options[0], conf: 1, ms: 0 } // Clef needs 2+ options to choose between
        : await askClef(describe(options, task, extra), options, task, btns)
      if (btns[d.pick].done) return `Clef pressed done (${Math.round((d.conf ?? 0) * 100)}%) after ${i} presses (${pressed.join(' > ')})`
      pressed.push(btns[d.pick].name)
      await step(d, 'clef', btns[d.pick])
      const [a, b] = [ap.recent.at(-1), ap.recent.at(-2)]
      if (a && b && !a.ok && !b.ok && a.task === b.task) ap.cooldown['task:' + d.pick] = Date.now() + 60000 // stop hammering a failing button
    }
    return `ran out of presses (${steps}): ${pressed.join(' > ')}`
  }
  const gateOf = (b) => { try { return !!b.gate() } catch { return false } }

  function safeGate(k) { try { return !!TASKS[k].gate() } catch { return false } }

  loop()
  return {
    set: (on) => { ap.enabled = on; return `autopilot ${on ? 'ON' : 'OFF'} (model ${MODEL})` },
    status: () => ({ enabled: ap.enabled, running: ap.running, last: ap.lastDecision }),
    runTask,
    buttons: () => Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, t.desc])),
  }
}
