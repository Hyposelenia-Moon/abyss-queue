/**
 * 查询类指令的**唯一定义**（纯函数，不依赖 Yunzai / 文件系统）
 *
 * 为什么要单独一层：「注册规则」「处理器解析」「分页提示」各写一遍写法时会出现两种不一致——
 *   - `#危战列表` 能过注册规则，处理器却只认「排队」后缀，回了「没找到这个榜」
 *   - 分页提示写的写法不命中任何规则，照着发没反应
 * 两处都从这里取：`SHEET_CMD_REGEX` 注册、`matchSheetCommand()` 解析，写法一变两处同时变。
 */
import { SHEET_ALIASES_KEYS, SHEETS } from "../components/constants.js"

/** 榜名的可写形式：全名 + 简称/别名（按长度降序，避免短名先匹配） */
export const SHEET_CMD_NAMES = [...SHEETS, ...SHEET_ALIASES_KEYS]

/**
 * 「榜名参数」的可写形式：全名 / 简称 / 别名 / **序号**（`#排队 2` 看第二个榜）
 * 序号写 `\d+`，能不能对上由 modules/router.js 的 resolveSheet 判定。
 */
export const SHEET_CMD_ARG = `(?:${SHEET_CMD_NAMES.join("|")}|\\d+)`

/**
 * 单榜查询的两种写法合成一个正则
 *   前缀式：`#排队 <榜>`
 *   后缀式：`#<榜>排队` / `#<榜>列表`（与前缀式等价，同样命中注册规则）
 *
 * 刻意**不接收裸榜名**（`#幽境危战` 等），那些归 Axiu-Plugin 等更低优先级的插件。
 * 榜名用 `(?:…)` 包住，免得每个候选各占一个组、下标随榜名数量变化。
 * 不再接受 `全部` 后缀；要看完整体请到编辑器/表格。
 */
export const SHEET_CMD_REGEX = `^(?:#排队(?:\\s+(${SHEET_CMD_ARG}))?|#(${SHEET_CMD_NAMES.join("|")})(?:排队|列表))$`

/**
 * 解析单榜查询消息
 * @param {string} msg 完整消息（处理器拿到的那一条）
 * @returns {{name:string}|null} 榜名写法；不是单榜命令则为 null
 */
export function matchSheetCommand(msg) {
  const m = new RegExp(SHEET_CMD_REGEX).exec(String(msg ?? "").trim())
  if (!m) return null
  /** 前缀式取 m[1]，后缀式取 m[2]；都为空 = `#排队` 看默认榜 */
  return { name: (m[1] ?? m[2] ?? "").trim() }
}
