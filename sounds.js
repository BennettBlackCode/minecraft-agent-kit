// Official Minecraft sounds for the dashboard. Uses the same asset index + CDN as the Minecraft launcher:
// sound event (e.g. "block.stone.break") -> sounds.json -> random variant .ogg -> cached in cache/objects.
const fs = require('fs')
const path = require('path')

const VERSION_URL = 'https://piston-meta.mojang.com/v1/packages/b547a27fc4d490dc10d62e40a42ace065162b644/1.21.4.json'
const CACHE = path.join(__dirname, 'cache')
let objects = null
let events = null

async function getObject(key) {
  const hash = objects[key]?.hash
  if (!hash) throw new Error(`no asset ${key}`)
  return getHash(hash)
}
async function getHash(hash) {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('bad hash')
  const file = path.join(CACHE, 'objects', hash)
  if (fs.existsSync(file)) return fs.readFileSync(file)
  const res = await fetch(`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`)
  if (!res.ok) throw new Error(`asset ${hash}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  return buf
}

async function load() {
  fs.mkdirSync(CACHE, { recursive: true })
  const idxFile = path.join(CACHE, 'assets-1.21.4.json')
  if (!fs.existsSync(idxFile)) {
    const version = await (await fetch(VERSION_URL)).json()
    fs.writeFileSync(idxFile, await (await fetch(version.assetIndex.url)).text())
  }
  objects = JSON.parse(fs.readFileSync(idxFile, 'utf8')).objects
  events = JSON.parse(await getObject('minecraft/sounds.json'))
}
const ready = load().catch((e) => console.log('sounds unavailable:', e.message))

// event name -> { hash, volume, pitch } for one random variant (null if unknown)
function resolve(name, depth = 0) {
  if (!events || depth > 3) return null
  const ev = events[String(name).replace(/^minecraft:/, '')]
  if (!ev?.sounds?.length) return null
  const pick = ev.sounds[Math.floor(Math.random() * ev.sounds.length)]
  const entry = typeof pick === 'string' ? { name: pick } : pick
  if (entry.type === 'event') return resolve(entry.name, depth + 1)
  const hash = objects[`minecraft/sounds/${entry.name.replace(/^minecraft:/, '')}.ogg`]?.hash
  return hash ? { hash, volume: entry.volume ?? 1, pitch: entry.pitch ?? 1, stream: !!entry.stream } : null
}

// block name -> sound group used by block.<group>.break/hit/step/place
function blockGroup(n = '') {
  if (/deepslate/.test(n)) return 'deepslate'
  if (/_log|_planks|_wood|crafting_table|door|fence|chest|bookshelf|barrel/.test(n)) return 'wood'
  if (/grass_block|leaves|short_grass|tall_grass|fern|vine|hay|moss/.test(n)) return 'grass'
  if (/^(dirt|coarse_dirt|gravel|farmland|clay|rooted_dirt|dirt_path)$/.test(n)) return 'gravel'
  if (/sand/.test(n)) return 'sand'
  if (/snow/.test(n)) return 'snow'
  if (/glass|ice/.test(n)) return 'glass'
  if (/wool|carpet/.test(n)) return 'wool'
  if (/netherrack/.test(n)) return 'netherrack'
  return 'stone'
}

function routes(app) {
  app.get('/sound-file/:hash', async (req, res) => {
    try { await ready; res.set('content-type', 'audio/ogg').set('cache-control', 'max-age=31536000').send(await getHash(req.params.hash)) } catch (e) { res.status(404).end() }
  })
  app.get('/music-pick', async (req, res) => {
    await ready
    const r = resolve(req.query.event || 'music.game')
    r ? res.json({ url: `/sound-file/${r.hash}`, volume: r.volume }) : res.status(404).end()
  })
}

module.exports = { resolve, blockGroup, routes, ready }
