// Watch page: follow-cam 3D view (patched prismarine-viewer client in web/view) + live status panel.
// Based on prismarine-viewer/lib/mineflayer.js, served under /view so the dashboard can live at /.
const path = require('path')
const express = require('express')
const { WorldView } = require('prismarine-viewer/viewer')
const { Vec3 } = require('vec3')

module.exports = (bot, { port, getState, getLog, viewDistance = 6 }) => {
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http, { path: '/view/socket.io' })

  // ---- voice: ./mc think lines are spoken aloud; the dashboard plays the latest one. Default engine is Kokoro, a local
  // open-source model (tts/server.py on :5123, KOKORO_VOICE picks the voice); macOS `say` (TTS_VOICE) is the fallback.
  // TTS_ENGINE=elevenlabs uses elevenlabs.env (private, needs a paid plan for library voices), TTS_ENGINE=say forces
  // the Mac voice, the voice is off unless TTS=on ----
  const fs = require('fs')
  const { execFile } = require('child_process')
  const TTS_DIR = path.join(__dirname, 'cache/tts')
  fs.mkdirSync(TTS_DIR, { recursive: true })
  const eleven = {}
  try { for (const m of fs.readFileSync(path.join(__dirname, 'elevenlabs.env'), 'utf8').matchAll(/^(\w+)=(.*)$/gm)) eleven[m[1]] = m[2].trim() } catch {}
  const ENGINE = process.env.TTS_ENGINE || 'kokoro'
  let voice = null, voiceN = 0
  const synth = async (line) => {
    if (ENGINE === 'kokoro') {
      const r = await fetch('http://127.0.0.1:5123/tts', { method: 'POST', signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json' }, // long lines on a busy machine can take a while
        body: JSON.stringify({ text: line, voice: process.env.KOKORO_VOICE }) })
      if (!r.ok) throw new Error(`kokoro ${r.status} ${(await r.text()).slice(0, 160)}`)
      return { ext: 'wav', data: Buffer.from(await r.arrayBuffer()) }
    }
    if (ENGINE === 'elevenlabs') {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${eleven.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'xi-api-key': eleven.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: line, model_id: eleven.ELEVENLABS_MODEL || 'eleven_flash_v2_5' }) })
      if (!r.ok) throw new Error(`elevenlabs ${r.status} ${(await r.text()).slice(0, 160)}`)
      return { ext: 'mp3', data: Buffer.from(await r.arrayBuffer()) }
    }
    throw new Error('local voice')
  }
  bot.speak = (text) => {
    if (!['1', 'on'].includes(process.env.TTS)) return // off unless TTS=on in .env
    const line = String(text).replace(/\(?-?\d+(\s*,\s*-?\d+){1,2}\)?/g, '').replace(/[_*`#|<>]/g, ' ').replace(/\s+/g, ' ').trim() // coordinates sound awful read aloud
    if (!line) return
    const n = ++voiceN, id = Date.now() // id survives bot restarts, files rotate
    const ready = (file) => { if (n === voiceN) voice = { id, url: `/tts/${file}?${id}` } }
    const local = () => execFile('say', ['-v', process.env.TTS_VOICE || 'Daniel', '-r', '190', '-o', path.join(TTS_DIR, `${n % 20}.wav`), '--file-format=WAVE', '--data-format=LEI16@22050', line],
      { timeout: 20000 }, (err) => { if (!err) ready(`${n % 20}.wav`) })
    if (ENGINE === 'say') return local()
    synth(line).then(({ ext, data }) => { fs.writeFileSync(path.join(TTS_DIR, `${n % 20}.${ext}`), data); ready(`${n % 20}.${ext}`) })
      .catch((e) => { console.log('tts:', e.message); if (e.name !== 'TimeoutError') local() }) // too slow: skip the line rather than switch voices
  }
  app.use('/tts', express.static(TTS_DIR))

  app.use(require('compression')())
  app.get('/api/state', (req, res) => { try { res.json({ ...getState(), camera: bot.camera?.mode(), voice }) } catch (e) { res.status(503).json({ error: e.message }) } })
  app.get('/api/log', (req, res) => res.json(getLog()))
  app.use('/view', express.static(path.join(__dirname, 'web/view')))
  app.use('/', express.static(path.join(__dirname, 'web')))

  // ---- sound: what the bot hears from the server + the bot's own action sounds (the server never sends a
  // player its own dig/step/place sounds - the real client plays those locally - so we generate them) ----
  const sounds = require('./sounds')
  sounds.routes(app)
  const emitSound = (name, pos, volume = 1, pitch = 1) => {
    if (!name || !bot.entity) return
    const r = sounds.resolve(name)
    if (!r) return
    const reach = 16 * Math.max(1, volume)
    const dist = pos ? bot.entity.position.distanceTo(pos) : 0
    if (dist > reach) return
    io.emit('sound', { name, url: `/sound-file/${r.hash}`, gain: Math.min(1, volume) * r.volume * (1 - dist / reach), rate: pitch * r.pitch })
  }
  bot.emitSound = emitSound
  // registry lookup is off by one vs the packet id here (calibrated against nearby zombies/llamas/traders)
  const soundName = (s) => s?.data?.soundName ?? (s?.soundId != null ? bot.registry.sounds?.[s.soundId + 1]?.name : null)
  bot._client.on('sound_effect', (p) => emitSound(p.sound ? soundName(p.sound) : bot.registry.sounds?.[p.soundId + 1]?.name, new Vec3(p.x / 8, p.y / 8, p.z / 8), p.volume, p.pitch))
  bot._client.on('entity_sound_effect', (p) => {
    const e = bot.entities[p.entityId]
    if (e) emitSound(p.sound ? soundName(p.sound) : bot.registry.sounds?.[p.soundId + 1]?.name, e.position, p.volume, p.pitch)
  })
  const groupAt = (pos) => sounds.blockGroup(bot.blockAt(pos)?.name)
  bot.on('diggingCompleted', (b) => emitSound(`block.${sounds.blockGroup(b.name)}.break`, b.position))
  const origPlace = bot.placeBlock.bind(bot)
  bot.placeBlock = async (ref, face) => {
    const r = await origPlace(ref, face)
    const p = ref.position.plus(face); emitSound(`block.${groupAt(p)}.place`, p)
    return r
  }
  const origConsume = bot.consume.bind(bot)
  bot.consume = async (...a) => {
    const t = setInterval(() => emitSound('entity.generic.eat', null, 0.5, 0.9 + Math.random() * 0.2), 260)
    try { return await origConsume(...a) } finally { clearInterval(t); emitSound('entity.player.burp', null, 0.5) }
  }
  let lastHealth = null
  bot.on('health', () => { if (lastHealth != null && bot.health < lastHealth) emitSound('entity.player.hurt'); lastHealth = bot.health })
  bot.on('playerCollect', (collector) => { if (collector === bot.entity) emitSound('entity.item.pickup', null, 0.2, 1 + Math.random() * 0.7) })
  bot.on('death', () => emitSound('entity.player.death'))
  let lastStep = 0, lastHit = 0
  setInterval(() => {
    if (!bot.entity) return
    const now = Date.now(), v = bot.entity.velocity
    if (bot.targetDigBlock && now - lastHit > 250) { lastHit = now; emitSound(`block.${sounds.blockGroup(bot.targetDigBlock.name)}.hit`, bot.targetDigBlock.position, 0.6, 0.5) }
    if (bot.entity.onGround && Math.hypot(v.x, v.z) > 0.08 && now - lastStep > 380) {
      lastStep = now; emitSound(`block.${groupAt(bot.entity.position.offset(0, -0.5, 0))}.step`, null, 0.35)
    }
  }, 50)

  // Camera director: picks a shot from what the bot is doing, ~10x/sec.
  //   wide    - establishing shot (high, slow orbit) after arriving somewhere new / changing dimension
  //   mining  - side-on shot framing the bot + the block being dug
  //   combat  - pulled back, framing the bot + the nearest close hostile
  //   chase   - behind the bot while travelling
  //   orbit   - slow cinematic circle when idle (crafting, smelting, thinking)
  // Every shot tries a few angles around its ideal one and picks the one with the clearest line of
  // sight, then is pulled in front of any blocking wall - so underground views stay usable.
  const SHOTS = {
    // Follow distances: close enough that tree canopies (which the camera sees through for collision) rarely block the view.
    wide: { dist: 10, elev: 0.65 },
    mining: { dist: 6, elev: 0.65 },
    combat: { dist: 6, elev: 0.65 },
    chase: { dist: 6, elev: 0.65 },
    orbit: { dist: 8, elev: 0.65 },
  }
  const director = { mode: 'chase', override: null, overrideUntil: 0, anchor: null, dim: null, wideUntil: 0, lastMove: Date.now(), lastPos: null }
  bot.camera = {
    set: (mode, secs = 30, focus = null, dist = null) => {
      director.focus = focus; director.focusDist = dist
      if (mode === 'auto') { director.override = null; return 'camera: auto director' }
      if (!SHOTS[mode]) throw new Error(`camera modes: auto, ${Object.keys(SHOTS).join(', ')}`)
      director.override = mode; director.overrideUntil = Date.now() + secs * 1000
      if (mode === 'wide') director.wideUntil = director.overrideUntil
      return `camera: ${mode} for ${secs}s`
    },
    mode: () => director.mode,
  }
  const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
  const yawToward = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z)) // mineflayer yaw that faces `to`
  let camYaw = null

  // animation state for the viewer: arm swings, dig progress, held item, block-break bursts
  let lastSwing = 0, digKey = null, digStart = 0
  for (const fn of ['attack', 'swingArm']) {
    const orig = bot[fn].bind(bot)
    bot[fn] = (...args) => { lastSwing = Date.now(); if (fn === 'attack') emitSound('entity.player.attack.strong', null, 0.6); return orig(...args) }
  }
  bot.on('diggingCompleted', (b) => io.emit('fx', { type: 'break', pos: b.position, name: b.name }))
  function animState() {
    const now = Date.now()
    let dig = null
    const tb = bot.targetDigBlock
    if (tb) {
      const key = tb.position.toString()
      if (key !== digKey) { digKey = key; digStart = now }
      let total = 1000
      try { total = Math.max(50, bot.digTime(tb)) } catch {}
      dig = { pos: tb.position, name: tb.name, progress: Math.min(1, (now - digStart) / total) }
    } else digKey = null
    const v = bot.entity.velocity
    return {
      held: bot.heldItem?.name || null,
      armor: [5, 6, 7, 8].map((s) => bot.inventory.slots[s]?.name || null), // head, chest, legs, feet

      dig,
      swing: !!dig || now - lastSwing < 350,
      speed: Math.hypot(v.x, v.z),
      pitch: bot.entity.pitch,
    }
  }

  // Only solid, opaque blocks push the camera in; leaves, glass and plants don't.
  const blocksCamera = (block) => block.boundingBox === 'block' && !/leaves|glass|pane|fence|bars|vine|azalea/.test(block.name)
  let camDist = null
  let camElev = null
  function pickShot() {
    const now = Date.now()
    const pos = bot.entity.position
    if (director.override && now < director.overrideUntil) return { mode: director.override, fixed: director.focus }
    director.override = null; director.focus = null
    // new place: moved 24+ blocks from the last establishing shot, or changed dimension
    if (!director.anchor || director.dim !== bot.game.dimension || pos.distanceTo(director.anchor) > 24) {
      director.anchor = pos.clone(); director.dim = bot.game.dimension; director.wideUntil = now + 3000
    }
    const mob = bot.nearestEntity((e) => e.type === 'hostile' && e.position.distanceTo(pos) < 10)
    if (mob) return { mode: 'combat', focus: mob.position.offset(0, mob.height / 2, 0) }
    if (bot.targetDigBlock) return { mode: 'mining', focus: bot.targetDigBlock.position.offset(0.5, 0.5, 0.5) }
    if (now < director.wideUntil) return { mode: 'wide' }
    if (director.lastPos && pos.distanceTo(director.lastPos) > 0.05) director.lastMove = now
    director.lastPos = pos.clone()
    return { mode: now - director.lastMove > 15000 ? 'orbit' : 'chase' }
  }

  setInterval(() => {
    if (!bot.entity) return
    const head = bot.entity.position.offset(0, 1.6, 0)
    const shot = pickShot()
    const cfg = SHOTS[shot.mode]
    director.mode = shot.mode
    let look = head.offset(0, 0.2, 0) // aim at head height, not the feet
    let ideal
    if (shot.fixed) {
      look = shot.fixed // e.g. centre of a build: orbit around it
      ideal = camYaw ?? 0
    } else if (shot.focus) {
      // side-on to the line between the bot and the focus, so both are in frame
      look = head.plus(shot.focus).scaled(0.5).offset(0, 0.3, 0)
      ideal = yawToward(head, shot.focus) + Math.PI / 2
    } else if (shot.mode === 'wide' || shot.mode === 'orbit') {
      ideal = camYaw ?? bot.entity.yaw // hold the angle - no auto-rotation
    } else {
      ideal = bot.entity.yaw // behind
    }
    if (camYaw === null) camYaw = ideal
    // Enclosed (tunnels, caves, the Nether): pulling the camera in front of walls jams it into the bot's head.
    // The viewer only draws faces that touch air, so a camera left inside solid rock gives a clean cut-away
    // view instead: the near wall vanishes and the far tunnel wall becomes the backdrop.
    const enclosed = !shot.fixed && (bot.blockAt(head)?.skyLight ?? 15) < 8
    const dist = enclosed ? 7 : (shot.fixed && director.focusDist) || cfg.dist
    if (enclosed) {
      camYaw += angleDiff(ideal, camYaw) * 0.08
      camElev = camElev === null ? 0.9 : camElev + (0.9 - camElev) * 0.15
      camDist = camDist === null ? dist : camDist + (dist - camDist) * 0.08
      const dir = new Vec3(Math.sin(camYaw), camElev, Math.cos(camYaw)).normalize()
      io.emit('cam', { cam: look.plus(dir.scaled(camDist)), look, mode: shot.mode, ...animState() })
      return
    }
    // Try angles around the ideal one, and higher camera heights. When something blocks the view the
    // camera rises over it rather than zooming in; it only moves closer if every option is blocked.
    let best = null
    const elevs = [cfg.elev, cfg.elev + 0.45, cfg.elev + 1, cfg.elev + 2]
    for (const [ei, elev] of elevs.entries()) {
      for (const k of [0, 1, -1, 2, -2, 3, -3, 4]) {
        const yaw = ideal + k * Math.PI / 4
        const dir = new Vec3(Math.sin(yaw), elev, Math.cos(yaw)).normalize()
        let hit = null
        try { hit = bot.world.raycast(look, dir, dist, blocksCamera) } catch {}
        const free = hit ? Math.max(0.6, look.distanceTo(hit.intersect ?? hit.position.offset(0.5, 0.5, 0.5)) - 0.5) : dist
        const score = free * 3 - Math.abs(k) * 0.6 - ei * 0.9 - Math.abs(angleDiff(yaw, camYaw)) * 0.3
        if (!best || score > best.score) best = { yaw, elev, free, score }
      }
    }
    camYaw += angleDiff(best.yaw, camYaw) * (shot.mode === 'wide' || shot.mode === 'orbit' ? 0.5 : 0.1)
    camElev = camElev === null ? best.elev : camElev + (best.elev - camElev) * 0.15
    const dir = new Vec3(Math.sin(camYaw), camElev, Math.cos(camYaw)).normalize()
    let hit = null
    try { hit = bot.world.raycast(look, dir, dist, blocksCamera) } catch {}
    const free = hit ? Math.max(0.6, look.distanceTo(hit.intersect ?? hit.position.offset(0.5, 0.5, 0.5)) - 0.5) : dist
    // Ease toward the target distance instead of snapping in and out.
    camDist = camDist === null ? free : camDist + (free - camDist) * (free < camDist ? 0.25 : 0.08)
    io.emit('cam', { cam: look.plus(dir.scaled(camDist)), look, mode: shot.mode, ...animState() })
  }, 100)

  io.on('connection', (socket) => {
    // ?pov=1 on the iframe URL = first-person (camera = the bot's eyes); otherwise third-person follow cam
    const pov = /[?&]pov=1/.test(socket.handshake.headers.referer || '')
    socket.emit('version', bot.version)
    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket)
    worldView.init(bot.entity.position)

    const botPosition = () => {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true }
      if (pov) packet.pitch = bot.entity.pitch
      socket.emit('position', packet)
      worldView.updatePosition(bot.entity.position)
    }
    botPosition()
    bot.on('move', botPosition)
    worldView.listenToBot(bot)
    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition)
      worldView.removeListenersFromBot(bot)
    })
  })

  http.listen(port, () => console.log(`dashboard on http://localhost:${port}`))
}
