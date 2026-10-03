/**
 * 插件级常量（字符串、上下文名、用法文案）
 */

/** 榜名（顺序即菜单与合并表的展示顺序） */
export const SHEETS = ["幻想真境剧诗", "幽境危战", "深境螺旋"]

/** 榜名简称 → 全名（#排队 <榜> 与 #<榜>排队 两种写法共用） */
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

export const PLUGIN_NAME = "三路深渊排队"
export const PLUGIN_DSC = "只读本地 xlsx 排表：查队列 / 主播 / 我的记录（表由腾讯文档与云端编辑器维护，插件不写表）"
