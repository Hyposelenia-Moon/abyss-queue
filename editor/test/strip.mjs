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