/* 隔离配置必须最先就位（ESM 静态 import 先于顶层代码执行） */
import { ensureEnv } from "./env.mjs"
/**
 * 命令注册 / 解析 / 分页提示的一致性（AQ-14）
 *
 * 表驱动回归：**从完整消息匹配到处理结果**，覆盖全名 / 简称 / 序号 / 后缀式 / 全量查看。
 * 重点两条：
 *   1. 注册规则能命中的写法，处理器必须也解析得了（`#危战列表`、`#幽境危战列表` 这类后缀写法都要认）
 *   2. 分页提示给出的命令必须真的能命中规则、并真的看到全部（提示里的写法发出去就要有反应）
 *
 * 用法：node test/commands.test.mjs（缺真实表格时用合成样本，仍然全跑）
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createChecker, installFrameworkStubs, requireSource } from "./_helper.mjs"
import { matchSheetCommand } from "../modules/commands.js"

const SOURCE = await requireSource()
const { check, finish } = createChecker("命令一致性")

const ENV = await ensureEnv({ prefix: "abyss-queue-cmd-" })
await fs.copyFile(SOURCE, ENV.fixture)

/** 框架桩：reply 记在插件实例的 __replies 里（真实入口是 ctx.reply） */
const sent = installFrameworkStubs()
const { config } = await import("../components/config.js")
/**
 * 分页提示要「行数被截断」才出现：这里把 list_limit 调到 2。
 * 不能经 ensureEnv 的 extra 传（那会给生成的 YAML 写出重复键，读取直接失败），改为改运行期配置。
 */
config.list_limit = 2
const { apps } = await import("../index.js")
const { firstEmptyRow } = await import("../modules/queue.js")
const { Table } = await import("../model/table.js")
const { AbyssQueueQuery } = await import("../apps/queue.js")

/** 源表格里幽境危战的总人数（不写死人数，只与解析结果比） */
const table = new Table({ file: ENV.fixture, backup: false })
const baseModel = await table.read(({ models }) => models.get("幽境危战"))
const TOTAL = baseModel.rows.length
/**
 * 单榜图那一行「共 N 人排队中」的数：**还没打完的人**（与总览菜单同一口径，见 `queuingCount`）。
 * 它和"表里有几行"（`TOTAL`）不是一回事：已完成 / 「等待开启」不算。
 */
const { isPending } = await import("../modules/progress.js")
const QUEUING = baseModel.rows.filter(r => isPending(r.status)).length

/** 注册规则（与框架 loader 同一取法：非 RegExp 的 reg 编译成正则） */
const rules = (new AbyssQueueQuery().rule ?? []).map(r => ({
  reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg),
  fnc: r.fnc,
}))
const ruleOf = msg => rules.find(r => r.reg.test(msg))?.fnc ?? null

/** 发一条消息：按规则匹配 → 调真实 handler → 收集回复 */
const say = async msg => {
  const inst = Object.assign(new AbyssQueueQuery(), {
    e: { msg, user_id: "90001", self_id: "10000", group_id: "20000", isGroup: true, sender: { card: "命令回归", nickname: "命令回归" } },
    __replies: [],
  })
  const fnc = ruleOf(msg)
  if (!fnc) return { fnc: null, replies: [], inst }
  await inst[fnc]()
  return { fnc, replies: inst.__replies, inst }
}

/** 一条回复转可读文本（图片段记成 [图片]，markdown 段取原文） */
const msgText = m =>
  Array.isArray(m)
    ? m
        .map(p =>
          typeof p === "string"
            ? p
            : p?.type === "image"
              ? "[图片]"
              : p?.type === "markdown"
                ? String(p.data?.content ?? "")
                : String(p),
        )
        .join("")
    : String(m)
const replyText = r => r.replies.map(msgText).join("\n")
/** 这一次渲染请求（看 Image 走的是哪张榜、limit 是多少） */
const lastCall = () => sent.renderCalls.at(-1)

console.log(`源表格：${SOURCE}\n测试副本：${ENV.fixture}\n幽境危战共 ${TOTAL} 人\n`)

console.log("【1】注册规则能命中的写法，处理器必须都能解析")
{
  /** 表驱动：完整消息 → 期望打开的榜（全名 / 简称 / 序号 / 后缀式都算） */
  const CASES = [
    ["#排队 幻想真境剧诗", "幻想真境剧诗"],
    ["#排队 幽境危战", "幽境危战"],
    ["#排队 深境螺旋", "深境螺旋"],
    ["#排队 剧诗", "幻想真境剧诗"],
    ["#排队 危战", "幽境危战"],
    ["#排队 深渊", "深境螺旋"],
    ["#排队 幻想", "幻想真境剧诗"],
    ["#排队 螺旋", "深境螺旋"],
    ["#排队 1", "幻想真境剧诗"],
    ["#排队 2", "幽境危战"],
    ["#排队 3", "深境螺旋"],
    /** 后缀式：与前缀式等价 */
    ["#剧诗排队", "幻想真境剧诗"],
    ["#危战排队", "幽境危战"],
    ["#深渊排队", "深境螺旋"],
    ["#螺旋列表", "深境螺旋"],
    ["#危战列表", "幽境危战"],
    ["#剧诗列表", "幻想真境剧诗"],
    ["#幽境危战列表", "幽境危战"],
  ]
  await check("全名/简称/序号/后缀式写法：注册命中 + 真正打开对应榜", async () => {
    for (const [cmd, sheet] of CASES) {
      assert.equal(ruleOf(cmd), "menu", `${cmd} 应命中 menu 规则`)
      const parsed = matchSheetCommand(cmd)
      assert.ok(parsed, `${cmd} 解析器应认出这是单榜命令`)
      const r = await say(cmd)
      const call = lastCall()
      assert.equal(call?.tpl, "queue/queue", `${cmd} 应走队列渲染：${JSON.stringify(r.replies.map(msgText))}`)
      assert.equal(call?.data.name, sheet, `${cmd} 应打开 ${sheet}`)
      assert.ok(!replyText(r).includes("没找到这个榜"), `${cmd} 不该回「没找到这个榜」：${replyText(r)}`)
    }
  })

  check("解析结果与注册规则同源：能注册就能解析", () => {
    for (const [cmd] of CASES) {
      assert.ok(ruleOf(cmd), `${cmd} 应命中规则`)
      assert.ok(matchSheetCommand(cmd)?.name, `${cmd} 应解析出榜名`)
    }
  })

  check("裸榜名仍不接管（不抢 Axiu-Plugin）", () => {
    for (const cmd of ["#幽境危战", "#深渊", "#危战", "#剧诗", "#螺旋", "#幻想真境剧诗"])
      assert.equal(ruleOf(cmd), null, `${cmd} 不该命中本插件规则`)
  })

  /**
   * 必须 `await`：这个回调是 async，不 await 的话它会和**下一段**（图片模式的「#排队 危战」）
   * 交错执行，`lastCall()` 读到的是下一段渲染的 `queue/queue` ⇒ 偶发红（K1，见交接文档）。
   * 断言保持精确，不弱化成"出现过 menu 就算过"。
   */
  await check("多榜总览仍是 #排队 一条", async () => {
    const r = await say("#排队")
    assert.equal(r.fnc, "menu")
    assert.equal(lastCall()?.tpl, "queue/menu")
    assert.equal(lastCall()?.data.sheets.length, 3)
  })
}

console.log("\n【2】图片模式：截断时给出「还有 N 人」，提示命令是可用的完整写法")
{
  /** list_limit=2，幽境危战 16 人：必然被截断 */
  const r = await say("#排队 危战")
  const call = lastCall()
  check("图片模式确实被截断（more > 0）", () => {
    assert.equal(call?.data.name, "幽境危战")
    assert.equal(call?.data.total, QUEUING, "「共 N 人排队中」数的是还没打完的人（与菜单同一口径）")
    assert.equal(call?.data.rows.length, 2)
    assert.ok(call?.data.more > 0, `more=${call?.data.more}`)
  })

  check("`全部` 后缀已取消：注册规则与解析器都不认", () => {
    for (const cmd of ["#排队 幽境危战 全部", "#排队 全部", "#排队 危战 全部"]) {
      assert.equal(ruleOf(cmd), null, `${cmd} 不该命中规则`)
      assert.equal(matchSheetCommand(cmd), null, `${cmd} 不该被解析`)
    }
    assert.ok(!replyText(r).includes("全部"), `截断提示里不该再出现「全部」：${replyText(r)}`)
  })
}

console.log("\n【3】出图不可用（文本兜底）时只提示还有多少人，不再给「全部」命令")
{
  const prev = config.render_image
  config.render_image = false
  try {
    const r = await say("#排队 危战")
    const text = replyText(r)
    check("文本兜底带「还有 N 人」，不带旧的全部命令", () => {
      assert.ok(/还有 \d+ 人/.test(text), text)
      assert.ok(!text.includes("全部"), text)
    })
  } finally {
    config.render_image = prev
  }
}

console.log(`\n（框架桩发送记录 ${sent.length} 条群消息，未使用；首个空行=${firstEmptyRow(baseModel)}）`)
await finish()
/**
 * 收尾：关掉假云端并删临时目录，然后**让事件循环自然结束**。
 *
 * 不要用 `process.exit()` 收尾：Windows + Node 24 上，强制退出时若 undici 的异步句柄还在收尾，
 * 会命中 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`（`src\win\async.c`）导致进程崩溃，
 * 断言全绿也会被 `run.mjs` 记成失败。反过来，**不关服务就会挂着不退出**（HTTP Server 是活跃句柄），
 * 所以"关服务 + 自然退出"两件都要做。
 */
await ENV.cloud.close()
fs.rm(ENV.dir, { recursive: true, force: true }).catch(() => {})
