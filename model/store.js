/**
 * QQ → 表格行号 绑定持久化
 *
 * 表格里没有 QQ 号列，所以「你是谁」以**绑定**为准：首次按群昵称匹配上之后就记下 QQ，
 * 以后即使群名片改了也认这个人，并把表里的群昵称同步成新名片（见 lib/queue.js 的 locateSelf）。
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
      if (err.code !== "ENOENT") globalThis.logger?.warn?.(`[abyss-queue] 读取绑定文件失败：${err.message}`)
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

  /** 反过来查这一行被哪些 QQ 绑着（判断"这一行已经是别人的了"） */
  qqsOf(sheet, row) {
    const target = this.data.binds?.[sheet] ?? {}
    return Object.entries(target)
      .filter(([, info]) => Number(info?.row) === Number(row))
      .map(([qq]) => qq)
  }

  /**
   * 清掉「与表里现在的内容对不上」的旧绑定
   * @param {string} keepNickname 表里这一行现在的昵称（对得上的绑定保留）
   * @param {string} keepQq 这个人的绑定另外处理（不在这里删）
   */
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

  /** 删掉指向某一行的所有绑定（行被清空 = 退队时用） */
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
