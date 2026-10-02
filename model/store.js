/**
 * QQ → 表格行号 绑定持久化
 *
 * 表格里没有 QQ 号列，身份只能靠群昵称匹配；
 * 这里额外记下绑定，回表校验昵称后使用，避免人工改表后指错行。
 */
import fs from "node:fs/promises"
import path from "node:path"

export class BindStore {
  constructor(file) {
    this.file = file
    this.data = { version: 1, binds: {} }
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"))
      this.data = {
        version: parsed?.version ?? 1,
        binds: parsed?.binds && typeof parsed.binds === "object" ? parsed.binds : {},
      }
    } catch (err) {
      if (err.code !== "ENOENT") logger?.warn?.(`[abyss-queue] 读取绑定文件失败：${err.message}`)
    }
    return this
  }

  get(sheet, qq) {
    return this.data.binds?.[sheet]?.[String(qq)] ?? null
  }

  /** 该 QQ 绑定了哪些榜 */
  sheetsOf(qq) {
    const id = String(qq)
    return Object.keys(this.data.binds ?? {}).filter(s => this.data.binds[s]?.[id])
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
