/**
 * 「主播=公共队列，完成情况恰好只有一位主播」时，把公共选择收窄到这个人。
 *
 * 这里只做纯判断，不碰表：
 *   - `labels` 已经是拆好的完成人（枪战复合状态由调用方用 statusLabels 拆）；
 *   - 固定状态词（排队中 / 等待开启 / 本人已完成）不是主播；
 *   - 有且只有一个名字、该名字是本榜主播、且不是这一行群昵称时，返回该名字；
 *   - 其余情况一律返回空串，调用方保持「公共队列」不变。
 */
const FIXED_STATUS = new Set(["排队中", "等待开启", "本人已完成"])

/**
 * 按完成人决定「选择主播」应该填什么：
 *   - 完成人里没有任何本榜主播 ⇒ `none`，保持原选择；
 *   - 全部都是本榜主播 ⇒ `anchors`，把这些主播都填上；
 *   - 混有本人/特殊人 ⇒ `public`，改成「公共队列」。
 *
 * 本人按「特殊人」处理：即使群昵称碰巧等于某个主播名，也不当成主播完成。
 */
export const autoAnchorOfStatus = (labels, nickname, anchors) => {
  const self = String(nickname ?? "").trim()
  const known = (anchors ?? []).map(anchor => String(anchor?.name ?? "").trim()).filter(Boolean)
  const anchorSet = new Set(known)
  const unique = [
    ...new Set(
      (Array.isArray(labels) ? labels : [])
        .map(label => String(label ?? "").trim())
        .filter(label => label && !FIXED_STATUS.has(label)),
    ),
  ]
  const picked = known.filter(name => name !== self && unique.includes(name))
  if (!picked.length) return { mode: "none", anchors: [] }
  const mixed = unique.some(label => label === self || !anchorSet.has(label))
  return mixed ? { mode: "public", anchors: [] } : { mode: "anchors", anchors: picked }
}

export const singleAnchorOfStatus = (labels, nickname, anchors) => {
  const self = String(nickname ?? "").trim()
  const unique = [
    ...new Set(
      (Array.isArray(labels) ? labels : [])
        .map(label => String(label ?? "").trim())
        .filter(label => label && !FIXED_STATUS.has(label)),
    ),
  ]
  if (unique.length !== 1) return ""
  const name = unique[0]
  if (name === self) return ""
  if (!(anchors ?? []).some(anchor => String(anchor?.name ?? "").trim() === name)) return ""
  return name
}
