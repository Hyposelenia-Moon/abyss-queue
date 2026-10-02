/**
 * 文本处理（纯函数，不依赖任何其它模块，避免循环依赖）
 */

/** 去首尾空白 */
export const cleanText = s => String(s ?? "").trim()

/**
 * 把「平台 / 其他」这类并列文本拆成多项，**保护 http 链接不被斜杠拆碎**
 *
 * 例：
 *   "B站 / 抖音"                     -> ["B站", "抖音"]
 *   "B站https://live.bilibili.com/1" -> ["B站https://live.bilibili.com/1"]
 *   "B站 / 抖音 https://a/b"         -> ["B站https://a/b", "抖音"]
 * 链接按顺序贴回它前面的那一项；多出来的链接单独成项。
 */
export function splitItems(input) {
  const raw = (Array.isArray(input) ? input : [input]).map(cleanText).filter(Boolean)
  const urls = []
  const text = raw
    .map(s =>
      s.replace(/https?:\/\/\S+/gi, m => {
        urls.push(m)
        return "\u0000"
      }),
    )
    .join(" ")

  const parts = text
    .split(/[\/、,，\u0000]/)
    .map(cleanText)
    .filter(Boolean)

  const out = []
  let i = 0
  for (const part of parts) out.push(part + (urls[i++] ?? ""))
  for (; i < urls.length; i++) out.push(urls[i])
  return out
}
