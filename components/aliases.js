/**
 * 主播别名（纯函数）
 *
 * 表里、群里对同一位主播常有多种写法：老昵称、简称、群名片与表里名字不一致。
 * 别名表把「别名 → 正名」的关系写下来，读的时候归一，避免同一个人被当成两个：
 *
 *   anchor_aliases:
 *     阿修Axiu: ["阿修"]
 *     摸头妹: ["璃月第一深情"]
 *
 * 别名按**正则**匹配（整串匹配、忽略大小写），所以 `阿修.*` 这类写法也可以。
 */

/**
 * 编译配置里的别名表
 * @param {Object<string, string|string[]>} map 正名 → 别名（可写正则）
 * @returns {Array<{name: string, re: RegExp, pattern: string}>}
 */
export function compileAliases(map) {
  const out = []
  for (const [name, list] of Object.entries(map ?? {})) {
    const canonical = String(name ?? "").trim()
    if (!canonical) continue
    for (const pattern of [].concat(list ?? [])) {
      const text = String(pattern ?? "").trim()
      if (!text) continue
      try {
        out.push({ name: canonical, re: new RegExp(`^(?:${text})$`, "i"), pattern: text })
      } catch {
        /** 配置里写了非法正则就跳过这一条，不要让整张表打不开 */
      }
    }
  }
  return out
}

/**
 * 归一成正名：命中别名就返回正名，否则原样返回
 * @param {string} name 表里/群里的写法
 * @param {Array} aliases compileAliases() 的结果
 */
export function canonicalAnchor(name, aliases = []) {
  const text = String(name ?? "").trim()
  if (!text) return ""
  for (const a of aliases) if (a.re.test(text)) return a.name
  return text
}

/** 这个名字是不是某位主播的别名（用于说明"其实是谁"） */
export function aliasOf(name, aliases = []) {
  const text = String(name ?? "").trim()
  if (!text) return null
  for (const a of aliases) if (a.re.test(text)) return a.name
  return null
}
