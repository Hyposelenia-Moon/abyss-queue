/**
 * 共用模块的加载口
 *
 * 表格读写、别名归一这些逻辑**只有一份实现**（复制一份迟早漂移，那才是会污染数据的做法），
 * 所以编辑器按绝对路径去插件目录加载共用模块。
 *
 * 编辑器住在插件里（`<plugin>/editor/test/`）时插件根就是上两级；
 * 也兼容旧布局（编辑器单独放在插件旁边、两个仓库并排）。
 * 两种都可用 `ABYSS_PLUGIN_DIR` 覆盖。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

const inside = path.resolve(HERE, "..", "..")
export const PLUGIN_DIR = path.resolve(
  process.env.ABYSS_PLUGIN_DIR ??
    (fs.existsSync(path.join(inside, "components", "pluginVersion.js")) ? inside : path.join(inside, "abyss-queue")),
)

/** 从插件目录加载某个模块 */
export const shared = rel => import(pathToFileURL(path.join(PLUGIN_DIR, rel)).href)
