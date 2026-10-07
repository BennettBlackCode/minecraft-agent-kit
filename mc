#!/usr/bin/env bash
# Usage: ./mc state | ./mc <action> key=value ...   (eval reads JS from stdin: ./mc eval <<< 'return bot.health')
# Action results print as one compact line (long results trimmed) to keep the player's context small.
API=http://127.0.0.1:${API_PORT:-3456}
[ "$1" = "state" ] || [ -z "$1" ] && exec curl -s "$API/state"
action=$1; shift
if [ "$action" = "eval" ]; then
  json=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify({action:"eval",code:d})))')
else
  json=$(node -e '
const o={action:process.argv[1]}
for (const kv of process.argv.slice(2)){const i=kv.indexOf("=");const k=kv.slice(0,i),v=kv.slice(i+1);o[k]=v!==""&&!isNaN(v)?Number(v):v}
console.log(JSON.stringify(o))' "$action" "$@")
fi
curl -s "$API/act" -H 'content-type: application/json' -d "$json" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const r=JSON.parse(d)
    const v=r.ok?(typeof r.result==="string"?r.result:JSON.stringify(r.result)):"ERROR "+(r.error||JSON.stringify(r))
    const p=r.pos?` @${Math.round(r.pos.x)},${Math.round(r.pos.y)},${Math.round(r.pos.z)}`:""
    const hp=r.health!==undefined?` hp${Math.round(r.health)} food${r.food}`:""
    console.log((v.length>400?v.slice(0,400)+"…":v)+p+hp)
  } catch { console.log(d.slice(0,400)) }
})'
# Surface new chat from human players after every action, so the player sees it mid-turn (not only in ./s).
[ "$action" = "chat" ] || [ "$action" = "think" ] || curl -s "$API/state" | node -e '
const fs=require("fs"),f=__dirname+"/.chat-seen"
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{
  let seen=[];try{seen=JSON.parse(fs.readFileSync(".chat-seen","utf8"))}catch{}
  const fresh=JSON.parse(d).chat.filter(c=>c.msg.startsWith("<")&&!c.msg.startsWith("<"+JSON.parse(d).name+">")).map(c=>c.t+" "+c.msg).filter(k=>!seen.includes(k))
  if(!fresh.length)return
  console.log("PLAYER CHAT (another player is talking to you - reply with ./mc chat): "+fresh.map(k=>k.slice(9)).join(" | "))
  fs.writeFileSync(".chat-seen",JSON.stringify(seen.concat(fresh).slice(-50)))
}catch{}})'
# Voice: the agent talks to viewers at least every 3 minutes. Each think resets the clock; any other action nags once it runs out.
if [ "$action" = "think" ]; then touch .last-think
elif [ -z "$(find .last-think -mmin -3 2>/dev/null)" ]; then
  echo "VOICE: 3+ minutes since you last spoke to the stream. Post a ./mc think now: what you're doing and how you honestly feel right now."
fi
