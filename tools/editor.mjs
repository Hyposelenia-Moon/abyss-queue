/**
 * 排队表在线编辑器（零额外依赖：只用 node 内置模块 + jszip）
 *
 * 群友在浏览器里填表，机器人在群里发链接。设计要点：
 *   - 只暴露「需要填的字段」：群昵称 / 原神游戏名 / 选择主播 / 难度及目标 / 账号强度 / 备注
 *   - 写入走插件自己的 Table.mutate：写前备份 `.bak`、写入后回读自检，校验不过放弃写入
 *   - 访问口令：带 token 才能打开（机器人随 #排队 把带 token 的链接发给群成员）
 *   - 可部署到云服务器：监听地址、端口、数据文件、口令都可用环境变量/参数指定
 *
 * 本机测试：
 *   node tools/editor.mjs
 *   → http://127.0.0.1:7788/?k=<口令>
 *
 * 云服务器（详见 tools/DEPLOY.md）：
 *   ABYSS_EDITOR_FILE=/srv/abyss/queue.xlsx \
 *   ABYSS_EDITOR_TOKEN=<随机口令> \
 *   ABYSS_EDITOR_BIND=0.0.0.0 \
 *   ABYSS_EDITOR_PORT=7788 \
 *   node editor.mjs
 *
 * 参数（优先级高于环境变量）：
 *   --file <xlsx>   表格文件
 *   --port <n>      端口，默认 7788
 *   --bind <addr>   监听地址，默认 127.0.0.1；对外服务填 0.0.0.0
 *   --token <口令>  访问口令；留空则不校验（仅本机测试用）
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, "editor.html")

const args = process.argv.slice(2)
const flag = (name, fallback = "") => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const PORT = Number(flag("--port", process.env.ABYSS_EDITOR_PORT ?? 7788))
const BIND = flag("--bind", process.env.ABYSS_EDITOR_BIND ?? "127.0.0.1")
const TOKEN = String(flag("--token", process.env.ABYSS_EDITOR_TOKEN ?? "")).trim()
const ONLINE_URL = process.env.ABYSS_EDITOR_ONLINE ?? ""

/**
 * 数据文件：优先 --file / 环境变量；否则用插件配置里的 xlsx_path。
 * 之所以要能独立指定，是为了让编辑器能单独部署到云服务器。
 */
const resolveFile = async () => {
  const direct = flag("--file", process.env.ABYSS_EDITOR_FILE ?? "")
  if (direct) return path.resolve(direct)
  const { config } = await import("../components/config.js")
  return config.xlsxPath
}

const xlsxPath = await resolveFile()
if (!xlsxPath) {
  console.error("没有指定表格文件：用 --file <xlsx> 或环境变量 ABYSS_EDITOR_FILE")
  process.exit(1)
}
if (!fs.existsSync(xlsxPath)) {
  console.error(`表格不存在：${xlsxPath}`)
  process.exit(1)
}

/* 数据层与渲染只在这一步引入：独立部署时这些文件必须一起带上 */
const { getTable } = await import("../model/index.js")
const { matchOption } = await import("../lib/queue.js")

const table = () => getTable()

/** 填写字段 = 报名者需要提供的信息 */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor" },
  { key: "goal", label: "难度及目标", option: "goal" },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
]

const blank = v => !String(v ?? "").trim()

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

/** 业务校验：必填、同榜不重名、下拉值必须命中 */
const validateRows = (model, rows) => {
  const problems = []
  const seen = new Map()
  const touched = new Set(rows.map(r => Number(r?.row)).filter(Boolean))
  for (const r of model.rows) {
    if (touched.has(r.row)) continue
    if (!blank(r.nickname)) seen.set(String(r.nickname).trim(), r.row)
  }

  for (const r of rows) {
    const v = r?.values ?? {}
    const who = blank(v.nickname) ? `第 ${r.row} 行` : `「${String(v.nickname).trim()}」`
    /* 整行清空 = 删除，允许 */
    if (FIELDS.every(f => blank(v[f.key]))) continue

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

/** 保存：校验 → 逐格写；整行空 = 清空该行（序号公式列不动） */
const applySave = async ({ sheet, rows }) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 500) throw new Error("一次提交的行数过多（>500）")

  const normalized = rows.map(r => ({
    row: Number(r?.row) || 0,
    values: Object.fromEntries(FIELDS.map(f => [f.key, String(r?.values?.[f.key] ?? "").trim()])),
  }))

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
      if (FIELDS.every(f => blank(r.values[f.key]))) {
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

/* ------------------------------ HTTP ------------------------------ */

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

/** 口令校验：支持 ?k=<token>；带着就一直可用（前端会存起来） */
const tokenOf = req => {
  const u = new URL(req.url, "http://localhost")
  return u.searchParams.get("k") ?? u.searchParams.get("token") ?? ""
}
const authorized = req => !TOKEN || tokenOf(req) === TOKEN

/** 未授权时给一个极简的「输入口令」页，避免直接 403 让人摸不着头脑 */
const denialPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 需要口令</title>
<style>body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16);width:min(92vw,340px)}
h1{font-size:17px;margin:0 0 6px}p{color:#6b7590;font-size:13px;margin:0 0 16px}
input{width:100%;padding:10px;border:1px solid #d6deef;border-radius:8px;font:inherit;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#c8a35a;color:#3a2c07;font:inherit;font-weight:700;cursor:pointer}
.err{color:#a53c2e;font-size:13px;margin-top:10px;display:none}</style></head>
<body><div class="card"><h1>排队表</h1><p>请输入群里的访问口令</p>
<form onsubmit="go(event)"><input id="k" placeholder="访问口令" autocomplete="off"><button>进入</button></form>
<div class="err" id="e">口令不对，请重新输入</div>
<script>
const q=new URLSearchParams(location.search);
if(q.get('bad'))document.getElementById('e').style.display='block';
function go(ev){ev.preventDefault();const k=document.getElementById('k').value.trim();if(!k)return;location.href='/?k='+encodeURIComponent(k)}
</script></div></body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)

  if (!authorized(req)) {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(denialPage())
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await fsp.readFile(TEMPLATE, "utf8")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(html)
    }
    if (req.method === "GET" && url.pathname === "/api/data") return json(res, 200, await buildPayload())
    if (req.method === "POST" && url.pathname === "/api/save") {
      const body = await readBody(req)
      return json(res, 200, { ok: true, ...(await applySave(body)) })
    }
    /* 健康检查：部署时用来确认服务活着 */
    if (req.method === "GET" && url.pathname === "/healthz")
      return json(res, 200, { ok: true, file: xlsxPath, bind: BIND, port: PORT, auth: Boolean(TOKEN) })
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    json(res, 400, { ok: false, error: err?.message ?? String(err) })
  }
})

server.listen(PORT, BIND, () => {
  console.log(`排队表编辑器已启动：http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${PORT}`)
  console.log(`  监听：${BIND}:${PORT}${BIND === "0.0.0.0" ? "（对外）" : "（仅本机）"}`)
  console.log(`  表格：${xlsxPath}`)
  console.log(`  口令：${TOKEN ? "已设置" : "未设置（任何人都能访问，仅建议本机测试）"}`)
  console.log(`  填写字段：${FIELDS.map(f => f.label).join(" / ")}`)
  console.log("  按 Ctrl+C 退出")
})
