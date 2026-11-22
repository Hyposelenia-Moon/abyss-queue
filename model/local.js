/**
 * 本地表读取：`data/queue.json` 是唯一数据源，`data/queue.xlsx` 是导出镜像
 *
 * 与编辑器同一台机器、同一个进程（编辑器挂在 bot 的 http.Server 上，见 `modules/editor-host.js`），
 * 所以这里**不再有快照 / TTL / 备份**这些东西：
 *
 * - 每次调用都重新读盘（`JsonTable#open()` 内部就是 `fs.readFile`），表被人在编辑器里改过、
 *   或手工改过 JSON，下一次读取立刻看到，不需要"等 TTL 过期"。
 * - 读失败（JSON 与 xlsx 都不存在）直接抛错给调用方，由指令层回"表格文件不存在"。
 * - 写仍然只发生在编辑器里（`JsonTable#mutate`），插件侧只读，这条边界不变。
 */
import { config, dataDir } from "../components/config.js"
import path from "node:path"
import { JsonTable } from "./json-table.js"
import { docFileOf, readDoc } from "./queue-doc.js"
import { exportWorkbook } from "./doc-export.js"

/**
 * 表文件（镜像）
 *
 * 生产：`<插件根>/data/queue.xlsx`（编辑器也只认这个位置）；
 * 套件：`ABYSS_QUEUE_XLSX_PATH` 指的临时副本（见 test/env.mjs）。
 */
export const tableFile = () => config.xlsxPath || path.join(dataDir, "queue.xlsx")

/** 状态文档：与镜像同目录、同名、扩展名换成 .json */
export const stateFile = () => docFileOf(tableFile())

let single = null

/**
 * 单例（不是缓存）：`JsonTable` 只在写的时候维护串行队列，读每次都重新打开文档
 *
 * 换成单例是为了让同一进程里的读写在同一个串行链上，避免"边读边写"看到半份文档。
 */
export const getLocal = () => (single ??= new JsonTable({ file: stateFile(), mirror: tableFile(), bootstrap: true }))

/** 读一次表的模型：`fn({ models, names, fp })` */
export const readTable = fn => getLocal().read(fn)

/**
 * 当前完整 xlsx 的字节（下载入口与版本摘要用）
 *
 * 优先读镜像（每次提交后都会重建）；镜像还没生成（从未写过）时，从 JSON 现导一份。
 */
export const snapshotBuffer = async () => {
  const { readFile } = await import("node:fs/promises")
  try {
    return await readFile(tableFile())
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
    return exportWorkbook(await readDoc(stateFile()))
  }
}

/** 配置改动 / 测试切换目录后重建实例 */
export const resetLocal = () => {
  single = null
}
