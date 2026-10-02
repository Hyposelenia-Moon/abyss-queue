/**
 * 插件级常量（字符串、上下文名、用法文案）
 */

/** 榜名（顺序即引导菜单顺序） */
export const SHEETS = ["幻想真境剧诗", "幽境危战", "深境螺旋"]

/** 上下文类型名 */
export const JOIN_CONTEXT = "joinStep"
export const CLEAR_CONTEXT = "clearStep"

/** 插件名与说明 */
export const PLUGIN_NAME = "三路深渊排队"
export const PLUGIN_DSC = "读写本地 xlsx 排表：查队列 / 报名 / 退队 / 改备注"

/** 一行式报名用法 */
export const JOIN_USAGE = "用法：#深渊报名 <榜> <游戏名> <主播> <难度> <强度> [备注]"

/** 更新指令：可接受的写法（缩写 → 目录名） */
export const UPDATE_ALIASES = { abyss: "abyss-queue" }

/** 更新指令的规则正则（只有指向本插件的写法才接管） */
export const UPDATE_COMMANDS = "^#(强制)?更新\\s+\\S+$"

/** 更新成功后的生效提示 */
export const UPDATE_COMMAND_HINT = "插件文件已落地，重载后生效（发送 #重启 或等宿主热重载）"
