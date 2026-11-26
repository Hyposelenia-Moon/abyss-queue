/** 主播别名（纯函数） */

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
      }
    }
  }
  return out
}

export function canonicalAnchor(name, aliases = []) {
  const text = String(name ?? "").trim()
  if (!text) return ""
  for (const a of aliases) if (a.re.test(text)) return a.name
  return text
}

export function aliasOf(name, aliases = []) {
  const text = String(name ?? "").trim()
  if (!text) return null
  for (const a of aliases) if (a.re.test(text)) return a.name
  return null
}
