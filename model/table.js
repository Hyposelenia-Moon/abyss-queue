/**
 * 表格文件读写引擎
 *
 * 特点：
 *  - 每次操作都重新读盘（人工可能刚用 Excel 改过表）
 *  - 写入走"读-改-校验-原子替换"，替换前会用新缓冲重新解析并核对写入结果
 *  - **所有写操作在进程内串行**（多群同时写表不会互相覆盖）
 *  - 整表替换（上传 / 回退）走**同一条队列**，并且读、校验、存底、提交都在同一个临界区里
 *    —— 以前它们各写各的，于是"普通保存"和"整表替换"并发时两个请求都返回成功、
 *    其中一个的改动却凭空消失（AQ-06）
 *  - 暴露文件指纹（`version`）：调用方可以拿它判断"我读到的那一版还在不在"，
 *    发现外部改动就报冲突，而不是把别人的改动盖掉
 */
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { openWorkbook, parseSheet, removeCells, setCellText, setValidationList, splitRef } from "../lib/xlsx.js"
import { DATA_COLUMNS, buildModel } from "../lib/schema.js"

const BUSY_CODES = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]

/**
 * 版本冲突：调用方读到的那一版表，在它提交之前已经被换掉了
 *
 * 宁可明确报错也不覆盖——静默覆盖正是"两个请求都成功、改动却没了"的来源。
 * `conflict` 供 HTTP 层翻译成 409。
 */
export class VersionConflict extends Error {
  constructor(message = "表格在你保存期间被改过（别人先提交、或表被外部改动），请刷新页面确认后再改") {
    super(message)
    this.name = "VersionConflict"
    this.conflict = true
  }
}

/** 调用方带了"我读到的版本"就必须一致，否则说明它手里的是旧快照 */
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

  /** 最近一次读盘/写盘之后的文件指纹（外部改动要等下一次读盘才会刷新） */
  get version() {
    return this.#version
  }

  #fpOf(buffer) {
    return createHash("sha256").update(buffer).digest("hex")
  }

  /** 重新读盘算一次指纹（不改变 #version 的用途，只是给调用方一个当前值） */
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

  /**
   * 解析一份**还没落盘**的字节（整表替换前的校验用）
   *
   * 与 #open 不同：这里**不吞**单张表解析失败的错——要替换进来的文件必须每张表都能建模，
   * 否则"上传成功"之后业务读出来是空的（AQ-07）。
   */
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

  /**
   * 读-改-提交（串行）
   *
   * @param {(ctx: object) => Promise<any>} fn 在临界区里跑：`ctx.models` 是这一版表解析出来的模型，
   *        改动用 ctx.setCell / clearRow / setValidationList 排进队列
   * @param {object} [opts]
   * @param {string} [opts.expect] 调用方读到的那一版指纹；不一致 → VersionConflict
   * @param {(info: {fp: string, changed: boolean}) => Promise<void>} [opts.afterCommit]
   *        表写成功之后、**仍在同一临界区里**执行：绑定 / 锁这类关联状态必须搭这趟车一起换版本
   */
  async mutate(fn, { expect, afterCommit } = {}) {
    return this.#enqueue(async () => {
      const { wb, models, names, fp } = await this.#open()
      assertVersion(expect, fp)
      const pending = new Map()
      /**
       * 这一版表**每个数据格自己的样式号**（行号 → 列字母 → s）
       *
       * 必须在 `fn` 之前就备好：普通保存（applySave 等）是**改已存在的数据行**，而表里是逐行配色的
       * （隔行换底色）。以前 setCell 一律套 `model.styles[key]`——那是"同列第一个有样式的格子"
       * 采样出来的**一个**样式号，于是与采样行不同的行会被抹平（审核报告：剧诗 B9 保存后
       * 样式号 30 → 37、底色变成第 8 行的）。`ctx.setCell` 是同步接口，拿不到 await 的机会，
       * 所以这里先按表读一遍；只有真正的新行 / 数据区之外才退回列采样样式。
       *
       * @type {Map<string, Map<number, Map<string, {style: string|undefined}>>>}
       */
      const sheetStyles = new Map()
      for (const name of names) {
        try {
          const parsed = parseSheet(await wb.sheetXml(name), wb.shared)
          const rows = new Map()
          for (const [r, row] of parsed.rows) rows.set(r, row.cells)
          sheetStyles.set(name, rows)
        } catch {
          /** 解析不了的表：当它没有样式可保，退回列采样（与 #open 跳过建模同一个口径） */
          sheetStyles.set(name, new Map())
        }
      }
      /**
       * 取"这一行这一格现在的样式号"
       *
       *   - 这一行里**没有这一格**（真正的新行 / 数据区之外 / 还没上色的空行）→ `undefined`，
       *     由调用方退回整列采样样式：空行本来就没样式可留，采样那一份才是"表里该有的样子"；
       *   - 有这一格 → 原样返回它的 s（`null` / `""` 表示这一格确实没有样式，交给 setCellText 沿用原样）。
       * 两种情况都用 `??` 合并的话，前者的"没样式可用"会被后者顶替，正确性反而变成巧合。
       */
      const styleAt = (sheet, row, col) => {
        const cells = sheetStyles.get(sheet)?.get(Number(row))
        if (!cells || !cells.has(col)) return undefined
        const style = cells.get(col).style
        return style == null || style === "" ? null : style
      }

      const bucket = sheet => {
        if (!pending.has(sheet)) pending.set(sheet, { sets: [], clears: [], lists: [] })
        return pending.get(sheet)
      }

      const ctx = {
        /** 这一版表的指纹：临界区里判断"绑定/锁是不是对着这一版记的" */
        version: fp,
        models,
        model(name) {
          const model = models.get(name)
          if (!model) throw new Error(`表格里没有工作表「${name}」，现有：${names.join("、")}`)
          return model
        },
        /**
         * 写一个数据格
         *
         * @param {string|null} [style] 该格要用的样式号。
         *   - **不传**：用"这一行这一格**现在**的样式"（已存在的数据行按自己的隔行配色写），
         *     只有真正的新行 / 数据区之外才退回整列采样（`model.styles[key]`）；
         *   - **传值**：就用它（搬行 compactSheet 要把源行每格的 s 显式带过来，见 rowStyles）；
         *   - **传 `null`**：明确表示"这一格不该有样式"（源行压根没有这一格），
         *     由 setCellText 沿用目标格原有样式——空行本身没有样式可搬，硬抹掉反而在表格里挖出个白洞。
         */
        setCell(sheet, row, key, value, style) {
          const model = ctx.model(sheet)
          const col = model.col[key]
          if (!col) throw new Error(`工作表「${sheet}」没有「${key}」列`)
          /** 只有显式传了样式才不查表：默认路径要读"当前这一行这一格"，否则逐行差别会被抹平 */
          const resolved = style !== undefined ? style : styleAt(sheet, row, col) ?? model.styles[key]
          bucket(sheet).sets.push({ ref: `${col}${row}`, value: String(value ?? ""), style: resolved })
        },
        /**
         * 取某一数据行 B–H **每格自己的**样式号
         *
         * 压紧行（删一行后其余整体上移）不能吃 setCell 的整列采样样式：那一份是"同列第一个格子的
         * 样式"，逐行差别会被抹平——上移后的行会套上别人那一行的底色/边框（AQ-15 的延伸：清空同一行
         * 保住了行样式，搬行却还在丢）。
         *
         * 读的是**本临界区开头那一版表**（即"搬走之前"的样子）：所有写入都排在临界区末尾才落表，
         * 所以整批搬完也不会读到搬动后的中间态。
         * @returns {Promise<Record<string, string|null>>} 列 key → 样式号；该格不存在或没有 s 时是 null
         */
        async rowStyles(sheet, row) {
          const model = ctx.model(sheet)
          const cells = sheetStyles.get(sheet)?.get(Number(row))
          const out = {}
          for (const key of DATA_COLUMNS) out[key] = (model.col[key] && cells?.get(model.col[key])?.style) || null
          return out
        },
        /** 按单元格地址写（表头上方的「主播列表」不在数据区列映射里） */
        setRef(sheet, ref, value, style) {
          ctx.model(sheet)
          bucket(sheet).sets.push({ ref: String(ref), value: String(value ?? ""), style })
        },
        /** 改写某一列下拉列表的内联选项（主播列表变了就同步「选择主播」的下拉） */
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
          for (const op of ops.sets) xml = setCellText(xml, op.ref, op.value, op.style)
          for (const op of ops.clears) xml = removeCells(xml, op.refs)
          for (const op of ops.lists) xml = setValidationList(xml, op.column, op.values, { errorStyle: op.errorStyle }).xml
          wb.setSheetXml(sheet, xml)
        }

        const buffer = await wb.toBuffer()
        await this.#verify(buffer, pending, names)
        await this.#save(buffer)
        this.#version = this.#fpOf(buffer)
      }
      /** 关联状态的提交放在表写成功之后：表没换成功就不该有"归属先换了"的中间态 */
      if (afterCommit) await afterCommit({ fp: this.#version, changed: pending.size > 0 })
      return result
    })
  }

  /**
   * 整表替换（上传 / 回退）
   *
   * 与 mutate 共用同一条队列，所以它和普通保存不会再互相盖掉（AQ-06）。
   * 新表先解析、再交给调用方做结构校验与关联状态迁移，最后才做"临时文件 → 原子替换"。
   *
   * @param {Buffer} bytes 新的表文件
   * @param {object} [opts]
   * @param {string} [opts.expect] 调用方读到的那一版指纹；不一致 → VersionConflict
   * @param {(after: object, before: object) => void} [opts.validate] 结构校验，抛错即拒绝替换
   * @param {(info: {before: object, after: object}) => any} [opts.transition]
   *        计算要一起提交的关联状态（如"绑定 / 锁按新表重建"），返回值原样交给 afterCommit
   * @param {() => Promise<void>} [opts.beforeWrite] 提交前存底（历史版本 / 归档）
   * @param {(info: {fp: string, changed: boolean, state: any}) => Promise<void>} [opts.afterCommit]
   * @returns {Promise<{fp: string, state: any}>}
   */
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
