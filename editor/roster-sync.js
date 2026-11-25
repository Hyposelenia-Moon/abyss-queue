/**
 * 群名单对账：改群名片 → 同步表里的群昵称；退群 / 被移出 → 删行并压紧；缺人提醒
 *
 * 从装配根搬出来（原来在 `editor/editor.mjs` 里，与 HTTP 装配混在一起）。
 * 表、绑定、名单、版本、额度这些服务单例一律从 `ctx` 取（装配根写、这里只读）；
 * 整理的核心 `tidySheetsCore` 还在装配根里，同样经 `ctx` 调用，避免 import 成环。
 */
import { oneLine } from "./audit.js"
import { ctx } from "./ctx.js"
import { AUTOSAVE_SNAPSHOT_MS } from "./versions.js"
import { bindSet, bindView, renameLock } from "./ownership.js"
import { statusRenamePlan } from "./status.js"

/** 名单是否还在信任期内（原装配根的解构别名 `trusted: rosterTrusted`） */
const rosterTrusted = () => ctx.roster.trusted()

/**
 * 按名单对账：改了群名片 → 同步表里该 QQ 那行的群昵称；退群/被移出 → 删掉那一行并压紧
 *
 * 删行前会自动存历史版本（同一临界区里做），所以退群删错能回退。
 *
 * 绑定与锁的迁移**只从不可变旧快照读、写进全新对象、最后整体替换**（AQ-08）：
 * 原地读旧键 / 写新键 / 删旧键时，新键可能正好是还没迁移的另一条锁，
 * 结果一条被覆盖、另一条落在错的行上——被锁住的人变成了别人。
 *
 * **留痕**：改名与退群删行都要记（`editor/ctx.changes.js`）——"我那行怎么没了"必须有据可查。
 * 这两类记录的 `qq` / `nick` 记的是**那一行的人**（不是机器人），`via` 标成 `"群名单同步"`，
 * 于是本人能在页面「改动记录」里看到"我的行被改名 / 被删了"。
 * @returns {Promise<{renamed:number, removed:number}>}
 */
export const reconcileRoster = async (members, { drop = true, sheet = "" } = {}) => {
  const only = String(sheet ?? "").trim()
  const byQq = new Map()
  for (const m of members) {
    const qq = String(m?.qq ?? "").trim()
    if (qq) byQq.set(qq, String(m?.nick ?? "").trim())
  }
  const bindStore = await ctx.store()
  const renamed = []
  /** 名单里**没有这个 QQ** 的行：默认退群删行；`drop: false`（改完成情况时那次立刻检测）只报不删 */
  const absent = []
  for (const [sheetName, list] of Object.entries(bindStore.data.binds ?? {})) {
    if (only && sheetName !== only) continue
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      if (!row) continue
      if (!byQq.has(String(qq))) {
        absent.push({ sheet: sheetName, row, qq })
        continue
      }
      const nick = byQq.get(String(qq))
      const old = String(info?.nickname ?? "").trim()
      if (nick && nick !== old) renamed.push({ sheet: sheetName, row, qq, from: old, nick })
    }
  }
  const gone = drop ? absent : []
  /**
   * 什么都不用写就提前返回（`renamed` 与 `gone` 都空）：
   * **只检测不删**那一路很常见（表里有几个退群候选一直没人管），不能因此每次都写一遍表。
   */
  if (!renamed.length && !gone.length) return { renamed: 0, removed: 0, renamedRows: renamed, missing: drop ? [] : absent }

  let removedRows = 0
  /** 这一次对账要落进改动记录的条目（改名 + 退群删行），写表成功后由 `afterCommit` 落盘 */
  const rosterRecords = []

  /**
   * **1) 退群删行 + 压紧（先做）**：搬行会改掉下面每一行的行号，改名必须写在**搬完之后**那一行上
   *
   * 为什么必须分两趟、且删行在前（2026-10 实测抓到的既有缺陷）：压紧是把"留下来的每一行内容整体
   * 重写一遍"（`compactSheet` 拿的是**本临界区开头那一版表**的值），所以"先写改名、再压紧"时，
   * 刚写进去的新名片会被同一格上的**旧值**盖掉；表写前的自检（`model/table.js` 的 `#verify`）
   * 发现"这一格期望「新名」实际「旧名」"就放弃**整趟**写入——机器人推名单整个失败、
   * 当天名单同步上不去（编辑器退回老口径 + 24 小时提醒主人），而群里只看得到"名单好像没更新"。
   * 拆成两趟之后，每一趟都在一版**稳定**的表上读改写，两笔写谁也不碰谁。
   */
  let shiftRows = null
  if (gone.length) {
    let plan = null
    await ctx.table().mutate(
      async ctx => {
        const snapshot = await ctx.snapshotBeforeWrite()
        const state = await ctx.ownershipIn(ctx, bindStore)
        const binds = state.binds
        /** 按榜分组：留痕要记"删掉的是谁"，昵称必须在**压紧之前**从这一版表里取，压完就查不到了 */
        const bySheet = new Map()
        for (const g of gone) {
          if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, [])
          bySheet.get(g.sheet).push(g.row)
          g.nick = String(ctx.model(g.sheet).rows.find(r => r.row === Number(g.row))?.nickname ?? "").trim()
        }
        /** 删行 + 绑定/锁迁移 + 压紧：与"主人确认删候选行"共用同一份实现 */
        const migrated = await ctx.dropRowsAndMigrate(ctx, bySheet, binds, state.locks)
        removedRows += migrated.removed
        shiftRows = migrated.shiftRows
        /**
         * 留痕：退群删行一条一行地记
         *
         * `qq` 记的是**被删那一行的人**（不是机器人）、`via` 标成 `"群名单同步"`——
         * 于是本人能在「改动记录」里看到"我的行被删了"，而不是只看到"机器人改了表"。
         * 行号记的是**删之前**那个行号：压紧之后同一行号已经是别人了。
         */
        for (const g of gone) {
          rosterRecords.push({
            kind: "remove",
            at: Date.now(),
            qq: String(g.qq ?? ""),
            nick: String(g.nick ?? ""),
            sheet: g.sheet,
            row: Number(g.row),
            via: "群名单同步",
            reason: "退群 / 被移出群",
            snapshot,
          })
        }
        plan = { binds, locks: migrated.locks }
        return { removed: removedRows }
      },
      {
        afterCommit: async info => {
          await ctx.persistState(info, plan)
          ctx.recordChanges(rosterRecords.map(r => ({ ...r, version: info.fp })))
        },
      },
    )
  }

  /**
   * **2) 改名**：表已经压紧过了，这里读到的行号就是最终的
   *
   * 被删掉的那些人当然不再改名（他们的行已经没了）；被压紧搬过的按搬家表换算到新行号
   * （名字跟着人走，与 `compactSheet` 搬内容同一口径）。
   */
  const renamedNow = []
  for (const r of renamed) {
    const dropped = gone.some(g => g.sheet === r.sheet && Number(g.row) === Number(r.row))
    if (dropped) continue
    const to = Number(shiftRows?.[r.sheet]?.[r.row] ?? r.row)
    renamedNow.push({ ...r, row: to })
  }

  if (renamedNow.length) {
    let plan = null
    await ctx.table().mutate(
      async ctx => {
        /**
         * 存底：删行那一趟刚存过（同一趟推送的两个动作），这里按自动保存的节流走——
         * 紧凑着存两份历史版本只会白占版本位，而"回到删行之前"那一份已经覆盖了改名的回退。
         */
        const snapshot = await ctx.snapshotBeforeWrite(gone.length ? { throttleMs: AUTOSAVE_SNAPSHOT_MS } : {})
        const state = await ctx.ownershipIn(ctx, bindStore)
        const binds = state.binds
        const lockRows = state.locks

        /**
         * 改名：直接改那一行的群昵称；绑定与锁上记的昵称一起换（否则归属就"对不上"了）
         *
         * 「帮帮完成情况」里记着他旧昵称的 token 一并跟着换（口径见 `statusRenamePlan`）：
         * 先按改之前的表算，再写昵称——写完这一行就不叫旧昵称了，唯一性判定会落空。
         * 同一次同步里改多行时，逐条叠加（`statusOf` 让后面几条看得到前面几条的结果）。
         */
        const statusWritten = new Map()
        for (const r of renamedNow) {
          const model = ctx.model(r.sheet)
          const plan = statusRenamePlan(model, {
            row: r.row,
            from: r.from,
            to: r.nick,
            qq: r.qq,
            binds: bindView(binds),
            statusOf: row => (statusWritten.has(row.row) ? statusWritten.get(row.row) : row.status),
          })
          for (const c of plan.changes) {
            statusWritten.set(c.row, c.status)
            if (model.col?.status) ctx.setCell(r.sheet, c.row, "status", c.status)
          }
          if (plan.skipped) console.log(`[editor] 群名单同步改名：${oneLine(plan.skipped)}`)
          if (model.col?.nickname) ctx.setCell(r.sheet, r.row, "nickname", r.nick)
          /** 留痕：这一行是被**谁**改成什么的（`qq` 记的是那一行的人，`via` 说明来自名单同步） */
          rosterRecords.push({
            kind: "edit",
            at: Date.now(),
            qq: String(r.qq ?? ""),
            nick: String(r.nick ?? ""),
            sheet: r.sheet,
            row: Number(r.row),
            via: "群名单同步",
            changes: { nickname: [String(r.from ?? "").trim(), String(r.nick ?? "").trim()] },
            snapshot,
          })
          bindSet(binds, r.sheet, r.qq, { row: r.row, nickname: r.nick })
          renameLock(lockRows, r.sheet, r.row, r.nick)
        }

        plan = { binds, locks: lockRows }
        return { renamed: renamedNow.length }
      },
      {
        afterCommit: async info => {
          await ctx.persistState(info, plan)
          ctx.recordChanges(rosterRecords.map(r => ({ ...r, version: info.fp })))
        },
      },
    )
  }

  if (renamedNow.length)
    console.log(
      `[editor] 按群名单同步群昵称：` +
        oneLine(renamedNow.map(r => `${r.sheet} 第 ${r.row} 行「${r.from}」→「${r.nick}」`).join("；")),
    )
  return { renamed: renamedNow.length, removed: removedRows, renamedRows: renamedNow, missing: drop ? [] : absent }
}

/**
 * **退群候选行**：表里有这一行、但**既没有有效绑定、群名单里也找不到这个人**
 *
 * 为什么需要人工确认、不自动删（口径见 `editor/README.md` 的「退群与整理」）：
 * 群名单里的昵称与表里那一格是**两份人工维护的文本**，改名 / 带后缀 / 表里手填都会让它们对不上；
 * 自动按昵称删行会误删活人。所以这里只**列候选**，删不删由主人按着名单点一下。
 *
 * 只在**群名单可信**（收到过、非空、48 小时内）时才算——名单不可信时"找不到人"毫无信息量。
 */
export const missingCandidates = async () => {
  const roster = ctx.roster.loadRoster()
  if (!rosterTrusted())
    return {
      supported: false,
      reason:
        (roster.updatedAt ? "群名单超过 48 小时没更新" : "群名单还没同步过") +
        "：按昵称判断「退群」不可靠，先发一次「#排队同步名单」再来看",
      rows: [],
    }
  const memberNicks = new Set((roster.members ?? []).map(m => String(m?.nick ?? "").trim()).filter(Boolean))
  const bindStore = await ctx.store()
  const binds = bindStore.data.binds ?? {}
  const rows = await ctx.table().read(({ models }) => {
    const out = []
    for (const model of models.values()) {
      /** 有**有效绑定**的行（绑定记的昵称与表里现在一致）：这些行归 QQ，不按昵称判退群 */
      const bound = new Set()
      for (const info of Object.values(binds[model.name] ?? {})) {
        const at = Number(info?.row) || 0
        const row = model.rows.find(r => r.row === at)
        if (at && row && String(info?.nickname ?? "").trim() === String(row.nickname ?? "").trim()) bound.add(at)
      }
      for (const r of model.rows) {
        const nick = String(r.nickname ?? "").trim()
        if (!nick || bound.has(r.row) || memberNicks.has(nick)) continue
        /**
         * `seq` = 给人看的那个编号（A 列序号 `=ROW()-k`；拿不到就按数据区第几行算）
         *
         * 三个榜的表头行号不一样，同一个位置的行号也就各不相同（现场：同一个人显示成
         * 「剧诗 第 9 行」「危战 第 15 行」「螺旋 第 9 行」），主人对着表和页面根本对不上号。
         * `row` 照发——删行要对准表格那一行；页面上显示的是 `seq`。
         */
        const seqText = String(r.seq ?? "").trim()
        out.push({
          sheet: model.name,
          row: r.row,
          seq: seqText ? Number(seqText) || 0 : r.row - model.dataStart + 1,
          nickname: nick,
          gameName: String(r.gameName ?? "").trim(),
          status: String(r.status ?? "").trim(),
        })
      }
    }
    return out
  })
  return { supported: true, reason: "", rows }
}

/**
 * **立刻做一次昵称检测**（"改了完成情况"那一次的附加动作，见 `afterSaveFollowUp`）
 *
 * 与每天那一趟（机器人推名单 → `/api/roster` → `reconcileRoster`）**同一套判据、同一份实现**，
 * 只有一处不同：**不删行**。原因就是"每日检测兜底"这条口径——立刻这一次只做**不可逆性为零**的事：
 *   - 表里某行的群昵称与它那个 QQ 在名单里的名片对不上（改名了）⇒ 按名单同步这一行（含完成情况里的旧名）；
 *   - 名单里找不到这个人（退群 / 被移出）⇒ **只列进退群候选行**并提醒主人，删不删由主人点（与页面
 *     「归属」面板那份名单同一个来源 `missingCandidates()`，所以"提醒里说的"与"页面上看到的"一致）。
 *
 * 名单不可信（还没同步过 / 空 / 超 48 小时）⇒ 什么都不做，只回一句原因：那时"找不到人"毫无信息量。
 *
 * @param {string} sheet 只检测这一榜（保存发生在哪个榜就查哪个榜）
 * @returns {Promise<{skipped: string, renamed: Array<{sheet: string, row: number, from: string, nick: string}>, missing: Array<{sheet: string, row: number, nickname: string}>}>}
 */
export const nicknameCheckNow = async sheet => {
  const roster = ctx.roster.loadRoster()
  if (!rosterTrusted())
    return { skipped: (roster.updatedAt ? "群名单超过 48 小时没更新" : "群名单还没同步过") + "（昵称检测跳过）", renamed: [], missing: [] }
  const synced = await reconcileRoster(roster.members ?? [], { drop: false, sheet })
  const candidates = await missingCandidates()
  /** 行号 → { 群昵称, 序号 }（读的是**改名同步之后**那一版表）：提醒里要写清"哪一行是谁" */
  const nicks = await ctx.table().read(({ models }) => {
    const model = models.get(sheet)
    return Object.fromEntries(
      (model?.rows ?? []).map(r => {
        const seqText = String(r.seq ?? "").trim()
        return [
          r.row,
          {
            nickname: String(r.nickname ?? "").trim(),
            seq: seqText ? Number(seqText) || 0 : r.row - Number(model.dataStart ?? 0) + 1,
          },
        ]
      }),
    )
  })
  /** 两类"名单里找不到这个人"合起来，按行去重：① 有绑定但那 QQ 不在了 ② 没绑定、按昵称也对不上 */
  const found = new Map()
  for (const r of synced.missing ?? [])
    if (!found.has(r.row))
      found.set(r.row, { sheet, row: r.row, seq: nicks[r.row]?.seq ?? 0, nickname: nicks[r.row]?.nickname ?? "", why: "名单里没有这个 QQ" })
  for (const r of candidates.rows)
    if (r.sheet === sheet && !found.has(r.row))
      found.set(r.row, { sheet, row: r.row, seq: r.seq ?? 0, nickname: r.nickname, why: "按群昵称在名单里找不到人" })
  return { skipped: "", renamed: synced.renamedRows ?? [], missing: [...found.values()] }
}

/**
 * 上一回"立刻检测"报过的退群候选（签名）：**没变就不再打扰主人**
 *
 * 名单里的候选常常几天没人管（主人还没确认），而"改完成情况"一天会发生很多次——
 * 每 5 分钟合并一条也还是吵。只在"候选集合真的变了"（多出一个人、或有人被处理掉）时才说一次。
 * 只在进程内存里记：重启后重新说一次是可接受的（那时主人多半也要重新看一眼）。
 */
let lastMissingSig = ""

/**
 * 保存之后的收尾：**改了完成情况 ⇒ 立刻生效**；每天那一趟（`ctx.roster.at`）照旧兜底
 *
 * 三件事，按"先改名、再排序"排：
 *   1. **昵称检测**（`nicknameCheckNow`）：改名同步、退群只报不删；
 *   2. **立刻整理**（`tidySheetsCore`）：按「已完成 → 等待开启 → 排队中」、
 *      组内难度/目标/强度排好——不必等到第二天早上；已经有序就一个字都不写；
 *   3. 回执里带上做了什么（页面据此提示"下面的行动了 / 名字被同步了"）。
 *
 * **只在"这一榜的完成情况真的变了"时做**（`statusChanged` 由调用方算）：改个备注也重排一遍，
 * 会让人正敲着的表在眼皮底下跳动、还每次都多写一版表。
 *
 * 整理用**存底节流**：它紧跟在那一次保存之后，保存已经存过底了（见 `tidySheetsCore` 的说明）。
 *
 * @param {{role: string, identity?: object}} caller 调用者（告警里要写"谁触发的"）
 * @param {string} sheet 榜名
 * @param {boolean} statusChanged 这一轮这一榜的「帮帮完成情况」是不是真的变了
 * @param {boolean} sortChanged 攻炼这一轮的目标/强度是不是变了
 * @returns {Promise<{nickSync: object, tidied?: number}|null>} 没触发时是 null
 */
export const afterSaveFollowUp = async (caller, sheet, statusChanged, sortChanged = false) => {
  if (!statusChanged && !sortChanged) return null
  const nick = statusChanged
    ? await nicknameCheckNow(sheet)
    : { skipped: "", renamed: [], missing: [] }
  if (nick.skipped) console.log(`[editor] 改完成情况后的昵称检测跳过：${oneLine(nick.skipped)}`)
  if (nick.missing.length) {
    const sig = nick.missing.map(r => `${r.sheet}#${r.row}#${r.nickname}`).sort().join("|")
    if (sig !== lastMissingSig) {
      lastMissingSig = sig
      ctx.alertOwner(caller, {
        kind: "missing",
        text:
          `「${sheet}」有 ${nick.missing.length} 行在群名单里找不到人（可能退群了）：` +
          /** 报的是**序号**（页面上第一列那个数），不是表格行号——两个数不一样，主人对着表看序号 */
          nick.missing.map(r => `序号 ${r.seq}「${r.nickname}」`).join("、") +
          "。**这一次没有自动删**——有绑定的那几行等每天那一趟按名单处理，没绑定的请在页面「归属」面板的「退群候选行」里确认后手动删。",
      })
    }
  }
  const tidy = await ctx.tidySheetsCore(sheet, { snapshotThrottleMs: AUTOSAVE_SNAPSHOT_MS })
  return {
    nickSync: {
      skipped: nick.skipped,
      renamed: nick.renamed.map(r => ({ row: r.row, from: r.from, nick: r.nick })),
      missing: nick.missing.map(r => ({ row: r.row, nickname: r.nickname })),
    },
    ...(tidy.moved ? { tidied: tidy.moved } : {}),
    /** 这一趟把哪些人的内容换了位置：`applySave` 拿它跟压紧那趟合成一份回执（页面的草稿键按它搬） */
    shift: tidy.shiftRows?.[sheet] ?? {},
  }
}

/**
 * **删掉主人确认过的候选行**（`POST /api/ownership { action: "prune-missing", rows }`）
 *
 * 只删主人点名的那几行（**服务端不自己重新算一遍**：主人看到的是那一刻的候选，
 * 重新算等于删他没看见的东西）。删行 + 绑定/锁迁移 + 压紧走 `dropRowsAndMigrate`（与退群对账同一份），
 * 删前照旧存历史版本，删了什么也照旧进改动记录（`via: "主人确认"`）。
 */
export const pruneMissingRows = async keys => {
  const drops = new Map()
  for (const item of Array.isArray(keys) ? keys : []) {
    const sheet = String(item?.sheet ?? "").trim()
    const row = Number(item?.row) || 0
    if (!sheet || !row) continue
    if (!drops.has(sheet)) drops.set(sheet, [])
    drops.get(sheet).push(row)
  }
  if (!drops.size) return { removed: 0, rows: [] }

  const bindStore = await ctx.store()
  let plan = null
  const records = []
  const out = await ctx.table().mutate(
    async ctx => {
      const snapshot = await ctx.snapshotBeforeWrite()
      const state = await ctx.ownershipIn(ctx, bindStore)
      const binds = state.binds
      /** 表可能已经变了：对不上的行号直接跳过（主人点的是他当时看见的那几行） */
      for (const [sheet, wanted] of [...drops]) {
        const model = ctx.model(sheet)
        const keep = wanted.map(Number).filter(row => model.rows.some(r => r.row === row))
        if (keep.length) drops.set(sheet, keep)
        else drops.delete(sheet)
      }
      for (const [sheet, rows] of drops) {
        const model = ctx.model(sheet)
        for (const row of rows) {
          const item = model.rows.find(r => r.row === row)
          records.push({
            kind: "remove",
            at: Date.now(),
            /** `qq` 留空：这一行**没有绑定**（正是它成为候选的原因），只能记昵称 */
            qq: "",
            nick: String(item?.nickname ?? "").trim(),
            sheet,
            row,
            via: "主人确认",
            reason: "退群候选行（表里既无有效绑定、群名单里也找不到这个人）",
            snapshot,
          })
        }
      }
      const migrated = await ctx.dropRowsAndMigrate(ctx, drops, binds, state.locks)
      plan = { binds, locks: migrated.locks }
      return { removed: migrated.removed }
    },
    {
      afterCommit: async info => {
        await ctx.persistState(info, plan)
        ctx.recordChanges(records.map(r => ({ ...r, version: info.fp })))
      },
    },
  )
  return { removed: out.removed, rows: records.map(r => ({ sheet: r.sheet, row: r.row, nickname: r.nick })) }
}

