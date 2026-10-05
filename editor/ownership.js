/**
 * 归属状态：QQ → 行 的绑定，以及"这份绑定是哪一版表的"
 *
 * 三条硬规矩（外部审核踩出来的，改这里之前先读）：
 *
 * 1. **行号只在同一版表里有意义**（AQ-03）。绑定文件、锁文件都记着 `table` = 表格文件指纹；
 *    版本对不上时**不按行号认人**，先按群昵称在当前表里唯一命中重新对账；命中不了一律作废
 *    ——宁可让人重新认一次，也不能把别人的行认成自己的。
 * 2. **绑定与锁必须和表写在同一个临界区**（AQ-06）。见 `persistState`：表没写成，
 *    `afterCommit` 根本不会跑，绑定也不会落盘，不会出现"表换了、归属还指着旧行号"。
 * 3. **同一行只属于一个人**（AQ-02）。两个 QQ 都"能确认"时一律作废（无法确认谁是真本人），
 *    这条同时是 `rebuildOwnership` 的最后一道安全网。
 *
 * 模块只依赖注入进来的 `deps`；`mineRows` 的按昵称兜底用插件的 `locateSelf`（纯函数）注入。
 */
import { lockKey, lockRowOf, lockSheetOf } from "./acl.js"

/** 记一条绑定（内存里改，整体替换后由 persistState 落盘） */
export const bindSet = (binds, sheet, qq, { row, nickname }) => {
  binds[sheet] ??= {}
  binds[sheet][String(qq)] = { row: Number(row), nickname: String(nickname ?? "").trim(), at: Date.now() }
}

/** 删一条绑定；返回"真的删掉了" */
export const bindDel = (binds, sheet, qq) => {
  const list = binds[sheet]
  if (!list || !(String(qq) in list)) return false
  delete list[String(qq)]
  if (!Object.keys(list).length) delete binds[sheet]
  return true
}

/** 深拷一份绑定（整体替换，不原地改） */
export const cloneBinds = binds => {
  const out = {}
  for (const [sheet, list] of Object.entries(binds ?? {})) out[sheet] = { ...(list ?? {}) }
  return out
}
export const cloneLocks = rows => ({ ...(rows ?? {}) })

/** 把普通对象包成 locateSelf 认识的 store 形状（绑定在内存里改，不走磁盘逻辑） */
export const bindView = binds => ({
  get: (sheet, qq) => binds?.[sheet]?.[String(qq)] ?? null,
  qqsOf: (sheet, row) =>
    Object.entries(binds?.[sheet] ?? {})
      .filter(([, info]) => Number(info?.row) === Number(row))
      .map(([qq]) => qq),
})

/**
 * 取一份"与这一版表对过账"的绑定视图
 *
 * 版本对不上就返回空视图（不按行号认人）：调用方要么先 `alignOwnership()` 重建，
 * 要么就在临界区里自己重建一次。
 */
export const gatedBinds = (bindStore, fp) => bindView(bindStore.tableVersion === fp ? bindStore.data.binds : {})

/**
 * 这一行换人了（或退队清空）：把指向它的其它旧绑定清掉
 *
 * 只有"绑定里记的昵称和表里现在这一行一致"的才算有效归属，其余都是手工改表留下的残渣。
 */
export const dropBindsAt = (binds, sheet, row, { keepNickname = "", keepQq = "" } = {}) => {
  const list = binds[sheet] ?? {}
  const want = String(keepNickname ?? "").trim()
  let dropped = 0
  for (const qq of Object.keys(list)) {
    if (Number(list[qq]?.row) !== Number(row)) continue
    if (String(qq) === String(keepQq)) continue
    if (String(list[qq]?.nickname ?? "").trim() === want) continue
    delete list[qq]
    dropped++
  }
  if (list && !Object.keys(list).length) delete binds[sheet]
  return dropped
}

/** 昵称变了：锁上记的那个昵称跟着变，否则下次对账会因"归属对不上"把锁丢掉 */
export const renameLock = (locks, sheet, row, nickname) => {
  const key = lockKey(sheet, row)
  if (locks[key]) locks[key] = { ...locks[key], nickname: String(nickname ?? "").trim() }
}

/**
 * 按「绑定还指着原来那一行、而那一行的昵称没变」+「群昵称在目标表里唯一命中」重建绑定与锁
 *
 * 为什么不能按行号搬：整表替换 / 外部改表之后，同一个行号可能已经是别人了（AQ-03）。
 * 所以先看**原来那一行**还在不在、写的是不是同一个昵称（这说明这一行没换人），
 * 对不上再按昵称在表里找**唯一**的一行（挪行/改名都能跟过去）；都不行就作废。
 * 为什么要求"唯一"：重名时无法判断是哪一个，认错了比不认更糟。
 *
 * @param {Map<string, object>} models 目标表各榜模型
 * @param {object} binds 旧绑定（只读，不修改）
 * @param {object} locks 旧锁（只读，不修改）
 * @param {Map<string, object>} [before] 旧表模型：整表替换时用来把"只有行号"的旧锁找回人
 * @returns {{binds:object, locks:object, bindKept:number, bindMoved:number, bindDropped:number,
 *   bindMissing:number, bindUnconfirmed:number, lockKept:number, lockDropped:number}}
 *   计数供日志与「归属审计」接口如实回报：保留 / 纠正行号 / 作废（分"人已不在"与"重名无法确认"）
 */
export const rebuildOwnership = (models, binds, locks = {}, before = null) => {
  const nickAt = (modelsOf, sheet, row) => String(modelsOf?.get(sheet)?.rows.find(r => r.row === Number(row))?.nickname ?? "").trim()
  /** 原来那一行还在、昵称也还对得上 → 这一行没换人（最可靠的一种确认） */
  const rowConfirmed = (model, info) => {
    const row = Number(info?.row)
    const want = String(info?.nickname ?? "").trim()
    if (!model || !row || !want) return 0
    return String(model.rows.find(r => r.row === row)?.nickname ?? "").trim() === want ? row : 0
  }
  const uniqueRow = (model, nick) => {
    const want = String(nick ?? "").trim()
    if (!want || !model) return 0
    const rows = model.rows.filter(r => String(r.nickname ?? "").trim() === want)
    return rows.length === 1 ? rows[0].row : 0
  }

  const nextBinds = {}
  let bindKept = 0
  let bindMoved = 0
  let bindDropped = 0
  let bindMissing = 0
  let bindUnconfirmed = 0
  for (const [sheet, list] of Object.entries(binds ?? {})) {
    for (const [qq, info] of Object.entries(list ?? {})) {
      const model = models.get(sheet)
      const row = rowConfirmed(model, info) || uniqueRow(model, info?.nickname)
      if (!row) {
        bindDropped++
        /**
         * 作废的原因要分开数（审计接口要如实回报"无法确认几条"）：
         * 表里同名**不止一行** → 无法确认是哪一位（重名，只能人工核对）；
         * 表里根本没有这个名字 → 这一行/这个人已经不在了（退队、手工删行）。
         * 两者给主人的处置建议完全不同，糊成一个数字等于没说。
         */
        const want = String(info?.nickname ?? "").trim()
        const sameNick = want ? (model?.rows.filter(r => String(r.nickname ?? "").trim() === want).length ?? 0) : 0
        if (sameNick > 1) bindUnconfirmed++
        else bindMissing++
        continue
      }
      nextBinds[sheet] ??= {}
      nextBinds[sheet][qq] = { ...info, row }
      bindKept++
      /** 还认这个人、但行号被纠正过（挪行 / 换表）——"改了几条"数的是它 */
      if (Number(info?.row) !== row) bindMoved++
    }
  }

  /**
   * 同一行被两个 QQ 同时"能确认"（绑定里记的昵称与表里那一行一致）
   *
   * 一个行只能属于一个人，所以这属于**无法确认**：谁也没法证明自己是本人。
   * 按 AQ-02/AQ-03 一律作废（与 locateSelf 对"别人已有效占用"的处理同口径），
   * 让两人下次各自重新认一次——绝不能随手留一个，那正是"把别人的行认成自己的"。
   * 正常写入流程不会产生这种状态（validateRows 拒重名、dropBindsAt 清旧绑定），
   * 只有手工改过的绑定文件 / 老数据才会，所以放在重建的最后当安全网。
   */
  for (const [sheet, list] of Object.entries(nextBinds)) {
    const owners = new Map()
    for (const [qq, info] of Object.entries(list)) {
      const key = Number(info?.row)
      if (!owners.has(key)) owners.set(key, [])
      owners.get(key).push(qq)
    }
    /** 先把要作废的 QQ 收齐再删：删到一半把整个榜删掉，后面的 group 就没处可删了 */
    const doomed = [...owners.values()].filter(qqs => qqs.length > 1).flat()
    for (const qq of doomed) {
      delete nextBinds[sheet][qq]
      bindKept--
      bindDropped++
      bindUnconfirmed++
    }
    if (!Object.keys(nextBinds[sheet]).length) delete nextBinds[sheet]
  }

  const nextLocks = {}
  let lockKept = 0
  let lockDropped = 0
  for (const [key, lock] of Object.entries(locks ?? {})) {
    const sheet = lockSheetOf(key)
    const row = lockRowOf(key)
    /** 锁上的昵称 → 没有（老数据）就退回"旧表里这一行的昵称"；两者都拿不到就没法确认归属 */
    const nick = String(lock?.nickname ?? "").trim() || nickAt(before, sheet, row)
    if (!nick) {
      lockDropped++
      continue
    }
    const target = uniqueRow(models.get(sheet), nick)
    if (!target) {
      lockDropped++
      continue
    }
    const to = lockKey(sheet, target)
    if (nextLocks[to]) {
      lockDropped++
      continue
    }
    nextLocks[to] = { ...lock, nickname: nick }
    lockKept++
  }
  return { binds: nextBinds, locks: nextLocks, bindKept, bindMoved, bindDropped, bindMissing, bindUnconfirmed, lockKept, lockDropped }
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.store 绑定库
 * @param {() => object} deps.table 表实例（`read` / `mutate` 两个入口）
 * @param {() => object} deps.loadLocks 读完成情况锁
 * @param {(locks: object) => void} deps.saveLocks 写完成情况锁
 * @param {() => object} deps.loadRoster 读群成员名单（审计里要报名单规模）
 * @param {(model: object, view: object, sheet: string, qq: string, nick: string) => object} deps.locateSelf
 *   插件 `lib/queue.js` 的按 QQ 定位（纯函数）
 */
export function createOwnership({ store, table, loadLocks, saveLocks, loadRoster, locateSelf }) {
  /**
   * 在临界区里取一份**可用**的归属状态
   *
   * 绑定/锁记的表版本与这一版表一致才直接用；否则先按群昵称重建（AQ-03）。
   * 每个写入口进来都先过这一道，就不会有人拿着旧行号去认人。
   * @returns {Promise<{binds: object, locks: object, realigned: boolean}>}
   */
  const ownershipIn = async (ctx, bindStore) => {
    const locks = loadLocks()
    if (bindStore.tableVersion === ctx.version && locks.table === ctx.version)
      return { binds: cloneBinds(bindStore.data.binds), locks: cloneLocks(locks.rows), realigned: false }
    const rebuilt = rebuildOwnership(ctx.models, bindStore.data.binds ?? {}, locks.rows ?? {})
    return { binds: rebuilt.binds, locks: rebuilt.locks, realigned: true }
  }

  /**
   * 提交关联状态：绑定 + 锁 + 表版本，必须和表写在**同一个临界区**里
   *
   * `plan` 由各写入口在临界区里算好（整体替换，不原地改）：
   *   - `binds` / `locks`：整份新状态
   *   - `stamp`：这次是否只为了盖版本（没有别的改动）
   * 表没写成，afterCommit 根本不会跑；绑定也没落盘 —— 不会出现"表换了、归属还指着旧行号"。
   */
  const persistState = async ({ fp }, plan) => {
    if (!plan) return
    const bindStore = await store()
    if (plan.binds) bindStore.data.binds = plan.binds
    bindStore.tableVersion = fp
    await bindStore.save()
    saveLocks({ table: fp, rows: plan.locks ?? loadLocks().rows })
  }

  /**
   * 归属对账（走 table 的队列，是个写入口）
   *
   * 绑定/锁记的表版本与当前表不一致时就重建：能按群昵称唯一命中的留下并把行号纠正过来，
   * 其余的作废。外部改表（人在 Excel 里编辑）与整表替换都会走到这里。
   */
  const alignOwnership = async () => {
    const bindStore = await store()
    let plan = null
    let rebuilt = null
    const out = await table().mutate(
      async ctx => {
        const locks = loadLocks()
        if (bindStore.tableVersion === ctx.version && locks.table === ctx.version) return { realigned: false }
        rebuilt = rebuildOwnership(ctx.models, bindStore.data.binds ?? {}, locks.rows ?? {})
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return { realigned: true }
      },
      { afterCommit: info => persistState(info, plan) },
    )
    if (out.realigned)
      console.log(
        `[editor] 表版本变了，归属已重新对账：绑定保留 ${rebuilt.bindKept} 条（其中 ${rebuilt.bindMoved} 条纠正了行号）、作废 ${rebuilt.bindDropped} 条；` +
          `锁保留 ${rebuilt.lockKept} 条、作废 ${rebuilt.lockDropped} 条`,
      )
    return out
  }

  /**
   * 归属状态的**审计视图**（主人专用，只读，不改任何东西）
   *
   * 为什么不加"稳定成员 ID"列（方案 B）：表是人工维护、还要给人看/给腾讯文档那份对齐的，
   * 多一列 ID 等于让所有人多维护一样东西（漏填一行就是"这个人没有身份"），
   * 而**稳定身份本来就在编辑器侧**（绑定文件里的 QQ + 表指纹）。代价必须由主人自己能看清：
   * 绑定只在"同一版表"里代表行号，外部改表 / 换表 / 手工挪行之后
   *   - `stale`：这条绑定与表里那一行已经对不上账（行没了，或那一行换了名字）；
   *   - `conflict`：同一行被两个 QQ 都"有效"认领（重名 + 手工改表就会出现），归属不明；
   * 这两种就是需要人来决定的那两种状态，所以连同"记的昵称 vs 表里现在的昵称"一起列出来。
   * @returns {Promise<object>} 见 editor/README.md「归属接口」一节
   */
  const ownershipAudit = async () => {
    const bindStore = await store()
    const locks = loadLocks()
    return table().read(({ models, fp }) => {
      const binds = bindStore.data.binds ?? {}
      const nickAt = (model, row) => String(model?.rows.find(r => r.row === Number(row))?.nickname ?? "").trim()
      const entryOf = (model, qq, info) => {
        const row = Number(info?.row) || 0
        const nickname = String(info?.nickname ?? "").trim()
        const current = row ? nickAt(model, row) : ""
        const rowExists = Boolean(row) && Boolean(model?.rows.some(r => r.row === row))
        /** 对不上账 = 那一行已经不在了，或那一行现在的昵称和绑定里记的不是同一个人 */
        return { qq: String(qq), row, nickname, current, rowExists, stale: !rowExists || current !== nickname, conflict: false, conflictWith: [] }
      }

      const sheets = []
      for (const model of models.values()) {
        const entries = Object.entries(binds[model.name] ?? {})
          .map(([qq, info]) => entryOf(model, qq, info))
          .sort((a, b) => a.row - b.row || a.qq.localeCompare(b.qq))
        /**
         * 同一行被两个 QQ 同时"有效"认领：只有"绑定里记的昵称 == 表里这一行现在的昵称"才算有效，
         * 所以正常保存流程里不会出现；重名 + 手工改表才会（AQ-02），必须让人看见。
         */
        const byRow = new Map()
        for (const e of entries) {
          if (e.stale) continue
          if (!byRow.has(e.row)) byRow.set(e.row, [])
          byRow.get(e.row).push(e)
        }
        for (const group of byRow.values()) {
          if (group.length < 2) continue
          for (const e of group) {
            e.conflict = true
            e.conflictWith = group.filter(x => x !== e).map(x => x.qq)
          }
        }
        sheets.push({ name: model.name, bound: entries.length, entries })
      }
      /** 绑定里还留着、表里已经没有的榜：不列出来就成了"归属凭空少了几个榜"，没人知道 */
      for (const [name, list] of Object.entries(binds)) {
        if (models.has(name)) continue
        const entries = Object.entries(list ?? {}).map(([qq, info]) => entryOf(null, qq, info))
        sheets.push({ name, missingSheet: true, bound: entries.length, entries })
      }

      const lockRows = Object.entries(locks.rows ?? {})
        .map(([key, lock]) => {
          const sheet = lockSheetOf(key)
          const row = lockRowOf(key)
          const current = nickAt(models.get(sheet), row)
          const nickname = String(lock?.nickname ?? "").trim()
          return { sheet, row, nickname, by: String(lock?.by ?? ""), at: Number(lock?.at) || 0, current, stale: !current || current !== nickname }
        })
        .sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row)

      const roster = loadRoster()
      const count = Object.values(binds).reduce((n, list) => n + Object.keys(list ?? {}).length, 0)
      return {
        /** 当前表的指纹（行号只在这一版里才有意义） */
        version: fp,
        /** 绑定记的是哪一版表；`stale` = 与当前表对不上，下次有人打开页面会先自动重建 */
        bindings: { table: String(bindStore.tableVersion ?? ""), stale: String(bindStore.tableVersion ?? "") !== fp, count },
        locks: { table: String(locks.table ?? ""), stale: String(locks.table ?? "") !== fp, count: lockRows.length, rows: lockRows },
        roster: { group: roster.group, updatedAt: roster.updatedAt, count: (roster.members ?? []).length },
        sheets,
      }
    })
  }

  /**
   * 按当前表 + 群名单**显式重建**归属（主人专用；写绑定文件，不动表格）
   *
   * 与自动对账（alignOwnership 在表版本变了时顺手做）走的是同一套规则（AQ-03）：
   * 能确认的留下并把行号纠正过来，对不上账 / 无法确认的一律作废，绝不按旧行号认人。
   * 区别只有一条：这里**不看版本对不对**，主人点一次就重算一次——"我手工在 Excel 里挪了行"
   * 这类外部改动之后，主人需要一个能主动执行、并且能看见结果的入口。
   *
   * 表没被改动（重建只写绑定与锁），所以不存历史版本；但提交走同一个临界区：
   * 绑定/锁与"读到的这一版表"必须一致，不能拿着读表期间的表去算归属（AQ-06）。
   */
  const rebuildOwnershipNow = async () => {
    const bindStore = await store()
    let plan = null
    let rebuilt = null
    const out = await table().mutate(
      async ctx => {
        rebuilt = rebuildOwnership(ctx.models, bindStore.data.binds ?? {}, loadLocks().rows ?? {})
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return { version: ctx.version }
      },
      { afterCommit: info => persistState(info, plan) },
    )
    console.log(
      `[editor] 归属已按当前表重建：绑定保留 ${rebuilt.bindKept} 条（纠正行号 ${rebuilt.bindMoved} 条）、` +
        `作废 ${rebuilt.bindDropped} 条（其中重名无法确认 ${rebuilt.bindUnconfirmed} 条、人已不在 ${rebuilt.bindMissing} 条）；` +
        `锁保留 ${rebuilt.lockKept} 条、作废 ${rebuilt.lockDropped} 条`,
    )
    return {
      version: out.version,
      kept: rebuilt.bindKept,
      moved: rebuilt.bindMoved,
      dropped: rebuilt.bindDropped,
      unconfirmed: rebuilt.bindUnconfirmed,
      missing: rebuilt.bindMissing,
      locks: { kept: rebuilt.lockKept, dropped: rebuilt.lockDropped },
    }
  }

  /** 这个人在各榜里属于自己的行号：`{ 榜名 → Set(行号) }`（有 QQ 绑定认绑定，否则按群昵称兜底） */
  const mineRows = async caller => {
    const bindStore = await store()
    const qq = caller.identity?.qq
    const nick = caller.identity?.nick
    const out = new Map()
    await table().read(({ models, fp }) => {
      /** 只在这一版表上对过账的绑定才能按行号认人（AQ-03） */
      const view = gatedBinds(bindStore, fp)
      for (const model of models.values()) {
        const hit = locateSelf(model, view, model.name, qq, nick)
        out.set(model.name, new Set(hit.row ? [hit.row] : []))
      }
    })
    return out
  }

  return { ownershipIn, persistState, alignOwnership, ownershipAudit, rebuildOwnershipNow, mineRows }
}
