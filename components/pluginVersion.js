/**
 * 版本号：供回复页脚使用（读 package.json，避免两处手改不同步）
 *
 * 框架名与两个版本号都按**本文件自身位置**推导（与 components/config.js 推 pluginRoot 是同一套做法），
 * 不用 `process.cwd()`：cwd 随启动方式变，而部署布局固定是 `<bot根>/plugins/<插件目录>`。
 * 推导不到一律降级成"未知"，不抛错——页脚上少一个号不该把整条回复拖没。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

/** 插件根：本文件在 `components/` 下，向上一级 */
const pluginRoot = path.resolve(import.meta.dirname, "..")

const pkg = createRequire(import.meta.url)("../package.json")

export const pluginVersion = pkg.version ?? "0.0.0"

/** 读不出来时页脚上的占位：人一眼看得出"没取到"，又不至于让页脚断掉 */
const UNKNOWN = "未知"

/** 框架名的默认值与判据：bot 根 `package.json` 的 `name` 含 `trss` ⇒ TRSS-Yunzai，其余是原版 */
const DEFAULT_FRAMEWORK = "Yunzai-Bot"
const frameworkName = name => (/trss/i.test(String(name ?? "")) ? "TRSS-Yunzai" : DEFAULT_FRAMEWORK)

/**
 * 读 bot 根（Yunzai）的显示名与版本号
 *
 * 路径推导与落点口径一致：插件挂在 `<bot根>/plugins/<插件目录>` 下，所以 bot 根是插件根往上两级。
 * 判据是**上一级目录名必须叫 `plugins`**——不满足就说明这份代码不在部署布局里
 * （开发仓库、并排布局、合成宿主），此时不拿别的目录碰运气，直接给默认框架名与"未知"。
 *
 * @returns {{ name: string, version: string }} 框架显示名（TRSS-Yunzai / Yunzai-Bot）与版本号
 */
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
    /** bot 根没有 `package.json`（或它不是合法 JSON）不算错误：插件照常工作 */
    return { name: DEFAULT_FRAMEWORK, version: UNKNOWN }
  }
}

const host = readHost()

/** 框架显示名：TRSS 与原版在页脚上的写法不同（判据与 Axiu-Plugin 的 pluginVersion.js 同一条） */
export const yunzaiName = host.name

export const yunzaiVersion = host.version

/** 页脚文案：Created By <框架名> <宿主版本> & <插件名> <插件版本>（口径见 AGENTS.md §3.5） */
export const versionFooter = name => `Created By ${yunzaiName} ${yunzaiVersion} & ${name} ${pluginVersion}`
