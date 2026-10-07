// Self-correcting chase camera. The server sends 'cam' (a spot behind Claude, pulled in front of walls)
// ~10x/sec; we glide toward it every frame. Dragging/zooming pauses the glide for 4s, then it eases back.
;(() => {
  const THREE = window.THREE
  let goal = null, target = null, lastInput = 0, snap = true
  window.__follow = true
  window.__resetCam = () => { snap = true; lastInput = 0 }
  window.__lastCam = 0

  window.__socket.on('cam', (c) => {
    goal = new THREE.Vector3(c.cam.x, c.cam.y, c.cam.z)
    target = new THREE.Vector3(c.look.x, c.look.y, c.look.z)
    window.__lastCam = Date.now()
  })
  for (const ev of ['pointerdown', 'touchstart']) addEventListener(ev, () => { lastInput = Date.now() }, { passive: true })
  // zoom: scales the distance between camera and Claude. Mouse wheel adjusts it; remembered per browser.
  let zoom = 0.6
  try { zoom = Number(localStorage.getItem('mc-zoom')) || 0.6 } catch {}
  addEventListener('wheel', (e) => {
    if (window.__free) return // OrbitControls zooms in free mode
    e.preventDefault()
    zoom = Math.min(1.4, Math.max(0.2, zoom * (e.deltaY > 0 ? 1.1 : 0.9)))
    try { localStorage.setItem('mc-zoom', String(zoom)) } catch {}
  }, { passive: false })
  addEventListener('pointermove', (e) => { if (e.buttons) lastInput = Date.now() })

  // free camera: WASD fly, E/Q up/down, Shift = fast; mouse drag looks around, wheel zooms
  window.__free = false
  const keys = new Set()
  addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()))
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
  addEventListener('blur', () => keys.clear())
  let lastT = performance.now()
  function freeFly(controls, cam) {
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now
    controls.enableZoom = true
    const speed = (keys.has('shift') ? 60 : 15) * dt
    const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd)
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize()
    const right = new THREE.Vector3().crossVectors(flat, new THREE.Vector3(0, 1, 0))
    const move = new THREE.Vector3()
    if (keys.has('w')) move.add(fwd)
    if (keys.has('s')) move.sub(fwd)
    if (keys.has('d')) move.add(right)
    if (keys.has('a')) move.sub(right)
    if (keys.has('e') || keys.has(' ')) move.y += 1
    if (keys.has('q')) move.y -= 1
    if (move.lengthSq()) { move.normalize().multiplyScalar(speed); cam.position.add(move); controls.target.add(move) }
  }

  function frame() {
    requestAnimationFrame(frame)
    const controls = window.__controls()
    if (controls && window.__free) { lastT = lastT || performance.now(); return freeFly(controls, window.__viewer.camera) }
    lastT = performance.now()
    if (!goal || !controls || window.__follow === false) return
    controls.enableZoom = false // the wheel drives our zoom instead
    const cam = window.__viewer.camera
    const zGoal = target.clone().add(goal.clone().sub(target).multiplyScalar(zoom))
    if (!snap && Date.now() - lastInput < 4000) {
      // viewer is steering: keep their angle, but keep the orbit centred on Claude
      const d = target.clone().sub(controls.target)
      controls.target.add(d); cam.position.add(d)
      return
    }
    cam.position.lerp(zGoal, snap ? 1 : 0.08)
    controls.target.lerp(target, snap ? 1 : 0.25)
    // broken-camera guard: NaN or drifted way off -> snap straight back
    if (!isFinite(cam.position.x) || cam.position.distanceTo(target) > 40) { cam.position.copy(zGoal); controls.target.copy(target) }
    snap = false
  }
  frame()
})()

// Makes Claude look alive: walking legs, head pitch, arm swings, a tool in hand, a darkening crack box
// on the block being mined, and a burst of particles when a block breaks.
;(() => {
  const THREE = window.THREE
  let anim = { held: null, dig: null, swing: false, speed: 0, pitch: 0 }
  window.__socket.on('cam', (c) => { anim = c })

  // player model bone order (prismarine-viewer entities.json): see skeleton.bones indices
  const B = { head: 3, leftArm: 6, rightArm: 9, rightItem: 11, leftLeg: 12, rightLeg: 14 }
  let bones = null, base = null, toolName = undefined, tool = null

  const MAT = { wooden: 0x8b6a3e, stone: 0x8a8a8a, iron: 0xdcdcdc, golden: 0xf2d24b, diamond: 0x4ee6d5, netherite: 0x4a4344 }
  const box = (w, h, d, color, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }))
    m.position.set(x, y, z); return m
  }
  function blockColor(name = '') {
    if (/log|plank|wood|crafting/.test(name)) return 0x8b6a3e
    if (/leaves|grass|moss/.test(name)) return 0x4f8a3a
    if (/dirt|mud|farmland/.test(name)) return 0x7a5534
    if (/sand/.test(name)) return 0xdcc98b
    if (/deepslate|basalt|blackstone/.test(name)) return 0x4b4b52
    if (/netherrack/.test(name)) return 0x7a2e2e
    if (/snow|quartz/.test(name)) return 0xf0f4f7
    if (/diamond/.test(name)) return 0x4ee6d5
    if (/gold/.test(name)) return 0xf2d24b
    return 0x8a8a8a
  }
  // a tiny voxel model of the held item, in player-model pixel units, pointing forward (-z) out of the fist
  function buildTool(name) {
    const g = new THREE.Group()
    if (!name) return g
    const mat = MAT[Object.keys(MAT).find((m) => name.startsWith(m))] ?? null
    const handle = 0x6b4a2b
    if (/_pickaxe$/.test(name)) { g.add(box(1, 1, 10, handle, 0, 0, -4)); g.add(box(1, 9, 2, mat, 0, 0, -9)) }
    else if (/_axe$/.test(name)) { g.add(box(1, 1, 10, handle, 0, 0, -4)); g.add(box(1, 4, 4, mat, 0, 2, -8)) }
    else if (/_shovel$/.test(name)) { g.add(box(1, 1, 10, handle, 0, 0, -4)); g.add(box(1, 3, 4, mat, 0, 0, -10)) }
    else if (/_sword$/.test(name)) { g.add(box(1, 1, 3, handle, 0, 0, -1)); g.add(box(1, 5, 1, 0x555555, 0, 0, -3)); g.add(box(1, 2, 11, mat, 0, 0, -9)) }
    else g.add(box(5, 5, 5, mat ?? blockColor(name), 0, 0, -3))
    g.rotation.x = -0.5 // tilt like a held tool
    return g
  }

  // armor: Minecraft's own armor textures on extra skinned meshes that share Claude's skeleton, so they move with
  // the walk/swing animation. Cubes and UVs follow vanilla's armor layers (64x32 textures, inflated past the skin).
  const FACES = [ // same face/UV layout as prismarine-viewer's Entity.js
    { dir: [0, 1, 0], u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1], corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]] },
    { dir: [0, -1, 0], u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1], corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]] },
    { dir: [1, 0, 0], u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1], corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] },
    { dir: [-1, 0, 0], u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
    { dir: [0, 0, -1], u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 1], corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]] },
    { dir: [0, 0, 1], u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1], corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]] },
  ]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  // per armor slot: [texture layer, bone index, cube origin, size, uv, inflate] (bones: body 1, head 3, arms 6/9, legs 12/14)
  const ARMOR = [
    [['humanoid', 3, [-4, 24, -4], [8, 8, 8], [0, 0], 1]],
    [['humanoid', 1, [-4, 12, -2], [8, 12, 4], [16, 16], 1], ['humanoid', 9, [-8, 12, -2], [4, 12, 4], [40, 16], 1], ['humanoid', 6, [4, 12, -2], [4, 12, 4], [40, 16], 1]],
    [['humanoid_leggings', 1, [-4, 12, -2], [8, 12, 4], [16, 16], 0.5], ['humanoid_leggings', 14, [-3.9, 0, -2], [4, 12, 4], [0, 16], 0.5], ['humanoid_leggings', 12, [-0.1, 0, -2], [4, 12, 4], [0, 16], 0.5]],
    [['humanoid', 14, [-3.9, 0, -2], [4, 12, 4], [0, 16], 1], ['humanoid', 12, [-0.1, 0, -2], [4, 12, 4], [0, 16], 1]],
  ]
  const ARMOR_MAT = { leather: 'leather', chainmail: 'chainmail', iron: 'iron', golden: 'gold', diamond: 'diamond', netherite: 'netherite', turtle: 'turtle_scute' }
  const texCache = {}
  function armorTexture(layer, mat) {
    const key = `${layer}/${mat}`
    if (!texCache[key]) {
      const t = new THREE.TextureLoader().load(`textures/1.21.4/entity/equipment/${key}.png`)
      t.magFilter = t.minFilter = THREE.NearestFilter; t.flipY = false
      texCache[key] = t
    }
    return texCache[key]
  }
  let armorKey = '', armorMeshes = []
  function buildArmor(skinned, names) {
    for (const m of armorMeshes) { m.parent?.remove(m); m.geometry.dispose(); m.material.dispose() }
    armorMeshes = []
    const groups = {} // one mesh per texture: "humanoid/diamond" -> cubes
    names.forEach((name, slot) => {
      const mat = name && ARMOR_MAT[Object.keys(ARMOR_MAT).find((k) => name.startsWith(k))]
      if (!mat) return
      for (const [layer, ...cube] of ARMOR[slot]) (groups[`${layer}/${mat}`] ??= []).push(cube)
    })
    for (const [key, cubes] of Object.entries(groups)) {
      const pos = [], nrm = [], uvs = [], idx = [], si = [], sw = []
      for (const [bone, o, s, uv, inf] of cubes) {
        for (const { dir, corners, u0, v0, u1, v1 } of FACES) {
          const n = pos.length / 3
          for (const c of corners) {
            pos.push(o[0] + c[0] * s[0] + (c[0] ? inf : -inf), o[1] + c[1] * s[1] + (c[1] ? inf : -inf), o[2] + c[2] * s[2] + (c[2] ? inf : -inf))
            uvs.push((uv[0] + dot(c[3] ? u1 : u0, s)) / 64, (uv[1] + dot(c[4] ? v1 : v0, s)) / 32)
            nrm.push(...dir); si.push(bone, 0, 0, 0); sw.push(1, 0, 0, 0)
          }
          idx.push(n, n + 1, n + 2, n + 2, n + 1, n + 3)
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
      g.setIndex(idx)
      const [layer, mat] = key.split('/')
      const m = new THREE.SkinnedMesh(g, new THREE.MeshLambertMaterial({ map: armorTexture(layer, mat), transparent: true, alphaTest: 0.1, skinning: true }))
      m.position.copy(skinned.position); m.quaternion.copy(skinned.quaternion); m.scale.copy(skinned.scale)
      skinned.parent.add(m)
      m.bind(skinned.skeleton, skinned.bindMatrix) // same skeleton: the armor follows every bone
      armorMeshes.push(m)
    }
  }

  // dig overlay
  const crack = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 1.02), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }))
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }))
  crack.visible = edges.visible = false

  // particles
  const parts = []
  window.__socket.on('fx', (fx) => {
    if (fx.type !== 'break' || !window.__viewer) return
    const color = blockColor(fx.name)
    for (let i = 0; i < 16; i++) {
      const p = box(0.12, 0.12, 0.12, color, fx.pos.x + 0.5 + (Math.random() - 0.5) * 0.6, fx.pos.y + 0.5 + (Math.random() - 0.5) * 0.6, fx.pos.z + 0.5 + (Math.random() - 0.5) * 0.6)
      p.userData = { v: new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 4 + 1, (Math.random() - 0.5) * 4), life: 0.9 }
      window.__viewer.scene.add(p); parts.push(p)
    }
  })

  let last = performance.now(), t = 0
  function frame(now) {
    requestAnimationFrame(frame)
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt
    const viewer = window.__viewer
    if (!viewer) return
    if (!crack.parent) { viewer.scene.add(crack); viewer.scene.add(edges) }

    // find the skinned player mesh once it exists
    if (!bones && window.__botMesh) {
      let skinned = null
      window.__botMesh.traverse((o) => { if (o.isSkinnedMesh && o.skeleton.bones.length >= 15) skinned = o })
      if (skinned) {
        bones = skinned.skeleton.bones
        // prismarine-viewer gives every bone its ABSOLUTE pivot as a local position, then nests it under its
        // parent - so pivots are offset twice and rotating a bone swings it around a point far away
        // (floating head, detached arms). Make positions parent-relative, then re-bind the skin.
        const abs = bones.map((b) => b.position.clone())
        bones.forEach((b, i) => { const pi = bones.indexOf(b.parent); if (pi >= 0) b.position.copy(abs[i]).sub(abs[pi]) })
        skinned.updateMatrixWorld(true)
        skinned.bind(skinned.skeleton)
        base = bones.map((b) => b.rotation.clone())
        bones.skinned = skinned
        armorKey = '' // (re)dress the new mesh
      }
    }
    if (bones) {
      const walk = Math.min(1, anim.speed / 0.2)
      const legSwing = Math.sin(t * 10) * 0.7 * walk
      bones[B.leftLeg].rotation.x = base[B.leftLeg].x + legSwing
      bones[B.rightLeg].rotation.x = base[B.rightLeg].x - legSwing
      bones[B.leftArm].rotation.x = base[B.leftArm].x - legSwing * 0.8
      bones[B.head].rotation.x = base[B.head].x + Math.max(-1.2, Math.min(1.2, anim.pitch || 0))
      const arm = bones[B.rightArm]
      arm.rotation.x = anim.swing ? base[B.rightArm].x + 0.6 + Math.abs(Math.sin(t * 9)) * 1.1 : base[B.rightArm].x + legSwing * 0.8 + (anim.held ? 0.3 : 0)
      const key = JSON.stringify(anim.armor || [])
      if (key !== armorKey) { armorKey = key; buildArmor(bones.skinned, anim.armor || []) }
      if (anim.held !== toolName) {
        if (tool) tool.parent?.remove(tool)
        tool = buildTool(anim.held); toolName = anim.held
        bones[B.rightItem].add(tool)
      }
    }

    // crack box darkens as the dig progresses, edges pulse
    if (anim.dig) {
      const p = anim.dig.pos
      crack.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5); edges.position.copy(crack.position)
      crack.material.opacity = 0.1 + anim.dig.progress * 0.6
      edges.material.opacity = 0.5 + Math.abs(Math.sin(t * 8)) * 0.5
      crack.scale.setScalar(1 + Math.sin(t * 20) * 0.01)
      crack.visible = edges.visible = true
    } else crack.visible = edges.visible = false

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; const u = p.userData
      u.v.y -= 14 * dt; p.position.addScaledVector(u.v, dt); p.rotation.x += dt * 5; u.life -= dt
      if (u.life <= 0) { viewer.scene.remove(p); parts.splice(i, 1) }
    }
  }
  requestAnimationFrame(frame)
})()

// sounds are played by the dashboard page (it owns the AudioContext, unlocked by the Sound button)
window.__socket.on('sound', (s) => { try { window.parent?.__mcSound?.(s) } catch {} })

// the bot restarted (code reload / world switch): the viewer's world state is stale, so start fresh
;(() => {
  let dropped = false
  window.__socket.on('disconnect', () => { dropped = true })
  window.__socket.on('connect', () => { if (dropped) location.reload() })
})()
