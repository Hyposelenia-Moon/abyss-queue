/**
 * 状态文档 → 工作表模型（与旧 `model/schema.js` 的 `buildModel` 同形）
 *
 * 编辑器、`/api/data`、`editor/actions.js`、`editor/ownership.js` 全都按 `model` 形状工作；
 * 迁移期间最省事的做法是：**存储换成 JSON，投影层吐出与 xlsx 时代完全一样的 model**，
 * 上层代码一行都不用动。
 *
 * 这里与旧 `buildModel` 的差异只在"数据从哪来"：
 *   - 标题 = 页签名（m00477：不加日期、不加「排队」）；
 *   - 行号 / 表头行 / 序号由数组位置推导；
 *   - `seq` 投影成数据区里的第几行（1 起）。真实表的 A 列是公式、旧版本读到的是空串，
 *     页面与机器人都有"按行号回退"的兜底；这里直接给出同一个数，省掉那层猜测；
 *   - `dataEnd` 取"表格一共有多少行可写"（`prefill` 与现有行数取大），与旧版
 *     `=ROW()-k` 公式撑到的行一致；
 *   - `styles` 为空对象（新导出不保样式，见 m00477）。
 */
import { splitItems } from "../components/text.js"
import { ROW_FIELDS } from "./queue-doc.js"

const clean = s => String(s ?? "").trim()

/** 逻辑列 → 导出列字母（A 序号 + B–G 六个数据字段） */
export const COL = { seq: "A", nickname: "B", gameName: "C", anchor: "D", goal: "E", note: "F", status: "G" }

/** 状态文档里的一行算不算"有内容" */
const hasContent = rec => ROW_FIELDS.some(key => clean(rec[key]))

/**
 * 主播区：表头上方的原始行（`top[0]` 是第 1 行），与 `schema.detectAnchors` 同口径
 *
 * 第 1 行是标题，不参与；招募公告（📢 / 超过 40 字）、无姓名的孤链接行都不算主播，
 * 但它们仍以原文留在 `top` 里，导出时原样写回。
 */
function anchorsOf(sheet) {
  const anchors = []
  sheet.top.forEach((rec, index) => {
    const row = index + 1
    if (row === 1) return
    const raw = clean(rec.A)
    if (!raw) return
    if (raw === "主播列表") return
    if (raw.startsWith("📢") || raw.length > 40) return

    let name = raw
    let recommend = ""
    const m = /【([^】]*)】/.exec(name)
    if (m) {
      recommend = m[1]
      name = clean(name.replace(m[0], ""))
    }
    anchors.push({
      row,
      name,
      recommend,
      skills: clean(rec.C),
      duty: clean(rec.D),
      entry: splitItems([clean(rec.G), clean(rec.H)]),
      totalSkills: clean(rec.I),
      cells: {
        name: raw,
        skills: clean(rec.C),
        duty: clean(rec.D),
        platform: clean(rec.G),
        link: clean(rec.H),
      },
    })
  })
  return anchors
}

/**
 * 文档 → `Map<页签名, model>`
 *
 * `model.rows` 只包含有内容的行（与旧 `buildModel` 一致）：占位空行保留在 `sheet.rows` 里，
 * 但不进入 model；导出与行号推导都靠数组位置，不靠这里的行号。
 */
export function modelsOf(doc) {
  const models = new Map()
  for (const sheet of doc.sheets) {
    const headerRow = sheet.top.length + 1
    const dataStart = headerRow + 1
    const rows = []
    sheet.rows.forEach((rec, index) => {
      if (rec.blank === true) return
      if (!hasContent(rec)) return
      const row = { row: dataStart + index, seq: String(index + 1) }
      for (const key of ROW_FIELDS) row[key] = clean(rec[key])
      rows.push(row)
    })

    const options = {}
    for (const key of ["anchor", "goal", "status"]) {
      const list = sheet.options?.[key]
      if (Array.isArray(list) && list.length) options[key] = [...list]
    }

    models.set(sheet.name, {
      name: sheet.name,
      title: sheet.name,
      headerRow,
      dataStart,
      dataEnd: dataStart + Math.max(sheet.prefill ?? 0, sheet.rows.length) - 1,
      col: { ...COL },
      options,
      styles: {},
      anchors: anchorsOf(sheet),
      rows,
    })
  }
  return models
}
