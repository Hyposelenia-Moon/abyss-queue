/**
 * 查询类指令的**唯一定义**（纯函数，不依赖 Yunzai / 文件系统）
 *
 * 为什么要单独一层：以前「注册规则」「处理器解析」「分页提示」三处各写一遍写法，
 * 于是出现两种不一致——
 *   - `#危战列表` 能过注册规则，处理器却只认「排队」后缀，回了「没找到这个榜」
 *   - 分页提示写的是 `#幽境危战 全部`，这条消息不命中任何规则，照着发没反应
 * 现在三处都从这里取：`SHEET_CMD_REGEX` 注册、`matchSheetCommand()` 解析、
 * `allCommand()` 生成提示，写法一变三处同时变。
 */
import { SHEET_ALIASES_KEYS, SHEETS } from "../components/constants.js"

/** 「全部」后缀：查看不过滤（等价 limit=0）的写法 */
export const ALL_SUFFIX = "全部"

/** 榜名的可写形式：全名 + 简称/别名（按长度降序，避免短名先匹配） */
export const SHEET_CMD_NAMES = [...SHEETS, ...SHEET_ALIASES_KEYS]

/**
 * 「榜名参数」的可写形式：全名 / 简称 / 别名 / **序号**（`#排队 2` 看第二个榜）
 *
 * 序号写 `\d+`，能不能对上由 lib/router.js 的 resolveSheet 判定。
 * 也允许「全部」：`#排队 全部` 表示对默认榜取全量（处理器按「榜名解析不出来 + all」处理）。
 */
export const SHEET_CMD_ARG = `(?:${SHEET_CMD_NAMES.join("|")}|\\d+|${ALL_SUFFIX})`

/**
 * 单榜查询的两种写法合成一个正则
 *   前缀式：`#排队 <榜> [全部]`
 *   后缀式：`#<榜>排队` / `#<榜>列表`（历史写法，继续兼容）
 *
 * 刻意**不接收裸榜名**（`#幽境危战` 等），那些归 Axiu-Plugin 等更低优先级的插件。
 * 榜名与「全部」各占一个**固定下标**的捕获组（m[1] / m[2] / m[3]），两种写法共用：
 * 榜名候选本身用 `(?:…)` 包住，免得每个候选各占一个组、下标随榜名数量变化。
 */
export const SHEET_CMD_REGEX = `^(?:#排队(?:\\s+(${SHEET_CMD_ARG})(?:\\s+(${ALL_SUFFIX}))?)?|#(${SHEET_CMD_NAMES.join("|")})(?:排队|列表))$`

/**
 * 解析单榜查询消息
 * @param {string} msg 完整消息（处理器拿到的那一条）
 * @returns {{name:string, all:boolean}|null} 榜名写法 + 是否全量查看；不是单榜命令则为 null
 */
export function matchSheetCommand(msg) {
  const m = new RegExp(SHEET_CMD_REGEX).exec(String(msg ?? "").trim())
  if (!m) return null
  /** 前缀式取 m[1]，后缀式取 m[3]；都为空 = `#排队` 看默认榜 */
  const raw = (m[1] ?? m[3] ?? "").trim()
  /**
   * `#排队 全部` 也走「默认榜 + 全量」：这时「全部」落在榜名那一个组里，
   * 不能当成榜名去 resolveSheet（否则会被包含匹配到「深境螺旋」上）。
   */
  const onlyAll = raw === ALL_SUFFIX
  return { name: onlyAll ? "" : raw, all: onlyAll || m[2] === ALL_SUFFIX }
}

/**
 * 全量查看某榜的完整写法（分页提示用）
 *
 * 必须是**注册规则真能命中**的写法：以前写 `#${model.name} 全部`，谁也匹配不上。
 * @param {string} sheet 榜名（表里的全名）
 */
export const allCommand = sheet => `#排队 ${String(sheet ?? "").trim()} ${ALL_SUFFIX}`
