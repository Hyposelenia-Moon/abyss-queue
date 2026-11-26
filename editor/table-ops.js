/**
 * 表操作：整榜整理、换表、压紧、删行迁移、改完成情况
 *
 * 全部要落在同一个写临界区里（`table().mutate` / `table().replace`）：读、校验、存底、
 * 提交必须是一次事务，否则两个人同时保存就会互相覆盖（AQ-06）。
 *
 * 服务单例（表 / 状态 / 变更单 / 版本 / 归属）一律经 `ctx` 拿；这里 `ctx` 这个名字
 * 留给 `mutate(async ctx => …)` 的事务形参，服务用 `services` 别名。
 */
import { ATTACK_SHEET } from "../components/attack.js"
import { openWorkbook } from "../model/xlsx.js"
import { lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { remapRowsOf } from "./anchors.js"
import { oneLine } from "./audit.js"
import { ctx as services } from "./ctx.js"
import { extraNamesOf } from "./cycle-ledger.js"
import { FIELDS, MOVE_COLUMN_KEYS, OPEN_RULES, QUEUED_STATUS, REPLACE_REQUIRED_COLUMNS, WAITING_STATUS } from "./defs.js"
import { rebuildOwnership } from "./ownership.js"
import { tidyOrder } from "./reorder.js"
import { defaultStatusOf } from "./status.js"

/**
 * 整理的核心（**所有榜**或指定的那一榜）：按
 * "**已完成 → 等待开启 → 排队中**" 分组，组内按难度/目标/强度排序（口径见 `tidyOrder` / `reorder.js`）
 *
 * 与 `#插队` 同一条理由由编辑器干这件事：插件对表**只读**，动整张表只有拿着表的编辑器做得到。
 * 动作 = **换内容**（与 `#插队` 同一套 `moveCell`）：不插行、不删行、行号一个都不变，
 * A 列序号（`=ROW()-k`）原地不动；归属（绑定与锁）按"哪一行的人去了哪一行"重排（`remapRowsOf`）。
 *
 * **已经是有序的 ⇒ 一个字都不写**：`mutate()` 只在真写了格时才落盘，所以这里提前 return
 * 就等于"没动过"——不产生历史版本、不刷新版本指纹（维护者要求：若当前表格也为此状态则不做改动）。
 *
 * 两个入口共用这一份：每天到点的那一次（`/api/tidy` → `applyTidy`）与**改了完成情况就立刻做**
 * 的那一次（`applySave` 的收尾，见 `afterSaveFollowUp`）。
 *
 * @param {string} wanted 榜名；空串 = 所有榜
 * @param {object} [opts]
 * @param {number} [opts.snapshotThrottleMs] 存历史版本的节流（只给"改完成情况之后立刻整理"那条路用：
 *   那一次紧跟在一次保存之后，而保存已经存过底了，再存一份只会白占版本位；见 `AUTOSAVE_SNAPSHOT_MS`）
 * @returns {Promise<{moved: number, tidied: Array<{sheet: string, moved: number, reason?: string}>}>}
 */
export const tidySheetsCore = async (wanted, { snapshotThrottleMs = 0 } = {}) => {
  const tidied = []
  /** 榜名 → `{老行号: 新行号}`：内容换过位置的行，页面的草稿键按它搬（见 `applySave` 的 `rowMap`） */
  const shiftRows = {}
  let plan = null
  let moved = 0
  await services.store()

  await services.table().mutate(
    async ctx => {
      const names = wanted ? [wanted] : [...ctx.models.keys()]
      /** 先算出每个榜"要不要动、怎么动"；一个都不用动的榜不进 ops（也就不写任何格） */
      const ops = []
      for (const name of names) {
        const model = ctx.model(name)
        const target = tidyOrder(model, {
          tempNames: extraNamesOf(name),
          frontNames: services.queueFrontOf(name),
        })
        if (!target) {
          tidied.push({ sheet: name, moved: 0, reason: "已经是有序的（或没有可排序的行），一个字都没写" })
          continue
        }
        ops.push({ name, model, ...target })
      }
      if (!ops.length) return { moved: 0 }

      /**
       * 写表前留底：历史版本 + 每日/换月归档（只有真的要动表时才留）
       *
       * "改完成情况之后立刻整理"那一次带节流（`snapshotThrottleMs`）：它紧跟在一次保存之后，
       * 而那次保存已经存过底了（自动保存那条路本来就有 5 分钟节流），再存一份只是白占版本位。
       */
      await services.snapshotBeforeWrite(snapshotThrottleMs ? { throttleMs: snapshotThrottleMs } : {})
      for (const op of ops) {
        /** 跟着人走的那几列：与 `#插队` 同一份（`MOVE_COLUMN_KEYS`，A 列序号不在里面） */
        const cols = Object.entries(op.model.col).filter(([key, col]) => col && MOVE_COLUMN_KEYS.includes(key))
        const byRow = new Map(op.model.rows.map(r => [r.row, r]))
        for (let i = 0; i < op.slots.length; i++) {
          const to = op.slots[i]
          const from = op.order[i]
          if (to === from) continue
          for (const [key, col] of cols)
            moveCell(
              ctx,
              op.name,
              key,
              col,
              to,
              String(byRow.get(from)?.[key] ?? ""),
              String(byRow.get(to)?.[key] ?? ""),
              /** 样式随内容一起换（每格带上**来源那一行**的样式号）：不这么做隔行配色会留在原地 */
              ctx.refStyle(op.name, `${col}${from}`),
            )
          op.moved = (op.moved ?? 0) + 1
        }
      }

      const state = await services.ownershipIn(ctx, await services.store())
      let merged = { binds: state.binds, locks: state.locks }
      for (const op of ops) {
        const rowMap = new Map()
        for (let i = 0; i < op.slots.length; i++) if (op.slots[i] !== op.order[i]) rowMap.set(op.order[i], op.slots[i])
        tidied.push({ sheet: op.name, moved: op.moved ?? 0, segments: op.groups })
        moved += op.moved ?? 0
        /** 页面的草稿键要按"哪个人去了哪一行"搬（见 `applySave` 的 `rowMap`）：只记真的换了位置的 */
        shiftRows[op.name] = Object.fromEntries(rowMap)
        merged = remapRowsOf(merged, op.name, r => rowMap.get(r) ?? r)
      }
      plan = merged
      return { moved }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )

  if (moved)
    console.log(
      `[editor] 每日整理：共挪 ${moved} 行（${oneLine(tidied.filter(t => t.moved).map(t => `${t.sheet} ${t.moved}`).join("、"))}）`,
    )
  return { moved, tidied, shiftRows }
}

/**
 * 挪行时写一格：`value` 与这一格现在的值一样就一个字不写（省掉一次无意义的重写）
 *
 * 值是空的来源有两种：对方那一行本来就空、或这一格在对面压根不存在——两者都落成**空值格**
 * （`ctx.clearCell`，保留格与样式）；已经不空的时候才用 `ctx.setCell` 带上样式号写进去。
 * @param {string} key 逻辑列 key（`ctx.setCell` 认它，不认列字母）
 * @param {string} col 列字母（拼格子地址）
 * @param {number} row 行号
 * @param {string} value 要写进去的值（对方那一格的原文）
 * @param {string} current 这一格现在的值
 * @param {string|undefined|null} style 这一格现在的样式号（内容换过来，格式也换过来）
 */
export const moveCell = (ctx, sheet, key, col, row, value, current, style) => {
  const next = String(value ?? "")
  if (next === String(current ?? "")) return
  if (next) ctx.setCell(sheet, row, key, next, style)
  else ctx.clearCell(sheet, `${col}${row}`)
}

/**
 * 开榜时间到了、表里还写着「等待开启」的行：自动翻成「排队中」
 *
 * 剧诗每月 1 号 4 点、深渊每月 16 号 4 点开，到点之后表里不该再留着「等待开启」。
 * 只由管理员打开页面时顺带做（危战没有固定开榜日子，它的「等待开启」是正常值，不动）。
 * @returns {Promise<number>} 改了几行
 */
export const catchUpOpenStatus = async caller => {
  if (caller.role !== "admin") return 0
  let opened = []
  let plan = null
  await services.table().mutate(
    async ctx => {
      opened = [...ctx.models.values()]
        .filter(m => OPEN_RULES.some(r => r.test.test(m.name)) && defaultStatusOf(m.name) === QUEUED_STATUS)
        .flatMap(m =>
          m.rows
            .filter(r => String(r.status ?? "").trim() === WAITING_STATUS)
            .map(r => ({ sheet: m.name, row: r.row, nickname: String(r.nickname ?? "").trim() })),
        )
      if (!opened.length) return { opened: 0 }
      /** 写表前留底：历史版本 + 每日/换月归档 */
      await services.snapshotBeforeWrite()
      for (const o of opened) ctx.setCell(o.sheet, o.row, "status", QUEUED_STATUS)
      const state = await services.ownershipIn(ctx, await services.store())
      /**
       * 翻成「排队中」的那几行**不该再锁着**：顺手把它们的锁删掉
       *
       * 读侧已经有 `lockIsLive` 兜底（过期锁不生效），这里只是别让陈旧记录一直躺在盘上；
       * 正常情况下这几行本来就没有锁（`等待开启` 的行造不出锁），这一步是给"手工改表"留的自愈。
       */
      if (state.locks) for (const o of opened) delete state.locks[lockKey(o.sheet, o.row)]
      plan = { binds: state.binds, locks: state.locks }
      return { opened: opened.length }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
  if (!opened.length) return 0
  console.log(
    `[editor] 开榜时间已到，把 ${opened.length} 行的「${WAITING_STATUS}」改成「${QUEUED_STATUS}」：` +
      oneLine(opened.map(o => `${o.sheet} 第 ${o.row} 行${o.nickname ? `「${o.nickname}」` : ""}`).join("；")),
  )
  return opened.length
}

/**
 * 替换前的结构校验（AQ-07）
 *
 * 名字对得上不代表内容对：空表壳或别的表也会"上传成功"，结果编辑器和机器人都读不出任何数据。
 * 所以逐表确认表头、必要列与建模结果。
 * @throws {Error} 带具体缺失项的中文说明
 */
export const validateReplacement = (after, before) => {
  /**
   * 允许**在当前表末尾新增「绝境攻炼」**（长期模块的第一张表）；其余增删/换序一律拒绝。
   * 不能直接放开成"任意多表"：上传覆盖是主人入口，但结构漂移会让机器人与页面一起读错。
   */
  const kept = before.names.every((name, i) => after.names[i] === name)
  const added = after.names.slice(before.names.length)
  if (!kept || added.some(name => name !== ATTACK_SHEET))
    throw new Error(
      `工作表对不上：文件里是「${after.names.join("、")}」，当前表是「${before.names.join("、")}」，拒绝替换` +
        `（只允许在末尾新增「${ATTACK_SHEET}」）`,
    )
  const unparsed = after.names.filter(n => !after.models.has(n))
  if (unparsed.length) throw new Error(`这些工作表解析不出结构：${unparsed.join("、")}，拒绝替换`)
  const problems = []
  for (const name of after.names) {
    const model = after.models.get(name)
    const missing = REPLACE_REQUIRED_COLUMNS.filter(([key]) => !model.col?.[key]).map(([, label]) => label)
    if (missing.length) problems.push(`「${name}」的表头缺少：${missing.join("、")}`)
  }
  if (problems.length)
    throw new Error(`这份表的结构不完整，拒绝替换（可以是没有成员的空模板，但表头与列必须齐全）：\n${problems.join("\n")}`)
}

/**
 * 用一份字节替换当前表（回退 / 云端上传共用）
 *
 * 表、QQ→行绑定、完成情况锁**必须作为同一次状态转换**处理：
 * 只换 xlsx 的话，旧行号会指到新表里的另一个人，本人一打开页面就把别人的昵称改成自己（AQ-03）。
 * 走 services.table().replace —— 与普通保存同一条队列，读/校验/存底/提交都在一个临界区里（AQ-06）。
 *
 * @param {Buffer} bytes 新的表文件
 * @param {string} label 日志里用的来源说明
 * @param {object} [opts]
 * @param {string} [opts.expect] 调用方读到的那一版指纹；不一致 → 冲突（不覆盖别人的改动）
 * @returns {Promise<{version:string, size:number, fp:string, bindings:object, locks:object}>}
 */
export const replaceTable = async (bytes, label, { expect } = {}) => {
  if (!bytes?.length) throw new Error("内容是空的")
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`文件过大（${Math.round(bytes.length / 1024 / 1024)}MB），拒绝替换`)

  /** 先探一次"这到底是不是 xlsx"：错的是文件类型，不该报成"结构不完整" */
  try {
    const probe = await openWorkbook(bytes)
    if (!probe.sheets?.length) throw new Error("里面没有任何工作表")
  } catch (err) {
    throw new Error(`这份文件不是能读的 xlsx：${err?.message ?? err}`)
  }

  const bindStore = await services.store()
  let snapshot = ""
  let plan = null
  let rebuilt = { bindKept: 0, bindDropped: 0, lockKept: 0, lockDropped: 0 }
  let out
  try {
    out = await services.table().replace(bytes, {
      expect,
      validate: validateReplacement,
      /**
       * 关联状态迁移：绑定与锁按**新表**的群昵称重新对账
       * 昵称在新表里唯一命中 → 跟过去（改名/挪行都认）；命中不了 → 作废，绝不按旧行号认人
       */
      transition: ({ before, after }) => {
        rebuilt = rebuildOwnership(after.models, bindStore.data.binds ?? {}, services.acl.loadLocks().rows ?? {}, before.models)
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return rebuilt
      },
      beforeWrite: async () => {
        snapshot = await services.snapshotBeforeWrite()
      },
      afterCommit: info => services.persistState(info, plan),
    })
  } catch (err) {
    if (err?.conflict) throw err
    /** buildModel 的报错（表头行 / 群昵称列）单看太像内部错误，这里补一句"这是替换被拒的原因" */
    const msg = String(err?.message ?? err)
    if (/找不到表头行|表头缺少/.test(msg)) throw new Error(`这份表结构不完整，拒绝替换：${msg}`)
    throw err
  }

  console.log(
    `[editor] 已用 ${label} 覆盖当前表（${bytes.length} 字节，替换前存了 ${snapshot || "未存版本"}）；` +
      `归属重新对账：绑定保留 ${rebuilt.bindKept}、作废 ${rebuilt.bindDropped}；锁保留 ${rebuilt.lockKept}、作废 ${rebuilt.lockDropped}`,
  )
  return {
    version: snapshot,
    size: bytes.length,
    fp: out.fp,
    bindings: { kept: rebuilt.bindKept, dropped: rebuilt.bindDropped },
    locks: { kept: rebuilt.lockKept, dropped: rebuilt.lockDropped },
  }
}

/**
 * 把某一榜的数据行压紧：删掉 dropRows，其余整体上移，队列不留空洞
 *
 * 序号是按行算的公式（=ROW()-偏移），所以只搬 B–H，尾部多出来的行清空，序号自然还是 1..N。
 *
 * 每行自己的样式（B–H 逐格的 s：填充/边框/条件格式观感）要**跟着这一行一起搬**。
 * 图省事用 ctx.setCell 默认的整列采样样式会把逐行差别抹平——上移后的行就套上了别人那一行的
 * 底色（AQ-15 的延伸：清空同一行保住了行样式，搬行却还在丢），所以这里先按源行读一遍
 * `ctx.rowStyles` 再逐格显式带上。源行没有那一格（null）时保留目标格原有样式：
 * 空行本身没有样式可搬，硬抹掉只会在表里挖出一个白洞。
 * @returns {{removed: number, moved: number}}
 */
export const compactSheet = async (ctx, model, dropRows) => {
  const drop = new Set(dropRows.map(Number))
  if (!drop.size) return { removed: 0, moved: 0 }
  const rows = []
  for (let r = model.dataStart; r <= model.dataEnd; r++) rows.push(r)
  const kept = rows.filter(r => !drop.has(r))
  const valueOf = new Map()
  for (const item of model.rows) valueOf.set(item.row, item)
  const nextRowOf = new Map()
  kept.forEach((oldRow, i) => nextRowOf.set(oldRow, model.dataStart + i))

  for (const oldRow of kept) {
    const target = nextRowOf.get(oldRow)
    const item = valueOf.get(oldRow)
    /** 样式按"搬走之前"那一行读：写入都排在临界区末尾落表，所以读到的还是旧样式 */
    const from = await ctx.rowStyles(model.name, oldRow)
    for (const f of FIELDS) {
      if (!model.col?.[f.key]) continue
      ctx.setCell(model.name, target, f.key, item ? String(item[f.key] ?? "") : "", from[f.key])
    }
  }
  /** 尾部空出来的行只清值、样式保持该位置原本的空行样式（退队删行不该在表尾留下一条花花绿绿的空行） */
  for (let r = model.dataStart + kept.length; r <= model.dataEnd; r++) ctx.clearRow(model.name, r)
  return { removed: drop.size, moved: kept.length }
}

/**
 * 删行 + **绑定 / 锁的迁移**（`reconcileRoster` 的退群删行与"主人确认删候选行"共用这一份）
 *
 * 口径（AQ-03 / AQ-08，两处必须一模一样，所以只留一处实现）：
 *   - **绑定**：QQ 是身份，按 QQ 迁移、压紧之后整体替换；被删掉的那些行解绑；
 *   - **锁**：从不可变旧快照（`lockRows`）生成全新对象、迁移完整体替换，并且**校验归属**——
 *     锁上记的人必须就是被搬走那一行上的人，否则作废（锁错人比不锁更糟，让主播重新填一次）；
 *   - 两件事都只读"这一版表"的模型与旧快照，**不回头改表**（原地读写会撞键、把锁落到错的行上）。
 *
 * @param {object} ctx 临界区上下文（`services.table().mutate` 的回调参数）
 * @param {Map<string, number[]>} drops 榜名 → 要删掉的行号
 * @param {object} binds 绑定对象（**原地改**，调用方随后整体落盘）
 * @param {object} lockRows 锁的旧快照
 * @returns {Promise<{locks: object, removed: number, moved: number}>} 新的锁对象 + 删掉/搬走的行数
 */
export const dropRowsAndMigrate = async (ctx, drops, binds, lockRows) => {
  /** 先把各榜的 drop / 位移算出来：迁移绑定与锁都只读这一份，不再回头改表 */
  const moves = new Map()
  for (const [sheet, rows] of drops) {
    const model = ctx.model(sheet)
    const drop = new Set(rows.map(Number))
    const shift = new Map()
    let kept = 0
    for (let r = model.dataStart; r <= model.dataEnd; r++) {
      if (drop.has(r)) continue
      shift.set(r, model.dataStart + kept)
      kept++
    }
    moves.set(sheet, { model, drop, shift })
  }

  /** 绑定：QQ 是身份，按 QQ 迁移，压紧后整体替换（不会撞键） */
  for (const [sheet, { drop, shift }] of moves) {
    for (const [qq, info] of Object.entries(binds[sheet] ?? {})) {
      const row = Number(info?.row)
      if (!row) continue
      if (drop.has(row)) {
        delete binds[sheet][qq]
        continue
      }
      if (shift.has(row) && shift.get(row) !== row) binds[sheet][qq] = { ...info, row: shift.get(row) }
    }
    if (binds[sheet] && !Object.keys(binds[sheet]).length) delete binds[sheet]
  }

  /** 锁：校验归属之后迁移（见上面第 2 条） */
  const nextLocks = {}
  for (const [key, lock] of Object.entries(lockRows)) {
    const sheet = lockSheetOf(key)
    const row = lockRowOf(key)
    const move = moves.get(sheet)
    if (!move) {
      nextLocks[key] = lock
      continue
    }
    if (move.drop.has(row) || !move.shift.has(row)) continue
    const atRow = String(move.model.rows.find(r => r.row === row)?.nickname ?? "").trim()
    const nick = String(lock?.nickname ?? "").trim() || atRow
    if (nick && atRow && nick !== atRow) continue
    const to = lockKey(sheet, move.shift.get(row))
    if (nextLocks[to]) continue
    nextLocks[to] = { ...lock, ...(nick ? { nickname: nick } : {}) }
  }

  let removed = 0
  let moved = 0
  /**
   * 行号搬家表（榜名 → `{老行号: 新行号}`，只记真的换了位置的）：**页面的草稿键按它搬**
   *
   * 搬行之后"第 N 行"已经换了人，页面上按行号存的草稿（榜 × 行号）若还指着老行号，
   * 下一次自动保存就会拿这个人的值去写那一行现在的人（轻则被红线拒掉、草稿卡住，
   * 重则把别人顶掉）。所以搬家表要跟着回执回到页面（见 `applySave` 的 `rowMap`）。
   */
  const shiftRows = {}
  for (const [sheet, { drop, shift }] of moves)
    for (const [from, to] of shift) if (!drop.has(from) && to !== from) (shiftRows[sheet] ??= {})[from] = to

  for (const [sheet, { model, drop }] of moves) {
    const out = await compactSheet(ctx, model, [...drop])
    removed += out.removed
    moved += out.moved
    console.log(`[editor] 已从「${oneLine(sheet)}」删掉 ${out.removed} 行并压紧（${out.moved} 行上移）`)
  }
  /** 被删掉的行，历史记录里对应的 `current` 标成 0（不再命中任何现存行）；余下的按压紧映射搬 */
  for (const [sheet, { drop }] of moves)
    if (drop.size) services.changes.remap(sheet, Object.fromEntries([...drop].map(r => [r, 0])))
  for (const [sheet, map] of Object.entries(shiftRows)) services.changes.remap(sheet, map)
  return { locks: nextLocks, removed, moved, shiftRows }
}

/**
 * 清空行之后**立刻**压紧：把下面那些行整体提上来，序号列不留空档
 *
 * 现场（维护者截图）：页面上的序号读成 14、15、17。原因是两件事凑在一起——
 *   1. A 列序号是**按行算**的公式 `=ROW()-k`，一行占一个行号，删掉的行不会自己让位；
 *   2. 页面只画"表里还有内容的行"（`model.rows` 不收整行空掉的行，见 `model/schema.js`），
 *      于是空着的那一行从页面上消失，它下面的行号就跳号了。
 * 压紧就是让空档合上：下面的行整体上移一格，A 列一格都不动（序号本来就等于位置）。
 * 动作与"退群删行 / 主人确认删候选行"完全一样，所以共用 `dropRowsAndMigrate`——
 * 绑定与完成情况锁的行号也跟着搬，不会有人被认到别人的行上。
 *
 * **另起一个临界区**（而不是塞进保存那一趟，见 `applySave` 调用处的说明）：
 * 保存那一趟里 `setCell` / `clearRow` 都还只是排队的写入，`compactSheet` 按行读内容时会读到
 * 清空前的旧值，等于把刚删掉的那一行又搬回来。
 *
 * 只压紧**这一刻真的空着、而且下面还有活着的行**的那几行：
 *   - 行号可能已经被别人的保存改过（`model.rows` 里又有内容了）⇒ 跳过，别删到别人的行上；
 *   - 清空的是数据区最后一行 ⇒ 后面没有行要上移，这一趟等于把整张表重写一遍，收益为零。
 *
 * 压紧的是**夹在活人中间的空行**（不是"这一次清掉的那几行"）：压紧是另一个临界区，两次几乎同时的
 * 删除可能这样交错——A 的保存提交、A 的压紧还没跑，B 的删除落地并**先**压紧（把 A 要删的那一行顶上了
 * 别人），A 再压紧时守卫跳过 ⇒ 空档留在表里（2026-10-18 审核观察到的"并发删行后编号空档"）。
 * 反正只有"删过行"才会进这个函数，扫一遍不增加额外开销，还能把漏掉的那次一起合上。
 *
 * **为什么只扫"夹在中间"的**：数据区末尾那一大片空行是"还能填的格子"（页面就是往空行里加人，
 * `pickRowNumber` 找的是第一个空行），把它们一起压紧等于把整张表重写一遍——`dataEnd` 里有近百行空行。
 * 空档在界面上表现为**序号跳号**，而序号 = 位置（A 列公式），所以空档只可能是"中间那一格"。
 * @param {string} sheet 榜名
 * @param {number[]} rows 这一轮被清空的行号（保存那一趟收集的；只用来判断"这趟要不要压紧"）
 * @returns {Promise<{compacted: {removed: number, moved: number}|null}>} `compacted` 为 null = 没写任何格
 */
export const compactClearedRows = async (sheet, rows) => {
  const wanted = (Array.isArray(rows) ? rows : []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (!wanted.length) return { compacted: null }
  const bindStore = await services.store()
  let plan = null
  return services.table().mutate(
    async ctx => {
      const model = ctx.model(sheet)
      /** 还有内容的行号：`model.rows` 不收整行空掉的行，所以"不在这份名单里"= 这一行现在空着 */
      const live = new Set(model.rows.map(r => r.row))
      /** 第一行与最后一行活人之间的空行（末尾那片空闲格不算空档，见函数头） */
      const first = Math.min(...live)
      const last = Math.max(...live)
      const empties = []
      for (let row = Math.max(first, model.dataStart); row < last; row++) if (!live.has(row)) empties.push(row)
      if (!empties.length) return { compacted: null }
      const state = await services.ownershipIn(ctx, bindStore)
      const binds = state.binds
      const migrated = await dropRowsAndMigrate(ctx, new Map([[sheet, empties]]), binds, state.locks)
      plan = { binds, locks: migrated.locks }
      return { compacted: { removed: migrated.removed, moved: migrated.moved }, shift: migrated.shiftRows?.[sheet] ?? {} }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
}

