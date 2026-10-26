/**
 * 文本处理（纯函数，不依赖任何其它模块，避免循环依赖）
 */

export const cleanText = s => String(s ?? "").trim()

const IS_URL = /^https?:\/\/\S+$/i

/** 链接 host → 平台名（只认能确定平台的；其余返回空串） */
const platformOfUrl = url => {
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
  if (host === "live.bilibili.com" || host === "space.bilibili.com" || host === "b23.tv" || host === "bili2233.cn")
    return "B站"
  if (host === "douyin.com" || host.endsWith(".douyin.com")) return "抖音"
  if (host === "huya.com" || host.endsWith(".huya.com")) return "虎牙"
  return ""
}

/** 一段入口文字里有没有提到这个平台（用于把裸链接贴回正确的平台项） */
const mentionsPlatform = (text, platform) => {
  if (platform === "B站") return /b站|bilibili|哔哩/i.test(text)
  if (platform === "抖音") return /抖音|douyin/i.test(text)
  if (platform === "虎牙") return /虎牙|huya/i.test(text)
  return platform ? text.includes(platform) : false
}

/**
 * 把「直播入口」这类文本拆成多项
 *
 * 表格里入口占 **G、H 两列**，而且一格之内还可能用「、」「,」并列多个平台，所以：
 *
 *   1. **每个单元格算一个独立的入口位**：G「B站」+ H「抖音（付费）」= 两项（渲染时各占一行）
 *   2. 同一格内部再按 、 , ， 拆开："B站、抖音" = 两项
 *      **斜杠 `/` 是普通字符，不作分隔符**：所以「B站/抖音」算一项、渲染在同一行
 *      （想让它们各占一行就用「、」或分两格写）
 *   3. 整格是一个链接时，贴到前面最近一个**同平台、还没有链接**的入口上；
 *      找不到同平台入口就单独成项（按 host 认平台），不会贴给无关平台：
 *      G「B站」+ H「https://live.bilibili.com/…」→ "B站https://live.bilibili.com/…"
 *      G「B站、抖音（付费）」+ H「https://live.bilibili.com/…」→ 贴回 B 站那一项，不是抖音
 *      G「B站」+ H「https://live.douyin.com/…」→ 两项：B站、抖音链接（不混成一项）
 *   4. 链接里的斜杠同样不参与拆分
 *
 * 例：
 *   ["群语音通话（屏幕共享）", "腾讯会议370-976-3227"] -> 两项
 *   ["B站", "抖音（付费）"]                            -> 两项
 *   ["B站", "https://live.bilibili.com/196"]           -> ["B站https://live.bilibili.com/196"]
 *   ["B站/抖音", ""]                                   -> ["B站/抖音"]（一项，同一行）
 *   ["B站、抖音", ""]                                  -> ["B站", "抖音"]（两项）
 */
export function splitItems(input) {
  const cells = (Array.isArray(input) ? input : [input]).map(cleanText).filter(Boolean)
  const out = []

  for (const cell of cells) {
    /** 累计中的普通文字（还没成为一项） */
    let buf = ""
    const flush = () => {
      const text = cleanText(buf)
      buf = ""
      if (text) out.push({ text, url: "" })
    }
    const attach = url => {
      const platform = platformOfUrl(url)
      /**
       * 裸链接优先贴回**同一个平台**的入口，而不是无脑贴最后一个。
       *
       * 例：G「B站、抖音（付费）」+ H「https://live.bilibili.com/…」——最后一项是抖音，
       * 旧实现会把 B 站链接贴到抖音上；现在按 host 找 B 站那一项。
       *
       * 带平台名的链接在表格里找不到同平台入口时**单独成项**（不贴给无关平台），
       * 由 `parseEntry()` 再按 host 认平台；这样抖音链接不会被算到 B 站头上。
       * 认不出平台的链接（会议地址等）仍按原来的"贴最近一个还没有链接的入口"。
       */
      const match = platform ? [...out].reverse().find(i => !i.url && mentionsPlatform(i.text, platform)) : null
      if (match) match.url += url
      else if (platform) out.push({ text: "", url })
      else {
        const last = out[out.length - 1]
        if (last && !last.url) last.url += url
        else out.push({ text: "", url })
      }
    }

    /** 按「链接」与「分隔符」切：捕获组给出链接，分隔符位置是 undefined（斜杠不在这里） */
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
