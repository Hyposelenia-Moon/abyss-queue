/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行（见 test/env.mjs 的说明） */
import { ensureEnv } from "./env.mjs"
/**
 * 清榜前核查落表（`model/editor-commands.js` 的 `markChecked`）：进程内直调编辑器的 checkDone
 *
 * 三道闸按顺序钉住——任何一道松了，"清榜前批量标记完成"就会写错行、覆盖别人刚改的表，或者干脆没写：
 *   1. 未挂载 ⇒ 抛「标记完成需要它」（不做 HTTP 兜底）；
 *   2. 版本串不是 64 位 hex（含空串）⇒ 抛「清榜核查缺少有效版本」，**editor 一次都不调**；
 *   3. `rows` 为空 ⇒ 直接返回 `{updated:0, rows:[]}`，不调 editor、不抛；
 *   4. 正常路径 ⇒ 恰好调一次，榜名 / 版本 / 行号（数字）/ 机器人身份透传。
 *
 * 与 notify.test.mjs 同一套样板：注册假 service、记 `calls`、结束时 `resetEditorService()`。
 * 被测函数只把参数交给 service、不读表，所以不需要复制 fixture 表。
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createChecker, installFrameworkStubs } from "./_helper.mjs"
import { registerEditorService, resetEditorService } from "../editor/service.js"

const ENV = await ensureEnv({ prefix: "abyss-queue-check-write-", cloud: false })
installFrameworkStubs()

const { markChecked } = await import("../model/editor-commands.js")
const { ROSTER_QQ } = await import("../model/roster.js")
const { check, finish } = createChecker("清榜核查落表")

const VERSION = "a".repeat(64)
const SHEET = "深渊1"
const ROWS = [{ row: 7, nickname: "小明", goal: "第12层满星" }]

const calls = []
const mount = () =>
  registerEditorService({
    checkDone: async (caller, body) => {
      calls.push({ caller, body })
      return { ok: true, sheet: body.sheet, updated: body.rows.length, rows: body.rows.map(r => r.row) }
    },
  })

console.log("【1】未挂载：直接报错，不做 HTTP 兜底")
{
  resetEditorService()
  await check("抛「标记完成需要它」", async () => {
    await assert.rejects(() => markChecked({ sheet: SHEET, version: VERSION, rows: ROWS }), /标记完成需要它/)
  })
  check("一次都没调 checkDone", () => assert.equal(calls.length, 0, `实际调了 ${calls.length} 次`))
}

console.log("\n【2】版本串非法：抛错，且 editor 一次都不调")
{
  mount()
  const bad = ["", "   ", "abc", "a".repeat(63), "a".repeat(65), "g".repeat(64)]
  await check("六种非法版本都抛「清榜核查缺少有效版本」", async () => {
    const before = calls.length
    for (const version of bad)
      await assert.rejects(
        () => markChecked({ sheet: SHEET, version, rows: ROWS }),
        /清榜核查缺少有效版本/,
        `version=${JSON.stringify(version)}`,
      )
    assert.equal(calls.length, before, `不该调 checkDone：${JSON.stringify(calls.slice(before))}`)
  })
  await check("不给 version（undefined）同样按缺失处理", async () => {
    await assert.rejects(() => markChecked({ sheet: SHEET, rows: ROWS }), /清榜核查缺少有效版本/)
  })
}

console.log("\n【3】rows 为空：早返回，不调 editor、不抛")
{
  const before = calls.length
  await check("rows: [] → {updated:0, rows:[]}", async () => {
    const out = await markChecked({ sheet: SHEET, version: VERSION, rows: [] })
    assert.deepEqual(out, { updated: 0, rows: [] })
    assert.equal(calls.length, before, `不该调 checkDone：${JSON.stringify(calls.slice(before))}`)
  })
  await check("不给 rows（默认空）→ 同样早返回", async () => {
    const out = await markChecked({ sheet: SHEET, version: VERSION })
    assert.deepEqual(out, { updated: 0, rows: [] })
    assert.equal(calls.length, before, `不该调 checkDone：${JSON.stringify(calls.slice(before))}`)
  })
}

console.log("\n【4】正常路径：恰好调一次，参数逐个透传")
{
  const before = calls.length
  const out = await markChecked({
    sheet: SHEET,
    version: VERSION,
    rows: [{ row: "7", nickname: "小明", goal: "第12层满星" }],
  })
  check("checkDone 恰好调 1 次", () => assert.equal(calls.length, before + 1, `实际调了 ${calls.length - before} 次`))
  check("body：榜名与版本原样透传", () => {
    const c = calls.at(-1)
    assert.ok(c, "checkDone 没被调用")
    assert.equal(c.body.sheet, SHEET)
    assert.equal(c.body.version, VERSION)
  })
  check("行号转成数字（输入字符串 \"7\" → 7），昵称与目标一起带上", () => {
    const rows = calls.at(-1)?.body?.rows ?? []
    assert.equal(rows.length, 1, JSON.stringify(rows))
    assert.strictEqual(rows[0].row, 7, `行号不是数字：${JSON.stringify(rows[0].row)}`)
    assert.equal(rows[0].nickname, "小明")
    assert.equal(rows[0].goal, "第12层满星")
  })
  check("调用者是机器人身份：ROSTER_QQ +「清榜核查」", () => {
    const caller = calls.at(-1)?.caller ?? {}
    assert.equal(String(caller.qq), ROSTER_QQ, JSON.stringify(caller))
    assert.equal(caller.nick, "清榜核查", JSON.stringify(caller))
  })
  check("回执把编辑器的结果并回来（ok=true）", () => assert.equal(out.ok, true, JSON.stringify(out)))
}

await ENV.cloud?.close()
await fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
await finish()
resetEditorService()
