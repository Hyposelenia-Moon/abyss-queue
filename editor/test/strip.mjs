/**
 * 测试辅助：把命中的片段整段剪掉（**不用一遍 `replace`**）
 *
 * 单遍删除会让两边拼出新的可命中串（`<scr<script>ipt>` → `<script>`），CodeQL 的
 * `js/incomplete-multi-character-sanitization` 说的就是这种写法。这里反复剪到不动点。
 *
 * 只服务于假 DOM 与静态扫描：真页面里的同类工作由 `editor/config.js` 的净化负责。
 */

/**
 * @param {string} text 原文
 * @param {RegExp[]} patterns 要剪掉的片段（没有 `g` 标志会自动补上）
 * @returns {string} 剪干净的文本
 */
export const cutSpans = (text, patterns) => {
  let out = String(text ?? "")
  for (let guard = 0; guard < 20; guard++) {
    const spans = []
    for (const re of patterns) {
      const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`
      for (const m of out.matchAll(new RegExp(re.source, flags))) spans.push([m.index, m.index + m[0].length])
    }
    if (!spans.length) return out
    spans.sort((a, b) => a[0] - b[0])
    let next = ""
    let cursor = 0
    for (const [start, end] of spans) {
      if (start < cursor) continue
      next += out.slice(cursor, start)
      cursor = end
    }
    out = next + out.slice(cursor)
  }
  return out
}

/**
 * 剪掉内联 `<script>`（连同内容）
 *
 * 闭合标签不止 `</script>` 一种写法：`</script >`、`</script\t\n bar>` 在浏览器里一样结束元素
 * （标签名后面开始就是属性区，属性被忽略）。所以尾巴用 `\b[^>]*>` 而不是 `\s*>`——
 * 后者只认空白，CodeQL 的 `js/bad-tag-filter` 点的就是这个。
 *
 * 只用于测试脚手架：真页面的脚本由 CSP 管，不走文本剪裁。
 */
export const stripScripts = html => cutSpans(html, [/<script\b[\s\S]*?<\/script\b[^>]*>/gi])