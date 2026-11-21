/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行（见 test/env.mjs 的说明） */
import { ensureEnv } from "./env.mjs"
/**
 * 退队（`model/leave-row.js`）：进程内直调编辑器的两条动作
 *
 * 这条链路原先零覆盖：编辑器没挂上、清行参数拼错（少 `clear` / 行号没转数字 / 字段没清空）
 * 在群里都只表现为"表里那一行还在"，不会报错，只能事后看表。
 *
 * 钉住四件事：
 *   1. 已挂载：`save` 恰好调一次，带**管理员身份**、目标行、`clear: true`、整行字段全空；
 *   2. 未挂载：抛错（不做 HTTP 兜底），一次都不调 `save`；
 *   3. `tidySheet`：榜名透传给编辑器；编辑器整理失败时只记日志、返回 null，不把退队带成失败；
 *   4. 未挂载时整理同样只返回 null（退队结果不受整理影响）。
 *
 * 编辑器动作在 `editor/service.js` 的注册表里，这里挂假 service 记录调用（与 notify.test.mjs 同一套样板）。
 * 两个被测函数只把参数交给 service、不读表，所以不需要复制 fixture 表。
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createChecker, installFrameworkStubs } from "./_helper.mjs"
import { registerEditorService, resetEditorService } from "../editor/service.js"

const ENV = await ensureEnv({ prefix: "abyss-queue-leave-row-", cloud: false })
installFrameworkStubs()

const { leaveRow, tidySheet } = await import("../model/leave-row.js")
const { check, finish } = createChecker("退队直调")

const saves = []
const tidies = []
/** 挂假 service（`overrides` 用来演"编辑器那边失败"）；`resetEditorService()` 之后就是未挂载 */
const mount = (overrides = {}) =>
  registerEditorService({
    save: async (caller, body) => {
      saves.push({ caller, body })
      return { ok: true, updated: 1 }
    },
    tidy: async (caller, body) => {
      tidies.push({ caller, body })
      return { ok: true, moved: 0, tidied: [] }
    },
    ...overrides,
  })

console.log("【1】已挂载：退队走 editor 的 save，只清发起者那一行")
{
  mount()
  const before = saves.length
  const out = await leaveRow({ caller: { qq: "10001", nick: "小明" }, sheet: "深渊1", row: 7 })
  check("save 恰好调 1 次", () => assert.equal(saves.length, before + 1, `实际调了 ${saves.length - before} 次`))
  check("调用者是管理员身份：role=admin，QQ 与昵称原样带上", () => {
    const c = saves.at(-1)
    assert.ok(c, "save 没被调用")
    assert.equal(c.caller.role, "admin", JSON.stringify(c.caller))
    assert.equal(c.caller.identity?.qq, "10001", JSON.stringify(c.caller))
    assert.equal(c.caller.identity?.nick, "小明", JSON.stringify(c.caller))
  })
  check("只清这一行：sheet 透传、rows 一条、row=7、clear=true", () => {
    const c = saves.at(-1)
    assert.ok(c, "save 没被调用")
    assert.equal(c.body.sheet, "深渊1")
    assert.equal(c.body.rows?.length, 1, JSON.stringify(c.body))
    assert.equal(c.body.rows[0].row, 7)
    assert.equal(c.body.rows[0].clear, true)
  })
  check("整行字段全空（编辑器据此把这一行当删除处理）", () => {
    const values = saves.at(-1)?.body?.rows?.[0]?.values ?? {}
    const keys = Object.keys(values)
    assert.ok(keys.length, "values 一个键都没有，编辑器不知道要清哪些字段")
    for (const key of keys) assert.equal(values[key], "", `${key} 不是空串`)
  })
  check("回执把编辑器的结果并回来（ok=true）", () => assert.equal(out.ok, true, JSON.stringify(out)))
}

console.log("\n【2】未挂载：报错让调用方回话，不做 HTTP 兜底")
{
  resetEditorService()
  const before = saves.length
  await check("抛「退队需要它」", async () => {
    await assert.rejects(
      () => leaveRow({ caller: { qq: "10001", nick: "小明" }, sheet: "深渊1", row: 7 }),
      /退队需要它/,
    )
  })
  check("一次都没调 save", () => assert.equal(saves.length, before, `实际调了 ${saves.length - before} 次`))
}

console.log("\n【3】整理：榜名透传给 editor，回执原样返回")
{
  mount()
  const before = tidies.length
  const out = await tidySheet("深渊1")
  check("tidy 恰好调 1 次，带的是这个榜（不是全部榜）", () => {
    const c = tidies.at(-1)
    assert.ok(c, "tidy 没被调用")
    assert.equal(tidies.length, before + 1, `实际调了 ${tidies.length - before} 次`)
    assert.equal(c.body.sheet, "深渊1")
    assert.equal(c.caller.nick, "每日整理", JSON.stringify(c.caller))
  })
  check("回执说明整理完成（ok=true）", () => assert.equal(out.ok, true, JSON.stringify(out)))
}

console.log("\n【4】整理失败：只记日志、返回 null，不把退队带成失败")
{
  mount({ tidy: async () => { throw new Error("模拟编辑器整理失败") } })
  await check("tidySheet 返回 null，不抛错", async () => {
    let out
    await assert.doesNotReject(async () => { out = await tidySheet("深渊1") })
    assert.equal(out, null)
  })
}

console.log("\n【5】未挂载时整理同样只返回 null")
{
  resetEditorService()
  await check("「整理需要它」被吞掉：返回 null，不抛错", async () => {
    let out
    await assert.doesNotReject(async () => { out = await tidySheet("深渊1") })
    assert.equal(out, null)
  })
}

await ENV.cloud?.close()
await fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
await finish()
resetEditorService()
