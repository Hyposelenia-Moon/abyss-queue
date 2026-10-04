/**
 * 报告渲染：把七步结果拼成一条给主人看的消息（✅ 做了什么 / ⏭ 已存在跳过 / ❌ 失败原因）
 */
import { list } from "./shared.js"

export function renderInitReport(result) {
  const mark = { done: "✅", skip: "⏭", fail: "❌", todo: "⏸" }
  const lines = ["【排队初始化】把本机编辑器那套手工初始化走一遍（主人专用 · 遇错即停）", ""]
  for (const s of result.steps) lines.push(`${s.no}. ${mark[s.status] ?? "·"} ${s.title}：${s.detail}`)

  if (result.ok) {
    lines.push("", "全部步骤完成。")
    return lines.join("\n")
  }
  const done = result.steps.filter(s => s.no < result.failedAt).map(s => s.no)
  const todo = result.steps.filter(s => s.status === "todo").map(s => s.no)
  lines.push(
    "",
    `❌ 第 ${result.failedAt} 步失败，已按「遇错即停」停在原地（后面一步都没做）`,
    `已完成：${done.length ? list(done) : "（无）"}`,
    `未做：${todo.length ? list(todo) : "（无）"}`,
    "修掉上面的原因再发一次 #排队初始化；已经做好的产物不会被覆盖。",
  )
  return lines.join("\n")
}
