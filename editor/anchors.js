/**
 * 主播区（下拉候选）的口径
 *
 * 这里回答一个问题：这一榜的「选择主播」下拉里，到底该出现哪些名字。
 * 口径 = 主播名单 ∪ 表里正在用的值 ∪ 公共队列；别名归一到主播本人。
 * 「完成情况」的下拉另走 `mergeStatusOptions` 净化，不直接用 xlsx 里那份旧验证。
 *
 * 配置从 `ctx.config` 读（装配根 `installCtx({ config })` 放进来）：
 * 配置是 `await createConfig()` 之后才有的，子模块直接 import 会成环。
 */
import { compileAliases, canonicalAnchor } from "../components/aliases.js"
import { ATTACK_TARGET_NAMES, attackModeNames, attackVersions } from "../components/attack.js"
import { mergeStatusOptions } from "./cycle-ledger.js"
import { ctx } from "./ctx.js"
import { ANY_ANCHOR } from "./defs.js"

/* ---------------------- 「难度及目标」的文字口径 ---------------------- */


export const effectiveOptions = model => {
  const known = compileAliases(ctx.config?.anchor_aliases)
  /** 主播名去重：表头里万一有重名，下拉里也只该出现一个 */
  const anchors = [...new Set(model.anchors.map(a => a.name).map(s => s.trim()).filter(Boolean))]
  const used = []
  for (const r of model.rows) {
    for (const part of String(r.anchor ?? "")
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean)) {
      /** 别名：能归到本榜某位主播就当作那位在用，不单独进列表 */
      const canonical = canonicalAnchor(part, known)
      if (canonical !== part && anchors.includes(canonical)) continue
      if (!anchors.includes(part) && !used.includes(part)) used.push(part)
    }
  }
  const fallback = [...new Set(model.options?.anchor ?? [])]
  const list = [...new Set([...anchors, ...used])]
  const anchor = list.length
    ? (list.includes(ANY_ANCHOR) ? list : [...list, ANY_ANCHOR])
    : [...new Set([...fallback, ANY_ANCHOR])]
  /**
   * 完成情况也下发"净化后的名单"（与写回表时同一份）
   *
   * 这一列的候选口径与写回口径必须一致：直接下发 xlsx 里那份下拉验证原样，
   * 而归档只增不减 ⇒ 早年用过、现在没人用的名字会永久留在页面的下拉里，
   * 看着像"这一榜真有人填过"（例如幽境危战的完成情况里冒出一个该榜没有任何一行填过的名字）。
   * 净化口径见 `mergeStatusOptions`：状态词 ∪ 主播名单 ∪ 表里在用的值。
   */
  const status = model.col?.status ? mergeStatusOptions(model, anchors) : model.options?.status
  /**
   * 「难度及目标」直接下发表里的新写法；旧写法不再接受，也不在保存时归一化。
   */
  const isAttack = /攻炼|绝境/.test(String(model.name ?? ""))
  const goal = isAttack ? undefined : model.options?.goal
  const mode = isAttack ? attackModeNames() : undefined
  const target = isAttack ? [...ATTACK_TARGET_NAMES] : undefined
  /** 页面按版本分组画模式选择器；具体模式列表必须跟随锅巴配置，不能再用前端硬编码 */
  const versionRows = isAttack
    ? attackVersions().map(v => ({
        version: v.version,
        preset: v.preset,
        open_at: v.open_at,
        modes: [...v.modes],
      }))
    : undefined
  return {
    ...(model.options ?? {}),
    anchor,
    ...(status ? { status } : {}),
    ...(goal ? { goal } : {}),
    ...(versionRows ? { attackVersions: versionRows } : {}),
    ...(mode ? { mode } : {}),
    ...(target ? { target } : {}),
  }
}
