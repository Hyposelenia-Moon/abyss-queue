/** 主播区：aliases / anchor-counts / locate-self 合并成一个套件（原文件见 git 历史） */
import assert from "node:assert/strict"
import { aliasOf, canonicalAnchor, compileAliases } from "../components/aliases.js"
import { ensureEnv } from "./env.mjs"
import { locateSelf, myRowOf } from "../modules/queue.js"
import { exactSelfView, mineView } from "../components/render.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("主播区")

await (async () => {
  const A = compileAliases({ 阿修Axiu: ["阿修"], 摸头妹: ["璃月第一深情"] })

  check("别名归一到正名", () => {
    assert.equal(canonicalAnchor("阿修", A), "阿修Axiu")
    assert.equal(canonicalAnchor("璃月第一深情", A), "摸头妹")
  })

  check("正名本身不受影响", () => {
    assert.equal(canonicalAnchor("阿修Axiu", A), "阿修Axiu")
    assert.equal(canonicalAnchor("摸头妹", A), "摸头妹")
    assert.equal(canonicalAnchor("听雨", A), "听雨")
  })

  check("不在别名表里的名字原样返回（空值给空串）", () => {
    assert.equal(canonicalAnchor("查无此人", A), "查无此人")
    assert.equal(canonicalAnchor("", A), "")
    assert.equal(canonicalAnchor(null, A), "")
  })

  check("按正则整串匹配：不会把「阿修Axiu」当成「阿修」的别名再套一层", () => {
    assert.equal(canonicalAnchor("阿修", A), "阿修Axiu")
    assert.equal(aliasOf("阿修Axiu", A), null)
    assert.equal(aliasOf("阿修", A), "阿修Axiu")
  })

  check("别名可以写正则", () => {
    const R = compileAliases({ 纸笑: ["纸笑.*", "纸笑"] })
    assert.equal(canonicalAnchor("纸笑笑", R), "纸笑")
    assert.equal(canonicalAnchor("纸笑", R), "纸笑")
    assert.equal(canonicalAnchor("纸", R), "纸")
  })

  check("配置写错（非法正则 / 空值）不会炸，只是这条别名不生效", () => {
    const bad = compileAliases({ 甲: ["[未闭合"], 乙: "", 丙: ["", null] })
    assert.equal(bad.length, 0)
    assert.equal(canonicalAnchor("甲", bad), "甲")
  })

  check("大小写不敏感（英文昵称常见）", () => {
    const E = compileAliases({ Aki: ["aki"] })
    assert.equal(canonicalAnchor("AKI", E), "Aki")
  })
})()

await (async () => {
  const ENV = await ensureEnv({ prefix: "abyss-anchor-counts-" })
  const { anchorsAllView, anchorsView, renderAnchors, renderAnchorsAll } = await import("../components/render.js")

  const anchor = name => ({
    name,
    recommend: "推荐",
    duty: "",
    skills: `${name}的强项`,
    entry: [],
    cells: {},
  })

  const model = (name, rows, names = ["阿修Axiu"]) => ({
    name,
    title: name,
    rows,
    anchors: names.map(anchor),
  })

  check("单榜：排队中/等待开启分开计，同一行同一主播只算一次", () => {
    const m = model("幻想真境剧诗", [
      { row: 1, anchor: "阿修Axiu,听雨", status: "排队中" },
      { row: 2, anchor: "阿修Axiu", status: "等待开启" },
      { row: 3, anchor: "阿修Axiu", status: "已完成" },
      { row: 4, anchor: "阿修Axiu，阿修Axiu", status: "排队中" },
      { row: 5, anchor: "阿修Axiu", status: "" },
    ])
    const one = anchorsAllView([m]).anchors[0]
    if (one.queued !== 2 || one.waiting !== 1)
      throw new Error(`single counts ${one.queued}/${one.waiting}，期望 2/1`)
    if (one.queueText !== "排队中 2 人 · 等待开启 1 人") throw new Error(one.queueText)
    if (!one.queueChips.some(q => q.short === "剧诗" && q.queued === 2 && q.waiting === 1))
      throw new Error(`queueChips ${JSON.stringify(one.queueChips)}`)
  })

  check("单榜视图和文本渲染都带排队人数", () => {
    const m = model("幻想真境剧诗", [{ row: 1, anchor: "阿修Axiu", status: "排队中" }])
    const view = anchorsView(m)
    if (view.anchors[0].queueText !== "排队中 1 人") throw new Error(view.anchors[0].queueText)
    const text = renderAnchors(m)
    if (!text.includes("排队：排队中 1 人")) throw new Error(text)
  })

  check("空榜显示排队中 0 人", () => {
    const m = model("幻想真境剧诗", [])
    const text = renderAnchorsAll(anchorsAllView([m]))
    if (!text.includes("排队：排队中 0 人")) throw new Error(text)
  })

  check("多榜合并：按榜分开，不混成一个数字", () => {
    const a = model("幻想真境剧诗", [{ row: 1, anchor: "阿修Axiu", status: "排队中" }])
    const b = model("幽境危战", [{ row: 1, anchor: "阿修Axiu", status: "等待开启" }])
    const one = anchorsAllView([a, b]).anchors[0]
    if (one.queued !== 1 || one.waiting !== 1) throw new Error(`${one.queued}/${one.waiting}`)
    if (!one.queueText.includes("幻想真境剧诗：排队中 1 人")) throw new Error(one.queueText)
    if (!one.queueText.includes("幽境危战：等待开启 1 人")) throw new Error(one.queueText)
    if (!one.queueChips.some(q => q.short === "剧诗" && q.queued === 1))
      throw new Error(`剧诗 chip ${JSON.stringify(one.queueChips)}`)
    if (!one.queueChips.some(q => q.short === "危战" && q.waiting === 1))
      throw new Error(`危战 chip ${JSON.stringify(one.queueChips)}`)
  })

  check("枪战复合状态有排队中时归 queued，只有等待时归 waiting", () => {
    const m = model("绝境攻炼", [
      { row: 1, anchor: "默秦", status: "7.2排队中 7.3等待开启" },
      { row: 2, anchor: "默秦", status: "7.3等待开启" },
      { row: 3, anchor: "默秦", status: "7.2默秦" },
    ], ["默秦"])
    const one = anchorsAllView([m]).anchors[0]
    if (one.queued !== 1 || one.waiting !== 1)
      throw new Error(`attack counts ${one.queued}/${one.waiting}，期望 1/1`)
  })

  await ENV.cloud?.close()
  await finish()
})()

await (async () => {
  const SHEET = "幽境危战"
  /** 两个同名行 + 一个不同的行：重名场景就是 AQ-02 的入口 */
  const dupModel = {
    name: SHEET,
    rows: [
      { row: 10, nickname: "同名的人" },
      { row: 11, nickname: "乙自己" },
      { row: 12, nickname: "同名的人" },
    ],
  }
  /** 只有一个同名行：被占之后就该"查无此人" */
  const singleModel = { name: SHEET, rows: [{ row: 10, nickname: "同名的人" }] }

  /** 假绑定表：`{ qq: {row, nickname} }`，形状与 BindStore 一致 */
  const store = binds => ({
    get: (sheet, qq) => binds[String(qq)] ?? null,
    qqsOf: (sheet, row) => Object.entries(binds).filter(([, info]) => Number(info?.row) === Number(row)).map(([qq]) => qq),
  })

  const A = "20001"
  const B = "20002"
  /** 乙对第 10 行的有效绑定：绑定里记的昵称与表里这一行一致 */
  const B_ON_10 = { [B]: { row: 10, nickname: "同名的人" } }

  await check("绑定记的行已被别人绑定：不抢别人已绑定的同名行；表里重名时谁都不自动认领", async () => {
    const hit = locateSelf(dupModel, store(B_ON_10), SHEET, A, "同名的人")
    if (hit.row === 10) throw new Error("抢到了乙绑定的第 10 行")
    /** 两行同名、其中一行已属于乙：归属不明（无法确定哪个是甲）→ 不自动认领，等主人理清 */
    if (hit.row !== 0) throw new Error(`重名时不该自动认领，实际 ${JSON.stringify(hit)}`)
    if (hit.bind) throw new Error("不该给出待绑定信息")
    if (myRowOf(dupModel, store(B_ON_10), SHEET, A, "同名的人") !== 0) throw new Error("myRowOf 也应当是 0")
  })

  await check("没有绑定 + 唯一同名行已被别人绑定：谁都认不出，返回 0（不给待绑定信息）", async () => {
    const hit = locateSelf(singleModel, store(B_ON_10), SHEET, A, "同名的人")
    if (hit.row !== 0) throw new Error(`认领了第 ${hit.row} 行：${JSON.stringify(hit)}`)
    if (hit.source !== "none") throw new Error(`source=${hit.source}`)
    if (hit.bind) throw new Error("不该给出待绑定信息（那会让调用方把别人的行记成自己的）")
    if (myRowOf(singleModel, store(B_ON_10), SHEET, A, "同名的人") !== 0) throw new Error("myRowOf 也应当是 0")
  })

  await check("绑定已过期（那一行已经属于别人）：不许抢别人已绑定的同名行", async () => {
    const binds = { [A]: { row: 99, nickname: "同名的人" }, ...B_ON_10 }
    const hit = locateSelf(singleModel, store(binds), SHEET, A, "同名的人")
    if (hit.stale !== true) throw new Error(`应当判为过期：${JSON.stringify(hit)}`)
    if (hit.row !== 0) throw new Error(`过期后仍抢到了第 ${hit.row} 行：${JSON.stringify(hit)}`)
  })

  await check("绑定已过期：重名时同样不自动认领（不落到别人的行上）", async () => {
    const binds = { [A]: { row: 99, nickname: "同名的人" }, ...B_ON_10 }
    const hit = locateSelf(dupModel, store(binds), SHEET, A, "同名的人")
    if (hit.stale !== true) throw new Error(`应当判为过期：${JSON.stringify(hit)}`)
    if (hit.row !== 0) throw new Error(`重名时不该自动认领，实际 ${JSON.stringify(hit)}`)
  })

  await check("别人留下、昵称已经对不上的绑定不算有效归属，不挡后来人", async () => {
    /** 乙的绑定记的是"很久以前的旧名字"，与表里第 10 行现在的昵称对不上 → 不是有效归属 */
    const binds = { [B]: { row: 10, nickname: "很久以前的旧名字" } }
    const hit = locateSelf(singleModel, store(binds), SHEET, A, "同名的人")
    if (hit.row !== 10) throw new Error(`应当能认领第 10 行，实际 ${JSON.stringify(hit)}`)
    if (hit.source !== "nickname") throw new Error(`source=${hit.source}`)
  })

  await check("自己的绑定仍然优先：昵称一致时按绑定认（不因别人同名而丢行）", async () => {
    const binds = { [A]: { row: 10, nickname: "同名的人" }, [B]: { row: 12, nickname: "同名的人" } }
    const hit = locateSelf(dupModel, store(binds), SHEET, A, "同名的人")
    if (hit.row !== 10 || hit.source !== "bind") throw new Error(`应当认自己的绑定：${JSON.stringify(hit)}`)
  })


  /* ---------------- 名字不可靠时：绑定（QQ）兜底，名字只当"要改表"的提示 ---------------- */

  /**
   * 线上现场（2026-10-18）：本人群昵称「希珀塞莱妮娅」，机器人拿到的是 QQ 名牌「绒月.」，
   * 而绑定指着第 14 行、格子里写着「铭诸心腑吖」（维护者："铭诸心腑吖不是我的名字，表里有我自己的行"、
   * "最好直接用绑定的 QQ 兜底"）。**绑定（QQ）才是身份**，名字对不上只提示改表，不能判绑定作废。
   */
  const movedModel = {
    name: SHEET,
    rows: [
      { row: 10, nickname: "铭诸心腑吖" },
      { row: 11, nickname: "希珀塞莱妮娅" },
    ],
  }

  await check("绑定（QQ）兜底：表里那一格的名字对不上也认这一行，并给出 renamedFrom（提示改表）", async () => {
    const binds = { [A]: { row: 10, nickname: "绒月." } }
    const hit = locateSelf(movedModel, store(binds), SHEET, A, "希珀塞莱妮娅")
    if (hit.row !== 10 || hit.source !== "bind") throw new Error(`应当认绑定：${JSON.stringify(hit)}`)
    if (hit.renamedFrom !== "铭诸心腑吖") throw new Error(`应当把"表里写的是别人名字"提示出来：${JSON.stringify(hit)}`)
  })

  await check("绑定昵称就是当前名片，但行里已经换人：不再把这一行当本人", async () => {
    const staleModel = { name: SHEET, rows: [{ row: 10, nickname: "铭诸心腑吖" }] }
    const binds = { [A]: { row: 10, nickname: "希珀塞莱妮娅" } }
    const hit = locateSelf(staleModel, store(binds), SHEET, A, "希珀塞莱妮娅")
    if (hit.row !== 0) throw new Error(`旧绑定行已经换人，不应再认：${JSON.stringify(hit)}`)
    if (hit.stale !== true) throw new Error(`应当标 stale：${JSON.stringify(hit)}`)
  })

  await check("绑定指向的行没了：判过期，按候选名字兜底（第一个名字不行就试下一个）", async () => {
    const binds = { [A]: { row: 99, nickname: "绒月." } }
    const hit = locateSelf(movedModel, store(binds), SHEET, A, "希珀塞莱妮娅")
    if (hit.stale !== true) throw new Error(`应当判为过期：${JSON.stringify(hit)}`)
    if (hit.row !== 11) throw new Error(`应当按名字认第 11 行，实际 ${JSON.stringify(hit)}`)
  })

  /* --------------------- 「认不回来」要说得出为什么 --------------------- */

  /** `mineView` 会读 `model.anchors`，假模型补齐它 */
  const withAnchors = model => ({ anchors: [], ...model })

  await check("认不回来时记一条 missed：绑定原来指到哪一行、试过哪些名字、为什么没认出来", async () => {
    const only = withAnchors({ name: SHEET, rows: [{ row: 10, nickname: "铭诸心腑吖" }] })
    /** 绑定那一行已经没了（退队/被删），按名字也一个都对不上 */
    const binds = { [A]: { row: 99, nickname: "绒月." } }
    const view = mineView(new Map([[SHEET, only]]), store(binds), A, "绒月.", { moreNames: ["希珀塞莱妮娅"] })
    if (view.active.length) throw new Error(`不该认出任何行：${JSON.stringify(view.active)}`)
    if (!view.missed?.length) throw new Error("没记 missed（用户只看到「未填：三榜」，分不清是没报名还是没认出）")
    const m = view.missed[0]
    if (m.sheet !== SHEET || m.bindRow !== 99) throw new Error(`missed 指错了：${JSON.stringify(m)}`)
    if (!(m.names ?? []).includes("希珀塞莱妮娅")) throw new Error(`没带上试过的名字：${JSON.stringify(m)}`)
    if (m.why !== "none") throw new Error(`why=${m.why}（表里没有这些名字）`)
  })

  await check("同名行已经绑给别的 QQ：missed 的 why 是 claimed（不是「没这个人」）", async () => {
    const model = withAnchors({
      name: SHEET,
      rows: [
        { row: 10, nickname: "铭诸心腑吖" },
        { row: 11, nickname: "希珀塞莱妮娅" },
      ],
    })
    /** A 的绑定那一行没了；表里那一行「希珀塞莱妮娅」已经被 B 有效绑着 */
    const binds = { [A]: { row: 99, nickname: "绒月." }, [B]: { row: 11, nickname: "希珀塞莱妮娅" } }
    const view = mineView(new Map([[SHEET, model]]), store(binds), A, "希珀塞莱妮娅")
    if (view.active.length) throw new Error(`不该认领别人已绑定的行：${JSON.stringify(view.active)}`)
    if (view.missed?.[0]?.why !== "claimed") throw new Error(`why=${JSON.stringify(view.missed)}`)
  })

  await check("机器人拿到的名字不对：换用别的来源的名字再试，能认回自己那一行", async () => {
    /** 没有绑定（新人）：名字#1「绒月.」对不上，名字#2「希珀塞莱妮娅」才是自己那一行 */
    const model = withAnchors({
      name: SHEET,
      rows: [
        { row: 10, nickname: "铭诸心腑吖" },
        { row: 12, nickname: "希珀塞莱妮娅" },
      ],
    })
    const view = mineView(new Map([[SHEET, model]]), store({}), A, "绒月.", { moreNames: ["希珀塞莱妮娅"] })
    if (view.active.length !== 1 || view.active[0].row !== 12)
      throw new Error(`没认回自己那一行：${JSON.stringify(view.active)}`)
    if (view.missed?.length) throw new Error(`认回来了就不该再记 missed：${JSON.stringify(view.missed)}`)
  })

  await check("旧绑定指向别人那一行：按本人名字能找到时，优先本人名字而不是旧绑定", () => {
    const model = withAnchors({
      name: SHEET,
      rows: [
        { row: 10, nickname: "别人" },
        { row: 11, nickname: "我自己" },
      ],
    })
    const view = mineView(new Map([[SHEET, model]]), store({ [A]: { row: 10, nickname: "旧名字" } }), A, "我自己")
    if (view.active.length !== 1 || view.active[0].row !== 11)
      throw new Error(`旧绑定抢在了本人名字前面：${JSON.stringify(view.active)}`)
  })

  await check("私聊档：有名字对得上的本人行时，旧绑定命中的别人行不再展示", () => {
    const view = {
      active: [
        { sheet: "幻想真境剧诗", row: 10, nickname: "细细听" },
        { sheet: "幽境危战", row: 20, nickname: "全世界水源消失而我能无限尿尿" },
      ],
      total: 2,
      drops: [],
    }
    const got = exactSelfView(view, ["全世界水源消失而我能无限尿尿"])
    if (got.active.length !== 1 || got.active[0].nickname !== "全世界水源消失而我能无限尿尿")
      throw new Error(`旧绑定行没被收掉：${JSON.stringify(got.active)}`)
    if (got.total !== 1) throw new Error(`total 没跟着收：${got.total}`)
    if (!got.drops?.some(d => d.row === 0 && d.sheet === "幻想真境剧诗"))
      throw new Error(`没把旧绑定记进 drops：${JSON.stringify(got.drops)}`)
  })

  await check("私聊档：一个名字都对不上时保留绑定兜底，不把本人清空", () => {
    const view = { active: [{ sheet: SHEET, row: 10, nickname: "铭诸心腑吖" }], total: 1, drops: [] }
    const got = exactSelfView(view, ["希珀塞莱妮娅"])
    if (got !== view) throw new Error("没有精确命中时不该改原结果")
  })

  await check("「第 N 位」按当前排队顺序算，不照抄表内 A 列序号", () => {
    const model = withAnchors({
      name: SHEET,
      rows: [
        { row: 10, seq: "9", nickname: "前面的人" },
        { row: 12, seq: "11", nickname: "我自己" },
      ],
    })
    const view = mineView(new Map([[SHEET, model]]), store({}), A, "我自己")
    if (view.active.length !== 1) throw new Error(`没认回自己：${JSON.stringify(view.active)}`)
    if (view.active[0].seq !== "2")
      throw new Error(`第 N 位仍是表内序号：${JSON.stringify(view.active[0])}`)
  })

  await finish()
})()

finish()
