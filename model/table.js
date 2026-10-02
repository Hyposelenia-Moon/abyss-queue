/**
 * 表格文件读写引擎
 *
 * 特点：
 *  - 每次操作都重新读盘（人工可能刚用 Excel 改过表）
 *  - 写入走"读-改-校验-原子替换"，替换前会用新缓冲重新解析并核对写入结果
 *  - 所有写操作在进程内串行（多群同时报名不会互相覆盖）
 */
import fs from "node:fs/promises"
import path from "node:path"
import { openWorkbook, parseSheet, removeCells, setCellText, splitRef } from "../lib/xlsx.js"
import { DATA_COLUMNS, buildModel } from "../lib/schema.js"

const BUSY_CODES = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]

export class Table {
  #chain = Promise.resolve()

  constructor({ file, backup = true }) {
    this.file = file
    this.backup = backup
  }

  /** 串行化写操作 */
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

    const wb = await openWorkbook(buf)
    const models = new Map()
    for (const sheet of wb.sheets) {
      try {
        const xml = await wb.sheetXml(sheet.name)
        models.set(sheet.name, buildModel({ name: sheet.name, xml, shared: wb.shared }))
      } catch (err) {
        logger?.warn?.(`[abyss-queue] 工作表「${sheet.name}」解析失败，已跳过：${err.message}`)
      }
    }
    return { wb, models, names: wb.sheets.map(s => s.name) }
  }

  /** 只读 */
  async read(fn) {
    return fn(await this.#open())
  }

  /** 读-改-校验-原子替换 */
  async mutate(fn) {
    return this.#enqueue(async () => {
      const { wb, models, names } = await this.#open()
      const pending = new Map()

      const bucket = sheet => {
        if (!pending.has(sheet)) pending.set(sheet, { sets: [], clears: [] })
        return pending.get(sheet)
      }

      const ctx = {
        models,
        model(name) {
          const model = models.get(name)
          if (!model) throw new Error(`表格里没有工作表「${name}」，现有：${names.join("、")}`)
          return model
        },
        setCell(sheet, row, key, value) {
          const model = ctx.model(sheet)
          const col = model.col[key]
          if (!col) throw new Error(`工作表「${sheet}」没有「${key}」列`)
          bucket(sheet).sets.push({ ref: `${col}${row}`, value: String(value ?? ""), style: model.styles[key] })
        },
        clearRow(sheet, row) {
          const model = ctx.model(sheet)
          const refs = DATA_COLUMNS.map(k => model.col[k] && `${model.col[k]}${row}`).filter(Boolean)
          bucket(sheet).clears.push({ refs })
        },
      }

      const result = await fn(ctx)

      for (const [sheet, ops] of pending) {
        let xml = await wb.sheetXml(sheet)
        for (const op of ops.sets) xml = setCellText(xml, op.ref, op.value, op.style)
        for (const op of ops.clears) xml = removeCells(xml, op.refs)
        wb.setSheetXml(sheet, xml)
      }

      if (!pending.size) return result

      const buffer = await wb.toBuffer()
      await this.#verify(buffer, pending, names)
      await this.#save(buffer)
      return result
    })
  }

  /** 替换原文件前的自检：新文件必须可解析，且写入结果正确 */
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
      for (const op of ops.clears)
        for (const ref of op.refs) {
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
