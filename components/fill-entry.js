/**
 * 填报入口（填写情况 + 「点此填表」短链）
 *
 * 与指令无关：`#排队` 与 `#排队 <榜>` 都要附这一段，内容口径完全一致。
 * 纯拼装 + 签名，不碰文件系统；地址/口令/签名密钥三者缺一就只写「暂无链接」。
 */
import { config } from "./config.js"
import { editorUrl, signTicket, SHORT_PATH } from "../model/identity.js"
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
 * 填报入口：**每次都附**，和图一起发（同一条消息）
 *
 * 第一行是填写情况：
 *   未填：<榜名…>；已完成：<榜名…>
 * 「未填」只列还没有自己那一行的榜；「已完成」列已经处理过的榜——主播打完的（表里是主播名）
 * 和自己点过完成的（表里落成了群昵称）都算；还在排队中的榜两边都不提。
 * 三个榜都填过就只有入口——让他随时能回去改已填的那一行（已填的内容也能改，自由度更高）。
 *
 * 第二段是填报入口：群里发的是**短链**（`<编辑器地址>/s/<16 字符码>`），链接字面就是「点此填表」（可选，见 linkSegment）。
 * 码是不透明的（QQ 经置换 + MAC，见 `signTicket`），编辑器验过之后才换成带 `k=` 与身份签名的完整地址，
 * 群名片由编辑器按 QQ 从群名单里自己取——所以码短、链接短，权限口径与长链接完全一样：
 * 编辑器验签后只让他改自己那一行。
 *
 * @param ctx 插件实例（取发送者的 QQ 与群昵称）
 * @param sheets 这一轮要看的榜名（#排队 是三个榜，单榜命令就一个）
 * @param active mineView().active（本人名下的行）
 * @returns {{head: string, seg: object|null, link: string}}
 *          head 填写情况那一行；seg「点此填表」那一段（签不出地址 / 关掉 markdown 时为 null）；link 纯文本兜底
 */
export function fillEntry(ctx, sheets, active) {
  const base = String(config.remote?.url ?? "").trim().replace(/\/+$/, "")
  const token = String(config.remote?.token ?? "").trim()
  const signKey = String(config.remote?.sign_key ?? "").trim()
  const url =
    base && token && signKey
      ? editorUrl(base, { token, signKey, qq: ctx.e.user_id, nick: ctx.nickname() })
      : ""
  const own = name => active.find(a => a.sheet === name)
  const missing = sheets.filter(name => !own(name))
  const done = sheets.filter(name => isDone(own(name)?.status))
  const head = [missing.length ? `未填：${missing.join("、")}` : "", done.length ? `已完成：${done.join("、")}` : ""]
    .filter(Boolean)
    .join("；")
  if (!url) return { head, seg: null, link: "暂无链接" }
  /**
   * 短链：云端 / 本机编辑器都要是**带这个路由的版本**；编辑器还没更新时把 remote.short_link
   * 改成 false 就退回长链接。
   */
  const code = config.remote?.short_link === false ? "" : signTicket({ qq: ctx.e.user_id }, signKey)
  const shown = code ? `${base}/${SHORT_PATH}/${code}` : url
  return {
    head,
    seg: config.remote?.link_markdown === true ? linkSegment(shown) : null,
    link: `${FILL_LINK_TEXT}：${shown}`,
  }
}
