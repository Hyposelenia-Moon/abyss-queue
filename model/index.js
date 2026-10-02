/**
 * 数据层入口：表格与绑定的单例
 *
 * 单例保证写操作共用同一把互斥锁（Table 内部串行化），
 * 也避免每次都重新读配置。
 */
import { config } from "../components/config.js"
import { Table } from "./table.js"
import { BindStore } from "./store.js"

let TABLE = null
let STORE = null

export const getTable = () => (TABLE ??= new Table({ file: config.xlsxPath, backup: config.backup }))

export const getStore = () => (STORE ??= new BindStore(config.storePath).load())
