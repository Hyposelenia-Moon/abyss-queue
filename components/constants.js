/** 插件级常量（字符串、上下文名、用法文案） */

import { ATTACK_SHEET } from "./attack.js"

export const SHEETS = ["幻想真境剧诗", "幽境危战", "深境螺旋", ATTACK_SHEET]

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
  攻炼: ATTACK_SHEET,
  枪战: ATTACK_SHEET,
  绝境: ATTACK_SHEET,
  绝境攻炼: ATTACK_SHEET,
}

export const SHEET_ALIASES_KEYS = Object.keys(SHEET_ALIASES).sort((a, b) => b.length - a.length)

export const PLUGIN_NAME = "三路深渊排队"
export const PLUGIN_DSC = "排队表工具：查队列 / 主播 / 我的记录（表格随机器人一起维护，自带网页编辑器）"

export const EDITOR_MOUNT = "/queue"
