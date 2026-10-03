/**
 * 数据层入口：云端表（插件用）、本地表（编辑器用）、绑定存储的单例
 *
 * - `getRemote()`：插件的数据来源 —— 从云端编辑器拉快照，只读，不落盘
 * - `getTable()` ：本地 xlsx 读写，**只有编辑器在用**（编辑器项目按绝对路径引用本模块）
 * - `getStore()` ：QQ → 行号 绑定，仍然写本地 `data/bindings.json`
 */
import { config } from "../components/config.js"
import { RemoteTable } from "./remote.js"
import { Table } from "./table.js"
import { BindStore } from "./store.js"

let REMOTE = null
let TABLE = null
let STORE = null

/** 插件的数据来源：云端表（配置改了就重建，方便 reloadConfig 后生效） */
export const getRemote = () => {
  const r = config.remote ?? {}
  if (!REMOTE || REMOTE.url !== String(r.url ?? "").trim().replace(/\/+$/, ""))
    REMOTE = new RemoteTable({ url: r.url, token: r.token, ttl: r.ttl_ms, timeout: r.timeout_ms })
  return REMOTE
}

/** 本地表读写：只给编辑器用（插件侧不该调用它） */
export const getTable = () => (TABLE ??= new Table({ file: config.xlsxPath, backup: config.backup }))

export const getStore = () => (STORE ??= new BindStore(config.storePath).load())
