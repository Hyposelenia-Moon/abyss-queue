/**
 * 本地表格编辑器（零依赖，仅监听 127.0.0.1）
 *
 * 用途：不开 Excel 也能方便地维护这张排表——看三个榜、改单元格、增删行，
 * 写入走插件自己的 Table.mutate（写前备份 + 回读自检），不会绕过校验。
 *
 * 启动（在机器人根目录，或任何能 import 到本插件的目录）：
 *   node plugins/abyss-queue/tools/editor.mjs            # 默认 http://127.0.0.1:7788
 *   node plugins/abyss-queue/tools/editor.mjs --port 8899
 *   node plugins/abyss-queue/tools/editor.mjs --file "D:/path/to/表.xlsx"
 *
 * 说明：
 *   - 序号列（A 列）是公式，编辑器只读不写，避免把公式写坏
 *   - 「选择主播 / 难度 / 账号强度 / 帮帮完成情况」这些列直接下拉，选项来自原表的数据验证
 *   - 保存前会先备份（<表名>.bak），写入后回读校验，校验不过会放弃写入
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getTable } from "../model/index.js"
import { config, configPath } from "../components/config.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, "editor.html")

/** 腾讯文档在线版（本地编辑器里给个入口，便于对照） */
const ONLINE_URL = process.env.ABYSS_ONLINE_URL ?? "https://docs.qq.com/sheet/DQURqWURTSWVCYmZQ?tab=fgj2p1"

/** 表字段 → 展示名与是否可编辑 */
const FIELDS = [
  { key: "seq", label: "序号", editable: false },
  { key: "nickname", label: "群昵称", editable: true },
  { key: "gameName", label: "游戏名", editable: true },
  { key: "anchor", label: "主播", editable: true, option: "anchor" },
  { key: "goal", label: "难度及目标", editable: true, option: "goal" },
  { key: "strength", label: "账号强度", editable: true, option: "strength" },
  { key: "status", label: "帮帮完成情况", editable: true, option: "status" },
  { key: "note", label: "备注", editable: true },
]

const args = process.argv.slice(2)
const flag = (name, fallback = "") => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PORT = Number(flag("--port", process.env.ABYSS_EDITOR_PORT ?? 7788))
const xlsxPath = flag("--file", config.xlsxPath)

if (!xlsxPath) {
  console.error(`表格路径为空：请先在 ${configPath} 里填写 xlsx_path，或用 --file 指定`)
  process.exit(1)
}
if (!fs.existsSync(xlsxPath)) {
  console.error(`表格不存在：${xlsxPath}`)
  process.exit(1)
}

const table = () => getTable()

/** 汇总所有工作表为前端可用的结构 */
const buildPayload = async () => {
  const data = await table().read(({ models }) => {
    const sheets = []
    for (const model of models.values()) {
      sheets.push({
        name: model.name,
        title: model.title,
        headerRow: model.headerRow,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        options: model.options,
        anchors: model.anchors.map(a => a.name).filter(Boolean),
        rows: model.rows.map(r => {
          const o = { row: r.row }
          for (const f of FIELDS) o[f.key] = r[f.key] ?? ""
          return o
        }),
      })
    }
    return { sheets }
  })
  return {
    file: xlsxPath,
    online: ONLINE_URL,
    fields: FIELDS,
    sheets: data.sheets,
    savedAt: fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath).mtime.toLocaleString("zh-CN") : "",
  }
}

/**
 * 保存：逐个单元格 setCell，行内容全空则清空该行
 * 只处理可编辑字段；序号列不动（它是公式）
 */
const applySave = async ({ sheet, rows }) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  const result = await table().mutate(ctx => {
    const model = ctx.model(sheet)
    const valid = new Set(Object.keys(model.col ?? {}))
    let written = 0
    let cleared = 0
    for (const r of rows) {
      const row = Number(r?.row)
      if (!row) continue
      const values = r.values ?? {}
      const editable = FIELDS.filter(f => f.editable && valid.has(f.key))
      const empty = editable.every(f => !String(values[f.key] ?? "").trim())
      if (empty) {
        ctx.clearRow(sheet, row)
        cleared++
        continue
      }
      for (const f of editable) ctx.setCell(sheet, row, f.key, values[f.key] ?? "")
      written++
    }
    return { written, cleared }
  })
  return result
}

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body), "utf8")
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length })
  res.end(buf)
}

const readBody = req =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", c => {
      chunks.push(c)
      if (Buffer.concat(chunks).length > 4 * 1024 * 1024) reject(new Error("请求体过大"))
    })
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`))
      }
    })
    req.on("error", reject)
  })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await fsp.readFile(TEMPLATE, "utf8")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(html)
    }
    if (req.method === "GET" && url.pathname === "/api/data") return json(res, 200, await buildPayload())
    if (req.method === "POST" && url.pathname === "/api/save") {
      const body = await readBody(req)
      const result = await applySave(body)
      return json(res, 200, { ok: true, ...result })
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    json(res, 500, { ok: false, error: err?.message ?? String(err) })
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`本地编辑器已启动：http://127.0.0.1:${PORT}`)
  console.log(`  表格：${xlsxPath}`)
  console.log(`  在线版：${ONLINE_URL}`)
  console.log("  按 Ctrl+C 退出")
})
