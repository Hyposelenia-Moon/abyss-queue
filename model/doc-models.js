/** 状态文档 → 工作表模型（与旧 `model/schema.js` 的 `buildModel` 同形） */
import { splitItems } from "../components/text.js"
import { ROW_FIELDS } from "./queue-doc.js"

const clean = s => String(s ?? "").trim()

export const COL = { seq: "A", nickname: "B", gameName: "C", anchor: "D", goal: "E", note: "F", status: "G" }

const hasContent = rec => ROW_FIELDS.some(key => clean(rec[key]))

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
