/**
 * 文本处理（纯函数，不依赖任何其它模块，避免循环依赖）
 */

export const cleanText = s => String(s ?? "").trim()

const IS_URL = /^https?:\/\/\S+$/i

/**
 * 把「直播入口」这类文本拆成多项
 *
 * 表格里入口占 **G、H 两列**，而且一格之内还可能用「、」「,」并列多个平台，所以：
 *
 *   1. **每个单元格算一个独立的入口位**：G「B站」+ H「抖音（付费）」= 两项（渲染时各占一行）
 *   2. 同一格内部再按 、 , ， 拆开："B站、抖音" = 两项
 *      **斜杠 `/` 不再是分隔符**：它是普通字符，所以「B站/抖音」算一项、渲染在同一行
 *      （想让它们各占一行就用「、」或分两格写）
 *   3. 整格是一个链接时，贴到前面最近一个**还没有链接**的入口上：
 *      G「B站」+ H「https://live.bilibili.com/…」→ "B站https://live.bilibili.com/…"（只有一行）
 *      没有可贴的入口就单独成项
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
      const last = out[out.length - 1]
      if (last && !last.url) last.url += url
      else out.push({ text: "", url })
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
