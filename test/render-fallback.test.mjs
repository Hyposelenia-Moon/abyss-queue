/**
 * 出图发送链的失败口径（AQ-13）
 *
 * `renderOrFallback` 的契约：**只有确认发出去了才算成功**。
 * 框架的 reply 把发送异常吞成返回值 `{ error: [...] }`（不抛），所以首次与重试都要检查返回值；
 * 重试仍失败时必须落到纯文本兜底，不能返回 sent:true 让上层以为图已经发了。
 *
 * 三类返回都要覆盖：抛异常 / 返回错误对象 / 成功。
 * 用法：node test/render-fallback.test.mjs
 */
import assert from "node:assert/strict"
import { createChecker, installFrameworkStubs } from "./_helper.mjs"

const { check, finish } = createChecker("出图失败回退")

/** 框架桩：reply 一律返回 true（真实框架的 happy path），用例里再逐条替换 */
const sent = installFrameworkStubs()

const { renderQueueImg } = await import("../components/render-html.js")

/** 一条消息转可读文本（图片段记成 [图片]、markdown 段取原文） */
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

/** 本次回复里有没有图片段 */
const hasImage = msgs => msgs.some(m => Array.isArray(m) && m.some(p => p?.type === "image"))

/** 模型：3 人排队，list_limit=2 时会被截断 */
const model = {
  name: "幽境危战",
  title: "",
  headerRow: 10,
  dataStart: 11,
  dataEnd: 110,
  col: {},
  options: {},
  styles: {},
  anchors: [],
  rows: [
    { row: 11, seq: "1", nickname: "甲", gameName: "游戏甲", status: "排队中" },
    { row: 12, seq: "2", nickname: "乙", gameName: "游戏乙", status: "排队中" },
    { row: 13, seq: "3", nickname: "丙", gameName: "游戏丙", status: "排队中" },
  ],
}

/** 一份「填写情况 + 点此填表」的入口（markdown 段，QQ 不认时最容易整条发不出去） */
const ENTRY = {
  head: "未填：幻想真境剧诗、深境螺旋",
  seg: { type: "markdown", data: { content: "[点此填表](http://127.0.0.1:7788/s/abcdefghijklmnop)" } },
  link: "点此填表：http://127.0.0.1:7788/s/abcdefghijklmnop",
}

/**
 * 跑一次出图发送链，reply 由用例给定
 * @param reply 桩：替换插件实例的 reply
 * @returns {{messages:Array, sent:boolean, log:String}}
 */
async function run(reply) {
  const messages = []
  const logs = []
  const ctx = {
    reply: async msg => {
      messages.push(msg)
      return reply(msg, messages.length)
    },
  }
  const e = { user_id: "10001", runtime: { render: async (plugin, tpl, data, cfg) => ({ type: "image", file: `base64://${tpl}` }) } }
  const prevError = globalThis.logger.error
  const prevWarn = globalThis.logger.warn
  globalThis.logger.error = (...a) => logs.push(a.join(" "))
  globalThis.logger.warn = (...a) => logs.push(a.join(" "))
  try {
    const ok = await renderQueueImg(ctx, e, model, { limit: 2, moreHint: "#排队 幽境危战 全部", entry: ENTRY })
    return { messages, sent: ok, log: logs.join("\n") }
  } finally {
    globalThis.logger.error = prevError
    globalThis.logger.warn = prevWarn
  }
}

console.log("【1】首次即失败（返回错误对象）→ 重试成功 → sent:true")
{
  const r = await run((msg, n) => (n === 1 ? { error: [{ message: "发送者版本过低" }] } : true))
  check("发了两次（首次 + 链接文本重试）", () => assert.equal(r.messages.length, 2, JSON.stringify(r.messages.map(msgText))))
  check("第二次不再带 markdown 段，退回纯文本链接", () => {
    assert.equal(r.messages[1].some(p => p?.type === "markdown"), false)
    assert.ok(msgText(r.messages[1]).includes("点此填表：http://"), msgText(r.messages[1]))
  })
  check("重试成功时返回 sent:true", () => assert.equal(r.sent, true))
}

console.log("\n【2】首次抛异常 → 重试成功 → sent:true")
{
  const r = await run((msg, n) => {
    if (n === 1) throw new Error("发送超时")
    return true
  })
  check("抛异常也走同一条重试路径", () => assert.equal(r.messages.length, 2, JSON.stringify(r.messages.map(msgText))))
  check("重试成功时返回 sent:true", () => assert.equal(r.sent, true))
}

console.log("\n【3】两次都失败（返回错误对象）→ 必须落到纯文本兜底（AQ-13 的核心回归）")
{
  const r = await run(() => ({ error: [{ message: "发送者版本过低" }] }))
  check("一共发了三次：首次 + 重试 + 纯文本兜底", () =>
    assert.equal(r.messages.length, 3, `实际 ${r.messages.length} 次：${JSON.stringify(r.messages.map(msgText))}`),
  )
  check("第三次是纯文本兜底（没有图片段）", () => {
    assert.equal(hasImage([r.messages[2]]), false, msgText(r.messages[2]))
    assert.ok(msgText(r.messages[2]).includes("【幽境危战】共 3 人在排"), msgText(r.messages[2]))
  })
  check("重试失败不能算成功：返回 sent:false", () => assert.equal(r.sent, false))
  check("重试失败的日志保留（便于定位 QQ 不认 markdown）", () =>
    assert.ok(r.log.includes("点此填表"), r.log),
  )
}

console.log("\n【4】两次都抛异常 → 同样落到纯文本兜底")
{
  const r = await run(() => {
    throw new Error("发送超时")
  })
  check("发了三次且最后一条是纯文本", () => {
    assert.equal(r.messages.length, 3, JSON.stringify(r.messages.map(msgText)))
    assert.equal(hasImage([r.messages[2]]), false)
  })
  check("返回 sent:false", () => assert.equal(r.sent, false))
}

console.log("\n【4.5】连纯文本兜底也失败 → 不抛异常、返回 sent:false")
{
  const r = await run(() => ({ error: [{ message: "发送者版本过低" }] }))
  check("兜底失败仍返回 sent:false（不把异常甩给上层污染聊天）", () => assert.equal(r.sent, false))
  check("兜底失败有日志", () => assert.ok(r.log.includes("纯文本兜底也发不出去"), r.log))
}

console.log("\n【5】不失败时不发兜底")
{
  const r = await run(() => true)
  check("只发一次，且带 markdown 入口", () => {
    assert.equal(r.messages.length, 1)
    assert.equal(r.messages[0].some(p => p?.type === "markdown"), true)
  })
  check("返回 sent:true", () => assert.equal(r.sent, true))
}

console.log("\n【6】小尾巴（规范署名行）：单榜与主播列表也要带，图上与文本兜底一致")
{
  const FOOTER = "Created By Yunzai-Bot 3.1.3 & 三路深渊排队 1.0.0"
  const { renderAnchorsImg } = await import("../components/render-html.js")

  /**
   * 抓一次出图发送链：既看**模板数据**（图上最底下一行 `.ver`），
   * 也看**纯文本兜底**（发不出去时那条消息的末尾）——两条路都得带上署名行。
   */
  const capture = async fn => {
    const messages = []
    const data = []
    const ctx = {
      reply: async msg => {
        messages.push(msg)
        return { error: [{ message: "发送者版本过低" }] }
      },
    }
    const e = {
      user_id: "10001",
      runtime: {
        render: async (plugin, tpl, d) => {
          data.push({ tpl, d })
          return { type: "image", file: `base64://${tpl}` }
        },
      },
    }
    await fn(ctx, e)
    return { text: msgText(messages.at(-1)), data }
  }

  const one = await capture((ctx, e) => renderQueueImg(ctx, e, model, { limit: 2, version: FOOTER }))
  check("单榜图：模板数据里有 version（图上 `.ver` 那一行）", () =>
    assert.equal(one.data[0]?.d?.version, FOOTER, JSON.stringify(one.data[0]?.d?.version)),
  )
  check("单榜文本兜底：末尾接上规范署名行", () =>
    assert.ok(one.text.endsWith(FOOTER), one.text.slice(-160)),
  )

  const all = await capture((ctx, e) => renderAnchorsImg(ctx, e, [model], { version: FOOTER }))
  check("主播列表图：模板数据里有 version", () =>
    assert.equal(all.data[0]?.d?.version, FOOTER, JSON.stringify(all.data[0]?.d?.version)),
  )
  check("主播列表文本兜底：末尾接上规范署名行", () =>
    assert.ok(all.text.endsWith(FOOTER), all.text.slice(-160)),
  )
}

console.log(`\n（框架桩已发送 ${sent.length} 条群消息，未使用）`)
await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
