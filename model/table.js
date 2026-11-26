/** 表格文件读写引擎 */
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { openWorkbook, parseSheet, insertRowsAndShift, removeCells, setCellText, setValidationList, splitRef } from "./xlsx.js"
import { DATA_COLUMNS, buildModel } from "./schema.js"

const BUSY_CODES = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]

export class VersionConflict extends Error {
  constructor(message = "表格在你保存期间被改过（别人先提交、或表被外部改动），请刷新页面确认后再改") {
    super(message)
    this.name = "VersionConflict"
    this.conflict = true
  }
}

const assertVersion = (expect, actual) => {
  if (expect === undefined || expect === null || expect === "") return
  if (String(expect) !== String(actual)) throw new VersionConflict()
}

export class Table {
  #chain = Promise.resolve()
  #version = ""
  constructor({ file, backup = true }) {
    this.file = file
    this.backup = backup
  }
  get version() {
    return this.#version
  }
  #fpOf(buffer) {
    return createHash("sha256").update(buffer).digest("hex")
  }
  async fingerprint() {
    try {
      return this.#fpOf(await fs.readFile(this.file))
    } catch (err) {
      if (err.code === "ENOENT") return ""
      throw err
    }
  }
  #enqueue(task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  async #open() {
    let buf
    try {
      buf = await fs.readFile(this.file)
    } catch (err) {
      if (err.code === "ENOENT") throw new Error(`表格文件不存在：${this.file}`)
      throw err
    }
    const fp = this.#fpOf(buf)
    this.#version = fp
    const wb = await openWorkbook(buf)
    const models = new Map()
    for (const sheet of wb.sheets) {
      try {
        const xml = await wb.sheetXml(sheet.name)
        models.set(sheet.name, buildModel({ name: sheet.name, xml, shared: wb.shared }))
      } catch (err) {
        globalThis.logger?.warn?.(`[abyss-queue] 工作表「${sheet.name}」解析失败，已跳过：${err.message}`)
      }
    }
    return { wb, models, names: wb.sheets.map(s => s.name), bytes: buf, fp }
  }
  async #parse(bytes) {
    const wb = await openWorkbook(bytes)
    const models = new Map()
    for (const sheet of wb.sheets) {
      const xml = await wb.sheetXml(sheet.name)
      models.set(sheet.name, buildModel({ name: sheet.name, xml, shared: wb.shared }))
    }
    return { wb, models, names: wb.sheets.map(s => s.name), fp: this.#fpOf(bytes) }
  }
  async read(fn) {
    return fn(await this.#open())
  }
  async mutate(fn, { expect, afterCommit } = {}) {
    return this.#enqueue(async () => {
      const { wb, models, names, fp } = await this.#open()
      assertVersion(expect, fp)
      const pending = new Map()
      const sheetStyles = new Map()
      for (const name of names) {
        try {
          const parsed = parseSheet(await wb.sheetXml(name), wb.shared)
          const rows = new Map()
          for (const [r, row] of parsed.rows) rows.set(r, row.cells)
          sheetStyles.set(name, rows)
        } catch {
          sheetStyles.set(name, new Map())
        }
      }
      const styleAt = (sheet, row, col) => {
        const cells = sheetStyles.get(sheet)?.get(Number(row))
        if (!cells || !cells.has(col)) return undefined
        const style = cells.get(col).style
        return style == null || style === "" ? null : style
      }
      const bucket = sheet => {
        if (!pending.has(sheet)) pending.set(sheet, { inserts: [], sets: [], clears: [], clearCells: [], lists: [] })
        return pending.get(sheet)
      }
      const ctx = {
        version: fp,
        models,
        model(name) {
          const model = models.get(name)
          if (!model) throw new Error(`表格里没有工作表「${name}」，现有：${names.join("、")}`)
          return model
        },
        setCell(sheet, row, key, value, style) {
          const model = ctx.model(sheet)
          const col = model.col[key]
          if (!col) throw new Error(`工作表「${sheet}」没有「${key}」列`)
          const resolved = style !== undefined ? style : styleAt(sheet, row, col) ?? model.styles[key]
          bucket(sheet).sets.push({ ref: `${col}${row}`, value: String(value ?? ""), style: resolved })
        },
        async rowStyles(sheet, row) {
          const model = ctx.model(sheet)
          const cells = sheetStyles.get(sheet)?.get(Number(row))
          const out = {}
          for (const key of DATA_COLUMNS) out[key] = (model.col[key] && cells?.get(model.col[key])?.style) || null
          return out
        },
        setRef(sheet, ref, value, style) {
          ctx.model(sheet)
          bucket(sheet).sets.push({ ref: String(ref), value: String(value ?? ""), style })
        },
        clearCell(sheet, ref) {
          ctx.model(sheet)
          bucket(sheet).clearCells.push(String(ref))
        },
        refStyle(sheet, ref) {
          ctx.model(sheet)
          const pos = splitRef(ref)
          return pos ? styleAt(sheet, pos.row, pos.col) : undefined
        },
        insertRows(sheet, rowNum, count = 1, opts = {}) {
          ctx.model(sheet)
          bucket(sheet).inserts.push({
            rowNum: Number(rowNum),
            count: Number(count),
            mergeTemplateRow: Number(opts.mergeTemplateRow) || 0,
          })
        },
        setValidationList(sheet, column, values, opts = {}) {
          ctx.model(sheet)
          bucket(sheet).lists.push({
            column: String(column),
            values: [...values].map(v => String(v ?? "")),
            errorStyle: opts.errorStyle ?? "warning",
          })
        },
        clearRow(sheet, row) {
          const model = ctx.model(sheet)
          const refs = DATA_COLUMNS.map(k => model.col[k] && `${model.col[k]}${row}`).filter(Boolean)
          bucket(sheet).clears.push({ refs })
        },
      }
      const result = await fn(ctx)
      if (pending.size) {
        for (const [sheet, ops] of pending) {
          let xml = await wb.sheetXml(sheet)
          for (const op of ops.inserts) xml = insertRowsAndShift(xml, op.rowNum, op.count, { mergeTemplateRow: op.mergeTemplateRow })
          for (const op of ops.sets) xml = setCellText(xml, op.ref, op.value, op.style)
          if (ops.clearCells.length) xml = removeCells(xml, ops.clearCells)
          for (const op of ops.clears) xml = removeCells(xml, op.refs)
          for (const op of ops.lists) xml = setValidationList(xml, op.column, op.values, { errorStyle: op.errorStyle }).xml
          wb.setSheetXml(sheet, xml)
        }
        const buffer = await wb.toBuffer()
        await this.#verify(buffer, pending, names)
        await this.#save(buffer)
        this.#version = this.#fpOf(buffer)
      }
      if (afterCommit) await afterCommit({ fp: this.#version, changed: pending.size > 0 })
      return result
    })
  }
  async replace(bytes, { expect, validate, transition, beforeWrite, afterCommit } = {}) {
    return this.#enqueue(async () => {
      const before = await this.#open()
      assertVersion(expect, before.fp)
      const after = await this.#parse(bytes)
      if (validate) validate(after, before)
      const state = transition ? await transition({ before, after }) : null
      if (beforeWrite) await beforeWrite({ before, after })
      const dir = path.dirname(this.file)
      const tmp = path.join(dir, `.${path.basename(this.file)}.replace.tmp`)
      try {
        await fs.writeFile(tmp, bytes)
        await fs.rename(tmp, this.file)
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        if (BUSY_CODES.includes(err.code))
          throw new Error(`替换表格失败：${this.file} 被占用或不可写（可能正用 Excel/WPS 打开），请关闭后重试`)
        throw err
      }
      this.#version = after.fp
      if (afterCommit) await afterCommit({ fp: after.fp, changed: true, state })
      return { fp: after.fp, state }
    })
  }
  async #verify(buffer, pending, names) {
    const wb = await openWorkbook(buffer)
    const newNames = wb.sheets.map(s => s.name)
    if (newNames.join("|") !== names.join("|"))
      throw new Error(`自检失败：工作表清单发生变化（${names.join("、")} → ${newNames.join("、")}），已放弃写入`)
    for (const [sheet, ops] of pending) {
      const parsed = parseSheet(await wb.sheetXml(sheet), wb.shared)
      for (const op of ops.sets) {
        const pos = splitRef(op.ref)
        const cell = parsed.rows.get(pos.row)?.cells.get(pos.col)
        const actual = cell?.value ?? ""
        if (actual !== op.value)
          throw new Error(`自检失败：${sheet}!${op.ref} 期望「${op.value}」实际「${actual}」，已放弃写入`)
      }
      for (const ref of [...ops.clears.flatMap(op => op.refs), ...(ops.clearCells ?? [])]) {
        const pos = splitRef(ref)
        const cell = parsed.rows.get(pos.row)?.cells.get(pos.col)
        if (cell && cell.value) throw new Error(`自检失败：${sheet}!${ref} 未清空，已放弃写入`)
      }
    }
  }
  async #save(buffer) {
    const dir = path.dirname(this.file)
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`)
    await fs.writeFile(tmp, buffer)
    try {
      if (this.backup) await fs.copyFile(this.file, `${this.file}.bak`)
      await fs.rename(tmp, this.file)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      if (BUSY_CODES.includes(err.code))
        throw new Error(`写表失败：${this.file} 被占用或不可写（可能正用 Excel/WPS 打开），请关闭后重试`)
      throw err
    }
  }
}
