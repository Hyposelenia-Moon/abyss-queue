/**
 * 主人提示的「首次部署」路径（AQ-16）
 *
 * `notifyMasterOnce` 先读 `data/notice.<key>` 判断静默期。首次部署没有这个文件，
 * 读文件会抛 ENOENT；旧实现把任何读错误都吞进空 catch，于是**创建标记与通知都不执行**，
 * 每次启动都重复同样结果（主人永远收不到「部署补丁缺失」的提醒）。
 *
 * 契约：缺文件 = 从未通知（旧时间 0）→ 检查冷却 → 建目录写当前时间 → 通知；
 * 其它读写错误仍保留原来的保护（不发、不抛）。
 * 本套件把标记文件指向临时目录，不碰仓库 data/。
 *
 * 用法：node test/notice.test.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createChecker, Paths } from "./_helper.mjs"

const { check, finish } = createChecker("主人提示初始化")

/** 框架桩：AppBase 继承 plugin */
globalThis.plugin = class {
  constructor(o = {}) {
    Object.assign(this, o)
  }
}
globalThis.logger = { mark: () => {}, info: () => {}, warn: () => {}, error: () => {} }
globalThis.Bot = undefined

/**
 * 退出钩子由 `components/boot.js` 的 `boot()` 装配，而 `boot()` 只在插件入口 `index.js` 里调用；
 * 本套件不 import 入口，所以进程退出钩子根本不会被装上，不需要桩 `process.once`。
 */
const { AppBase, patchesCheckCount } = await import("../components/base.js")
const { noticeFile, notifyOnce } = await import("../components/notify.js")
const { boot, restartFlagFile } = await import("../components/boot.js")
const { PATCHES } = await import("../model/patches.js")

const COOLDOWN = 6 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

/** 一次通知记录 */
const recorder = () => {
  const calls = []
  return { calls, send: text => void calls.push(text) }
}

console.log("【1】全新目录（没有标记文件）：必须创建标记 + 通知一次")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-notice-"))
  const file = path.join(dir, "data", "notice.patches")
  const rec = recorder()

  check("目录不存在（前置）", () => assert.equal(fs.existsSync(path.dirname(file)), false))

  let ok
  check("首次调用返回 true（旧的 ENOENT 路径返回 false）", () => {
    ok = notifyOnce(file, "部署补丁缺失", { now: T0, send: rec.send })
    assert.equal(ok, true)
  })
  check("发出了通知", () => {
    assert.equal(rec.calls.length, 1, `通知次数 ${rec.calls.length}`)
    assert.equal(rec.calls[0], "部署补丁缺失")
  })
  check("标记文件被创建（目录也一并建出来）", () => assert.equal(fs.existsSync(file), true))
  check("标记里写的是当前时间", () => assert.equal(fs.readFileSync(file, "utf8"), String(T0)))
  check("boot() 装退出钩子，且只装一次（触发钩子会留下重启标记）", () => {
    const stub = { handlers: [] }
    const realOnce = process.once
    process.once = (event, fn) => stub.handlers.push({ event, fn })
    const flagFile = restartFlagFile
    const existed = fs.existsSync(flagFile)
    try {
      boot()
      boot()
      assert.equal(stub.handlers.length, 1, `exit 钩子注册了 ${stub.handlers.length} 次`)
      assert.equal(stub.handlers[0].event, "exit")
      stub.handlers[0].fn()
      assert.equal(fs.existsSync(flagFile), true, "触发退出钩子应留下重启标记")
      const at = Number(fs.readFileSync(flagFile, "utf8").trim())
      assert.ok(Number.isFinite(at) && at > 0, `标记内容应是时间戳：${at}`)
    } finally {
      process.once = realOnce
      if (!existed) fs.rmSync(flagFile, { force: true })
    }
  })
}

console.log("\n【2】冷却期内重复调用：不再通知")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-notice-"))
  const file = path.join(dir, "notice.patches")
  const rec = recorder()
  notifyOnce(file, "第一次", { now: T0, send: rec.send })

  check("冷却期内返回 false", () =>
    assert.equal(notifyOnce(file, "第二次", { now: T0 + COOLDOWN - 1, send: rec.send }), false),
  )
  check("只发了一次", () => assert.equal(rec.calls.length, 1, JSON.stringify(rec.calls)))
  check("标记没有被改写", () => assert.equal(fs.readFileSync(file, "utf8"), String(T0)))
}

console.log("\n【3】冷却期过后：重新通知并刷新标记")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-notice-"))
  const file = path.join(dir, "notice.patches")
  const rec = recorder()
  notifyOnce(file, "第一次", { now: T0, send: rec.send })

  check("冷却期刚过就再发一次", () =>
    assert.equal(notifyOnce(file, "第二次", { now: T0 + COOLDOWN, send: rec.send }), true),
  )
  check("通知内容是新的一条", () => assert.deepEqual(rec.calls, ["第一次", "第二次"]))
  check("标记刷新成新时间", () => assert.equal(fs.readFileSync(file, "utf8"), String(T0 + COOLDOWN)))
}

console.log("\n【4】已有的历史标记（旧行为里唯一能工作的路径）照旧")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-notice-"))
  const file = path.join(dir, "notice.patches")
  fs.writeFileSync(file, "0", "utf8")
  const rec = recorder()
  check("内容为 0 的标记 = 从未通知 → 发一次", () =>
    assert.equal(notifyOnce(file, "历史标记", { now: T0, send: rec.send }), true),
  )
  check("标记被改写", () => assert.equal(fs.readFileSync(file, "utf8"), String(T0)))
}

console.log("\n【5】其它读错误仍受保护（不通知、也不抛）")
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-notice-"))
  const file = path.join(dir, "notice.patches")
  /** 把标记做成目录：readFileSync 会抛 EISDIR（不是 ENOENT） */
  fs.mkdirSync(file, { recursive: true })
  const rec = recorder()
  check("读不出来的标记不当成「从未通知」：返回 false", () =>
    assert.equal(notifyOnce(file, "不该发", { now: T0, send: rec.send }), false),
  )
  check("也没有发通知", () => assert.equal(rec.calls.length, 0, JSON.stringify(rec.calls)))
}

console.log("\n【6】生产路径：标记落在插件 data/ 下，且自检与通知接在一起")
{
  check("noticeFile(key) = <插件根>/data/notice.<key>", () =>
    assert.equal(noticeFile("patches"), path.join(Paths.root, "data", "notice.patches")),
  )
  check("补丁清单非空（自检有东西可查）", () => assert.ok(PATCHES.length > 0))
  /** 只 import _base 不会跑自检：它在 AppBase 构造函数里 */
  check("加载阶段没跑自检", () => assert.equal(patchesCheckCount(), 0, `自检次数 ${patchesCheckCount()}`))
  check("构造 AppBase 后自检跑了一次", () => {
    new AppBase()
    assert.equal(patchesCheckCount(), 1, `自检次数 ${patchesCheckCount()}`)
  })
  check("再构造多个 app 实例不会重复自检", () => {
    new AppBase()
    new AppBase()
    assert.equal(patchesCheckCount(), 1, `自检次数 ${patchesCheckCount()}`)
  })
}

await finish()
process.exit(process.exitCode || 0)
