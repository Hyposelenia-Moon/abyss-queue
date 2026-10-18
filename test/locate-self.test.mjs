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

/**
 * 线上现场（2026-10-18 日志）：`深境螺旋#14「铭诸心腑吖」← 绑定（记的昵称「绒月.」）`——
 * 绑定还指着第 14 行、记的正是发送者现在的名片，可那一行写着另一个名字。
 *
 * **光看三个名字判不出来**：正常改名也长这样（`syncIdentity` 会在改名那一趟把绑定里记的昵称
 * 刷成新名片，而表里的名字要等编辑器同步）。能区分的是**那个名字属于谁**——群名单里有没有
 * 另一个成员现在的名片就叫它。
 */
const movedModel = {
  name: SHEET,
  rows: [
    { row: 10, nickname: "铭诸心腑吖" },
    { row: 11, nickname: "绒月." },
  ],
}

await check("表里那一行的名字是**群里另一个人**的名片：判过期，不把别人的行当成本人的", async () => {
  const binds = { [A]: { row: 10, nickname: "绒月." } }
  /** 群名单：第 10 行那个名字属于另一个 QQ */
  const roster = [
    { qq: A, nick: "绒月." },
    { qq: B, nick: "铭诸心腑吖" },
  ]
  const hit = locateSelf(movedModel, store(binds), SHEET, A, "绒月.", { roster })
  if (hit.stale !== true) throw new Error(`应当判为过期：${JSON.stringify(hit)}`)
  if (hit.row === 10) throw new Error("把别人的行当成了本人的（现场那个 bug）")
  if (hit.row !== 11) throw new Error(`应当按昵称兜底认第 11 行，实际 ${JSON.stringify(hit)}`)
})

await check("表里那一行是**自己以前的名字**（名单里没有别人叫它）：仍认绑定，并给出 renamedFrom", async () => {
  const binds = { [A]: { row: 10, nickname: "绒月." } }
  /** 群名单里只有我自己叫「绒月.」：第 10 行的「铭诸心腑吖」不是别人的当前名片 ⇒ 是我改名滞后 */
  const roster = [{ qq: A, nick: "绒月." }]
  const hit = locateSelf(movedModel, store(binds), SHEET, A, "绒月.", { roster })
  if (hit.row !== 10 || hit.source !== "bind") throw new Error(`应当仍认绑定：${JSON.stringify(hit)}`)
  if (hit.renamedFrom !== "铭诸心腑吖") throw new Error(`应当报改名：${JSON.stringify(hit)}`)
})

await check("没有群名单（没扫过）：不做「换人」判断，退回「绑定优先」（老口径，不会把信息弄丢）", async () => {
  const binds = { [A]: { row: 10, nickname: "绒月." } }
  const hit = locateSelf(movedModel, store(binds), SHEET, A, "绒月.")
  if (hit.row !== 10 || hit.source !== "bind") throw new Error(`应当按绑定认：${JSON.stringify(hit)}`)
})

await check("真改名（绑定里记的昵称 == 表里旧昵称）：仍然认绑定，并给出 renamedFrom", async () => {
  const model = { name: SHEET, rows: [{ row: 10, nickname: "旧名字" }] }
  const binds = { [A]: { row: 10, nickname: "旧名字" } }
  const hit = locateSelf(model, store(binds), SHEET, A, "新名字")
  if (hit.row !== 10 || hit.source !== "bind") throw new Error(`应当仍认绑定：${JSON.stringify(hit)}`)
  if (hit.renamedFrom !== "旧名字") throw new Error(`应当报改名：${JSON.stringify(hit)}`)
})

/* --------------------- 「认不回来」要说得出为什么 --------------------- */

/** `mineView` 会读 `model.anchors`，假模型补齐它 */
const withAnchors = model => ({ anchors: [], ...model })

await check("认不回来时记一条 missed：绑定原来指到哪一行、为什么没认出来", async () => {
  /** 表里只有别人那一行：绑定指过去，而自己的名字一个都没有 */
  const only = withAnchors({ name: SHEET, rows: [{ row: 10, nickname: "铭诸心腑吖" }] })
  const binds = { [A]: { row: 10, nickname: "绒月." } }
  const roster = [
    { qq: A, nick: "绒月." },
    { qq: B, nick: "铭诸心腑吖" },
  ]
  const view = mineView(new Map([[SHEET, only]]), store(binds), A, "绒月.", { roster })
  if (view.active.length) throw new Error(`不该认出任何行：${JSON.stringify(view.active)}`)
  if (!view.missed?.length) throw new Error("没记 missed（用户只看到「未填：三榜」，分不清是没报名还是没认出）")
  const m = view.missed[0]
  if (m.sheet !== SHEET || m.bindRow !== 10) throw new Error(`missed 指错了：${JSON.stringify(m)}`)
  if (m.bindNick !== "铭诸心腑吖") throw new Error(`没带上那一行现在的名字：${JSON.stringify(m)}`)
  if (m.why !== "none") throw new Error(`why=${m.why}（表里没有叫「绒月.」的行）`)
})

await check("同名行已经绑给别的 QQ：missed 的 why 是 claimed（不是「没这个人」）", async () => {
  const model = withAnchors({
    name: SHEET,
    rows: [
      { row: 10, nickname: "铭诸心腑吖" },
      { row: 11, nickname: "绒月." },
    ],
  })
  const binds = { [A]: { row: 10, nickname: "绒月." }, [B]: { row: 11, nickname: "绒月." } }
  const roster = [
    { qq: A, nick: "绒月." },
    { qq: B, nick: "铭诸心腑吖" },
  ]
  const view = mineView(new Map([[SHEET, model]]), store(binds), A, "绒月.", { roster })
  if (view.active.length) throw new Error(`不该认领别人已绑定的行：${JSON.stringify(view.active)}`)
  if (view.missed?.[0]?.why !== "claimed") throw new Error(`why=${JSON.stringify(view.missed)}`)
})

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
