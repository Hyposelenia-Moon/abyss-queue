/**
 * 一次性：端到端验证本地编辑器（读写都打在表格副本上）
 * 用法：node test/.editor-e2e.mjs
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
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
const child = spawn(process.execPath, [editor, "--port", String(port)], {
  env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg },
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
  return { status: res.status, json: await res.json() }
}

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}

try {
  // 等服务就绪
  let ready = false
  for (let i = 0; i < 60; i++) {
    await wait(500)
    try {
      await api("/api/data")
      ready = true
      break
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  const before = await api("/api/data")
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

  const saved = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, note: marker } }] })
  check("写入：保存成功", () => {
    if (!saved.json.ok) throw new Error(saved.json.error || "ok 不为 true")
    if (saved.json.written !== 1) throw new Error(`written=${saved.json.written}`)
  })

  const after = await api("/api/data")
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
  await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, note: original } }] })
  const restored = await api("/api/data")
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
