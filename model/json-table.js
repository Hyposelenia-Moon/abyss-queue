/**
 * JSON 存储的"表"（`Table` 的替身）
 *
 * 对外接口与 `model/table.js` 的 `Table` 保持一致：`version` / `fingerprint()` /
 * `read(fn)` / `mutate(fn, {expect, afterCommit})` / `replace(bytes, {...})`，
 * `ctx` 也提供同一组原语（setCell / setRef / insertRows / clearRow …）。
 * 这样 `editor/editor.mjs`、`editor/actions.js`、`editor/ownership.js` 的调用点不用改。
 *
 * 落盘三件事（一次提交里按顺序）：
 *   1. `queue.json`：唯一事实源（原子替换、revision+1）；
 *   2. `queue.xlsx`：导出镜像（给下载 / 版本快照 / 云上传 / 兼容测试用）；
 *   3. 版本与归档仍由 `editor/versions.js` 在写前读取镜像完成（见 editor.mjs 接线）。
 *
 * 自举：`queue.json` 不存在而 `queue.xlsx` 在时，先导入 xlsx 生成 JSON（不改 xlsx）。
 */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { VersionConflict } from "./table.js"
import { readDoc, writeDoc, validateDoc, serializeDoc } from "./queue-doc.js"
import { importWorkbook } from "./doc-import.js"
import { exportWorkbook } from "./doc-export.js"
import { modelsOf, COL } from "./doc-models.js"
import { withFileLock } from "./file-lock.js"

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex")

const assertVersion = (expect, actual) => {
  if (expect === undefined || expect === null || expect === "") return
  if (String(expect) !== String(actual)) throw new VersionConflict()
}

const parseRef = ref => {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref).toUpperCase())
  return m ? { col: m[1], row: Number(m[2]) } : null
}

const FIELD_OF_COL = Object.fromEntries(Object.entries(COL).map(([key, letter]) => [letter, key]))

export class JsonTable {
  #chain = Promise.resolve()
  #version = ""

  /**
   * @param {object} opts
   * @param {string} opts.file 状态文档路径（`data/queue.json`）
   * @param {string} [opts.mirror] 导出镜像路径（`data/queue.xlsx`）
   * @param {boolean} [opts.bootstrap] 文档不存在时是否从镜像导入（默认是）
   */
  constructor({ file, mirror = null, bootstrap = true }) {
    this.file = file
    this.mirror = mirror
    this.bootstrap = bootstrap
    this.backup = true
  }

  get version() {
    return this.#version
  }

  async fingerprint() {
    /**
     * 指纹口径 = 下一次写表时 `#open` 会看到的那一版。
     *
     * 不能只看磁盘上的 `queue.json`：镜像（xlsx）比文档新时，`#open` 会先把镜像导回来，
     * 版本随之变化。若这里偷懒只哈希旧文档，`/api/version` 与首次提交就会对不上，
     * 正常提交被误判成“别人改过表”（VersionConflict）。
     */
    return this.#enqueue(async () => {
      try {
        await this.#open()
        return this.#version
      } catch (err) {
        if (err?.code === "ENOENT" || /不存在/.test(String(err?.message ?? ""))) return ""
        throw err
      }
    })
  }

  #enqueue(fn) {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 读文档；缺失时从镜像自举（只写 JSON，不动 xlsx） */
  async #open() {
    let text
    try {
      text = await fs.readFile(this.file, "utf8")
    } catch (err) {
      if (err.code !== "ENOENT") throw err
      if (!this.bootstrap || !this.mirror) throw new Error(`表格文件不存在：${this.file}`)
      const buffer = await fs.readFile(this.mirror)
      const doc = await importWorkbook(buffer)
      text = await writeDoc(this.file, doc, { backup: false })
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      throw new Error(`${this.file} 不是合法 JSON（可以从最近的 versions/ 快照恢复）`)
    }
    validateDoc(doc)

    /**
     * 镜像比文档新 ⇒ 表被外部直接改过（Excel / WPS / 测试直接写 xlsx）
     *
     * 正常提交的顺序是"先写 JSON、再写镜像"，所以镜像更新只可能来自外部改动。
     * 内容一致就什么都不做（避免每次读都重写 revision）；不一致才按镜像重新导入，
     * 让"人工改表"仍然生效——这条在测试里尤其重要（套件直接拿 Table 写 fixture）。
     */
    if (this.mirror) {
      try {
        const [docStat, mirrorStat] = await Promise.all([fs.stat(this.file), fs.stat(this.mirror)])
        if (mirrorStat.mtimeMs > docStat.mtimeMs) {
          const imported = await importWorkbook(await fs.readFile(this.mirror))
          const key = value => serializeDoc({ ...value, revision: 0, updatedAt: "" })
          if (key(imported) !== key(doc)) {
            text = await writeDoc(this.file, imported, { backup: this.backup })
            doc = imported
          }
        }
      } catch (err) {
        if (err?.code !== "ENOENT") throw err
      }
    }

    const models = modelsOf(doc)
    this.#version = sha256(text)
    return { doc, models, names: doc.sheets.map(s => s.name), fp: this.#version, bytes: null, wb: null }
  }

  async read(fn) {
    return fn(await this.#open())
  }

  /** 在内存文档里按"插入之后"的行号定位并写格 */
  #applySet(sheet, ref, value) {
    const pos = parseRef(ref)
    if (!pos) throw new Error(`非法单元格引用: ${ref}`)
    const headerRow = sheet.top.length + 1
    if (pos.row < headerRow) {
      const rec = (sheet.top[pos.row - 1] ??= {})
      if (value === "") delete rec[pos.col]
      else rec[pos.col] = String(value)
      return
    }
    const index = pos.row - headerRow - 1
    while (sheet.rows.length <= index) sheet.rows.push({ blank: true })
    const rec = sheet.rows[index]
    if (rec.blank === true) {
      for (const key of Object.keys(rec)) delete rec[key]
    }
    const key = FIELD_OF_COL[pos.col]
    if (!key) return // A 列序号是公式，不存
    if (value === "") delete rec[key]
    else rec[key] = String(value)
    if (!Object.keys(rec).length) rec.blank = true
    else delete rec.blank
  }

  /** 写镜像：先 tmp 再 rename，失败不吞 */
  async #writeMirror(doc) {
    if (!this.mirror) return
    const buffer = await exportWorkbook(doc)
    await fs.mkdir(path.dirname(this.mirror), { recursive: true })
    const tmp = path.join(path.dirname(this.mirror), `.${path.basename(this.mirror)}.${process.pid}.${Date.now()}.tmp`)
    await fs.writeFile(tmp, buffer)
    try {
      await fs.rename(tmp, this.mirror)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  async mutate(fn, { expect, afterCommit } = {}) {
    // 进程内先排队，再抢跨进程锁；锁圈住“读 JSON → 写 JSON → 写镜像”，afterCommit（绑定/锁）也在锁内
    return this.#enqueue(() => withFileLock(this.file, async () => {
      const { doc, models, names, fp } = await this.#open()
      assertVersion(expect, fp)
      const next = structuredClone(doc)
      const byName = new Map(next.sheets.map(sheet => [sheet.name, sheet]))
      const bucket = new Map()
      const get = sheetName => {
        const sheet = byName.get(sheetName)
        if (!sheet) throw new Error(`表格里没有工作表「${sheetName}」，现有：${names.join("、")}`)
        if (!bucket.has(sheetName)) bucket.set(sheetName, { inserts: [], sets: [], clearCells: [], clears: [], lists: [] })
        return { sheet, ops: bucket.get(sheetName) }
      }

      const ctx = {
        version: fp,
        models,
        model(name) {
          const model = models.get(name)
          if (!model) throw new Error(`表格里没有工作表「${name}」，现有：${names.join("、")}`)
          return model
        },
        setCell(sheetName, row, key, value) {
          const model = ctx.model(sheetName)
          const col = model.col[key]
          if (!col) throw new Error(`工作表「${sheetName}」没有「${key}」列`)
          get(sheetName).ops.sets.push({ ref: `${col}${row}`, value: String(value ?? "") })
        },
        async rowStyles(sheetName, row) {
          void row
          const model = ctx.model(sheetName)
          const out = {}
          for (const key of ["nickname", "gameName", "anchor", "goal", "note", "status"]) out[key] = null
          return out
        },
        setRef(sheetName, ref, value) {
          get(sheetName).ops.sets.push({ ref: String(ref), value: String(value ?? "") })
        },
        clearCell(sheetName, ref) {
          get(sheetName).ops.clearCells.push(String(ref))
        },
        refStyle() {
          return undefined
        },
        insertRows(sheetName, rowNum, count = 1) {
          get(sheetName).ops.inserts.push({ rowNum: Number(rowNum), count: Number(count) })
        },
        setValidationList(sheetName, column, values) {
          get(sheetName).ops.lists.push({ column: String(column).toUpperCase(), values: [...values].map(v => String(v ?? "")) })
        },
        clearRow(sheetName, row) {
          const model = ctx.model(sheetName)
          const refs = ["nickname", "gameName", "anchor", "goal", "note", "status"].map(k => model.col[k] && `${model.col[k]}${row}`).filter(Boolean)
          get(sheetName).ops.clears.push({ refs })
        },
      }

      const result = await fn(ctx)

      let changed = false
      for (const [sheetName, ops] of bucket) {
        const { sheet } = get(sheetName)
        // 与 Table 的落表顺序一致：先插行、再写格、最后清格 / 清行 / 改下拉
        for (const op of ops.inserts) {
          changed = true
          const headerRow = sheet.top.length + 1
          if (op.rowNum <= headerRow) {
            sheet.top.splice(Math.max(0, op.rowNum - 1), 0, ...Array.from({ length: op.count }, () => ({})))
          } else {
            const index = op.rowNum - headerRow - 1
            while (sheet.rows.length < index) sheet.rows.push({ blank: true })
            sheet.rows.splice(index, 0, ...Array.from({ length: op.count }, () => ({ blank: true })))
          }
        }
        for (const op of ops.sets) {
          changed = true
          this.#applySet(sheet, op.ref, op.value)
        }
        for (const ref of ops.clearCells) {
          changed = true
          this.#applySet(sheet, ref, "")
        }
        for (const op of ops.clears) {
          changed = true
          for (const ref of op.refs) this.#applySet(sheet, ref, "")
        }
        for (const op of ops.lists) {
          changed = true
          const key = FIELD_OF_COL[op.column]
          if (!key || !["anchor", "goal", "status"].includes(key)) continue
          sheet.options ??= {}
          if (op.values.length) sheet.options[key] = [...op.values]
          else delete sheet.options[key]
        }
      }

      if (changed) {
        const body = await writeDoc(this.file, next, { backup: this.backup })
        this.#version = sha256(body)
        await this.#writeMirror(next)
      }
      if (afterCommit) await afterCommit({ fp: this.#version, changed })
      return result
    }))
  }

  /**
   * 整表替换（上传 / 回滚）
   *
   * `bytes` 可以是 xlsx Buffer（走导入），也可以是状态文档对象（回滚 JSON 快照用）。
   */
  async replace(input, { expect, validate, transition, beforeWrite, afterCommit } = {}) {
    return this.#enqueue(() => withFileLock(this.file, async () => {
      const before = await this.#open()
      assertVersion(expect, before.fp)

      const doc = Buffer.isBuffer(input) ? await importWorkbook(input) : structuredClone(input)
      validateDoc(doc)
      const after = { doc, models: modelsOf(doc), names: doc.sheets.map(s => s.name), fp: null, bytes: null, wb: null }

      if (validate) await validate(after, before)
      if (transition) await transition({ before, after })
      if (beforeWrite) await beforeWrite({ before, after })

      const body = await writeDoc(this.file, doc, { backup: this.backup })
      after.fp = sha256(body)
      this.#version = after.fp
      await this.#writeMirror(doc)
      if (afterCommit) await afterCommit({ fp: after.fp, changed: true, state: after })
      return { fp: after.fp, state: after }
    }))
  }
}
