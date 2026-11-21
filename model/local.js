/**
 * 本地表读取：`data/queue.xlsx` 就是唯一数据源
 *
 * 与编辑器同一台机器、同一个进程（编辑器挂在 bot 的 http.Server 上，见 `modules/editor-host.js`），
 * 所以这里**不再有快照 / TTL / 备份**这些东西：
 *
 * - 每次调用都重新读盘（`Table#open()` 内部就是 `fs.readFile`），表被人在 Excel/WPS 或编辑器里
 *   改过，下一次读取立刻看到，不需要"等 TTL 过期"。
 * - 读失败（文件不存在）直接抛错给调用方，由指令层回"表格文件不存在"，不再有"用上次快照顶着"的分支。
 * - 写仍然只发生在编辑器里（`Table#mutate`），插件侧只读，这条边界不变。
 */
import { config, dataDir } from "../components/config.js"
import path from "node:path"
import { Table } from "./table.js"

/**
 * 表文件
 *
 * 生产：`<插件根>/data/queue.xlsx`（编辑器也只认这个位置）；
 * 套件：`ABYSS_QUEUE_XLSX_PATH` 指的临时副本（见 test/env.mjs）。
 */
export const tableFile = () => config.xlsxPath || path.join(dataDir, "queue.xlsx")

let single = null

/**
 * 单例（不是缓存）：`Table` 只在写的时候维护串行队列，读每次都重新打开文件
 *
 * 换成单例是为了让同一进程里的读写在同一个串行链上，避免"边读边写"看到半张表。
 */
export const getLocal = () => (single ??= new Table({ file: tableFile() }))

/** 读一次表的模型：`fn({ models, names, fp })` */
export const readTable = fn => getLocal().read(fn)

/** 当前完整 xlsx 的字节（下载入口与版本摘要用） */
export const snapshotBuffer = async () => {
  const { readFile } = await import("node:fs/promises")
  return readFile(tableFile())
}

/** 配置改动 / 测试切换目录后重建实例 */
export const resetLocal = () => {
  single = null
}
