/**
 * 数据层入口
 *
 * - `getRemote()`：插件的数据来源 —— 从云端编辑器拉快照，只读，不落盘
 * - `getStore()` ：QQ → 行号 绑定，写本地 `data/bindings.json`
 *
 * 本地 xlsx 读写（`model/table.js`）**插件侧已不再使用**，只有编辑器项目按绝对路径直接
 * `import` 那个类、并按自己的 `--file` 建实例（见 abyss-queue-editor/editor.mjs）。
 */
import { config } from "../components/config.js"
import { RemoteTable } from "./remote.js"
import { BindStore } from "./store.js"

let REMOTE = null
let STORE = null

/** 插件的数据来源：云端表（配置改了就重建，方便 reloadConfig 后生效） */
export const getRemote = () => {
  const r = config.remote ?? {}
  if (!REMOTE || REMOTE.url !== String(r.url ?? "").trim().replace(/\/+$/, ""))
    REMOTE = new RemoteTable({ url: r.url, token: r.token, ttl: r.ttl_ms, timeout: r.timeout_ms, autostart: r.autostart })
  return REMOTE
}

export const getStore = () => (STORE ??= new BindStore(config.storePath).load())
