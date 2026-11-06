import assert from "node:assert/strict"
import { attackStatusKind } from "../components/attack.js"
import { isPending, isDone, nextPending, pendingBySheet } from "../modules/progress.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("攻炼混合排队")
const status = "7.1排队中 7.2阿修Axiu 7.3等待开启"
const model = {
  name: "绝境攻炼",
  rows: [
    { row: 10, nickname: "前一位", status: "7.2前一位" },
    { row: 11, nickname: "部分完成者", status },
    { row: 12, nickname: "后面的排队者", status: "7.2排队中" },
  ],
}
check("未完成段中有排队就仍属排队，不被未来等待覆盖", () => {
  assert.equal(attackStatusKind(status), "queued")
  assert.equal(isPending(status), true)
  assert.equal(isDone(status), false)
})
check("下一位不漏掉部分完成者", () => assert.equal(nextPending(model, 10)?.nickname, "部分完成者"))
check("月度待办包含部分完成者", () => {
  assert.deepEqual(pendingBySheet([model])[0].rows.map(row => row.nickname), ["部分完成者", "后面的排队者"])
})
check("只有未来等待仍不算排队", () => assert.equal(isPending("7.3等待开启"), false))
check("已完成加未来等待仍不算排队", () => assert.equal(isPending("7.2阿修Axiu 7.3等待开启"), false))
check("所有段完成仍为完成", () => assert.equal(isDone("7.1阿修Axiu 7.2听雨"), true))
finish()
