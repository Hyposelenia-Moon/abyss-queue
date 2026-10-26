/**
 * 直播入口解析（纯函数，不联网）
 *
 * 主播区 G/H 两列是**手填文本**，写法很自由（见 README「主播的直播入口」）：
 *   `B站`、`B站https://live.bilibili.com/1960956034`、`https://space.bilibili.com/123`、
 *   `B站/抖音（付费）`、`群语音通话（屏幕共享）`…
 *
 * 展示层要的只是"这一项是什么平台、有没有可查的房间号"，所以这里把每条入口拆成
 * `{ text, platform, url, kind, roomId, uid }`；**原文一个字都不改**，查不到就原样展示。
 *
 * **只认 B 站直播/空间的公开 id**：这两类能在不登录的情况下查状态（见 model/live-status.js）。
 * 抖音 / 虎牙 / 腾讯会议等只记平台名，不猜 id、不拼接口。
 */

const clean = s => String(s ?? "").trim()

/** 从一段文字里取出第一个 http(s) 地址（遇到空白、中文逗号顿号、尖引号就截断） */
const URL_RE = /https?:\/\/[^\s<>"'、，,]+/i

/** 去掉粘贴时常见的尾部标点 */
const trimUrl = url => url.replace(/[)\]）】。；;]+$/, "")

/**
 * 解析一条入口
 * @param {string} raw G/H 单元格里的一项（已按 `、,，` 拆过）
 * @returns {{text:string, platform:string, url:string, kind:"bili-live"|"bili-space"|"bili-short"|"other", roomId:string, uid:string}}
 */
export function parseEntry(raw) {
  const text = clean(raw)
  const url = trimUrl(URL_RE.exec(text)?.[0] ?? "")
  const out = { text, platform: "", url, kind: "other", roomId: "", uid: "" }
  /** 链接 host 认出来的平台优先于文字（「B站/抖音（付费）」后面跟抖音链接时不能算 B 站） */
  let hostPlatform = ""
  if (url) {
    let u = null
    try {
      u = new URL(url)
    } catch {
      u = null
    }
    if (u) {
      const host = u.hostname.toLowerCase()
      const segs = u.pathname.split("/").filter(Boolean)
      if (host === "live.bilibili.com") {
        out.kind = "bili-live"
        hostPlatform = "B站"
        /** `/1960956034`、`/blanc/1960956034`、`/h5/1960956034` 都取最后一段数字 */
        out.roomId = [...segs].reverse().find(s => /^\d+$/.test(s)) ?? ""
      } else if (host === "space.bilibili.com") {
        out.kind = "bili-space"
        hostPlatform = "B站"
        out.uid = segs.find(s => /^\d+$/.test(s)) ?? ""
      } else if (host === "b23.tv" || host === "bili2233.cn") {
        /** 短链不解析（要额外请求跳转），只标记，避免把短码当房间号 */
        out.kind = "bili-short"
        hostPlatform = "B站"
      } else if (host.endsWith("douyin.com")) {
        hostPlatform = "抖音"
      } else if (host.endsWith("huya.com")) {
        hostPlatform = "虎牙"
      }
    }
  }
  if (hostPlatform) out.platform = hostPlatform
  else if (/b站|bilibili|哔哩/i.test(text)) out.platform = "B站"
  else if (/抖音|douyin/i.test(text)) out.platform = "抖音"
  else if (/虎牙|huya/i.test(text)) out.platform = "虎牙"
  else if (/腾讯会议/i.test(text)) out.platform = "腾讯会议"
  else if (/群语音|屏幕共享/i.test(text)) out.platform = "群语音"
  return out
}

/** 一批入口 → 解析结果（空串丢掉） */
export const parseEntries = entries =>
  (Array.isArray(entries) ? entries : [entries]).map(parseEntry).filter(e => e.text)

/**
 * 一条入口的缓存键：B 站直播间 / UP 主各有稳定 id；其余返回空串（不参与查状态）
 * @returns {string} `room:1960956034` / `uid:123` / `""`
 */
export const biliKey = e => (e?.roomId ? `room:${e.roomId}` : e?.uid ? `uid:${e.uid}` : "")

/**
 * 从一批入口里收集需要查状态的 B 站引用（按 key 去重）
 * @returns {Array<{key:string, roomId:string, uid:string, entry:object}>}
 */
export function collectBiliRefs(entries) {
  const seen = new Map()
  for (const entry of parseEntries(entries)) {
    const key = biliKey(entry)
    if (!key || seen.has(key)) continue
    seen.set(key, { key, roomId: entry.roomId, uid: entry.uid, entry })
  }
  return [...seen.values()]
}

/** 状态 → 人话（只认两种；未知返回空串） */
export const liveLabel = state => (state === "live" ? "直播中" : state === "off" ? "未开播" : "")

/** 入口文字后面的状态后缀（未知不加，避免把"不知道"写成"未开播"） */
export const liveSuffix = live => (live?.label ? `（${live.label}）` : "")
