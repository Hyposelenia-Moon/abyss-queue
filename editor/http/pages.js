/** 三个提示页 + 页脚 */

export function createPages({ footHtml }) {
  const footerHtml = () => String(footHtml ?? "").trim()
  const pageCss = botPad => `body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;position:relative;padding-bottom:${botPad}}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16)}
.site-footer{position:absolute;left:0;right:0;bottom:14px;text-align:center;font-size:12px;line-height:1.9;color:#7b8399}
.site-footer a{color:#5c6b96;text-decoration:none}
.site-footer a:hover{text-decoration:underline}
.site-footer img{vertical-align:middle}`

  const pageFooter = () => {
    const html = footerHtml()
    return html ? `<div class="site-footer">${html}</div>` : ""
  }
  const denialPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 需要口令</title>
<style>${pageCss("120px")}
.card{width:min(92vw,340px)}
h1{font-size:17px;margin:0 0 6px}p{color:#6b7590;font-size:13px;margin:0 0 16px}
input{width:100%;padding:10px;border:1px solid #d6deef;border-radius:8px;font:inherit;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#c8a35a;color:#3a2c07;font:inherit;font-weight:700;cursor:pointer}
.err{color:#a53c2e;font-size:13px;margin-top:10px;display:none}</style></head>
<body><div class="card"><h1>排队表</h1><p>请输入群里的访问口令</p>
<form onsubmit="go(event)"><input id="k" placeholder="访问口令" autocomplete="off"><button>进入</button></form>
<div class="err" id="e">口令不对，请重新输入</div>
<script>
const q=new URLSearchParams(location.search);
if(q.get('bad'))document.getElementById('e').style.display='block';
/**
 * 编辑器页面会把地址栏清干净（避免截图带走口令），所以"刷新一下"会落到这里。
 * 口令与身份都还在这台浏览器里，直接拼回地址栏，不用再输一遍。
 * 带了口令却仍然被拦（口令不对）时不自动跳，免得来回弹。
 */
const saved=localStorage.getItem('abyss-editor-token');
if(saved&&!q.get('k')){
  const u=sessionStorage.getItem('abyss-editor-identity'),s=sessionStorage.getItem('abyss-editor-sign');
  location.replace(location.pathname+'?k='+encodeURIComponent(saved)+(u&&s?'&u='+encodeURIComponent(u)+'&s='+encodeURIComponent(s):''));
}
function go(ev){ev.preventDefault();const k=document.getElementById('k').value.trim();if(!k)return;location.href=location.pathname+'?k='+encodeURIComponent(k)}
</script></div>${pageFooter()}</body></html>`

  const entryPage = nonce => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 填写入口</title>
<style>${pageCss("120px")}
.card{width:min(92vw,360px)}
h1{font-size:17px;margin:0 0 6px}p{color:#6b7590;font-size:13px;margin:0 0 16px}
input{width:100%;padding:10px;border:1px solid #d6deef;border-radius:8px;font:inherit;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#c8a35a;color:#3a2c07;font:inherit;font-weight:700;cursor:pointer}
.err{color:#a53c2e;font-size:13px;margin-top:10px;display:none}
details{margin-top:18px;color:#7b8399;font-size:12px}
summary{cursor:pointer}
details input{margin-top:8px}
</style></head>
<body><div class="card"><h1>排队表</h1>
<p>请输入群里机器人发给你的 6 位数字填表口令</p>
<form id="codeForm"><input id="code" placeholder="6 位数字口令" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required><button>进入</button></form>
<div class="err" id="err">口令不对或已过期，请回群里重新发一次 #排队</div>
<details><summary>管理员 / 本机：用访问口令进入</summary>
<form id="tokenForm"><input id="k" placeholder="访问口令" autocomplete="off"><button>进入</button></form>
</details>
<script nonce="${nonce}">
const err=document.getElementById('err');
/**
 * 表单提交一律用 addEventListener 绑，**不要写 HTML 内联事件属性**：
 * CSP 只放行带 nonce 的脚本（script-src 'self' 'nonce-…'），内联事件处理器不在白名单里，
 * 浏览器会静默拦掉——表现就是手输口令点「进入」毫无反应（Chromium 里提交请求数为 0）。
 */
async function goCode(ev){
  if(ev)ev.preventDefault();
  const code=document.getElementById('code').value.replace(/\D/g,'').trim();
  if(code.length!==6)return;
  err.style.display='none';
  try{
    const r=await fetch('api/link-code?code='+encodeURIComponent(code),{cache:'no-store'});
    const out=await r.json();
    if(!out||!out.ok)throw new Error(out&&out.error||'口令不对或已过期');
    location.href=out.url;
  }catch(e){
    err.textContent=e.message||'口令不对或已过期';
    err.style.display='block';
  }
}
/**
 * 群链接把 6 位口令拼在 URL 末尾的 hash（#code=123456）：点开就直接兑换。
 * hash 被 QQ 或手动复制时抹掉，就留在本页提示手输口令——不能再拿本地存着的访问口令
 * 自动跳转，否则会跳进没有身份的编辑器，看起来像“只读”。
 */
const hash=new URLSearchParams((location.hash||'').replace(/^#/,''));
const seed=(hash.get('code')||hash.get('c')||'').replace(/\D/g,'');
const input=document.getElementById('code');
if(seed.length===6){input.value=seed;goCode()}
function goToken(ev){
  ev.preventDefault();
  const k=document.getElementById('k').value.trim();
  if(k)location.href=location.pathname+'?k='+encodeURIComponent(k);
}
document.getElementById('codeForm').addEventListener('submit',goCode);
document.getElementById('tokenForm').addEventListener('submit',goToken);
</script></div>${pageFooter()}</body></html>`

  const ownerOnlyPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 仅主人可用</title>
<style>${pageCss("120px")}
.card{width:min(92vw,360px)}
h1{font-size:17px;margin:0 0 8px}p{color:#6b7590;font-size:13px;margin:0 0 10px}
b{color:#23283a}</style></head>
<body><div class="card"><h1>这是本机编辑器</h1>
<p>本机这份是云端数据的备份，<b>只有主人</b>能打开。</p>
<p>群友请用群里 <b>#排队</b> 拿到的链接，那是服务器上的在线编辑器。</p>
</div>${pageFooter()}</body></html>`

  const expiredLinkPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 链接已失效</title>
<style>${pageCss("120px")}
.card{width:min(92vw,380px)}
h1{font-size:17px;margin:0 0 8px}p{color:#6b7590;font-size:13px;margin:0 0 10px}b{color:#23283a}</style></head>
<body><div class="card"><h1>这个填表链接已经失效</h1>
<p>链接有有效期（30 天），也可能是换了签名密钥、或被人改过。</p>
<p>请回到群里重新发一次 <b>#排队</b>，取一条新链接再点。</p>
</div>${pageFooter()}</body></html>`

  return { footerHtml, pageCss, pageFooter, denialPage, entryPage, ownerOnlyPage, expiredLinkPage }
}
