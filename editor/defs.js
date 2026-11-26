/** 表格的静态定义：列、状态词、榜单简称、公共队列、各项上限 */

export const PUBLIC_ANCHOR = "公共队列"

export const PUBLIC_QUEUE_NAME = "公共队列"

export const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]

export const MOVE_COLUMN_KEYS = FIELDS.map(f => f.key)

export const ANCHOR_FIELDS = [
  { key: "name", label: "主播", col: "A", required: true },
  { key: "recommend", label: "推荐度", col: "" },
  { key: "duty", label: "专职", col: "D" },
  { key: "skills", label: "核心强项", col: "C" },
  { key: "platform", label: "B站直播入口（平台）", col: "G" },
  { key: "link", label: "B站直播入口（链接）", col: "H" },
]

export const blank = v => !String(v ?? "").trim()

export const WAITING_STATUS = "等待开启"

export const QUEUED_STATUS = "排队中"

export const OPEN_RULES = [
  { test: /剧诗/, day: 1 },
  { test: /螺旋/, day: 16 },
]

export const SHEET_SHORT = {
  幻想真境剧诗: "剧诗",
  幽境危战: "危战",
  深境螺旋: "深渊",
  绝境攻炼: "枪战",
}

export const sheetShortOf = sheet => SHEET_SHORT[String(sheet ?? "").trim()] || String(sheet ?? "").trim()

export const ANCHOR_CALL_COOLDOWN_MS = 5 * 60 * 1000

export const ANY_ANCHOR = "公共队列"

export const PENDING_STATUS = ["等待开启", "排队中"]

export const SELF_DONE = "本人已完成"

export const EXCLUSIVE_VALUES = [ANY_ANCHOR]

export const CYCLE_PROTOCOL = 2

export const APPEND_ROWS_MAX = 500

export const ANCHOR_FIRST_ROW = 3

export const REPLACE_REQUIRED_COLUMNS = [
  ["seq", "序号"],
  ["nickname", "群昵称"],
  ["gameName", "原神游戏名"],
  ["anchor", "选择主播"],
  ["goal", "难度及目标"],
  ["status", "帮帮完成情况"],
  ["note", "备注"],
]
