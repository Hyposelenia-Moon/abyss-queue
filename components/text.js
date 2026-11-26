/** 文本处理（纯函数，不依赖任何其它模块，避免循环依赖） */

export const cleanText = s => String(s ?? "").trim()

const IS_URL = /^https?:\/\/\S+$/i

/** B 站域名（只认这几个；抖音、虎牙这些不做了） */
export const BILI_HOSTS = new Set(["live.bilibili.com", "space.bilibili.com", "b23.tv", "bili2233.cn"])

const platformOfUrl = url => {
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
  return BILI_HOSTS.has(host) ? "B站" : ""
}

const mentionsBili = text => /b站|bilibili|哔哩/i.test(text)

const ANY_PLATFORM = /b站|bilibili|哔哩|抖音|douyin|虎牙|huya|腾讯会议|群语音|屏幕共享/i

export function splitItems(input) {
  const cells = (Array.isArray(input) ? input : [input]).map(cleanText).filter(Boolean)
  const out = []
  for (const cell of cells) {
    let buf = ""
    const flush = () => {
      const text = cleanText(buf)
      buf = ""
      if (text) out.push({ text, url: "" })
    }
    const attach = url => {
      const platform = platformOfUrl(url)
      const match = platform === "B站" ? [...out].reverse().find(i => !i.url && mentionsBili(i.text)) : null
      if (match) match.url += url
      else if (platform) out.push({ text: "", url })
      else {
        /** 认不出平台的链接贴最近一个还没有链接的入口，但别贴到 B 站头上 */
        const last = [...out].reverse().find(i => !i.url)
        if (last && !mentionsBili(last.text)) last.url += url
        else out.push({ text: "", url })
      }
    }
    for (const chunk of cell.split(/(https?:\/\/\S+)|[、,，]/g)) {
      if (chunk === undefined) flush()
      else if (IS_URL.test(chunk)) {
        flush()
        attach(chunk)
      } else buf += chunk
    }
    flush()
  }
  return out.map(i => i.text + i.url).filter(Boolean)
}
