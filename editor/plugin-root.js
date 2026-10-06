/**
 * 插件根定位与「共用模块」加载
 *
 * **表格读写只保留一份实现**：复制一套 xlsx/表格逻辑迟早会跟插件漂移，那才是真正会污染数据的做法，
 * 所以编辑器按绝对路径从插件目录加载插件的 `components/` / `model/` / `modules/`。
 *
 * 编辑器住在插件里（`<插件根>/editor/editor.mjs`），插件根是上一级；
 * 编辑器与插件目录并排（同级 `abyss-queue`）时按并排布局推。
 * 两种都能用 `--plugin <dir>` / 环境变量 `ABYSS_PLUGIN_DIR` 覆盖。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** 本文件所在目录（`<插件根>/editor`；注意不是插件根） */
export const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 插件根（`editor/` 的上一级） */
export const pluginRoot = path.resolve(HERE, "..")

/** 前端模板：与入口同目录，编辑器把它整份发给浏览器 */
export const TEMPLATE = path.join(HERE, "editor.html")

/**
 * 解析插件根：优先 `--plugin` / `ABYSS_PLUGIN_DIR`，否则按"自己住在插件里"推
 * （判据是插件根下有 `components/pluginVersion.js`；没有就按并排布局取同级 `abyss-queue`）
 *
 * @param {(name:string, fallback?:string)=>string} flag argv 取值函数（见 cli.js）
 */
export function resolvePluginDir(flag) {
  const inside = pluginRoot
  const fallback = fs.existsSync(path.join(inside, "components", "pluginVersion.js"))
    ? inside
    : path.resolve(HERE, "..", "abyss-queue")
  return path.resolve(flag("--plugin", process.env.ABYSS_PLUGIN_DIR ?? fallback))
}

/** 按相对路径加载插件里的共用模块（`shared("model/identity.js")`） */
export const makeShared = pluginDir => rel => import(pathToFileURL(path.join(pluginDir, rel)).href)

/** 读不出来的占位：人一眼看得出"没取到"，又不至于把页脚整行吞掉（与 components/pluginVersion.js 同一口径） */
const UNKNOWN = "未知"

/** 取成非空字符串：空 / 缺一律「未知」 */
const text = value => String(value ?? "").trim() || UNKNOWN

/**
 * 插件根下的 `package.json`
 *
 * 编辑器**自己读**，不经插件的 `components/`：编辑器可能按并排布局部署，静态 import 插件模块在那种
 * 布局下会直接解析失败。读不到 / 不是合法 JSON 一律给空对象——页脚少一个号不该让编辑器起不来。
 */
const readManifest = pluginDir => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))
  } catch {
    return {}
  }
}

/**
 * bot 根（Yunzai）的版本号
 *
 * 判据与 `components/pluginVersion.js` 同一口径：插件根必须挂在 `plugins/` 下（部署布局），
 * 那时 bot 根才是插件根的上一级；否则（开发仓库 / 并排布局）不拿别的目录碰运气，直接给「未知」。
 */
function hostVersion(pluginDir) {
  try {
    const pluginsDir = path.dirname(pluginDir)
    if (path.basename(pluginsDir).toLowerCase() !== "plugins") return UNKNOWN
    return text(JSON.parse(fs.readFileSync(path.join(path.dirname(pluginsDir), "package.json"), "utf8")).version)
  } catch {
    /** bot 根没有 `package.json`（或它不是合法 JSON）不算错误：页脚照常画 */
    return UNKNOWN
  }
}

/**
 * 插件显示名
 *
 * 与 `components/pluginVersion.js` 的 `versionFooter` 同源：插件 `components/constants.js` 的 `PLUGIN_NAME`
 * （回复页脚用的就是它）。走 `makeShared` 动态加载——不是静态 import，并排布局照样能推；
 * 加载不到 / 没这个常量就给「未知」，不抛错。
 */
async function pluginName(pluginDir) {
  try {
    const { PLUGIN_NAME } = await makeShared(pluginDir)("components/constants.js")
    return text(PLUGIN_NAME)
  } catch {
    return UNKNOWN
  }
}

/**
 * 规范署名行：`Created By Yunzai-Bot {yunzaiVersion} & {PluginName} {pluginVersion}`（口径见 AGENTS.md §3.5）
 *
 * 编辑器页脚在**配置提供的自由 HTML 之后**追加这一行（见 `editor/config.js` 的 `footerHtml`）：
 * 它是规范署名，不从配置里取——所以版本号也不会被硬编码进 `footer.html` 的默认文本里。
 * 两个版本号都按**编辑器自己定位到的插件根**推导，不用 `process.cwd()`；推导不到一律「未知」。
 *
 * @param {string} pluginDir 编辑器定位到的插件根（见 `resolvePluginDir`）
 * @returns {Promise<string>}
 */
export async function attributionLine(pluginDir) {
  const pkg = readManifest(pluginDir)
  return `Created By Yunzai-Bot ${hostVersion(pluginDir)} & ${await pluginName(pluginDir)} ${text(pkg.version)}`
}
