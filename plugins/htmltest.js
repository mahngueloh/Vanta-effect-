'use strict'
// Owner diagnostic: sends one tiny interactive HTML page as an in-chat "rich
// response" using each metadata variant, so we can see which one WhatsApp
// actually renders inside the bubble. Usage: .htmltest
const { sendRichHtml } = require('../lib/richhtml')

const TEST_PAGE = n => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;background:#0b141a;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:18px}
h2{margin:0 0 8px}button{background:#00e5ff;border:0;border-radius:12px;padding:16px 28px;font-size:20px;font-weight:800}
#box{width:40px;height:40px;background:#ff2d95;border-radius:10px;margin:14px auto;position:relative}</style></head>
<body><h2>HTML test #${n}</h2><p>If you can tap the button and the pink box moves, in-chat HTML works.</p>
<button id="b">TAP ME: <span id="n">0</span></button><div id="box"></div>
<script>let k=0,d=1,p=0;document.getElementById('b').onclick=()=>{k++;document.getElementById('n').textContent=k};
setInterval(()=>{p+=d*3;if(p>140||p<-140)d=-d;document.getElementById('box').style.left=p+'px'},16)</script></body></html>`

async function sendHtmlTest(sock, from, msg) {
    await sock.sendMessage(from, { text: 'Sending 1 in-chat HTML test page…' }, { quoted: msg })
    try { await sendRichHtml(sock, from, TEST_PAGE(1), { title: 'HTML test' }) }
    catch (e) { console.log('[htmltest] FAILED:', e.stack || e.message); await sock.sendMessage(from, { text: '❌ send failed: ' + e.message }) }
}
module.exports = { sendHtmlTest }
