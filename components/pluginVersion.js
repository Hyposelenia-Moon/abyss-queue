/** 版本号：供回复页脚使用（读 package.json，避免两处手改不同步） */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const pluginRoot = path.resolve(import.meta.dirname, "..")

const pkg = createRequire(import.meta.url)("../package.json")

export const pluginVersion = pkg.version ?? "0.0.0"

const UNKNOWN = "未知"

const DEFAULT_FRAMEWORK = "Yunzai-Bot"
const frameworkName = name => (/trss/i.test(String(name ?? "")) ? "TRSS-Yunzai" : DEFAULT_FRAMEWORK)

function readHost() {
  try {
    const pluginsDir = path.dirname(pluginRoot)
    if (path.basename(pluginsDir).toLowerCase() !== "plugins") return { name: DEFAULT_FRAMEWORK, version: UNKNOWN }
    const host = JSON.parse(fs.readFileSync(path.join(path.dirname(pluginsDir), "package.json"), "utf8"))
    return {
      name: frameworkName(host?.name),
      version: String(host?.version ?? "").trim() || UNKNOWN,
    }
  } catch {
    return { name: DEFAULT_FRAMEWORK, version: UNKNOWN }
  }
}

const host = readHost()

export const yunzaiName = host.name

export const yunzaiVersion = host.version

export const versionFooter = name => `Created By ${yunzaiName} ${yunzaiVersion} & ${name} ${pluginVersion}`
