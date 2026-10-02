/**
 * 插件级常量（字符串、上下文名、用法文案）
 */

/** 榜名（顺序即引导菜单顺序） */
export const SHEETS = ["幻想真境剧诗", "幽境危战", "深境螺旋"]

/**
 * 榜名简称 → 全名
 * 用于指令（#排队 危战 / #危战排队）两种场景
 */
export const SHEET_ALIASES = {
  剧诗: "幻想真境剧诗",
  幻想: "幻想真境剧诗",
  真境剧诗: "幻想真境剧诗",
  危战: "幽境危战",
  幽境: "幽境危战",
  幽境危战: "幽境危战",
  深渊: "深境螺旋",
  螺旋: "深境螺旋",
  深境: "深境螺旋",
}

/** 别名键（供指令正则使用；按长度降序，避免短名先匹配） */
export const SHEET_ALIASES_KEYS = Object.keys(SHEET_ALIASES).sort((a, b) => b.length - a.length)

/** 上下文类型名（#清空 的二次确认） */
export const CLEAR_CONTEXT = "clearStep"

/** 插件名与说明 */
export const PLUGIN_NAME = "三路深渊排队"
export const PLUGIN_DSC = "读写本地 xlsx 排表：查队列 / 主播 / 我的记录；填表用本地编辑器"
