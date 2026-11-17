'use strict'
// Owner diagnostic: sends one tiny interactive HTML page as an in-chat "rich
// response" using each metadata variant, so we can see which one WhatsApp
// actually renders inside the bubble. Usage: .htmltest
const { sendRichHtml, META } = require('../lib/richhtml')

const TEST_PAGE = n => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;background:#0b141a;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:18px}
h2{margin:0 0 8px}button{background:#00e5ff;border:0;border-radius:12px;padding:16px 28px;font-size:20px;font-weight:800}
#box{width:40px;height:40px;background:#ff2d95;border-radius:10px;margin:14px auto;position:relative}</style></head>
<body><h2>HTML test #${n}</h2><p>If you can tap the button and the pink box moves, in-chat HTML works.</p>
<button id="b">TAP ME: <span id="n">0</span></button><div id="box"></div>
<script>let k=0,d=1,p=0;document.getElementById('b').onclick=()=>{k++;document.getElementById('n').textContent=k};
setInterval(()=>{p+=d*3;if(p>140||p<-140)d=-d;document.getElementById('box').style.left=p+'px'},16)</script></body></html>`

async function sendHtmlTest(sock, from, msg) {
    const names = Object.keys(META)
    await sock.sendMessage(from, { text: `Sending ${names.length} HTML tests (one every 4s). Tell me which numbers show a page you can tap, or "none".\n` + names.map((n, i) => `${i + 1} = ${n}`).join('\n') }, { quoted: msg })
    for (let i = 0; i < names.length; i++) {
        try { await sendRichHtml(sock, from, TEST_PAGE(i + 1), { title: `HTML test #${i + 1} (${names[i]})`, meta: names[i] }) }
        catch (e) { console.log(`[htmltest] ${i + 1} (${names[i]}) FAILED:`, e.stack || e.message) }
        await new Promise(r => setTimeout(r, 4000))
    }
    await sock.sendMessage(from, { text: 'Done. Reply with the numbers that showed a tappable page (or "none").' })
}
module.exports = { sendHtmlTest }
