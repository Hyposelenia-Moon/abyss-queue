/**
 * 填报入口（填写情况 + 纯文本链接）
 *
 * 与指令无关：`#排队` 与 `#排队 <榜>` 都要附这一段，内容口径完全一致。
 * 链接只有一种形态：**带当期时间窗的长地址**（`windowedEditorUrl`）。
 * 纯拼装 + 签名，不碰文件系统；地址/口令/签名密钥三者缺一就只写「暂无链接」。
 */
import { config } from "./config.js"
import { editorUrl, signWindow, WINDOW_SIG_CHARS } from "../model/identity.js"
import { isDone, statusOf } from "../modules/progress.js"

/**
 * **带当期时间窗**的编辑器长地址：`<base>/?k=&u=&s=&w=&ws=`
 *
 * `ws` 在群链接里截到前 20 个字符（见 `model/identity.js` 的 `WINDOW_SIG_CHARS`）；旧链接里的完整签名仍兼容。
 *
 * `w` 是"这是哪 5 分钟"（`model/identity.js` 的 `windowEpoch`），`ws` 是它连同身份的 HMAC：
 * 改不动、过期即废。签名密钥没配时退回用口令签（与 `editorUrl` 同一套口径，只在验收不过时才发生）。
 *
 * 身份**只有链接这一个来源**：谁点进来就是谁（`u/s` 里的 QQ）。能写多少由本群守卫
 * （这个 QQ 在不在群成员名单里）决定，没有设备认领、也没有"链接是不是最新一条"这一层。
 *
 * @param {object} opts base / token / signKey 来自 `config.editor`；qq / nick 是链接身份
 * @param {number} [opts.now] 签发时刻（套件注入用；默认当前时间）
 * @returns {string} 拼不出来的（缺地址 / 缺密钥 / QQ 不合法）返回空串
 */
export function windowedEditorUrl({ base = "", token = "", signKey = "", qq = "", nick = "", now = Date.now() } = {}) {
  const url = editorUrl(base, { token, signKey, qq, nick, now })
  const win = signWindow({ qq }, String(signKey ?? "").trim() || String(token ?? "").trim(), now)
  if (!url || !win) return ""
  /**
   * `ws` 截到 20 字符：QQ 会按**完整 URL** 风控（264 字符被拦），整条链接要控制在 255 以内。
   */
  const ws = String(win.ws).slice(0, WINDOW_SIG_CHARS)
  return `${url}&w=${win.w}&ws=${encodeURIComponent(ws)}`
}

/**
 * 填报入口：**每次都附**，和图一起发（同一条消息）
 *
 * 第一行是填写情况，只留两段（2026-10-26 维护者：「取消所有未填提示，只显示未完成与已完成」）：
 *   未完成：<榜名…>；已完成：<榜名…>
 * 空的段直接不写；**没有自己那一行的榜两边都不列**（不再写「未填」）。
 *   - 「未完成」= 有自己那一行，且状态明确是 `排队中`；
 *   - 「已完成」= 主播打完的（表里是主播名）和自己点过完成的（表里落成了群昵称）。
 *   - `等待开启` / 空状态：还没真正排队，不写进任何一段。
 * 三个榜都填过就只有入口——让他随时能回去改已填的那一行（已填的内容也能改，自由度更高）。
 *
 * 第二段是填报入口：**纯文本**「点此填表：<带时间窗的长地址>」。
 * 群内普通成员这一份在 `apps/queue.js` 的 `prepareEntry()` 里会换成 `#code=` 短码（登记簿换回同一条链接）。
 *
 * @param ctx 插件实例（取发送者的 QQ 与群昵称）
 * @param sheets 这一轮要看的榜名（#排队 是三个榜，单榜命令就一个）
 * @param active mineView().active（本人名下的行）
 * @param {object} [opts]
 * @param {boolean} [opts.manager] true = 这一份是发给主人 / 白名单管理员的
 * @param {number} [opts.now] 时间窗的签发时刻（默认当前时间；调用方与"记录哪个窗口"共用同一个值）
 * @returns {{head: string, link: string}} head 填写情况那一行；link 纯文本入口
 */
export function fillEntry(ctx, sheets, active, { manager = false, now = Date.now(), nick = "" } = {}) {
  const editor = config.editor ?? {}
  const base = String(editor.public_url ?? "").trim().replace(/\/+$/, "")
  const token = String(editor.token ?? "").trim()
  const signKey = String(editor.sign_key ?? "").trim()
  const ready = Boolean(base && token && signKey)
  /**
   * 签进链接的"我是谁"用哪个名字：**调用方给出的优先**（通常就是表里那一行的群昵称），
   * 没有再用 `ctx.nickname()`。现场（2026-10-18）：机器人拿到的名片是错的（QQ 昵称「绒月.」），
   * 而表里那一行写的是群昵称「希珀塞莱妮娅」——按错的名字签进 `?n=`，
   * 编辑器就会拿它去认"本人那一行"，照样认不出来。
   */
  const qq = String(ctx.e?.user_id ?? "").trim()
  /**
   * 退路里再排一遍候选：机器人偶尔拿不到群名片，`ctx.nickname()` 会回落成 QQ 号。
   * 把 QQ 号本身从候选里剔掉，优先用 `ctx.nicknames()`（名片 → 群名单 → QQ 名牌）；
   * 全部都没有才留空，由页面提示「这个链接里没有你的群昵称」。
   */
  const candidates = [nick, ctx.nickname?.(), ...(typeof ctx.nicknames === "function" ? ctx.nicknames() : [])]
  const selfNick = candidates.map(name => String(name ?? "").trim()).find(name => name && name !== qq) || ""
  const own = name => active.find(a => a.sheet === name)
  const done = sheets.filter(name => isDone(own(name)?.rawStatus))
  /** 未完成只认「有自己那一行 + 原始状态明确是排队中」；未填/等待开启不列 */
  const queuing = sheets.filter(name => {
    const item = own(name)
    return Boolean(item) && statusOf(item.rawStatus) === "queued"
  })
  const head = [
    queuing.length ? `未完成：${queuing.join("、")}` : "",
    done.length ? `已完成：${done.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；")
  if (!ready) return { head, link: "暂无链接" }
  const shown = windowedEditorUrl({ base, token, signKey, qq: ctx.e.user_id, nick: selfNick, now })
  if (!shown) return { head, link: "暂无链接" }
  return { head, link: `点此填表：${shown}` }
}
