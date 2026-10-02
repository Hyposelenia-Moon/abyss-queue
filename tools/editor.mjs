/**
 * 本地表格编辑器（零依赖，仅监听 127.0.0.1）
 *
 * 这是填写排表的**唯一入口**：聊天端只保留查询指令（#排队 / #我的 / #主播 / #清空），
 * 报名、退队、改备注都在这里填。因此界面上只显示「需要填的信息」：
 *
 *   #  群昵称  原神游戏名  选择主播  难度  账号强度  备注
 *
 * 序号是公式（只读不给填），「帮帮完成情况」是主播的进度、也不在填写范围里。
 *
 * 启动（在机器人根目录）：
 *   node plugins/abyss-queue/tools/editor.mjs              # http://127.0.0.1:7788
 *   node plugins/abyss-queue/tools/editor.mjs --port 8899
 *   node plugins/abyss-queue/tools/editor.mjs --file "D:/path/to/表.xlsx"
 *
 * 写入安全：走插件自己的 Table.mutate —— 写前备份 `<表名>.bak`、写入后回读自检，
 * 校验不过会放弃写入；写之前还会做一次业务校验（昵称必填、同榜不重名、下拉值必须命中）。
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getTable } from "../model/index.js"
import { config, configPath } from "../components/config.js"
import { matchOption } from "../lib/queue.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, "editor.html")

/** 腾讯文档在线版（本地编辑器里给个入口，便于对照） */
const ONLINE_URL = process.env.ABYSS_ONLINE_URL ?? "https://docs.qq.com/sheet/DQURqWURTSWVCYmZQ?tab=fgj2p1"

/**
 * 填写字段 = 报名者需要提供的信息
 *   key   对应表格列（由模型按表头识别）
 *   label 界面标题（与表头一致，方便对照原表）
 *   option 指定时用原表该列的数据验证做下拉
 *   required 必填
 */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor" },
  { key: "goal", label: "难度及目标", option: "goal" },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
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

/** 汇总为前端可用的结构：只给出要填的字段 */
const buildPayload = async () => {
  const data = await table().read(({ models }) => {
    const sheets = []
    for (const model of models.values()) {
      sheets.push({
        name: model.name,
        title: model.title,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        options: model.options ?? {},
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

const blank = v => !String(v ?? "").trim()

/**
 * 业务校验（与插件报名时的口径一致）
 * @returns {string[]} 问题列表，空数组表示通过
 */
const validateRows = (model, rows) => {
  const problems = []
  const seen = new Map()
  /* 表内已有的昵称（排除本次要改的行） */
  const touched = new Set(rows.map(r => Number(r?.row)).filter(Boolean))
  for (const r of model.rows) {
    if (touched.has(r.row)) continue
    if (!blank(r.nickname)) seen.set(String(r.nickname).trim(), r.row)
  }

  for (const r of rows) {
    const v = r?.values ?? {}
    const who = blank(v.nickname) ? `第 ${r.row} 行` : `「${String(v.nickname).trim()}」`
    if (blank(v.nickname) && blank(v.gameName) && blank(v.note) && blank(v.anchor))
      continue /* 整行清空是合法的删除 */

    for (const f of FIELDS.filter(x => x.required))
      if (blank(v[f.key])) problems.push(`${who}：${f.label}不能为空`)

    const nick = String(v.nickname ?? "").trim()
    if (nick) {
      if (seen.has(nick)) problems.push(`${who}：昵称与表格第 ${seen.get(nick)} 行重复`)
      seen.set(nick, r.row)
    }

    for (const f of FIELDS.filter(x => x.option)) {
      const val = String(v[f.key] ?? "").trim()
      if (!val) continue
      const opts = model.options?.[f.option] ?? []
      if (opts.length && !opts.includes(val) && !matchOption(val, opts))
        problems.push(`${who}：${f.label}「${val}」不在下拉选项里`)
    }
  }
  return problems
}

/** 保存：先校验，再逐格写；整行空内容 = 清空该行 */
const applySave = async ({ sheet, rows }) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")

  const normalized = rows.map(r => ({
    row: Number(r?.row) || 0,
    values: Object.fromEntries(FIELDS.map(f => [f.key, String(r?.values?.[f.key] ?? "").trim()])),
  }))

  /* 校验要基于当前表内容，因此放在 mutate 之外先读一次 */
  const model = await table().read(({ models }) => models.get(sheet) ?? null)
  if (!model) throw new Error(`表格里没有工作表「${sheet}」`)
  const problems = validateRows(model, normalized)
  if (problems.length) throw new Error(`校验未通过：\n${problems.slice(0, 6).join("\n")}`)

  return table().mutate(ctx => {
    const m = ctx.model(sheet)
    let written = 0
    let cleared = 0
    for (const r of normalized) {
      if (!r.row) continue
      /* 计算行号：空行按清空处理（序号公式列不动） */
      const empty = FIELDS.every(f => blank(r.values[f.key]))
      if (empty) {
        ctx.clearRow(sheet, r.row)
        cleared++
        continue
      }
      for (const f of FIELDS) if (m.col?.[f.key]) ctx.setCell(sheet, r.row, f.key, r.values[f.key])
      written++
    }
    return { written, cleared }
  })
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
      return json(res, 200, { ok: true, ...(await applySave(body)) })
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    json(res, 400, { ok: false, error: err?.message ?? String(err) })
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`本地编辑器已启动：http://127.0.0.1:${PORT}`)
  console.log(`  表格：${xlsxPath}`)
  console.log(`  在线版：${ONLINE_URL}`)
  console.log(`  填写字段：${FIELDS.map(f => f.label).join(" / ")}`)
  console.log("  按 Ctrl+C 退出")
})
