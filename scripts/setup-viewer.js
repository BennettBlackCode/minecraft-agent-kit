// Builds web/view (the dashboard's 3D view) from prismarine-viewer's published files plus a few patches:
// 1.18+ world height (y -64..320), bone-name lookup for the player model, and hooks the follow camera
// (web/view/follow.js) uses. Runs automatically after `npm install`; safe to run again.
const fs = require('fs')
const path = require('path')

const src = path.join(__dirname, '../node_modules/prismarine-viewer/public')
const dst = path.join(__dirname, '../web/view')
if (!fs.existsSync(src)) { console.log('setup-viewer: prismarine-viewer not installed yet, skipping'); process.exit(0) }

for (const name of fs.readdirSync(src)) fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true })

function patch(file, edits) {
  const p = path.join(dst, file)
  let s = fs.readFileSync(p, 'utf8')
  for (const [find, replace] of edits) {
    if (s.includes(replace) && !s.includes(find)) continue // already patched
    const n = s.split(find).length - 1
    if (n !== 1) throw new Error(`setup-viewer: expected 1 match in ${file}, found ${n}: ${find.slice(0, 60)}`)
    s = s.replace(find, replace)
  }
  fs.writeFileSync(p, s)
}

patch('index.js', [
  ['for(const t of e.bones)t.parent?i[t.parent].add(i[t.name]):o.push(i[t.name])',
    'for(const t of e.bones)(p=>p?p.add(i[t.name]):o.push(i[t.name]))(t.parent&&(i[t.parent]||i[Object.keys(i).find(k=>k.toLowerCase()===t.parent.toLowerCase())]))'],
  ['Message({type:"chunk",x:t,z:e,chunk:i});for(let i=0;i<256', 'Message({type:"chunk",x:t,z:e,chunk:i});for(let i=-64;i<320'],
  ['stMessage({type:"unloadChunk",x:t,z:e});for(let i=0;i<256', 'stMessage({type:"unloadChunk",x:t,z:e});for(let i=-64;i<320'],
  [' h=new THREE.OrbitControls(u.camera,l.domElement);', ' h=new THREE.OrbitControls(u.camera,l.domElement);window.__viewer=u;window.__controls=()=>h;window.__socket=o;'],
  ['w a("1.16.4","player",u.scene).mesh,u.scene.add(e)', 'w a("1.16.4","player",u.scene).mesh,u.scene.add(e),window.__botMesh=e'],
])
patch('worker.js', [
  ['Properties().waterlogged)continue;if(g.position.y<0', 'Properties().waterlogged)continue;if(g.position.y<-64'],
  ['!n.transparent&&n.isCube)continue;if(n.position.y<0', '!n.transparent&&n.isCube)continue;if(n.position.y<-64'],
  ['s.columns[t];if(!n)return null;const a=e.floored(),', 's.columns[t];if(!n)return null;const a=e.floored();if(a.y<(n.minY||0)||a.y>=(n.minY||0)+(n.worldHeight||256))return null;const '],
  ['l),s=sectionKey(n,a,l);t?i&&i.sections[Math.floor(a', 'l),s=sectionKey(n,a,l);t?i&&i.sections[Math.floor((a-(i.minY||0))'],
  ['=world.getColumn(e,a);if(l&&l.sections[Math.floor(n', '=world.getColumn(e,a);if(l&&l.sections[Math.floor((n-(l.minY||0))'],
])
patch('index.html', [['</body>', '    <script type="text/javascript" src="follow.js"></script>\n</body>']])
console.log('setup-viewer: web/view ready')
