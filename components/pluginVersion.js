/**
 * 版本号：供回复页脚使用（读 package.json，避免两处手改不同步）
 *
 * 两个版本号都按**本文件自身位置**推导（与 components/config.js 推 pluginRoot 是同一套做法），
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

/**
 * 读 bot 根（Yunzai）的版本号
 *
 * 路径推导与落点口径一致：插件挂在 `<bot根>/plugins/<插件目录>` 下，所以 bot 根是插件根往上两级。
 * 判据是**上一级目录名必须叫 `plugins`**——不满足就说明这份代码不在部署布局里
 * （开发仓库、并排布局、合成宿主），此时不拿别的目录碰运气，直接给"未知"。
 *
 * @returns {string} bot 根 `package.json` 的 `version`；读不到时 `UNKNOWN`
 */
function readYunzaiVersion() {
  try {
    const pluginsDir = path.dirname(pluginRoot)
    if (path.basename(pluginsDir).toLowerCase() !== "plugins") return UNKNOWN
    const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(pluginsDir), "package.json"), "utf8"))
    return String(version ?? "").trim() || UNKNOWN
  } catch {
    /** bot 根没有 `package.json`（或它不是合法 JSON）不算错误：插件照常工作 */
    return UNKNOWN
  }
}

export const yunzaiVersion = readYunzaiVersion()

/** 页脚文案：Created By Yunzai-Bot <宿主版本> & <插件名> <插件版本>（口径见 AGENTS.md §3.5） */
export const versionFooter = name => `Created By Yunzai-Bot ${yunzaiVersion} & ${name} ${pluginVersion}`
