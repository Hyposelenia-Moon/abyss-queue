/** 排队表状态文档（`data/queue.json`） */
import fs from "node:fs/promises"
import path from "node:path"

export const STATE_FORMAT = 2

const KINDS = new Set(["theater", "abyss", "spiral", "attack"])

export const ROW_FIELDS = ["nickname", "gameName", "anchor", "goal", "note", "status"]

const COL_RE = /^[A-Z]$/
const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value)

export const docFileOf = xlsxPath => (/\.xlsx$/i.test(String(xlsxPath)) ? String(xlsxPath).replace(/\.xlsx$/i, ".json") : `${xlsxPath}.json`)

const fail = (where, message) => {
  throw new Error(`queue.json 结构不对：${where} ${message}`)
}

export function validateDoc(doc) {
  if (!isPlainObject(doc)) fail("(根)", "必须是一个对象")
  if (doc.format !== STATE_FORMAT) fail("format", `应为 ${STATE_FORMAT}，实际 ${JSON.stringify(doc.format)}`)
  if (!Number.isInteger(doc.revision) || doc.revision < 0) fail("revision", "应为非负整数")
  if (typeof doc.updatedAt !== "string" || !doc.updatedAt) fail("updatedAt", "应为 ISO 时间字符串")
  if (!Array.isArray(doc.sheets)) fail("sheets", "应为数组")
  if (!doc.sheets.length) fail("sheets", "至少要有 1 张表")
  const names = new Set()
  doc.sheets.forEach((sheet, si) => {
    const at = `sheets[${si}]`
    if (!isPlainObject(sheet)) fail(at, "应为对象")
    if (typeof sheet.name !== "string" || !sheet.name.trim()) fail(`${at}.name`, "应为非空字符串")
    if (names.has(sheet.name)) fail(`${at}.name`, `页签名重复：${sheet.name}`)
    names.add(sheet.name)
    if (!KINDS.has(sheet.kind)) fail(`${at}.kind`, `应为 ${[...KINDS].join("/")}`)
    if (!isPlainObject(sheet.header)) fail(`${at}.header`, "应为对象")
    for (const [col, text] of Object.entries(sheet.header)) {
      if (!COL_RE.test(col)) fail(`${at}.header`, `列名「${col}」应为 A–Z 的单字母`)
      if (typeof text !== "string") fail(`${at}.header.${col}`, "应为字符串")
    }
    if (!isPlainObject(sheet.options)) fail(`${at}.options`, "应为对象")
    for (const [key, list] of Object.entries(sheet.options)) {
      if (!["anchor", "goal", "status"].includes(key)) fail(`${at}.options.${key}`, "只认 anchor / goal / status")
      if (!Array.isArray(list) || list.some(v => typeof v !== "string")) fail(`${at}.options.${key}`, "应为字符串数组")
    }
    if (!Number.isInteger(sheet.prefill) || sheet.prefill < 0 || sheet.prefill > 5000) fail(`${at}.prefill`, "应为 0–5000 的整数")
    if (!Array.isArray(sheet.top)) fail(`${at}.top`, "应为数组")
    sheet.top.forEach((rec, ri) => {
      if (!isPlainObject(rec)) fail(`${at}.top[${ri}]`, "应为对象")
      for (const [col, text] of Object.entries(rec)) {
        if (!COL_RE.test(col)) fail(`${at}.top[${ri}]`, `列名「${col}」应为 A–Z 的单字母`)
        if (typeof text !== "string") fail(`${at}.top[${ri}].${col}`, "应为字符串")
      }
    })
    if (!Array.isArray(sheet.rows)) fail(`${at}.rows`, "应为数组")
    sheet.rows.forEach((row, ri) => {
      if (!isPlainObject(row)) fail(`${at}.rows[${ri}]`, "应为对象")
      if (row.blank === true) {
        const extra = Object.keys(row).filter(k => k !== "blank")
        if (extra.length) fail(`${at}.rows[${ri}]`, `占位行只应有 blank：多出 ${extra.join("、")}`)
        return
      }
      for (const key of ROW_FIELDS) {
        if (row[key] !== undefined && typeof row[key] !== "string") fail(`${at}.rows[${ri}].${key}`, "应为字符串")
      }
      for (const key of Object.keys(row)) if (!ROW_FIELDS.includes(key)) fail(`${at}.rows[${ri}]`, `多出字段 ${key}`)
    })
  })
  return doc
}

const oneLine = (value, keys) => {
  const parts = []
  for (const key of keys) {
    const v = value[key]
    if (v === undefined || v === null || v === "") continue
    parts.push(`${JSON.stringify(key)}: ${JSON.stringify(v)}`)
  }
  return `{ ${parts.join(", ")} }`
}

export function serializeDoc(doc) {
  const lines = []
  lines.push("{")
  lines.push(`  "format": ${doc.format},`)
  lines.push(`  "revision": ${doc.revision},`)
  lines.push(`  "updatedAt": ${JSON.stringify(doc.updatedAt)},`)
  lines.push(`  "sheets": [`)
  doc.sheets.forEach((sheet, si) => {
    lines.push("    {")
    lines.push(`      "name": ${JSON.stringify(sheet.name)},`)
    lines.push(`      "kind": ${JSON.stringify(sheet.kind)},`)
    lines.push(`      "header": ${JSON.stringify(sheet.header)},`)
    lines.push(`      "options": ${JSON.stringify(sheet.options)},`)
    lines.push(`      "prefill": ${sheet.prefill},`)
    lines.push('      "top": [')
    sheet.top.forEach((rec, ri) => {
      const keys = Object.keys(rec).sort((a, b) => a.localeCompare(b))
      lines.push(`        ${oneLine(rec, keys)}${ri < sheet.top.length - 1 ? "," : ""}`)
    })
    lines.push("      ],")
    lines.push('      "rows": [')
    sheet.rows.forEach((row, ri) => {
      const keys = row.blank === true ? ["blank"] : ROW_FIELDS
      lines.push(`        ${oneLine(row, keys)}${ri < sheet.rows.length - 1 ? "," : ""}`)
    })
    lines.push("      ]")
    lines.push(`    }${si < doc.sheets.length - 1 ? "," : ""}`)
  })
  lines.push("  ]")
  lines.push("}")
  return `${lines.join("\n")}\n`
}

export async function readDoc(file) {
  const text = await fs.readFile(file, "utf8")
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err?.message ?? err}（可以从最近的 versions/ 快照恢复）`)
  }
  return validateDoc(doc)
}

export async function writeDoc(file, doc, { backup = true } = {}) {
  validateDoc(doc)
  doc.revision += 1
  doc.updatedAt = new Date().toISOString()
  const body = serializeDoc(doc)
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmp, body, "utf8")
  try {
    if (backup) await fs.copyFile(file, `${file}.bak`).catch(() => {})
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return body
}
