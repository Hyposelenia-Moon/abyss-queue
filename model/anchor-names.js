/** 主播在**群里的名字**：表里怎么叫 → 群里怎么叫（`<插件根>/data/anchor-names.json`） */
import fs from "node:fs"
import path from "node:path"
import { config, pluginRoot } from "../components/config.js"
import { log } from "../components/logger.js"

export const anchorNamesPaths = () => {
  const inside = String(config.anchorNamesPath ?? "").trim()
  const outside = path.resolve(pluginRoot, "..", "..", "data", "anchor-names.json")
  const list = [inside, outside].filter(Boolean).filter((p, i, all) => all.indexOf(p) === i)
  return list
}

export const anchorNamesPath = () => {
  const list = anchorNamesPaths()
  return list.find(p => fs.existsSync(p)) ?? list[0] ?? ""
}

const cleanNames = raw => {
  const out = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    const name = String(key ?? "").trim()
    const to = String(value ?? "").trim().replace(/^@+/, "")
    if (name && to) out[name] = to
  }
  return out
}

export const readAnchorNames = (file = anchorNamesPath()) => {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if (err?.code !== "ENOENT")
      log("warn", `[abyss-queue] 读主播名字映射失败（${file}）——本次按"没有特殊名字"处理：${err?.message ?? err}`)
    return {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return cleanNames(raw.names && typeof raw.names === "object" ? raw.names : raw)
}

export const groupNameOfAnchor = (name, names = null) => {
  const key = String(name ?? "").trim()
  if (!key) return ""
  const map = names ?? readAnchorNames()
  return String(map[key] ?? key).trim()
}
