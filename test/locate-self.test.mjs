/**
 * 按 QQ 定位：昵称兜底不得认领别人已经有效绑定的行（AQ-02）
 *
 * 群昵称可以重名、本人也随时能改，而绑定才是身份。昵称兜底不能是 `rows.find(昵称相同)`：
 * 两个 QQ 用同一个群昵称时，后来的人可以不声不响地拿到
 * 先来者已经绑定的那一行，然后通过 /api/save 改别人的记录（横向越权）。
 *
 * 这里用假模型 + 假绑定表把几条路都钉死（纯逻辑，不需要真表、不需要起服务）：
 *   1. 没有旧绑定 → 不能抢别人已绑定的行（同名也不行），但可以认领没人有效绑定的同名行
 *   2. 旧绑定失效 → 同样不能抢别人已绑定的行
 *   3. 「别人留下、昵称已经对不上」的旧绑定不算有效归属，不该挡住后来人
 */
import { createChecker } from "./_helper.mjs"
import { locateSelf, myRowOf } from "../modules/queue.js"
import { mineView } from "../components/render.js"

const { check, finish } = createChecker("按 QQ 定位（归属校验）")

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

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */