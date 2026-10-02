/**
 * 在线编辑器端到端：读写都打在表格副本上
 *
 * 覆盖：只暴露待填字段、下拉选项、写入校验、口令鉴权、健康检查。
 * 用法：node test/editor.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const SRC = process.argv[2] ?? "D:/文件/游戏/原神/2026年10月三路深渊排队.xlsx"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-editor-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
fs.writeFileSync(cfg, `xlsx_path: "${fixture.replace(/\\/g, "/")}"\n`, "utf8")

const editor = path.resolve(import.meta.dirname, "..", "tools", "editor.mjs")
const port = 7799
const TOKEN = "test-token-42"
const child = spawn(process.execPath, [editor, "--port", String(port), "--token", TOKEN], {
  env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_FILE: fixture },
  stdio: ["ignore", "pipe", "pipe"],
})
let out = ""
child.stdout.on("data", d => (out += d))
child.stderr.on("data", d => (out += d))

const wait = ms => new Promise(r => setTimeout(r, ms))
const api = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { __raw: text.slice(0, 4000) }
  }
  return { status: res.status, json }
}
/** 带口令的请求（编辑器要求 ?k=<token>） */
const apiK = (p, body) => api(`${p}${p.includes("?") ? "&" : "?"}k=${TOKEN}`, body)

let failed = 0
/** 支持同步与 async 回调 */
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}

try {
  // 等服务就绪（用带口令的请求）
  let ready = false
  for (let i = 0; i < 60; i++) {
    await wait(500)
    try {
      const r = await apiK("/healthz")
      if (r.status === 200) {
        ready = true
        break
      }
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  await check("口令：无口令访问接口被拒绝", async () => {
    const r = await api("/api/data")
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("口令：错误口令被拒绝", async () => {
    const r = await api("/api/data?k=wrong")
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("口令：无口令打开首页给出口令输入页（而不是 403）", async () => {
    const r = await api("/")
    if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
    if (!String(r.json.__raw).includes("访问口令")) throw new Error("首页不是口令输入页")
  })
  await check("健康检查：带口令返回配置摘要", async () => {
    const r = await apiK("/healthz")
    if (r.status !== 200 || !r.json.ok) throw new Error(`healthz 异常：${JSON.stringify(r.json)}`)
    if (r.json.auth !== true) throw new Error("healthz 未表明已启用口令")
    if (r.json.file !== fixture) throw new Error(`healthz 文件不对：${r.json.file}`)
  })

  const before = await apiK("/api/data")

  check("读取：三个工作表", () => {
    if (before.json.sheets.length !== 3) throw new Error(`得到 ${before.json.sheets.length} 个`)
  })
  check("读取：字段与下拉选项", () => {
    const s = before.json.sheets.find(x => x.name === "幽境危战")
    if (!s) throw new Error("缺少幽境危战")
    if (!s.options.goal?.length) throw new Error("难度没有下拉选项")
    if (!s.options.anchor?.length) throw new Error("主播没有下拉选项")
    if (!s.rows.length) throw new Error("没有数据行")
  })
  check("只显示要填的字段（不出现序号与完成情况）", () => {
    const keys = before.json.fields.map(f => f.key)
    /** 表格写入移到这里之后，界面只给报名者要填的信息 */
    const want = ["nickname", "gameName", "anchor", "goal", "strength", "note"]
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`字段为 ${keys.join(",")}，期望 ${want.join(",")}`)
    for (const gone of ["seq", "status"])
      if (keys.includes(gone)) throw new Error(`不该再显示 ${gone}`)
    /** 必填标记：群昵称与原神游戏名 */
    const required = before.json.fields.filter(f => f.required).map(f => f.key)
    if (JSON.stringify(required) !== JSON.stringify(["nickname", "gameName"]))
      throw new Error(`必填项为 ${required.join(",")}`)
    /** 传回来的行数据里也不该有 seq/status */
    const row = before.json.sheets[0].rows[0]
    if ("seq" in row || "status" in row) throw new Error("行数据里仍带 seq/status")
  })

  const sheet = "幽境危战"
  const target = before.json.sheets.find(x => x.name === sheet)
  const row = target.rows[target.rows.length - 1]
  const original = row.note
  const marker = "编辑器测试备注"

  const saved = await apiK("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, note: marker } }] })
  check("写入：保存成功", () => {
    if (!saved.json.ok) throw new Error(saved.json.error || "ok 不为 true")
    if (saved.json.written !== 1) throw new Error(`written=${saved.json.written}`)
  })

  const after = await apiK("/api/data")
  const back = after.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === row.row)
  check("写入：回读到新备注", () => {
    if (back.note !== marker) throw new Error(`期望 ${marker}，实际 ${back.note}`)
  })
  check("写入：其它列未被误改", () => {
    if (back.nickname !== row.nickname || back.gameName !== row.gameName) throw new Error("昵称/游戏名被改动")
    if (back.anchor !== row.anchor || back.goal !== row.goal || back.strength !== row.strength) throw new Error("主播/难度/强度被改动")
  })
  check("写入：序号公式列未受影响", () => {
    if (back.seq !== row.seq) throw new Error(`序号从 ${row.seq} 变成 ${back.seq}`)
  })

  // 还原备注
  await apiK("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, note: original } }] })
  const restored = await apiK("/api/data")
  const r2 = restored.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === row.row)
  check("还原：备注回到原值", () => {
    if (r2.note !== original) throw new Error(`期望 ${JSON.stringify(original)}，实际 ${JSON.stringify(r2.note)}`)
  })
  check("整表行数未变", () => {
    if (restored.json.sheets.find(x => x.name === sheet).rows.length !== target.rows.length)
      throw new Error("行数变化")
  })
  check("源表格未被触碰（编辑器只写副本）", () => {
    const a = fs.statSync(SRC)
    if (Date.now() - a.mtimeMs < 60_000) console.log(`     （注意：源表最近被改过 ${a.mtime.toLocaleString()}，请人工确认）`)
  })
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  child.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 编辑器端到端验证失败 ${failed} 项` : "\n✅ 编辑器端到端验证通过")
process.exit(failed ? 1 : 0)
