/** 导出器回归：`prefill` 的边界口径 */
import assert from "node:assert/strict"
import { sheetXmlOf } from "../model/doc-export.js"
import { createChecker } from "./_helper.mjs"

const { check, finish } = createChecker("导出器")

/** 一张最小工作表：顶部 1 行标题 + 1 行表头 + N 行数据 */
const makeSheet = ({ prefill, rows = 2 } = {}) => ({
  name: "测试榜",
  top: [{ A: "测试榜" }],
  header: { A: "序号", B: "昵称", C: "游戏名", D: "主播", E: "目标", F: "备注", G: "完成情况" },
  rows: Array.from({ length: rows }, (_, i) => ({ nickname: `成员${i + 1}` })),
  options: {},
  ...(prefill === undefined ? {} : { prefill }),
})

/** 工作表 XML 的 `dimension ref` 末行 = 导出器实际铺到的最后一行 */
const lastRowOf = sheet => {
  const xml = sheetXmlOf(sheet)
  const matched = xml.match(/<dimension ref="A1:I(\d+)"\/>/)
  assert.ok(matched, "工作表 XML 里应当有 dimension")
  return Number(matched[1])
}

// 顶部 1 行 + 表头 1 行 = 第 2 行是表头，数据从第 3 行开始

check("prefill: 0 只写到数据末行，不铺预填区", () => {
  // 2 行数据 → 第 3、4 行；最后一行是 4（曾经被 0 > 0 判成"没填"，多铺到 102 行）
  assert.equal(lastRowOf(makeSheet({ prefill: 0, rows: 2 })), 4)
})

check("prefill 缺省仍是 100 行预填（编辑体验不变）", () => {
  assert.equal(lastRowOf(makeSheet({ rows: 2 })), 2 + 100)
})

check("prefill 小于数据行数时以数据行数为准", () => {
  // 追加到预填区之外的行也必须落进镜像
  assert.equal(lastRowOf(makeSheet({ prefill: 1, rows: 3 })), 2 + 3)
})

check("负数 / 非整数 prefill 回退 100", () => {
  assert.equal(lastRowOf(makeSheet({ prefill: -1, rows: 2 })), 2 + 100)
  assert.equal(lastRowOf(makeSheet({ prefill: 2.5, rows: 2 })), 2 + 100)
})

await finish()
