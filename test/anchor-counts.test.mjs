import { ensureEnv } from "./env.mjs"
/**
 * 主播级排队人数
 *
 * 口径（未来方案文档 2026-11-15 P1）：
 *   - 排队中 / 等待开启分开统计；
 *   - 同一行同一主播只算一次；
 *   - 已完成/空状态不计；
 *   - 多榜合并时按榜分别显示，不把不同榜加成一个数。
 */
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("主播排队人数")
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
