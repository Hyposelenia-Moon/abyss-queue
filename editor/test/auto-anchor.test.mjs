import { autoAnchorOfStatus, singleAnchorOfStatus } from "../status-anchor.js"

const anchors = [{ name: "默秦" }, { name: "听雨" }]
const statusLabels = status => {
  // 与 editor.mjs 的 statusLabels 同一结果的最小替身：普通逗号与枪战复合状态
  const attack = String(status ?? "").trim().split(/\s+/).filter(Boolean)
  if (attack.length && attack.every(token => /^\d+\.\d+(?:\/\d+\.\d+)*.+$/.test(token)))
    return attack.map(token => token.replace(/^\d+\.\d+(?:\/\d+\.\d+)*/, ""))
  return String(status ?? "").split(/[,，]/).map(s => s.trim()).filter(Boolean)
}
const cases = [
  ["单主播", ["默秦"], "希珀塞莱尼娅", "默秦"],
  ["枪战复合：等待不影响已完成人", statusLabels("7.2默秦 7.3等待开启"), "希珀塞莱尼娅", "默秦"],
  ["同人合并版本", statusLabels("7.1/7.2默秦 7.3等待开启"), "希珀塞莱尼娅", "默秦"],
  ["本人完成不改", ["希珀塞莱尼娅"], "希珀塞莱尼娅", ""],
  ["本人完成标记不改", ["本人已完成"], "希珀塞莱尼娅", ""],
  ["群昵称碰巧等于主播名也不改本人", ["默秦"], "默秦", ""],
  ["两位主播不改", ["默秦", "听雨"], "希珀塞莱尼娅", ""],
  ["枪战两位完成人不改", statusLabels("7.1默秦 7.2听雨 7.3等待开启"), "希珀塞莱尼娅", ""],
  ["只有排队中不改", ["排队中"], "希珀塞莱尼娅", ""],
  ["未知名字不改", ["不存在的人"], "希珀塞莱尼娅", ""],
]

let failed = 0
for (const [label, status, nickname, expected] of cases) {
  const got = singleAnchorOfStatus(status, nickname, anchors)
  if (got !== expected) {
    console.error(`❌ ${label}: ${JSON.stringify(status)} -> ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`)
    failed++
  } else {
    console.log(`✅ ${label}`)
  }
}

const autoCases = [
  ["单主播 -> 收窄", ["默秦"], "希珀塞莱尼娅", { mode: "anchors", anchors: ["默秦"] }],
  ["两位主播 -> 都选上", ["默秦", "听雨"], "希珀塞莱尼娅", { mode: "anchors", anchors: ["默秦", "听雨"] }],
  ["主播 + 本人 -> 都可以", ["默秦", "希珀塞莱尼娅"], "希珀塞莱尼娅", { mode: "public", anchors: [] }],
  ["主播 + 特殊人 -> 都可以", ["默秦", "不存在的人"], "希珀塞莱尼娅", { mode: "public", anchors: [] }],
  ["全是本人/特殊人 -> 不动", ["希珀塞莱尼娅", "不存在的人"], "希珀塞莱尼娅", { mode: "none", anchors: [] }],
  ["枪战多主播", statusLabels("7.1默秦 7.2听雨 7.3等待开启"), "希珀塞莱尼娅", { mode: "anchors", anchors: ["默秦", "听雨"] }],
  ["枪战主播 + 本人", statusLabels("7.1默秦 7.2希珀塞莱尼娅 7.3等待开启"), "希珀塞莱尼娅", { mode: "public", anchors: [] }],
]

for (const [label, status, nickname, expected] of autoCases) {
  const got = autoAnchorOfStatus(status, nickname, anchors)
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`❌ ${label}: ${JSON.stringify(status)} -> ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`)
    failed++
  } else {
    console.log(`✅ ${label}`)
  }
}

if (failed) {
  console.error(`❌ 自动主播收窄：${failed} 项失败`)
  process.exit(1)
}
console.log(`✅ 自动主播收窄：通过 ${cases.length + autoCases.length} 项断言`)
