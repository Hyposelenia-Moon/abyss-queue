/** 本地表读取：`data/queue.json` 是唯一数据源，`data/queue.xlsx` 是导出镜像 */
import { config, dataDir } from "../components/config.js"
import path from "node:path"
import { JsonTable } from "./json-table.js"
import { docFileOf, readDoc } from "./queue-doc.js"
import { exportWorkbook } from "./doc-export.js"

export const tableFile = () => config.xlsxPath || path.join(dataDir, "queue.xlsx")

export const stateFile = () => docFileOf(tableFile())

let single = null

export const getLocal = () => (single ??= new JsonTable({ file: stateFile(), mirror: tableFile(), bootstrap: true }))

export const readTable = fn => getLocal().read(fn)

export const snapshotBuffer = async () => {
  const { readFile } = await import("node:fs/promises")
  try {
    return await readFile(tableFile())
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
    return exportWorkbook(await readDoc(stateFile()))
  }
}
