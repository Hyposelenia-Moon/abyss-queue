/**
 * 编辑器套件的「被测表格」来源（与插件套件同一口径）
 *
 * 以前这里每个套件都自己写一条路径：
 *   `process.argv[2] ?? XLSX_PATH ?? <插件同级目录>/2026年10月三路深渊排队.xlsx`
 * 拿不到就整套 `exit 0` —— 干净克隆上这些套件一条都没跑（外部审核「改进意见 #3」）。
 *
 * 现在统一走插件 `test/_helper.mjs` 的三层来源（显式 XLSX_PATH > 维护者真实表 > 合成样本），
 * 那里只有一份实现，插件套件与编辑器套件不会漂移；本模块负责"加载 + 顶层 await 一次"。
 *
 * 用法：`import { SOURCE } from "./source.mjs"`
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PLUGIN_DIR } from "./plugin.mjs"

const helper = await import(pathToFileURL(path.join(PLUGIN_DIR, "test", "_helper.mjs")).href)

/**
 * 当前这次跑用哪份表（真实表 / XLSX_PATH / 合成样本），文件已经落盘、可以直接复制
 * @type {string}
 */
export const SOURCE = await helper.requireSource()

/** 维护者那份真实表的位置（不论在不在）：套件想"只在真实数据上做某条对照"时用它判断 */
export const realTable = helper.Paths.realTable
