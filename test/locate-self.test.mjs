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

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
