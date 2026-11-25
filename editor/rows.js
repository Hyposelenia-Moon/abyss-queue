/**
 * 行的校验、差异与冲突判定
 *
 * 这里只处理"一行是什么、改了什么、能不能改"：行号集合、必填项、越权红线、
 * 逐格 diff、写前冲突检查。**不读写文件**——调用方拿到结果自己去落盘。
 *
 * 之所以单独成册：这些规则原来夹在 `editor.mjs` 的写表流程里，改一处要翻过大半张表；
 * 现在写表流程只负责"按计划写"，规则都在这里。
 */
import crypto from "node:crypto"

import { APPEND_ROWS_MAX, EXCLUSIVE_VALUES, FIELDS, PENDING_STATUS, blank } from "./defs.js"
import { attackStatusParts, parseAttackGoal } from "../components/attack.js"
import { matchOption } from "../modules/queue.js"
import { statusTokens } from "./status.js"
import { effectiveOptions } from "./anchors.js"

/** 群昵称比对：忽略首尾空白与大小写（英文昵称常见） */
export const sameNick = (a, b) => {
  const x = String(a ?? "").trim()
  const y = String(b ?? "").trim()
  return Boolean(x) && Boolean(y) && x.toLowerCase() === y.toLowerCase()
}

export const validateRows = (model, rows) => {
  const problems = []
  const seen = new Map()
  const options = effectiveOptions(model)
  /** 表里出现过的群昵称：点「本人已完成」会把它写进完成情况，所以这种值要认 */
  const nicknames = new Set(model.rows.map(r => String(r.nickname ?? "").trim()).filter(Boolean))
  const touched = new Set(rows.map(r => Number(r?.row)).filter(Boolean))
  for (const r of model.rows) {
    if (touched.has(r.row)) continue
    if (!blank(r.nickname)) seen.set(String(r.nickname).trim(), r.row)
  }

  for (const r of rows) {
    const v = r?.values ?? {}
    const who = blank(v.nickname) ? `第 ${r.row} 行` : `「${String(v.nickname).trim()}」`
    /* 整行清空 = 删除，允许 */
    if (FIELDS.every(f => blank(v[f.key]))) continue
    /** 表里已有的那一行：值没动就不校验（表里的旧值可能已经不在主播列表里了，不该逼着人改） */
    const before = model.rows.find(x => x.row === Number(r.row))

    for (const f of FIELDS.filter(x => x.required))
      if (blank(v[f.key])) problems.push(`${who}：${f.label}不能为空`)

    const nick = String(v.nickname ?? "").trim()
    if (nick) {
      if (seen.has(nick)) problems.push(`${who}：昵称与表格第 ${seen.get(nick)} 行重复`)
      seen.set(nick, r.row)
    }

    for (const f of FIELDS.filter(x => x.option)) {
      const val = String(v[f.key] ?? "").trim()
      if (!val) continue
      if (before && String(before[f.key] ?? "").trim() === val) continue
      /** 绝境攻炼的完成情况是 `7.2完成人 7.3等待开启` 复合值，不按普通下拉逐项比对 */
      if (/攻炼|绝境/.test(String(model.name ?? "")) && f.key === "status" && attackStatusParts(val)) continue
      /** 绝境攻炼的 E 是「模式多选 + 目标单选」组合值，不走普通下拉逐项比对 */
      if (/攻炼|绝境/.test(String(model.name ?? "")) && f.key === "goal") {
        if (!parseAttackGoal(val)) problems.push(`${who}：${f.label}格式不对（模式用、分隔，目标用｜）`)
        continue
      }
      if (/攻炼|绝境/.test(String(model.name ?? "")) && f.key === "status") {
        const compound = attackStatusParts(val)
        if (compound) {
          const allowed = new Set([...(options.status ?? []), ...nicknames, nick, before?.nickname])
          for (const part of compound) {
            if (part.kind !== "done" || allowed.has(part.label)) continue
            const people = part.label.split("/").map(s => s.trim()).filter(Boolean)
            if (!people.length || people.some(person => !allowed.has(person)))
              problems.push(`${who}：帮帮完成情况「${part.label}」不在下拉选项里`)
          }
          continue
        }
      }
      const opts = options[f.option] ?? []
      if (!opts.length) continue
      /**
       * 完成人昵称本身可能含逗号（如「孩子们，记得多存档$」）。
       * 先按**完整值**认一次，不能被多值分隔符拆成两个不存在的选项。
       */
      if (f.key === "status" && (nicknames.has(val) || sameNick(val, before?.nickname))) continue
      /** 完成情况允许多个值（"阿修Axiu,听雨"），逐个比对 */
      const parts = f.multi ? val.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [val]
      for (const part of parts) {
        if (opts.includes(part) || matchOption(part, opts)) continue
        /** 认得出的别名（如「阿修」→ 阿修Axiu）也算命中 */
        if (f.key === "anchor" && opts.includes(canonicalAnchor(part, compileAliases(config.anchor_aliases)))) continue
        /** 完成人可以直接是某位群友的群昵称（点「本人已完成」就是这么落表的） */
        if (f.key === "status" && (nicknames.has(part) || sameNick(part, before?.nickname))) continue
        /**
         * 这一格里**本来就有的值**一律放行：完成情况的候选只认「状态词 ∪ 主播区 ∪ 手动收录」
         * （见 `mergeStatusOptions`），而老数据里存着当年点「本人已完成」落下的群昵称——
         * 它们不该因为"不在候选里"而卡住这一行的其它字段（改个备注就被整行拒掉）。
         * 页面把这一格的现值并进候选，所以用户点得到；服务端在这里只做"值没变就照旧"的兜底。
         */
        if (f.key === "status" && statusTokens(before?.status).includes(part)) continue
        problems.push(`${who}：${f.label}「${part}」不在下拉选项里`)
      }
      /** 独占值（如「公共队列」）不能和别的并选 */
      if (parts.length > 1) {
        const exclusive = parts.filter(p => EXCLUSIVE_VALUES.includes(p))
        if (exclusive.length)
          problems.push(`${who}：${f.label}「${exclusive[0]}」不能和别的选项一起选（它是独占的，single choice）`)
      }
      /** 完成情况：「等待开启 / 排队中」与「某完成人」互斥；这两个状态之间也只能留一个 */
      if (f.key === "status" && parts.length > 1) {
        const pending = parts.filter(p => PENDING_STATUS.includes(p))
        const done = parts.filter(p => !PENDING_STATUS.includes(p) && !EXCLUSIVE_VALUES.includes(p))
        if (pending.length && done.length)
          problems.push(`${who}：${f.label}「${pending[0]}」不能和完成人一起选（两者互斥）`)
        else if (pending.length > 1) problems.push(`${who}：${f.label}「${PENDING_STATUS.join("」「")}」只能选一个`)
      }
    }
  }
  return problems
}

/**
 * 把请求里的 `row` 收成干净的整数行号（**必须在任何角色分支之前**调用）
 *
 * 单独拎出来是为了让"格式不对"和"越界"两种拒绝都说清楚：下面 `assertMemberRows` 拿到的是
 * 已经确认是安全整数的行号，它只需要比区间。
 * @returns {number[]} 与入参一一对应的行号
 */
export const rowNumbersOf = rows =>
  rows.map((r, i) => {
    const raw = r?.row
    /** 不用 `Number(raw) || 0`：那会把 `null` / 空串 / `"abc"` 全变成 0，坏输入被静默吞掉 */
    const row = typeof raw === "number" ? raw : Number(String(raw ?? "").trim())
    if (!Number.isSafeInteger(row)) throw new Error(`第 ${i + 1} 项的行号不是整数：${JSON.stringify(raw ?? null)}`)
    return row
  })

/**
 * 成员保存的**业务行范围检查**
 *
 * 允许两种行号：
 *   - 数据区内：`dataStart`（表头下一行）到 `dataEnd`（表里最后一个有数据的行）；
 *   - 合法追加：`dataEnd` 之后 `APPEND_ROWS_MAX` 行以内（页面就是在末尾顺延找空行的）。
 * 表头行、主播区行、以及更远的行号一律拒绝。
 *
 * **越界要在建对象、算权限、开写表队列之前就拒掉**：这样工作簿、绑定、锁与版本都不会被碰，
 * 也不会因为"先算了一遍归属"而留下痕迹。
 * @param {object} model 这一版表的模型（`ctx.model(sheet)`）
 * @param {number[]} rowNums `rowNumbersOf` 的结果
 */
export const assertMemberRows = (model, rowNums) => {
  if (!rowNums.length) return
  const { dataStart, dataEnd, headerRow } = model
  /** 数据区上沿：表头以下才是成员数据。`dataEnd` 可能小于 `dataStart`（表里一行都没有） */
  const min = Math.min(dataStart, dataEnd + 1)
  /** 业务上界：数据区末尾之后留一段追加余量，再往后就不是"给成员加行"了 */
  const max = Math.max(dataEnd, min - 1) + APPEND_ROWS_MAX
  for (const row of rowNums) {
    if (row < min || row > max)
      throw new Error(
        `第 ${row} 行不是成员数据行：表头在第 ${headerRow} 行、成员数据从第 ${min} 行起（空行可以直接在末尾追加新行，` +
          `但最多到第 ${max} 行）。表头上方的主播区与表头都只能用对应的接口改`,
      )
  }
}

/* ------------------------- 本群守卫 / 越界红线 / 额度 ------------------------- */

/**
 * 越界红线：**不计数、直接拒**，并且**每次都私聊告警主人**
 *
 * 三条里这一版落两条（第三条见下）：
 *   1. **清空别人的行**——等于把那个人踢出队列，不可逆，没有任何正常协作需要它；
 *   2. **改别人那一行的群昵称**——群昵称是"这一行是谁"的依据（绑定 / @ 都靠它），
 *      改它等于把别人顶掉；
 *   3. 改被主播锁定的完成情况——**不在这里拒**：现在的口径是"忽略这一格、其余照写 + 回执说明"
 *      （见下面那段），它既保住了主播的填写、又不让用户白填一整行，比整单拒绝更合适。
 *
 * 群外人想写表**不算红线**（只记审计与日志）：那多半是有人点了转发链试了一下，
 * 每次都给主人发一条私聊只会把人烦到关掉告警。
 */
export const redLine = (text, ownerNote) => {
  const err = new Error(`这条改动被拒绝了：${text}。${ownerNote}这次一个字都没写进表里。`)
  err.refused = true
  return err
}

/* ------------------------- 改动记录（留痕） ------------------------- */

/**
 * 这条记录算谁的
 *
 * 身份 QQ 优先；只拿管理口令进来的人记成 `(管理口令)`（与 `editor/audit.js` 的 `whoOf` 同一口径）。
 */
export const changeAuthor = caller => ({
  qq: String(caller?.identity?.qq ?? "") || (caller?.adminTokenOk ? "(管理口令)" : ""),
  nick: String(caller?.identity?.nick ?? ""),
})

/**
 * 这一轮提交里**真正变了的行与字段**（按实际差异算，不信客户端）
 *
 * 为什么按差异算：页面自动保存提交的是**整行**（只发改动那一格会把别的字段当空串写回去），
 * 所以"提交了几行"不等于"改了几行"。判据只看 `FIELDS` 那 7 列，原值与新值都 `trim` 后比
 * （与写表时的空值判定同一套）。
 *
 * @returns {Array<{row:number, changes:Record<string,[string,string]>}>}
 */
export const diffRows = (model, normalized) => {
  const out = []
  for (const r of normalized) {
    if (!r.row) continue
    const before = model.rows.find(x => x.row === r.row)
    const edited = {}
    for (const f of FIELDS) {
      const from = String(before?.[f.key] ?? "").trim()
      const to = String(r.values[f.key] ?? "").trim()
      if (from !== to) edited[f.key] = [from, to]
    }
    if (Object.keys(edited).length) out.push({ row: Number(r.row), changes: edited })
  }
  return out
}

/** 一条 `edit` 记录（`changes` 是 `{字段: [原值, 新值]}`） */

export const editRecord = (caller, sheet, row, changed, { via = "", version = "", snapshot = "", at = Date.now() } = {}) => ({
  kind: "edit",
  at,
  sheet,
  row,
  via,
  changes: changed,
  version,
  snapshot,
  ...changeAuthor(caller),
})

/** 记一批记录：**永远不抛**（写表已经成功，留痕失败只记一行日志，见 `editor/changes.js`） */

/* ------------------------- 行指纹（乐观并发的判据） ------------------------- */

/**
 * 一行值的指纹：**只由 `FIELDS` 那 7 列决定**（逐列 `trim` 后按列序拼起来取 sha1 前 16 位）
 *
 * 用途：`/api/data` 把它随每一行下发，页面把它当**不透明凭据**原样带回来（保存时的 `base`），
 * 服务端据此判断"我记的这一行，在我改它之前有没有被别人动过"。
 *
 * **口径只有这一处**：页面自己不计算、不解释它（两边各算一份，字段顺序或 trim 口径一漂就永远对不上）。
 * 指纹算的是**表里那一行的原值**，不是下发时改造过的值——下发那条路的 `status` 会被
 * `statusWithSelfDone` 换成群昵称，而保存时手上拿到的是原值，两者必须同一个来源。
 */
export const rowFingerprint = row =>
  crypto
    .createHash("sha1")
    .update(FIELDS.map(f => String(row?.[f.key] ?? "").trim()).join("\u0001"))
    .digest("hex")
    .slice(0, 16)

/**
 * 行级冲突（422/409 那一侧）：**只报哪几行，不写一个字** *
 * 与整表指纹冲突（`VersionConflict`）是两码事：那个是"整张表被换过了"，这个是"你改的这几行
 * 在你编辑期间被人动过"。页面拿 `conflictRows` 把那几行标出来，其余行照旧能保存。
 */
export const rowConflict = rows => {
  const err = new Error(
    `第 ${rows.join("、")} 行在你编辑期间被别人改过：你这次的改动一个字都没写进去。` +
      `草稿还在，请点「读取最新并对比」核对后再改。`,
  )
  err.conflict = true
  err.conflictRows = rows
  return err
}

/** 主播区里第一个能放主播的行（第 1 行是表格标题、第 2 行是「主播列表」小表头，见 model/schema.js） */

/**
 * 两次搬行合起来：`first`（压紧）之后再走 `second`（整理），得到"老行号 → 最终行号"
 *
 * 页面的草稿键只认最终行号，所以两次搬动的结果要合成一份再回执（见 `dropRowsAndMigrate` 的
 * `shiftRows` 与 `tidySheetsCore` 的 `rowMap`）。
 * @param {Record<string, number>} [first] 第一趟：老行号 → 中间行号
 * @param {Record<string, number>} [second] 第二趟：中间行号 → 最终行号
 * @returns {Record<string, number>} 只含真的换过位置的行
 */
export const composeRowMap = (first, second) => {
  const out = {}
  const keys = new Set([...Object.keys(first ?? {}), ...Object.keys(second ?? {})].map(Number))
  for (const row of keys) {
    const mid = Number(first?.[row] ?? row)
    const to = Number(second?.[mid] ?? mid)
    if (to !== row) out[row] = to
  }
  return out
}
