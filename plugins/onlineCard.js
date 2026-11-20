'use strict'
// In-chat "Bot is Online" status card (native rich HTML, like the games).
// Live-ticking uptime. Falls back to a plain box if rich HTML isn't supported.
const os = require('os')
const { sendRichHtml } = require('./../lib/richhtml')

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function fmtUp(ms) {
    const s = Math.floor(ms / 1000)
    return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 }
}

function buildHtml({ botName, upMs, latency, cores, node, mode, ramUsed, ramTotal, time, tz }) {
    const u = fmtUp(upMs)
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a1224;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#e8eefc;padding:10px}
.card{background:linear-gradient(160deg,#0f1c3a,#0a1428);border:1px solid #1f3a6b;border-radius:18px;padding:16px}
.top{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1f3a6b;padding-bottom:12px;margin-bottom:14px}
.name{font-size:19px;font-weight:700}
.pill{font-size:11px;font-weight:700;letter-spacing:.5px;color:#4da3ff;background:#0d2a52;border:1px solid #1d4f94;border-radius:20px;padding:5px 10px;display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;background:#4da3ff;animation:p 1.4s infinite}
@keyframes p{50%{opacity:.25}}
.up{text-align:center;background:#0c1f40;border:1px solid #1d4f94;border-radius:14px;padding:14px;margin-bottom:12px}
.lbl{font-size:11px;letter-spacing:1.2px;color:#4da3ff;font-weight:700}
.big{font-size:30px;font-weight:800;margin:6px 0;font-variant-numeric:tabular-nums}
.sub{font-size:12px;color:#8aa0c8}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.box{background:#0c1a33;border:1px solid #1a3563;border-radius:12px;padding:11px}
.box .lbl{color:#7d92ba;font-size:10px}
.val{font-size:19px;font-weight:700;margin-top:5px}
.ok{background:#0d2a1f;border:1px solid #1b6b49;color:#4ade80;border-radius:12px;padding:11px;font-size:14px;margin-bottom:12px}
.foot{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #1f3a6b;padding-top:10px;font-size:11px;color:#7d92ba}
.pw{color:#ffd166;font-weight:700;font-size:12px}
</style></head><body><div class="card">
<div class="top"><div class="name">🤖 ${esc(botName)}</div><div class="pill"><span class="dot"></span>SYSTEM ONLINE</div></div>
<div class="up"><div class="lbl">⏱ BOT ACTIVE UPTIME</div><div class="big" id="t">${u.h} h ${u.m} min ${u.s} s</div><div class="sub">Time: ${esc(time)} (${esc(tz)})</div></div>
<div class="grid">
<div class="box"><div class="lbl">LATENCY SPEED</div><div class="val">${latency} ms</div></div>
<div class="box"><div class="lbl">CPU CORES</div><div class="val">${cores} Core</div></div>
<div class="box"><div class="lbl">RUNTIME ENGINE</div><div class="val">Node ${esc(node)}</div></div>
<div class="box"><div class="lbl">MODE · RAM</div><div class="val">${esc(mode)} · ${ramUsed}/${ramTotal} MB</div></div>
</div>
<div class="ok">🟢 The service is active and ready for commands</div>
<div class="foot"><span>updated just now</span><span class="pw">⚡ Powered by Zack — your friendly bot developer</span></div>
</div><script>var b=Date.now()-${Math.floor(upMs)};setInterval(function(){var s=Math.floor((Date.now()-b)/1000);document.getElementById('t').textContent=Math.floor(s/3600)+' h '+Math.floor(s%3600/60)+' min '+s%60+' s'},1000)</script></body></html>`
}

async function sendOnlineCard(sock, from, msg, ctx) {
    const { config, startTime } = ctx
    const ts = msg?.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : 0
    const latency = ts ? Math.max(1, Date.now() - ts) : 1
    const tz = process.env.TZ || 'Africa/Nairobi'
    let time
    try { time = new Date().toLocaleTimeString('en-GB', { timeZone: tz }) } catch { time = new Date().toLocaleTimeString('en-GB') }
    const t = os.totalmem()
    const data = {
        botName: config.botName || 'MAHNGUELOH VANTA',
        upMs: Date.now() - startTime,
        latency,
        cores: os.cpus().length,
        node: process.version,
        mode: (config.mode || 'public').toUpperCase(),
        ramUsed: Math.round((t - os.freemem()) / 1048576),
        ramTotal: Math.round(t / 1048576),
        time, tz,
    }
    try {
        await sendRichHtml(sock, from, buildHtml(data), { title: `${data.botName} is Online`, quoted: msg })
    } catch (e) {
        const u = fmtUp(data.upMs)
        await sock.sendMessage(from, {
            text: `🤖 *${data.botName} is Online!*\n\n⏱ Uptime: ${u.h}h ${u.m}m ${u.s}s\n⚡ Latency: ${latency} ms\n🧠 CPU: ${data.cores} cores\n🟢 Node ${data.node}\n\n_Powered by Zack — your friendly bot developer_`
        }, { quoted: msg })
    }
}

module.exports = { sendOnlineCard, buildHtml }
