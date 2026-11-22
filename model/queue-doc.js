/**
 * 排队表状态文档（`data/queue.json`）
 *
 * 从这一版起，**JSON 是唯一事实源**，xlsx 降级为导入 / 导出格式：
 *
 *   - 读写都走 `readDoc` / `writeDoc`（临时文件 + rename 原子替换）；
 *   - 记录级单行序列化：`top` / `rows` 里每条记录占一行、键序固定，
 *     这样 git 里看到的 diff 是"改了哪一行"，而不是整段重排；
 *   - 结构校验放在这里（不引依赖），出错时带 JSON 路径，方便手改后定位；
 *   - 行号 / 序号 / 标题 / 表头行**都不存**：由数组位置与页签名推导（见 `doc-models.js`）。
 *
 * 为什么单文件：四张榜共用一张表、单写者、总量几十行，
 * "一次原子替换 = 全量一致"比拆文件或上数据库都更稳（选型讨论见 docs）。
 *
 * 注意与 `model/queue-state.js` 区分：那个是定时任务的进度状态，与本文件无关。
 */
import fs from "node:fs/promises"
import path from "node:path"

/** 文档格式版本；结构变化时 +1，并在 `migrations` 里补一条迁移 */
export const STATE_FORMAT = 2

/** 页签种类（只影响语义与色带，不参与存储定位） */
const KINDS = new Set(["theater", "abyss", "spiral", "attack"])

/** 数据行字段（顺序即导出 B–G 的列序） */
export const ROW_FIELDS = ["nickname", "gameName", "anchor", "goal", "note", "status"]

const COL_RE = /^[A-Z]$/
const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value)

/** `data/queue.xlsx` → `data/queue.json`；不是 .xlsx 结尾就原样加 `.json` */
export const docFileOf = xlsxPath => (/\.xlsx$/i.test(String(xlsxPath)) ? String(xlsxPath).replace(/\.xlsx$/i, ".json") : `${xlsxPath}.json`)

/** 空文档（首启时由 xlsx 导入填充，不直接用） */
export const emptyDoc = () => ({ format: STATE_FORMAT, revision: 0, updatedAt: new Date().toISOString(), sheets: [] })

const fail = (where, message) => {
  throw new Error(`queue.json 结构不对：${where} ${message}`)
}

/**
 * 结构校验（手写，不引依赖）
 *
 * 只校验"结构能不能用"，不校验业务口径（昵称是否重名、行号是否连续等）——
 * 那些是迁移 / 编辑动作自己的事，放在这里会让一次手改触发一堆无关报错。
 */
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

/** 一条记录 → 一行 JSON（键序固定，保证 git diff 落行） */
const oneLine = (value, keys) => {
  const parts = []
  for (const key of keys) {
    const v = value[key]
    if (v === undefined || v === null || v === "") continue
    parts.push(`${JSON.stringify(key)}: ${JSON.stringify(v)}`)
  }
  return `{ ${parts.join(", ")} }`
}

/**
 * 规范化序列化：UTF-8、无 BOM、LF、末尾换行；`top` / `rows` 每条一行
 *
 * 注意不要用 `JSON.stringify(doc, null, 2)`：那会把每条记录摊成多行，
 * 改一格就是十几行 diff，存档比对也没法看。
 */
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

/** 读文档；文件不存在时抛 ENOENT（由调用方决定要不要从 xlsx 自举） */
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

/**
 * 原子写文档：临时文件 → （备份）→ rename
 *
 * 自动 `revision + 1` 并刷新 `updatedAt`：调用方不用自己维护这两个字段。
 */
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
