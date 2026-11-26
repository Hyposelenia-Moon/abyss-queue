/** QQ → 表格行号 绑定持久化 */
import fs from "node:fs/promises"
import path from "node:path"
import { config } from "../components/config.js"

export class BindStore {
  constructor(file) {
    this.file = file
    this.data = { version: 1, table: "", binds: {}, queueFront: {} }
  }
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"))
      this.data = {
        version: parsed?.version ?? 1,
        table: typeof parsed?.table === "string" ? parsed.table : "",
        binds: parsed?.binds && typeof parsed.binds === "object" ? parsed.binds : {},
        queueFront:
          parsed?.queueFront && typeof parsed.queueFront === "object" ? parsed.queueFront : {},
      }
    } catch (err) {
      if (err.code !== "ENOENT") globalThis.logger?.warn?.(`[abyss-queue] 读取绑定文件失败：${err.message}`)
    }
    return this
  }
  get tableVersion() {
    return String(this.data.table ?? "")
  }
  set tableVersion(fp) {
    this.data.table = String(fp ?? "")
  }
  get(sheet, qq) {
    return this.data.binds?.[sheet]?.[String(qq)] ?? null
  }
  sheetsOf(qq) {
    const id = String(qq)
    return Object.keys(this.data.binds ?? {}).filter(s => this.data.binds[s]?.[id])
  }
  qqsOf(sheet, row) {
    const target = this.data.binds?.[sheet] ?? {}
    return Object.entries(target)
      .filter(([, info]) => Number(info?.row) === Number(row))
      .map(([qq]) => qq)
  }
  dropStale(sheet, row, keepNickname, keepQq = "") {
    const want = String(keepNickname ?? "").trim()
    let dropped = 0
    for (const qq of this.qqsOf(sheet, row)) {
      if (String(qq) === String(keepQq)) continue
      if (String(this.get(sheet, qq)?.nickname ?? "").trim() === want) continue
      if (this.del(sheet, qq)) dropped++
    }
    return dropped
  }
  remap(sheet, rowMap) {
    const binds = this.data.binds?.[sheet]
    if (!binds || !rowMap || typeof rowMap !== "object") return 0
    let changed = 0
    const next = {}
    for (const [qq, info] of Object.entries(binds)) {
      const from = Number(info?.row)
      const to = rowMap[from]
      if (to === undefined) {
        next[qq] = info
        continue
      }
      const target = Number(to)
      if (!Number.isFinite(target) || target <= 0) {
        changed++
        continue
      }
      if (target !== from) {
        next[qq] = { ...info, row: target }
        changed++
      } else {
        next[qq] = info
      }
    }
    if (changed) {
      if (Object.keys(next).length) this.data.binds[sheet] = next
      else delete this.data.binds[sheet]
    }
    return changed
  }
  dropRow(sheet, row) {
    let dropped = 0
    for (const qq of this.qqsOf(sheet, row)) if (this.del(sheet, qq)) dropped++
    return dropped
  }
  set(sheet, qq, info) {
    this.data.binds[sheet] ??= {}
    this.data.binds[sheet][String(qq)] = { ...info, at: Date.now() }
  }
  del(sheet, qq) {
    const target = this.data.binds?.[sheet]
    if (!target) return false
    const had = delete target[String(qq)]
    if (!Object.keys(target).length) delete this.data.binds[sheet]
    return had
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8")
    await fs.rename(tmp, this.file)
  }
}

let STORE = null

export const getStore = () => (STORE ??= new BindStore(config.storePath).load())
