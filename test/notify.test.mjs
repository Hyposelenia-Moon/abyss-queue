/* 隔离配置必须最先就位：ESM 的静态 import 先于顶层代码执行，
   若在本文件里 setenv，config.js 早就按仓库 config.yaml 读完了（会动到真实表格） */
import { ensureEnv } from "./env.mjs"
/**
 * 定时通知回归：**唯一一条定时任务**（`notify.cron`）里的四件事
 *
 *   1. 完成情况轮询（上一位完成 → @ 下一位，见 workflow.test.mjs 的主链路用例）
 *   2. 榜开启提醒（未开启 → 已开启时 @ 该榜排队中的人，每榜每次开启只提醒一次）
 *   3. 月末催办（每月最后一天到 monthly_at 之后当天只发一次）
 *   4. 群成员名单同步（每天到 roster.at 之后当天只发一次）
 *
 * 三条去重口径都落在 `data/progress.json` 那一个文件里（`rows` / `open` / `daily`）：
 *   - `open` 存的是"上一次观察到的每榜开启状态"，因此 false→true 才提醒、true→true 不提醒，
 *     重启后读同一个文件也不会重复提醒；
 *   - `daily` 按本地日期记"今天做过了"，所以重启、重复 tick 都只发一次。
 *
 * 时间全部由 `tick(now)` 注入（不 mock 全局 Date）：月末与名单同步这两条按真实日历没法在一秒内跑完。
 * 表格是**假云端**（`test/env.mjs`）服务的副本，改表走 `model/table.js`（测试侧摆数据，插件只读）。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createChecker, installFrameworkStubs, requireSource } from "./_helper.mjs"
import { DEFAULT_CONFIG } from "../components/config.js"
import { TICK_NAME } from "../lib/notify.js"
import { QUEUED, WAITING } from "../lib/progress.js"

const SOURCE = await requireSource()
const { check, finish } = createChecker("定时通知")

/** 通知群：@ 人的名单（群昵称 → QQ）由桩动态提供，内容在用例里补 */
const MEMBERS = { 名单样本甲: "11001", 名单样本乙: "11002" }

const ENV = await ensureEnv({
  prefix: "abyss-queue-notify-",
  extra: {
    notify: { enable: true, groups: [20000] },
    roster: { group: "20000", at: "05:00" },
    anchor_aliases: {},
  },
})
await fs.promises.copyFile(SOURCE, ENV.fixture)
const sha256 = buf => createHash("sha256").update(buf).digest("hex")
const fixtureHash = sha256(fs.readFileSync(ENV.fixture))

/** 固定成"两个榜都已开启"的日历：沿用编辑器那套 剧诗=每月 1 号 4 点 / 螺旋=16 号 4 点 */
const D1 = new Date(2026, 9, 20, 12, 0, 0) // 20 号：剧诗已开、螺旋已开（>=16 号 4 点）
const D2 = new Date(2026, 9, 10, 12, 0, 0) // 10 号：剧诗已开、螺旋未开（<16 号 4 点）

const sent = installFrameworkStubs({ members: MEMBERS })

const { config } = await import("../components/config.js")
const { AbyssQueueQuery } = await import("../apps/queue.js")
const { Table } = await import("../model/table.js")
const { defaultStatusOf, localDayKey } = await import("../lib/progress.js")

/** 状态文件落点：`ensureEnv` 已经按 ABYSS_QUEUE_STATE_FILE 指到临时目录（配置里没有这个键） */
const STATE = config.notifyStatePath
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"))
  } catch {
    return null
  }
}
/** 一次 tick：返回**本轮新发**的消息（把上一次的收件箱长度记下来做差） */
const tick = async (now = D1) => {
  const before = sent.length
  await new AbyssQueueQuery().tick(now)
  return sent.slice(before).map(m => ({ gid: m.gid, text: flat(m.msg) }))
}
const flat = msg =>
  Array.isArray(msg)
    ? msg
        .map(p => (typeof p === "string" ? p : p?.type === "at" ? `@${p.qq}` : JSON.stringify(p)))
        .join("")
    : String(msg)

const model = async sheet => new Table({ file: ENV.fixture, backup: false }).read(({ models }) => models.get(sheet))
/** 表里"排队中"的人（提醒应当 @ 的正是他们） */
const queuedNames = async sheet => (await model(sheet)).rows.filter(r => r.status === QUEUED).map(r => r.nickname)

console.log(`源表格：${SOURCE}\n测试副本：${ENV.fixture}\n状态文件：${STATE}\n`)

/* ------------------------------ 用例 ------------------------------ */

console.log("【1】只注册一条定时任务")
{
  const inst = new AbyssQueueQuery()
  inst.init()
  check("注册的任务恰好 1 条", () => {
    assert.equal(inst.task?.length ?? 0, 1, `实际 ${(inst.task ?? []).map(t => t.name).join(",")}`)
  })
  check("这一条就是统一 tick，cron 取 notify.cron", () => {
    assert.equal(inst.task?.[0]?.name, TICK_NAME)
    assert.equal(inst.task?.[0]?.cron, config.notify.cron)
  })
  check("旧的三条按频率注册的任务都没了（推送 / 轮询 / 催办 / 名单同步）", () => {
    const names = (inst.task ?? []).map(t => t.name)
    for (const gone of ["深渊排队推送", "排队完成情况轮询", "月末排队催办", "群成员名单同步"])
      assert.ok(!names.includes(gone), `仍然注册着「${gone}」：${names.join(",")}`)
  })
  check("默认 cron 与示例配置一致", () => assert.equal(DEFAULT_CONFIG.notify.cron, "*/3 * * * *"))
}

console.log("\n【2】榜开启提醒")
{
  /** 首个 tick：只记基线（不提醒），避免首次部署就炸群 */
  await tick(D1)
  check("首次 tick 只记基线：不发任何消息", () => assert.equal(sent.length, 0, flat(sent[0]?.msg ?? "")))
  check("状态文件里记下了每个榜的开启状态", () => {
    const open = readState()?.open
    assert.ok(open && typeof open === "object", JSON.stringify(readState()))
    for (const name of ["幻想真境剧诗", "幽境危战", "深境螺旋"]) assert.equal(typeof open[name], "boolean", name)
  })
  check("剧诗已开启（每月 1 号 4 点后：无「等待开启」语义）", () => assert.equal(readState().open["幻想真境剧诗"], true))

  /** 构造"上一轮还没开"：把状态文件里的开启标记按回 false，下一轮就该提醒了 */
  const state = readState()
  state.open["幻想真境剧诗"] = false
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8")

  const before = sent.length
  const out = await tick(D1)
  check("false→true：发出一条开启提醒", () => assert.equal(sent.length, before + 1, `实际新增 ${sent.length - before} 条`))
  const notice = out[0]?.text ?? ""
  check("文案写清是哪个榜开了", () => assert.ok(notice.includes("幻想真境剧诗"), notice))
  check("发到 notify.groups 配的群", () => assert.equal(out[0]?.gid, 20000))

  const queued = await queuedNames("幻想真境剧诗")
  const doneNames = (await model("幻想真境剧诗")).rows.filter(r => r.status !== QUEUED && r.status !== WAITING).map(r => r.nickname)
  check("提醒 @ 的正是该榜排队中的人", () => {
    assert.ok(queued.length, "样本里没有排队中的人")
    for (const name of queued) assert.ok(notice.includes(name), `漏了「${name}」：${notice}`)
  })
  check("已完成 / 等待开启的人一个都不 @", () => {
    for (const name of new Set(doneNames)) assert.ok(!notice.includes(name), `不该 @「${name}」：${notice}`)
  })
  check("文案里写明还有多少人没轮到", () => {
    assert.ok(notice.includes(String(queued.length)), notice)
    assert.ok(/没轮到/.test(notice), notice)
  })

  const again = sent.length
  await tick(D1)
  check("再 tick 一次：不重复发（true→true 不提醒）", () => assert.equal(sent.length, again + 0, flat(sent.at(-1)?.msg ?? "")))
  check("开启状态已落盘为 true", () => assert.equal(readState().open["幻想真境剧诗"], true))
}

console.log("\n【3】重启不重复")
{
  /** 状态文件保留，重建插件实例（等价于重启进程）再跑一轮 */
  const state = readState()
  const hadOpen = Object.values(state.open).filter(Boolean).length
  check("重启前状态文件里确实有已开启的榜（否则这条用例是空转）", () => assert.ok(hadOpen > 0, JSON.stringify(state.open)))

  const before = sent.length
  await tick(D1)
  check("重建实例后 tick：不再重复发开启提醒", () => assert.equal(sent.length, before, flat(sent.at(-1)?.msg ?? "")))
}

console.log("\n【4】一直处于开启状态：不发提醒（避免首次部署炸群）")
{
  /** 场景：库里的榜一直开着（`open` 为 true），重复 tick 一次都不该有提醒 */
  const state = readState()
  state.open["幽境危战"] = true
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8")

  const before = sent.length
  await tick(D1)
  check("已开启的榜不提醒", () => assert.equal(sent.length, before, flat(sent.at(-1)?.msg ?? "")))
  check("那一榜的开启标记保持 true", () => assert.equal(readState().open["幽境危战"], true))
}

console.log("\n【5】开榜时间判定（与编辑器的同名口径一致）")
{
  check("剧诗：每月 1 号 4 点开，任何一天都默认「排队中」", () => {
    assert.equal(defaultStatusOf("幻想真境剧诗", new Date(2026, 9, 3, 2, 0, 0)), QUEUED)
    assert.equal(defaultStatusOf("幻想真境剧诗", new Date(2026, 9, 28, 23, 0, 0)), QUEUED)
  })
  check("螺旋：16 号 4 点前「等待开启」，到点后「排队中」", () => {
    assert.equal(defaultStatusOf("深境螺旋", new Date(2026, 9, 16, 3, 59, 0)), WAITING)
    assert.equal(defaultStatusOf("深境螺旋", new Date(2026, 9, 16, 4, 0, 0)), QUEUED)
    assert.equal(defaultStatusOf("深境螺旋", new Date(2026, 9, 20, 0, 0, 0)), QUEUED)
  })
  check("危战：没有固定日子，靠手改（默认「等待开启」）", () =>
    assert.equal(defaultStatusOf("幽境危战", new Date(2026, 9, 20, 12, 0, 0)), WAITING),
  )
}

console.log("\n【6】月末催办：到点后当天只发一次")
{
  /** 前置自检：这条用例只在"运行时配置真的开了月末催办"时才有意义 */
  check("月末催办处于开启状态（否则下面几条是空转）", () =>
    assert.equal(config.notify.monthly_enable, true),
  )
  /** 月末那天：到 monthly_at 之前不发，到点后发一次，再 tick 不重复 */
  const last = new Date(2026, 9, 31, 13, 0, 0)
  const beforeAt = new Date(2026, 9, 31, 9, 0, 0)
  const state = readState()
  delete state.daily.monthly
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8")

  const early = sent.length
  await tick(beforeAt)
  check(`未到 monthly_at（${config.notify.monthly_at}）不发催办`, () =>
    assert.equal(sent.length, early, flat(sent.at(-1)?.msg ?? "")),
  )

  const first = sent.length
  await tick(last)
  const mout = sent.slice(first).map(m => flat(m.msg))
  check("到点后发出月末催办（@ 还在排队的人）", () => {
    assert.equal(mout.length, 1, JSON.stringify(mout))
    assert.ok(mout[0].includes("月末") || mout[0].includes("最后一天"), mout[0])
  })
  check("催办标记按本地日期落盘", () => assert.equal(readState().daily.monthly, localDayKey(last)))

  const again = sent.length
  await tick(new Date(2026, 9, 31, 23, 30, 0))
  check("同一天再 tick：不重复发", () => assert.equal(sent.length, again, flat(sent.at(-1)?.msg ?? "")))
  check("不是月末的日子不发（10 月 30 日）", async () => {
    const s = readState()
    delete s.daily.monthly
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2), "utf8")
    const n = sent.length
    await tick(new Date(2026, 9, 30, 23, 30, 0))
    assert.equal(sent.length, n, flat(sent.at(-1)?.msg ?? ""))
  })
}

console.log("\n【7】群成员名单同步：到点后当天只发一次")
{
  const state = readState()
  delete state.daily.roster
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), "utf8")

  const early = sent.length
  await tick(new Date(2026, 9, 20, 4, 0, 0))
  check(`未到 roster.at（${config.roster.at}）不同步名单`, () =>
    assert.equal(sent.length, early, flat(sent.at(-1)?.msg ?? "")),
  )

  await tick(new Date(2026, 9, 20, 5, 30, 0))
  check("到点后同步一次并记下当天标记", () => assert.equal(readState().daily.roster, "2026-10-20"))

  const again = sent.length
  await tick(new Date(2026, 9, 20, 18, 0, 0))
  check("同一天再 tick：不再同步", () => {
    assert.equal(sent.length, again, flat(sent.at(-1)?.msg ?? ""))
    assert.equal(readState().daily.roster, "2026-10-20")
  })
}

console.log("\n【8】状态文件是唯一的去重依据（不会写到别处）")
{
  check("每榜开启状态与当天标记都在 state_file 里", () => {
    assert.ok(path.resolve(STATE).startsWith(path.resolve(ENV.dir)), STATE)
    const s = readState()
    for (const k of ["rows", "open", "daily"]) assert.ok(s[k] && typeof s[k] === "object", `${k} 不在状态文件里`)
  })
  check("被测表格没被插件改过（插件只读）", () =>
    assert.equal(sha256(fs.readFileSync(ENV.fixture)), fixtureHash),
  )
}

console.log("\n【9】notify.enable = false：三条 @ 通知一条都不发")
{
  const { notifyGroups } = await import("../components/notify-send.js")
  const withGroups = notifyGroups()
  check("开着时按 notify.groups 取群号", () => assert.deepEqual(withGroups, [20000]))

  config.notify.enable = false
  check("关掉后群号列表为空（tick 里那道 `if (!groups.length) return` 就兜住了）", () =>
    assert.deepEqual(notifyGroups(), []),
  )
  check("关掉只影响通知，不动 roster.group（名单同步照旧）", () =>
    assert.equal(String(config.roster?.group ?? ""), "20000"),
  )
  check("tick 不因关闭而改表、也不发消息", async () => {
    const before = sent.length
    await tick(new Date(2026, 9, 21, 12, 0, 0))
    assert.equal(sent.length, before, flat(sent.at(-1)?.msg ?? ""))
    assert.equal(sha256(fs.readFileSync(ENV.fixture)), fixtureHash)
  })
  config.notify.enable = true
}

await ENV.cloud?.close()
await finish()
