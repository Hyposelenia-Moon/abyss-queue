/**
 * 插件根定位与「共用模块」加载
 *
 * **表格读写只保留一份实现**：复制一套 xlsx/表格逻辑迟早会跟插件漂移，那才是真正会污染数据的做法，
 * 所以编辑器按绝对路径从插件目录加载插件的 `lib/` / `components/` / `model/`。
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

/** 按相对路径加载插件里的共用模块（`shared("lib/identity.js")`） */
export const makeShared = pluginDir => rel => import(pathToFileURL(path.join(pluginDir, rel)).href)
