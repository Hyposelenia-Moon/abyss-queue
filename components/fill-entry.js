/**
 * 填报入口（填写情况 + 「点此填表」链接）
 *
 * 与指令无关：`#排队` 与 `#排队 <榜>` 都要附这一段，内容口径完全一致。
 * 链接两种形态：群里发**短链**（`/s/<码>`），主人 / 白名单管理员那份走私聊、
 * 用**带当期时间窗的长地址**（`windowedEditorUrl`，见下）。
 * 纯拼装 + 签名，不碰文件系统；地址/口令/签名密钥三者缺一就只写「暂无链接」。
 */
import { config } from "./config.js"
import { editorUrl, signFreshness, signTicket, signWindow, SHORT_PATH } from "../model/identity.js"
import { isDone } from "../modules/progress.js"

/** 填报入口上的那四个字（点它就是链接） */
const FILL_LINK_TEXT = "点此填表"

/**
 * 「点此填表」这一段
 *
 * 要求是"文字本身就是短链，点文字跳浏览器"，QQ 里能做到这点的只有 **markdown 段**：
 * 卡片（json / xml / 小程序）会被 QQ 当成第三方客户端发的卡片挡掉（提示「发送者版本过低」），
 * share 段 NapCat 根本不认（未知段会直接抛错，整条消息都发不出去），纯文本又挂不了超链接。
 *
 * 本机链路：TRSS 的 OneBotv11 适配器把段原样透传 → NapCat 映射成 markdownElement（见
 * `napcat.mjs` 的 `ob11ToRawConverters[markdown]`）。QQ 不认时发送会报错，
 * 调用方会把这一段换成纯文本「点此填表：<地址>」，图与填写情况照发。
 *
 * @param url 带身份签名的编辑器地址
 */
export const linkSegment = url => ({ type: "markdown", data: { content: `[${FILL_LINK_TEXT}](${url})` } })

/**
 * **带当期时间窗**的编辑器长地址：`<base>/?k=&u=&s=&w=&ws=`
 *
 * 编辑器只认带 `w/ws` 的身份链接（见 `editor/editor.mjs` 的「链接的时间窗」一段），
 * 所以凡是发**长地址**的地方都必须走这里——短链（`/s/<码>`）除外，那条路由在 302 时自己现签窗口。
 *
 * `w` 是"这是哪 5 分钟"（`model/identity.js` 的 `windowEpoch`），`ws` 是它连同身份的 HMAC：
 * 改不动、过期即废。签名密钥没配时退回用口令签（与 `editorUrl` 同一套口径，只在验收不过时才发生）。
 *
 * @param {object} opts base / token / signKey 来自 `config.remote`；qq / nick 是链接身份
 * @param {number} [opts.now] 签发时刻（套件注入用；默认当前时间）
 * @returns {string} 拼不出来的（缺地址 / 缺密钥 / QQ 不合法）返回空串
 */
export function windowedEditorUrl({ base = "", token = "", signKey = "", qq = "", nick = "", now = Date.now() } = {}) {
  const url = editorUrl(base, { token, signKey, qq, nick, now })
  const win = signWindow({ qq }, String(signKey ?? "").trim() || String(token ?? "").trim(), now)
  if (!url || !win) return ""
  return `${url}&w=${win.w}&ws=${encodeURIComponent(win.ws)}`
}

/**
 * 填报入口：**每次都附**，和图一起发（同一条消息）
 *
 * 第一行是填写情况：
 *   未填：<榜名…>；已完成：<榜名…>
 * 「未填」只列还没有自己那一行的榜；「已完成」列已经处理过的榜——主播打完的（表里是主播名）
 * 和自己点过完成的（表里落成了群昵称）都算；还在排队中的榜两边都不提。
 * 三个榜都填过就只有入口——让他随时能回去改已填的那一行（已填的内容也能改，自由度更高）。
 *
 * 第二段是填报入口：
 *   - 群里发的是**短链**（`<编辑器地址>/s/<16 字符码>`），链接字面就是「点此填表」（可选，见 linkSegment）。
 *     码是不透明的（QQ 经置换 + MAC，见 `signTicket`），编辑器验过之后才换成带 `k=` 与身份签名的完整地址，
 *     群名片由编辑器按 QQ 从群名单里自己取——所以码短、链接短，权限口径与长链接完全一样：
 *     编辑器验签后只让他改自己那一行。
 *   - **主人 / 白名单管理员那份走长地址**（`manager: true`）：短码在编辑器侧是"点开时现签窗口"，
 *     拿它当私聊链接就等于永不过期；管理链接要的是**5 分钟作废**，所以私聊那份必须把
 *     当期窗口（`w/ws`）签在链接里——只在本人发 `#排队` 时给一次，窗口一过即失效
 *     （见 `modules/manager-link.js`）。
 *
 * @param ctx 插件实例（取发送者的 QQ 与群昵称）
 * @param sheets 这一轮要看的榜名（#排队 是三个榜，单榜命令就一个）
 * @param active mineView().active（本人名下的行）
 * @param {object} [opts]
 * @param {boolean} [opts.manager] true = 这一份是发给主人 / 白名单管理员的（用带窗口的长地址）
 * @param {number} [opts.now] 时间窗的签发时刻（默认当前时间；调用方与"记录哪个窗口"共用同一个值）
 * @returns {{head: string, seg: object|null, link: string}}
 *          head 填写情况那一行；seg「点此填表」那一段（签不出地址 / 关掉 markdown 时为 null）；link 纯文本兜底
 */
export function fillEntry(ctx, sheets, active, { manager = false, now = Date.now() } = {}) {
  const remote = config.remote ?? {}
  const base = String(remote.url ?? "").trim().replace(/\/+$/, "")
  const token = String(remote.token ?? "").trim()
  const signKey = String(remote.sign_key ?? "").trim()
  const ready = Boolean(base && token && signKey)
  const own = name => active.find(a => a.sheet === name)
  const missing = sheets.filter(name => !own(name))
  const done = sheets.filter(name => isDone(own(name)?.status))
  const head = [missing.length ? `未填：${missing.join("、")}` : "", done.length ? `已完成：${done.join("、")}` : ""]
    .filter(Boolean)
    .join("；")
  if (!ready) return { head, seg: null, link: "暂无链接" }
  /**
   * 短链：云端 / 本机编辑器都要是**带这个路由的版本**；编辑器还没更新时把 remote.short_link
   * 改成 false 就退回长链接（长地址现在也带时间窗，见 windowedEditorUrl）。
   */
  const code = manager || remote.short_link === false ? "" : signTicket({ qq: ctx.e.user_id }, signKey)
  /**
   * 短链后面再挂一段**签名过的签发时刻 + 发送者群昵称**（`?t=&ts=&n=`，见 model/identity.js 的 `signFreshness`）：
   *   - 签发时刻：短码在同一 30 天窗口内是确定性的、认不出新旧，而认领层要靠"谁手里那条更新"
   *     来决定能不能**接管**（主人重新发一次 `#排队` 就该抢回写权限）；
   *   - 群昵称：短码里只有 QQ，编辑器一向按 QQ 从**群名单**里补群名片，而那份名单是每天推一次的
   *     旁路数据——没推成功 / 那人刚进群时名单里就没有他，身份里的昵称会是空的，页面于是认不出
   *     "自己那一行"（现场：主人第一次点自己的链接看到"这个链接里没带上你的群昵称"）。
   *     发链接这一刻机器人手里正好有他的群名片，一起签进去，名单里查不到时编辑器拿它兜底。
   *   两段信息共用同一段签名，改一个字整段作废。旧版编辑器不认这些参数也没关系——它只多看几个
   *   查询参数，路由照旧；反过来，**没带 `n` 时签名输入与从前一字不差**，已经发出去的链接照旧验得过。
   */
  const fresh = code ? signFreshness(code, signKey, now, ctx.nickname()) : null
  const shown = code
    ? `${base}/${SHORT_PATH}/${code}` +
      (fresh ? `?t=${fresh.t}&ts=${encodeURIComponent(fresh.ts)}${fresh.n ? `&n=${fresh.n}` : ""}` : "")
    : windowedEditorUrl({ base, token, signKey, qq: ctx.e.user_id, nick: ctx.nickname(), now })
  if (!shown) return { head, seg: null, link: "暂无链接" }
  return {
    head,
    seg: remote.link_markdown === true ? linkSegment(shown) : null,
    link: `${FILL_LINK_TEXT}：${shown}`,
  }
}
