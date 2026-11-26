/** 主播区写：reorder / anchor-add 合并成一个套件（原文件见 git 历史） */
import { attackGroupRank, groupRankOf, goalRankOf, tidyOrder } from "../reorder.js"
import { shared } from "./plugin.mjs"
import assert from "node:assert/strict"
import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"
import { createChecker } from "../../test/_helper.mjs"

const { check, finish } = createChecker("主播区写")

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")


  const row = (id, status, goal) => ({ row: id, nickname: `人${id}`, status, goal })

  const orderOf = (sheet, rows, { anchors = [], tempNames = [], frontNames = [] } = {}) =>
    tidyOrder({ name: sheet, rows, anchors }, { tempNames, frontNames })?.order ?? rows.map(r => r.row)

  check("分组：已完成 → 等待开启 → 排队中", () => {
    const rows = [
      row(10, "排队中", "险恶(N4)"),
      row(11, "本人已完成", "绝境(N6)"),
      row(12, "等待开启", "无畏(N5)"),
      row(13, "阿修Axiu", "险恶(N4)"),
    ]
    if (groupRankOf("排队中") !== 2 || groupRankOf("等待开启") !== 1 || groupRankOf("阿修Axiu") !== 0)
      throw new Error("分组秩不对")
    const got = orderOf("幽境危战", rows, { anchors: ["阿修Axiu"] })
    if (JSON.stringify(got) !== JSON.stringify([13, 11, 12, 10]))
      throw new Error(`分组顺序不对：${JSON.stringify(got)}`)
  })

  check("剧诗：难度 → 目标", () => {
    const rows = [
      row(10, "排队中", "困难模式满原石"),
      row(11, "排队中", "困难模式满原石"),
      row(12, "排队中", "困难模式满星章"),
      row(13, "排队中", "卓越模式满原石"),
    ]
    const got = orderOf("幻想真境剧诗", rows)
    if (JSON.stringify(got) !== JSON.stringify([10, 11, 12, 13]))
      throw new Error(`剧诗顺序不对：${JSON.stringify(got)}`)
    if (goalRankOf("幻想真境剧诗", "月谕模式满星章").difficulty <= goalRankOf("幻想真境剧诗", "卓越模式满星章").difficulty)
      throw new Error("月谕应当排在卓越之后")
  })

  check("危战：N4 → N5 → N6 → N6 180s", () => {
    const rows = [
      row(10, "排队中", "绝境(N6)180s"),
      row(11, "排队中", "绝境(N6)"),
      row(12, "排队中", "无畏(N5)"),
      row(13, "排队中", "险恶(N4)"),
    ]
    const got = orderOf("幽境危战", rows)
    if (JSON.stringify(got) !== JSON.stringify([13, 12, 11, 10]))
      throw new Error(`危战顺序不对：${JSON.stringify(got)}`)
  })

  check("深渊：第11层 → 第12层", () => {
    const rows = [
      row(10, "排队中", "第12层满星"),
      row(11, "排队中", "第11层满星"),
      row(12, "排队中", "第12层满星"),
    ]
    const got = orderOf("深境螺旋", rows)
    if (JSON.stringify(got) !== JSON.stringify([11, 10, 12]))
      throw new Error(`深渊顺序不对：${JSON.stringify(got)}`)
  })

  check("攻炼：模式数量 → 目标", () => {
    const rows = [
      row(10, "排队中", "焰羽追绞｜满星章"),
      row(11, "排队中", "焰羽追绞｜满原石"),
      row(12, "排队中", "囚笼冰城｜满原石"),
      row(13, "排队中", "焰羽追绞｜满原石"),
      row(15, "排队中", "焰羽追绞,囚笼冰城｜满原石"),
    ]
    const got = orderOf("绝境攻炼", rows)
    if (JSON.stringify(got) !== JSON.stringify([11, 12, 13, 15, 10]))
      throw new Error(`攻炼顺序不对：${JSON.stringify(got)}`)
  })

  check("攻炼：已完成 → 等待开启 → 排队中，部分/全部不再分组", () => {
    if (attackGroupRank("7.2排队中 7.3等待开启") !== 3) throw new Error("部分排队中应归排队中")
    if (attackGroupRank("7.2排队中") !== 3 || attackGroupRank("7.3等待开启") !== 2)
      throw new Error("排队中/等待开启分组不对")
    if (attackGroupRank("7.2阿修Axiu 7.3等待开启") !== 2)
      throw new Error("部分完成 + 等待开启应归等待开启")
    if (attackGroupRank("7.2阿修Axiu 7.3排队中") !== 3)
      throw new Error("部分完成 + 排队中应归排队中")
    const rows = [
      row(10, "7.2排队中 7.3等待开启", "焰羽追绞｜满原石"),
      row(11, "7.3等待开启", "焰羽追绞｜满原石"),
      row(12, "7.2排队中", "焰羽追绞｜满原石"),
      row(13, "7.0阿修Axiu", "焰羽追绞｜满原石"),
      row(14, "7.2阿修Axiu 7.3等待开启", "焰羽追绞｜满原石"),
    ]
    const got = orderOf("绝境攻炼", rows)
    if (JSON.stringify(got) !== JSON.stringify([13, 11, 14, 10, 12]))
      throw new Error(`攻炼排队分组不对：${JSON.stringify(got)}`)
  })

  check("攻炼：模式数量按大预设算，7.1/7.2 与 7.2/7.3 同为 2 版", () => {
    const rows = [
      row(10, "7.2排队中", "7.2/7.3模式｜顶分"),
      row(11, "7.2排队中", "7.1/7.2模式｜满星章"),
      row(12, "7.2排队中", "7.3/7.2模式｜满星章"),
    ]
    const got = orderOf("绝境攻炼", rows)
    if (JSON.stringify(got) !== JSON.stringify([11, 12, 10]))
      throw new Error(`大预设数量/目标排序不对：${JSON.stringify(got)}`)
  })

  check("完成类型：本人 → 主播 → 临时名 → 未知", () => {
    const rows = [
      row(10, "主播甲", "险恶(N4)"),
      row(11, "人11", "险恶(N4)"),
      row(12, "临时甲", "险恶(N4)"),
      row(13, "查无此人", "险恶(N4)"),
    ]
    const got = orderOf("幽境危战", rows, { anchors: ["主播甲"], tempNames: ["临时甲"] })
    if (JSON.stringify(got) !== JSON.stringify([11, 10, 12, 13]))
      throw new Error(`完成类型顺序不对：${JSON.stringify(got)}`)

    /** 多值按最高优先级：本人 + 主播 ⇒ 仍按本人 */
    const multi = [row(10, "主播甲", "险恶(N4)"), row(11, "人11,主播甲", "险恶(N4)")]
    const multiGot = orderOf("幽境危战", multi, { anchors: ["主播甲"] })
    if (JSON.stringify(multiGot) !== JSON.stringify([11, 10]))
      throw new Error(`多值完成类型没有按最高优先级：${JSON.stringify(multiGot)}`)
  })

  check("同键稳定：保留原始行号顺序；未知目标放本组最后", () => {
    const rows = [
      row(12, "排队中", "险恶(N4)"),
      row(10, "排队中", "不知道的目标"),
      row(11, "排队中", "险恶(N4)"),
    ]
    const got = orderOf("幽境危战", rows)
    if (JSON.stringify(got) !== JSON.stringify([11, 12, 10]))
      throw new Error(`稳定兜底不对：${JSON.stringify(got)}`)
    const again = orderOf("幽境危战", rows)
    if (JSON.stringify(got) !== JSON.stringify(again)) throw new Error("同一输入两次排序结果不同")
  })

  check("插队置顶：只把指定排队中的人放队首，其他行仍按原规则", () => {
    const rows = [
      row(10, "排队中", "险恶(N4)"),
      row(11, "排队中", "绝境(N6)"),
      row(12, "排队中", "无畏(N5)"),
    ]
    const normal = orderOf("幽境危战", rows)
    if (JSON.stringify(normal) !== JSON.stringify([10, 12, 11]))
      throw new Error(`原始顺序不对：${JSON.stringify(normal)}`)

    const front = orderOf("幽境危战", rows, { frontNames: ["人11"] })
    if (JSON.stringify(front) !== JSON.stringify([11, 10, 12]))
      throw new Error(`置顶后顺序不对：${JSON.stringify(front)}`)

    const front2 = orderOf("幽境危战", rows, { frontNames: ["人12", "人11"] })
    if (JSON.stringify(front2) !== JSON.stringify([12, 11, 10]))
      throw new Error(`多人置顶顺序不对：${JSON.stringify(front2)}`)
  })

  await finish()
})()

await (async () => {
  const { createChecker } = await shared("test/_helper.mjs")


  const boot = async () => {
    const data = makeData()
    const timers = makeFakeTimers()
    const h = bootPage({
      timers,
      dataFor: () => data,
      anchorReply: () => ({ status: 200, body: { ok: true, notified: 1 } }),
    })
    await h.ready()
    return { h, timers, data }
  }

  await check("主播卡按 anchorRows 逐张渲染，名字一个不少", async () => {
    const { h, data } = await boot()
    const cards = [...h.el("acards").querySelectorAll(".acard")]
    const names = data.sheets[0].anchorRows.map(a => a.name)
    assert.equal(cards.length, names.length + (data.sheets[0].publicQueue ? 1 : 0), `卡片 ${cards.length} 张 / 主播 ${names.length} 位`)
    for (const name of names) {
      assert.ok(
        cards.some(c => h.textOf(c).includes(name)),
        `卡片里找不到「${name}」`,
      )
    }
  })

  await check("公共队列单独一张：带「公共队」角标、不给呼叫按钮", async () => {
    const data = makeData()
    /** 服务端在有「公共队列/不挑主播」那类报名时会下发 publicQueue，卡片是**按它**补出来的 */
    data.sheets[0].publicQueue = { name: "公共队列", queued: 2, queuePills: [] }
    const timers = makeFakeTimers()
    const h = bootPage({ timers, dataFor: () => data })
    await h.ready()
    const pub = [...h.el("acards").querySelectorAll(".acard.pub")]
    assert.equal(pub.length, 1, `公共队列卡有 ${pub.length} 张`)
    assert.ok(h.textOf(pub[0]).includes("公共队"), "公共队列卡没有「公共队」角标")
    assert.equal(pub[0].querySelectorAll("[data-acall]").length, 0, "公共队列卡不该有呼叫按钮")
  })

  await check("呼叫打 api/anchor-call，带当前榜名与主播行号", async () => {
    const { h, timers, data } = await boot()
    const btn = h.el("acards").querySelector("[data-acall]")
    assert.ok(btn, "没有可点的呼叫按钮")
    const row = Number(btn.dataset.acall)
    const anchor = data.sheets[0].anchorRows.find(a => a.row === row)
    assert.ok(anchor, `按钮上的行号 ${row} 对不上任何主播`)
    btn.onclick({ stopPropagation() {} })
    timers.advance(200)
    await h.ready()
    const post = h.posts("api/anchor-call").at(-1)
    assert.ok(post, `没有发出 api/anchor-call（实际发了 ${JSON.stringify(h.posts().map(p => p.url))}）`)
    assert.equal(post.body.sheet, data.sheets[0].name)
    assert.equal(post.body.row, row)
  })

  await check("呼叫失败只提示，不把页面搞崩", async () => {
    const data = makeData()
    const timers = makeFakeTimers()
    const h = bootPage({
      timers,
      dataFor: () => data,
      anchorReply: () => ({ status: 500, body: { ok: false, error: "（套件：呼叫失败）" } }),
    })
    await h.ready()
    h.el("acards").querySelector("[data-acall]").onclick({ stopPropagation() {} })
    timers.advance(200)
    await h.ready()
    assert.ok(h.toasts().some(t => /呼叫失败/.test(t)), `提示条里没有「呼叫失败」：${JSON.stringify(h.toasts())}`)
  })

  await check("呼叫成功后按钮短暂变成「已发出」，到点自己退回", async () => {
    const { h, timers } = await boot()
    const btn = h.anchorCall(0)
    assert.ok(btn, "没有可点的呼叫按钮")
    assert.equal(btn.classList.contains("called"), false, "点之前不该带 called")
    timers.advance(200)
    await h.ready()
    assert.equal(btn.classList.contains("called"), true, "呼叫成功后按钮没有变成「已发出」")
    timers.advance(1200)
    assert.equal(btn.classList.contains("called"), false, "「已发出」没有自己退回去")
  })

  await check("呼叫失败时按钮不留「已发出」（别假装成功了）", async () => {
    const data = makeData()
    const timers = makeFakeTimers()
    const h = bootPage({
      timers,
      dataFor: () => data,
      anchorReply: () => ({ status: 500, body: { ok: false, error: "（套件：呼叫失败）" } }),
    })
    await h.ready()
    const btn = h.anchorCall(0)
    timers.advance(200)
    await h.ready()
    assert.equal(btn.classList.contains("called"), false, "失败了还把按钮画成「已发出」")
  })

  await finish()
})()

finish()
