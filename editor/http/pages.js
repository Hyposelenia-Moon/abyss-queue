/**
 * 三个提示页 + 页脚
 *
 * 这三个页面都是**服务端直接吐字符串**，不依赖前端脚本，所以进不来编辑器时也画得出来：
 *   - `denialPage`    没带口令（或口令不对）
 *   - `ownerOnlyPage` 开了「主人专用」，来的是别人
 *   - `expiredLinkPage` 短链过期 / 被改过 / 换了签名密钥
 *
 * 页脚来自插件配置 `footer.html`（`editor/config.js` 已在它后面追加规范署名行），
 * 三页与首页共用同一份（首页由 `/api/meta` 取）。取值只由 `editor.mjs` 注入一次。
 */

/**
 * @param {object} deps
 * @param {string} deps.footHtml 页脚的 HTML：插件配置 `footer.html` 的自由 HTML + 规范署名行
 *        （由 `editor/config.js` 拼好；空 = 不显示页脚）
 */
export function createPages({ footHtml }) {
  /**
   * 页脚 HTML：上面那份内容**原样**插进页面（留空 = 整块不渲染）。
   *
   * 自由那部分为什么不拆字段、不做转义：版权与备案怎么排是维护者的事（行数、链接、公安备案的图），
   * 编辑器只负责"有就画、没有就不画"；末尾那一行规范署名由编辑器自己追加，不由配置提供。
   * 它是**维护者自己写的内容**，不是群友输入——别把用户可控的字符串接到这里。
   */
  const footerHtml = () => String(footHtml ?? "").trim()

  /** 三个提示页共同的样式：卡片居中 + 页脚贴底（`botPad` 是给页脚留的高度） */
  const pageCss = botPad => `body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;position:relative;padding-bottom:${botPad}}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16)}
.site-footer{position:absolute;left:0;right:0;bottom:14px;text-align:center;font-size:12px;line-height:1.9;color:#7b8399}
.site-footer a{color:#5c6b96;text-decoration:none}
.site-footer a:hover{text-decoration:underline}
.site-footer img{vertical-align:middle}`

  /** 提示页的页脚块（贴底）；没有配置就不渲染 */
  const pageFooter = () => {
    const html = footerHtml()
    return html ? `<div class="site-footer">${html}</div>` : ""
  }

  /** 未授权时给一个极简的「输入口令」页，避免直接 403 让人摸不着头脑 */
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

  /** 只给主人用的时候，别人打开首页看到的话 */
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

  /** 短链验不过（过期 / 被改过 / 换了签名密钥）时的提示页 */
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

  return { footerHtml, pageCss, pageFooter, denialPage, ownerOnlyPage, expiredLinkPage }
}
