/**
 * 四张表统一重排序规则：纯函数层。
 * 覆盖三段式分组、目标阶梯、强度阶梯、攻炼组合目标与稳定兜底。
 */
import { groupRankOf, goalRankOf, strengthRankOf, tidyOrder } from "../reorder.js"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("强迫症重排序")

const row = (id, status, goal, strength) => ({ row: id, nickname: `人${id}`, status, goal, strength })
const orderOf = (sheet, rows, { anchors = [], tempNames = [] } = {}) =>
  tidyOrder({ name: sheet, rows, anchors }, { tempNames })?.order ?? rows.map(r => r.row)

check("分组：已完成 → 等待开启 → 排队中", () => {
  const rows = [
    row(10, "排队中", "险恶(N4)", "低配"),
    row(11, "本人已完成", "绝境(N6)", "高配"),
    row(12, "等待开启", "无畏(N5)", "中配"),
    row(13, "阿修Axiu", "险恶(N4)", "低配"),
  ]
  if (groupRankOf("排队中") !== 2 || groupRankOf("等待开启") !== 1 || groupRankOf("阿修Axiu") !== 0)
    throw new Error("分组秩不对")
  const got = orderOf("幽境危战", rows, { anchors: ["阿修Axiu"] })
  if (JSON.stringify(got) !== JSON.stringify([13, 11, 12, 10]))
    throw new Error(`分组顺序不对：${JSON.stringify(got)}`)
})

check("剧诗：难度 → 目标 → 强度，低配在中配/高配前", () => {
  const rows = [
    row(10, "排队中", "困难模式满原石", "高配"),
    row(11, "排队中", "困难模式满原石", "低配"),
    row(12, "排队中", "困难模式满星章", "低配"),
    row(13, "排队中", "卓越模式满原石", "低配"),
  ]
  const got = orderOf("幻想真境剧诗", rows)
  if (JSON.stringify(got) !== JSON.stringify([11, 10, 12, 13]))
    throw new Error(`剧诗顺序不对：${JSON.stringify(got)}`)
  if (goalRankOf("幻想真境剧诗", "月谕模式满星章").difficulty <= goalRankOf("幻想真境剧诗", "卓越模式满星章").difficulty)
    throw new Error("月谕应当排在卓越之后")
  if (strengthRankOf("低配｜角色不足") >= strengthRankOf("中配｜角色达标") || strengthRankOf("待定｜待核验") <= strengthRankOf("高配｜角色充裕"))
    throw new Error("强度阶梯不对")
})

check("危战：N4 → N5 → N6 → N6 180s", () => {
  const rows = [
    row(10, "排队中", "绝境(N6)180s", "低配"),
    row(11, "排队中", "绝境(N6)", "高配"),
    row(12, "排队中", "无畏(N5)", "低配"),
    row(13, "排队中", "险恶(N4)", "高配"),
  ]
  const got = orderOf("幽境危战", rows)
  if (JSON.stringify(got) !== JSON.stringify([13, 12, 11, 10]))
    throw new Error(`危战顺序不对：${JSON.stringify(got)}`)
})

check("深渊：第11层 → 第12层", () => {
  const rows = [
    row(10, "排队中", "第12层满星", "低配"),
    row(11, "排队中", "第11层满星", "高配"),
    row(12, "排队中", "第12层满星", "低配"),
  ]
  const got = orderOf("深境螺旋", rows)
  if (JSON.stringify(got) !== JSON.stringify([11, 10, 12]))
    throw new Error(`深渊顺序不对：${JSON.stringify(got)}`)
})

check("攻炼：模式难度 → 目标 → 强度", () => {
  const rows = [
    row(10, "排队中", "焰羽追绞｜满星章", "低配"),
    row(11, "排队中", "焰羽追绞｜满原石", "高配"),
    row(12, "排队中", "囚笼冰城｜满原石", "低配"),
    row(13, "排队中", "焰羽追绞｜满原石", "低配"),
  ]
  const got = orderOf("绝境攻炼", rows)
  if (JSON.stringify(got) !== JSON.stringify([13, 11, 10, 12]))
    throw new Error(`攻炼顺序不对：${JSON.stringify(got)}`)
})

check("完成类型：本人 → 主播 → 临时名 → 未知", () => {
  const rows = [
    row(10, "主播甲", "险恶(N4)", "低配"),
    row(11, "人11", "险恶(N4)", "低配"),
    row(12, "临时甲", "险恶(N4)", "低配"),
    row(13, "查无此人", "险恶(N4)", "低配"),
  ]
  const got = orderOf("幽境危战", rows, { anchors: ["主播甲"], tempNames: ["临时甲"] })
  if (JSON.stringify(got) !== JSON.stringify([11, 10, 12, 13]))
    throw new Error(`完成类型顺序不对：${JSON.stringify(got)}`)

  /** 多值按最高优先级：本人 + 主播 ⇒ 仍按本人 */
  const multi = [row(10, "主播甲", "险恶(N4)", "低配"), row(11, "人11,主播甲", "险恶(N4)", "低配")]
  const multiGot = orderOf("幽境危战", multi, { anchors: ["主播甲"] })
  if (JSON.stringify(multiGot) !== JSON.stringify([11, 10]))
    throw new Error(`多值完成类型没有按最高优先级：${JSON.stringify(multiGot)}`)
})

check("同键稳定：保留原始行号顺序；未知目标放本组最后", () => {
  const rows = [
    row(12, "排队中", "险恶(N4)", "低配"),
    row(10, "排队中", "不知道的目标", "低配"),
    row(11, "排队中", "险恶(N4)", "低配"),
  ]
  const got = orderOf("幽境危战", rows)
  if (JSON.stringify(got) !== JSON.stringify([11, 12, 10]))
    throw new Error(`稳定兜底不对：${JSON.stringify(got)}`)
  const again = orderOf("幽境危战", rows)
  if (JSON.stringify(got) !== JSON.stringify(again)) throw new Error("同一输入两次排序结果不同")
})

await finish()
