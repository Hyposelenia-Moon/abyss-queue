/** 插件根定位与「共用模块」加载 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const HERE = path.dirname(fileURLToPath(import.meta.url))

export const pluginRoot = path.resolve(HERE, "..")

export const TEMPLATE = path.join(HERE, "editor.html")

export function resolvePluginDir(flag) {
  const inside = pluginRoot
  const fallback = fs.existsSync(path.join(inside, "components", "pluginVersion.js"))
    ? inside
    : path.resolve(HERE, "..", "abyss-queue")
  return path.resolve(flag("--plugin", process.env.ABYSS_PLUGIN_DIR ?? fallback))
}

export const makeShared = pluginDir => rel => import(pathToFileURL(path.join(pluginDir, rel)).href)

const UNKNOWN = "未知"

const DEFAULT_FRAMEWORK = "Yunzai-Bot"
const frameworkName = name => (/trss/i.test(String(name ?? "")) ? "TRSS-Yunzai" : DEFAULT_FRAMEWORK)

const text = value => String(value ?? "").trim() || UNKNOWN

const readManifest = pluginDir => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))
  } catch {
    return {}
  }
}

function host(pluginDir) {
  try {
    const pluginsDir = path.dirname(pluginDir)
    if (path.basename(pluginsDir).toLowerCase() !== "plugins") return { name: DEFAULT_FRAMEWORK, version: UNKNOWN }
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(pluginsDir), "package.json"), "utf8"))
    return { name: frameworkName(pkg?.name), version: text(pkg?.version) }
  } catch {
    return { name: DEFAULT_FRAMEWORK, version: UNKNOWN }
  }
}

async function pluginName(pluginDir) {
  try {
    const { PLUGIN_NAME } = await makeShared(pluginDir)("components/constants.js")
    return text(PLUGIN_NAME)
  } catch {
    return UNKNOWN
  }
}

export async function attributionLine(pluginDir) {
  const pkg = readManifest(pluginDir)
  const { name, version } = host(pluginDir)
  return `Created By ${name} ${version} & ${await pluginName(pluginDir)} ${text(pkg.version)}`
}
