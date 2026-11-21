/**
 * 编辑器的"动作"层：一个动作 = 一次表变更 + 审计 + 改动记录
 *
 * 为什么要有这一层：这些动作原来是 HTTP 端点里的实现（`editor.mjs` 的 `/api/move-row`
 * 等），插件要用就只能绕一圈 HTTP 调自己。消费者其实只有插件，所以把动作抽成可直调的函数；
 * HTTP 端点退化成"解析请求 → 调这里 → 回 JSON"。
 *
 * 边界：这里**不重新实现规则**，依赖全部由 `createActions` 注入（锁、版本、绑定、
 * 改动记录、列定义），保证与编辑器内用的是同一份实现。
 */

/**
 * @param {object} deps
 * @param {() => any} deps.table                Table 实例（惰性）
 * @param {() => Promise<any>} deps.store       BindStore（惰性）
 * @param {any} deps.changes                    改动记录（`editor/changes.js`）
 * @param {(opts?: { throttleMs?: number }) => Promise<any>} deps.snapshotBeforeWrite 写表前存底（自动保存那条路带节流窗口）
 * @param {(ctx, store) => Promise<any>} deps.ownershipIn 归属快照
 * @param {(info, plan) => Promise<void>} deps.persistState 提交后落归属
 * @param {(state, sheet, toRow) => any} deps.remapRowsOf   归属/锁的行号重映射
 * @param {(ctx, sheet, key, col, row, next, current, style) => void} deps.moveCell
 * @param {(sheet, nick) => Promise<void>} deps.rememberQueueFront 记插队置顶
 * @param {(sheet?: string) => Promise<any>} deps.tidySheetsCore 每日整理的实现（惰性）
 * @param {string[]} deps.MOVE_COLUMN_KEYS      跟着人走的列
 * @param {string} deps.QUEUED_STATUS           「排队中」
 * @param {(code: string) => string|null} deps.linkByCode 口令 → 完整链接（登记簿，见 `model/editor-links.js`）
 * @param {number} deps.CYCLE_PROTOCOL          周期清榜协议版本
 * @param {(fn: () => Promise<any>) => Promise<any>} deps.cycleExclusive 周期账本临界区（同一时刻只跑一个周期事件）
 * @param {(opts?: {fresh?: boolean}) => Promise<any>} deps.loadCycleLedger 周期完成账本（`fresh` 跳过内存缓存）
 * @param {(next: any) => Promise<void>} deps.saveCycleLedger 写完成账本（先落盘再换内存）
 * @param {(eventKey: string) => Promise<any>} deps.readCycleIntent 读未决 intent（没有 → null）
 * @param {(eventKey: string, data: any) => Promise<boolean>} deps.createCycleIntent 独占创建 intent
 * @param {(eventKey: string) => Promise<void>} deps.removeCycleIntent 撤销 intent
 * @param {(status: any) => boolean} deps.isDoneStatus 「已完成」判据
 * @param {() => any} deps.loadRoster             当前群名单（空名单校验用）
 * @param {(data: any) => any} deps.saveRoster    写入群名单
 * @param {(members: any[]) => Promise<{renamed: number, removed: number}>} deps.reconcileRoster 按 QQ 对账
 * @param {() => any[]} deps.nickCandidates       群昵称候选
 * @param {(line: string) => void} [deps.log]
 */

/**
 * 周期清榜的协议错误：HTTP 语义挂在 error 上（`statusCode` + 响应要带的字段），端点只做映射。
 * 进程内调用方（`model/cycle-write.js`）看到的仍然只是一个带 message 的 Error。
 */
const cycleError = (statusCode, extra, message) => Object.assign(new Error(message), { statusCode, ...extra })

/** 群名单推送的请求错误：校验失败一律 400（端点只做映射，与 `cycleError` 同一个形状） */
const rosterError = message => Object.assign(new Error(message), { statusCode: 400 })

export function createActions(deps) {
  const {
    table,
    store,
    changes,
    snapshotBeforeWrite,
    ownershipIn,
    persistState,
    remapRowsOf,
    moveCell,
    rememberQueueFront,
    tidySheetsCore,
    MOVE_COLUMN_KEYS,
    QUEUED_STATUS,
    /** 口令兑换（`linkCode`）：登记簿查询，与编辑器端点共用同一份实现（见 `model/editor-links.js`） */
    linkByCode,
    /* 周期清榜（`cycle` / `cycleStatus`）：账本与未决 intent 都在编辑器侧，动作层只做协议编排 */
    CYCLE_PROTOCOL,
    cycleExclusive,
    loadCycleLedger,
    saveCycleLedger,
    readCycleIntent,
    createCycleIntent,
    removeCycleIntent,
    isDoneStatus,
    /* 群名单推送（`roster`）：名单读写、对账与昵称候选都在编辑器侧 */
    loadRoster,
    saveRoster,
    reconcileRoster,
    nickCandidates,
    /* 保存（`save`）那一摊的依赖：状态词与列定义、校验、权限（名单 / 链接 / 额度 / 红线 / 主播锁）、
     * 归属与锁的搬迁、整理与版本存底——都是编辑器里的同一份实现，这里只引用，不复制规则。 */
    AUTOSAVE_SNAPSHOT_MS,
    FIELDS,
    PENDING_STATUS,
    PUBLIC_ANCHOR,
    SELF_DONE,
    WAITING_STATUS,
    afterSaveFollowUp,
    alertOwner,
    assertMemberRows,
    attackCompletedStatus,
    attackPendingStatus,
    attackStatusParts,
    autoAnchorOfStatus,
    bindSet,
    bindView,
    blank,
    cleanNickValue,
    compactClearedRows,
    composeRowMap,
    defaultStatusOf,
    diffRows,
    dropBindsAt,
    editRecord,
    linkStateOf,
    locateSelf,
    lockIsLive,
    lockKey,
    lockWorthy,
    memberStateOf,
    parseAttackGoal,
    quota,
    recordChanges,
    redLine,
    renameLock,
    rosterQqOfNick,
    rowConflict,
    rowFingerprint,
    rowNumbersOf,
    sameNick,
    statusLabels,
    statusRenamePlan,
    statusTokens,
    statusWithSelfDone,
    validateRows,
    validationPlan,
    writeValidationPlan,
    version = "",
    mount = "",
    log = line => console.log(line),
  } = deps

  /**
   * 进程内探活：给插件的 `#排队初始化` 第 3 步用
   *
   * 只回三件事——版本、挂载前缀、群名单人数。**不是** `/healthz` 的镜像：
   * 那个端点要给浏览器/运维看完整状态（features、bind、owner_only 等），插件只关心
   * "编辑器在不在、是哪个版本、收到名单没有"。所以这里不复制那份 payload，
   * 免得两处口径各自漂移。
   *
   * 只能回答"这个进程里有没有编辑器"：独立进程（`7788` 调试模式）注册不进来，
   * 那种情况调用方拿到的是 `null`，按"未挂载"处理。
   */
  const health = () => {
    const roster = loadRoster()
    return { version, mount: mount || "", roster: (roster.members ?? []).length }
  }

  /**
   * 插队：把某一行挪到这一榜所有「排队中」的最前面
   *
   * 只给管理员用：一条消息就能改全表顺序，不该由"能改自己那一行"的身份触发。
   * 返回值里的 `moved:false` 是**正常结论**（前面没有排队中的人），必须原样带回给调用方。
   */
  const moveRow = async (caller, { sheet, row, mode, nick } = {}) => {
    if (caller.role !== "admin") throw new Error("只有白名单管理员可以插队")
    if (String(mode ?? "") !== "queue-front")
      throw new Error('请求格式不对：需要 { sheet, row, mode: "queue-front" }')
    const sheetName = String(sheet ?? "").trim()
    const from = Number(row)
    if (!sheetName) throw new Error("缺少 sheet")
    if (!Number.isSafeInteger(from) || from < 1) throw new Error(`行号不合法：${row}`)

    let out = null
    let plan = null
    const movedRows = {}
    await table().mutate(
      async ctx => {
        const model = ctx.model(sheetName)
        const cols = Object.entries(model.col).filter(([key, col]) => col && MOVE_COLUMN_KEYS.includes(key))
        /** 给回话用的"第几位"取 A 列序号，不取表格行号 */
        const seqOf = r => {
          const seq = Number(String(r?.seq ?? "").trim())
          return Number.isSafeInteger(seq) && seq > 0 ? seq : r.row - model.dataStart + 1
        }

        const person = model.rows.find(r => r.row === from)
        if (!person || !String(person.nickname ?? "").trim()) throw new Error(`第 ${from} 行不是排队的记录，不能插队`)
        if (String(person.status ?? "").trim() !== QUEUED_STATUS)
          throw new Error(`「${String(person.nickname).trim()}」在「${sheetName}」里不是「${QUEUED_STATUS}」，不能插队`)

        const target = model.rows
          .filter(r => r.row < from && String(r.nickname ?? "").trim() && String(r.status ?? "").trim() === QUEUED_STATUS)
          .sort((a, b) => a.row - b.row)[0]
        if (!target) {
          out = {
            moved: false,
            sheet: sheetName,
            from,
            nickname: String(person.nickname).trim(),
            reason: `已经是这一榜最前面的「${QUEUED_STATUS}」`,
          }
          return { moved: false }
        }
        if (target.row < model.dataStart || target.row >= from)
          throw new Error(`算出来的目标行第 ${target.row} 行不在数据区里（数据区自 ${model.dataStart} 起），整表不动`)

        const rowsByNumber = new Map(model.rows.map(r => [r.row, r]))
        const span = from - target.row
        for (let i = 0; i <= span; i++) {
          const to = target.row + i
          const src = i === 0 ? from : target.row + i - 1
          const toRowData = rowsByNumber.get(to)
          const srcRowData = rowsByNumber.get(src)
          for (const [key, col] of cols) {
            const current = String(toRowData?.[key] ?? "")
            const next = String(srcRowData?.[key] ?? "")
            moveCell(ctx, sheetName, key, col, to, next, current, ctx.refStyle(sheetName, `${col}${src}`))
          }
        }

        await snapshotBeforeWrite()
        const state = await ownershipIn(ctx, await store())
        const toRow = r => {
          if (r === from) return target.row
          if (r >= target.row && r < from) return r + 1
          return r
        }
        plan = remapRowsOf(state, sheetName, toRow)
        for (let r = target.row; r <= from; r++) movedRows[r] = toRow(r)
        out = {
          moved: true,
          sheet: sheetName,
          from,
          to: target.row,
          fromSeq: seqOf(person),
          toSeq: seqOf(target),
          nickname: String(person.nickname).trim(),
          crossed: String(target.nickname).trim(),
          rowMap: movedRows,
        }
        return { moved: out.moved }
      },
      { afterCommit: info => persistState(info, plan) },
    )

    if (out?.nickname) {
      await rememberQueueFront(sheetName, out.nickname).catch(err =>
        console.warn(`[editor] 记录插队置顶失败：${err?.message ?? err}`),
      )
    }
    if (!out?.moved) return out ?? { moved: false, sheet: sheetName, reason: "没有可挪的位置" }
    changes.remap(sheetName, movedRows)
    log(
      `[editor] 插队：${out.sheet} 序号 ${out.fromSeq}（第 ${out.from} 行）「${out.nickname}」挪到序号 ${out.toSeq}（第 ${out.to} 行）（排到队首，原队首「${out.crossed}」）` +
        (nick ? `（由 ${nick} 发起）` : ""),
    )
    return out
  }

  /**
   * `POST /api/tidy` 的入口：权限判据在路由里，这里只管"整理哪几个榜"
   *
   * @param {{role: string, identity?: object}} caller 调用者（机器人身份或主人，见路由的权限判据）
   * @param {{sheet?: string}} body 不给 `sheet` 就整理所有榜
   */
  const tidy = async (caller, { sheet } = {}) => {
    const out = await tidySheetsCore(String(sheet ?? "").trim())
    for (const [name, map] of Object.entries(out.shiftRows ?? {}))
      if (map && Object.keys(map).length) changes.remap(name, map)
    return out
  }

  /**
   * 群成员名单推送（机器人 → 编辑器）
   *
   * 只认机器人身份（`ROSTER_QQ`）或主人：成员拿不到机器人身份的签名，所以推不动。
   * 收到后就地按 QQ 对账：改名同步表里的群昵称；退群删行并压紧（删前自动存底）。
   *
   * 权限判据在路由里（HTTP 的 caller 带 `identity`，进程内调用方只有 `{qq, nick}`）；
   * 这里只管“名单形状 → 落盘 → 对账 → 回执”，校验失败带 `statusCode: 400`，端点按它映射响应。
   *
   * @param {object} caller 调用者（动作本身不判权限）
   * @param {{group?: string, members?: Array<{qq: string, nick?: string}>}} body 整份名单
   */
  const roster = async (caller, body) => {
    const members = Array.isArray(body?.members) ? body.members.slice(0, 5000) : null
    if (!members) throw rosterError("缺少 members")
    /** 空名单绝不用于对账：那等于把绑定过的人都判成退群 */
    const previous = loadRoster()
    if (!members.length && (previous.members ?? []).length)
      throw rosterError("推来的是空名单，拒绝按它对账（先确认机器人取成员是否正常）")

    saveRoster({ group: body?.group, members })
    const out = await reconcileRoster(members)
    return { ok: true, total: members.length, ...out, candidates: nickCandidates().length }
  }

  /**
   * 清榜前核查写状态：只把“当前仍是排队中、昵称仍对得上、没有主播锁”的行改成该行群昵称。
   * `version` 在 Table 写队列内做最终核验，期间有人改表就整批拒绝。
   */
  const checkDone = async (caller, { sheet, version = "", rows = [] } = {}) => {
    const name = String(sheet ?? "").trim()
    if (!name) throw new Error("缺少 sheet")
    if (!/^[0-9a-f]{64}$/i.test(String(version ?? "").trim())) throw new Error("缺少有效版本")
    if (!Array.isArray(rows) || !rows.length) return { sheet: name, updated: 0, rows: [] }

    let updated = []
    let plan = null
    await table().mutate(
      async ctx => {
        const model = ctx.model(name)
        const state = await ownershipIn(ctx, await store())
        for (const item of rows) {
          const row = model.rows.find(r => r.row === Number(item?.row))
          if (!row) continue
          const nickname = String(row.nickname ?? "").trim()
          if (!nickname || nickname !== String(item?.nickname ?? "").trim()) continue
          if (item.goal !== undefined && String(row.goal ?? "").trim() !== String(item.goal ?? "").trim()) continue
          const status = String(row.status ?? "").trim()
          /** 只处理排队中/空状态；等待、已完成、被主播锁住的一律不动 */
          if (status !== "" && status !== QUEUED_STATUS) continue
          if (lockIsLive(row, state.locks, name)) continue
          ctx.setCell(name, row.row, "status", nickname)
          updated.push({ row: row.row, nickname })
        }
        plan = { binds: state.binds, locks: state.locks }
        return { updated: updated.length }
      },
      { expect: version, afterCommit: info => persistState(info, plan) },
    )
    return { sheet: name, updated: updated.length, rows: updated.map(x => x.row) }
  }

  /**
   * 周期清榜 / 翻状态（机器人专用）
   *
   * mode:
   *   - `all`          ：清空全部成员行（剧诗）
   *   - `queued-done`  ：清排队中 + 已完成（深渊、危战）
   *   - `done`         ：只清已完成（枪战版更）
   *   - `promote`      ：不删行，只把等待开启行翻成排队中（危战下一版开始时单独调用）
   *
   * 删行与翻状态都必须在**同一张表的最新一版**上做；机器人先归档、后调用，失败会重试。
   */
  const applyCycle = async (caller, { sheet, mode = "queued-done", promote = false, version = "" } = {}) => {
    const name = String(sheet ?? "").trim()
    if (!name) throw new Error("缺少 sheet")
    if (!["all", "queued-done", "done", "promote"].includes(mode)) throw new Error(`不认识的清榜模式：${mode}`)

    let clearedRows = []
    let cleared = 0
    let promoted = 0
    let plan = null

    await table().mutate(
      async ctx => {
        const model = ctx.model(name)
        const rows = model.rows.filter(r => String(r.nickname ?? "").trim())
        const targets =
          mode === "all"
            ? rows
            : mode === "done"
              ? rows.filter(r => isDoneStatus(r.status))
              : mode === "queued-done"
                ? rows.filter(r => {
                    const s = String(r.status ?? "").trim()
                    /** 空状态也算旧排队记录（与业务 `isPending("")` 同口径）；等待开启保留 */
                    return s === "" || s === QUEUED_STATUS || isDoneStatus(s)
                  })
                : []
        if (targets.length || promote) await snapshotBeforeWrite()

        const state = await ownershipIn(ctx, await store())
        const binds = state.binds
        const locks = state.locks

        for (const r of targets) {
          ctx.clearRow(name, r.row)
          dropBindsAt(binds, name, r.row)
          delete locks[lockKey(name, r.row)]
          clearedRows.push(r.row)
          cleared++
        }

        if (promote) {
          for (const r of rows) {
            if (clearedRows.includes(r.row)) continue
            const raw = String(r.status ?? "").trim()
            const isAttack = /攻炼/.test(name)
            const parts = isAttack ? attackStatusParts(raw) : null
            if (!parts && raw !== WAITING_STATUS) continue
            /** 攻炼按版本开放时间派生；其余榜清榜后等待行统一翻回排队中 */
            const auto = isAttack
              ? parts?.some(part => part.kind === "done")
                ? attackCompletedStatus(r.goal, raw)
                : attackPendingStatus(r.goal)
              : QUEUED_STATUS
            /** `future-real`：等到这一版真的开放，才把等待行翻成排队中 */
            if (auto === raw) continue
            if (promote === "future-real" && !attackStatusParts(auto)?.some(part => part.kind === "queued")) continue
            ctx.setCell(name, r.row, "status", auto)
            if (!lockWorthy(auto, r.nickname)) delete locks[lockKey(name, r.row)]
            promoted++
          }
        }

        plan = { binds, locks }
        return { cleared, promoted }
      },
      { expect: version, afterCommit: async info => {
        await persistState(info, plan)
        if (clearedRows.length) changes.remap(name, Object.fromEntries(clearedRows.map(row => [row, 0])))
      } },
    )

    const compacted = await compactClearedRows(name, clearedRows)
    /** 清完/翻完再整理一次：按新的三段式分组与难度/强度顺序排好 */
    const tidy = cleared || promoted ? await tidySheetsCore(name, { snapshotThrottleMs: AUTOSAVE_SNAPSHOT_MS }) : null
    const rowMap = composeRowMap(compacted?.shift, tidy?.shiftRows?.[name])
    const changeRowMap = {
      ...Object.fromEntries(clearedRows.map(r => [r, 0])),
      ...rowMap,
    }
    const tidyShift = tidy?.shiftRows?.[name]
    if (tidyShift && Object.keys(tidyShift).length) changes.remap(name, tidyShift)
    if (cleared) console.log(`[editor] 周期清榜：${name} 清除 ${cleared} 行${promoted ? `，翻排队 ${promoted} 行` : ""}`)
    else if (promoted) console.log(`[editor] 周期翻状态：${name} 等待开启 → 排队中 ${promoted} 行`)
    return {
      sheet: name,
      cleared,
      promoted,
      compacted: compacted?.compacted ?? null,
      /** 老行号 → 新行号；0 = 这一行已清空。插件本地绑定按它搬（见 `BindStore.remap`） */
      rowMap: changeRowMap,
    }
  }

  /**
   * 周期清榜：查这一轮是否已执行（`done`）/ 是否有未决 intent（`pending`）
   *
   * 客户端**必须在下载/覆盖归档之前**调用：回执丢失后的重试不能把已清过的表再清一次。
   * 账本与 intent 都在编辑器进程里，HTTP 与进程内两条路看到的是同一份。
   *
   * @param {{role?: string, identity?: object}} caller 调用者（权限判据在路由里，与 `tidy` 同一口径）
   * @param {{eventKey?: string}} body
   * @returns {Promise<{protocol: number, done: boolean, pending: boolean}>}
   */
  const cycleStatus = async (caller, { eventKey } = {}) => {
    const key = String(eventKey ?? "").trim()
    if (!key) throw new Error("缺少 eventKey")
    const ledger = await loadCycleLedger()
    const done = Boolean(ledger.done[key])
    const pending = !done && Boolean(await readCycleIntent(key))
    return { protocol: CYCLE_PROTOCOL, done, pending }
  }

  /**
   * 周期清榜 / 翻状态：**带幂等账本与未决 intent 的完整协议**（原来的 `POST /api/cycle`）
   *
   * 顺序就是安全性的全部：
   *   1. 同一 eventKey 已完成 ⇒ 直接回 `skipped`（不能再清一次清榜后新报名的人）；
   *   2. 有未决 intent ⇒ 423（表可能已经改了但回执没送到，停止自动重放）；
   *   3. 先落 intent、再写表；写表成功后再落完成账本，最后撤 intent；
   *   4. 版本冲突（写表前就被拒）⇒ 撤 intent；其他失败无法证明没提交 ⇒ 保留 intent。
   *
   * @param {{role?: string, identity?: object}} caller 调用者（权限判据在路由里）
   * @param {{sheet?: string, mode?: string, promote?: false|string, eventKey?: string, version?: string}} body
   * @returns {Promise<any>} 清榜回执；已完成时为 `{ skipped: true, reason, ...账本条目 }`
   */
  const cycle = async (caller, body = {}) => {
    const eventKey = String(body?.eventKey ?? "").trim().slice(0, 200)
    const version = String(body?.version ?? "").trim()
    if (!eventKey || !/^[0-9a-f]{64}$/i.test(version))
      throw cycleError(400, {}, "周期清榜缺少有效的 eventKey / version")

    return await cycleExclusive(async () => {
      const ledger = await loadCycleLedger({ fresh: true })
      if (ledger.done[eventKey])
        return { skipped: true, reason: "这一轮已经执行过", ...ledger.done[eventKey] }
      if (await readCycleIntent(eventKey))
        throw cycleError(423, { pending: true }, "同一轮清榜已有未决 intent，停止自动重放")

      const intent = {
        at: new Date().toISOString(),
        version,
        sheet: String(body?.sheet ?? ""),
        mode: String(body?.mode ?? ""),
        promote: body?.promote ?? false,
      }
      if (!(await createCycleIntent(eventKey, intent)))
        throw cycleError(423, { pending: true }, "同一轮清榜已有未决 intent，停止自动重放")

      let out
      try {
        out = await applyCycle(caller, { ...body, version })
      } catch (err) {
        if (err?.conflict) {
          /** 版本冲突发生在写表之前，本次 intent 可以撤销 */
          await removeCycleIntent(eventKey).catch(() => {})
          throw cycleError(409, { conflict: true }, err?.message ?? "表格版本冲突")
        }
        /** 其他失败无法证明表没提交：保留 intent，等人工核对 */
        throw cycleError(500, { pending: true }, `清榜失败，intent 已保留：${err?.message ?? err}`)
      }

      const next = {
        done: {
          ...ledger.done,
          [eventKey]: { at: new Date().toISOString(), ...intent, cleared: out?.cleared ?? 0, promoted: out?.promoted ?? 0 },
        },
      }
      try {
        await saveCycleLedger(next)
      } catch (err) {
        /** 表已经提交，但完成账本没落盘：保留 intent，重启后也不会自动重放 */
        throw cycleError(500, { pending: true }, `清榜已提交，但完成账本写入失败，已停止自动重放：${err?.message ?? err}`)
      }
      try {
        await removeCycleIntent(eventKey)
      } catch {
        /* 完成账本已经落盘，残留 intent 不影响 status（done 优先） */
      }
      return out
    })
  }

/**
 * 保存：校验 → 逐格写；整行空 = 清空该行（序号公式列不动，**下面的行立刻提上来**，见 `compactClearedRows`）
 *
 * 权限在服务端落实，不依赖前端（**分两档，按"名单可不可信"走**）：
 *   - 名单可信、他在名单里（`roam`）⇒ **可改整张排队区**：自己的行不限；**别人的行**受额度
 *     （一次 ≤3 行、10 分钟 ≤10 行）与三条红线（清空别人的行 / 改别人那一行的群昵称 / 主播锁）
 *     约束，越界就拒 + 私聊告警主人；
 *   - 名单不可信（空 / 超 48 小时）⇒ **不放权也不拒人**：退回老口径——只能碰「本来就是自己那一行」
 *     或「新增的、昵称是自己的」行；
 *   - 名单可信、但他**不在名单里**（转发到群外、退群了）⇒ 只读，一个字都不许写。
 *   self 改不动已被主播锁定的完成情况（其余字段照常保存，被忽略的那格回报给前端）。
 *
 * **读表、校验、写表、改绑定与锁全在 table() 的同一个临界区里**：
 * 队列外先读一次算清楚、再进队列写，中间别的写入口（上传/回退/名单整理）
 * 可能已经把表换掉了，于是写回去的是过期快照，改动凭空消失（AQ-06）。
 *
 * 冲突判据两档，**按请求带什么走哪一档**：
 *   - 带了 `base`（`{ 行号 → 行指纹 }`，页面从 `/api/data` 拿到的）：**按行判**——
 *     只比"这一轮真正改了的那些行"的指纹，别人改了别的行不再连坐（多人同时填表的日常）；
 *   - 只带了 `version`（机器人 / 旧页面 / 套件）：照旧整表指纹，对不上就 409（AQ-06 的老口径）。
 */
const save = async (caller, { sheet, rows, version, base }, req = null) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 500) throw new Error("一次提交的行数过多（>500）")
  /**
   * 走不走行级判据：`base` 只要**显式给了**（哪怕是空对象）就算新协议。
   *
   * 用"给没给"而不是"里面有没有值"来判：页面在"我这一行都不知道长什么样"（新增行）时
   * 给的就是空值，那本身也是一条信息（= 我认为这一行是空的）。
   */
  const rowLevel = base !== undefined && base !== null && typeof base === "object"
  /**
   * 群昵称里的不可见字符**在写入口就清掉**（维护者口径："直接用「随伦」显示"）
   *
   * 放在这里而不是"只改比较"：表里存的、页面上显示的、群里 @ 的都跟着干净，
   * 也不会再出现"表里这份和群名单那份写法不同"的连带问题（对面那份靠 `normNick` 兜底）。
   * 只动 `nickname` 一个字段，其它字段一个字不碰。
   */
  for (const r of rows) if (r?.values && typeof r.values.nickname === "string") r.values.nickname = cleanNickValue(r.values.nickname)
  /**
   * 行号格式先收干净：这一步**不依赖任何权限**，坏输入在进临界区之前就该被拒。
   *
   * 放在角色分支**之前**是有意的：`rowNumbersOf` 只管"是不是安全整数"，与"你是谁"无关；
   * 先判角色会让 `0 / -1 / "abc"` 这类坏行号在某些角色下走出不同的分支——`Number(x) || 0`
   * 会把它们静默吞成"第 0 行"，那样权限逻辑就得各自再防一遍。
   */
  const rowNums = rowNumbersOf(rows)
  if (caller.role === "guest") throw new Error("这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）")

  const bindStore = await store()
  const qq = caller.identity?.qq
  const nick = caller.identity?.nick
  /** 本群守卫：`true` 在名单里（可改整表，受额度）、`false` 不在（只读）、`null` 名单不可信（走老口径） */
  const member = memberStateOf(caller)
  if (member === false)
    throw new Error(
      "这个链接的身份不在本群成员名单里：只能查看，不能修改。若你确实在这个群里，请在群里发一次 #排队 取你自己那条链接；" +
        "若这是别人转发的链接，也请自己发 #排队。",
    )
  /** 可改整张排队区（受额度与红线）；`null`（名单不可信）时为 false ⇒ 走老口径 */
  const roam = member === true
  /**
   * **链接新旧**：手里的不是该 QQ 最新那一条 ⇒ 只读（本人重发一次 `#排队` 就等于把旧链作废）
   *
   * 放在这里（进写表队列之前）是有意的：被判只读的请求一个字都不该碰表、也不该进队列。
   */
  const linkState = linkStateOf(caller, req)
  if (linkState.stale)
    throw new Error(
      "这条链接已经被更新的那条取代了：只能查看，不能修改。请回群里重新发一次 #排队，用**最新**那条链接打开。",
    )
  let plan = null
  /** 这一轮要落进改动记录的条目（在临界区里算好，写表成功后由 `afterCommit` 落盘） */
  let changeRecords = []
  /** 这一轮动了几个"别人的行"（额度只在**写表成功之后**记账，被拒的尝试不占额度） */
  let quotaRows = 0
  /**
   * 这一轮被"整行清空"（页面上的「删除」）的行号：在临界区里收集，表写完之后按它压紧
   * （`compactClearedRows`）——删一行不该在序号列上留个空档，见那个函数的说明。
   */
  let clearedRows = []
  /**
   * 这一轮这一榜的「帮帮完成情况」真的变了（临界区里算）：表写完之后要做"昵称检测 + 立刻整理"
   * （`afterSaveFollowUp`）——状态一改，排序与名字立刻跟上，不等第二天早上那一趟。
   */
  let statusTouched = false
  let attackSortTouched = false

  const result = await table().mutate(
    async ctx => {
      /** 表里没有这个榜就在这里抛错——和写入读的是同一版表 */
      const model = ctx.model(sheet)
      /** 行号是不是成员数据区 / 合法追加：**排在归属与角色判断之前**（读的是同一版表） */
      assertMemberRows(model, rowNums)
      /** 版本对不上（整表替换过 / 外部改过表）：先按群昵称重新对账，再谈权限 */
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      let lockRows = state.locks
      const realigned = state.realigned

      const normalized = rowNums.map((row, i) => {
        const r = rows[i]
        const src = r?.values ?? {}
        const before = model.rows.find(x => x.row === row)
        const values = {}
        /** `clear: true`：退队专用，整行清空，且跳过必填校验（否则清空会被“必填不能为空”挡住） */
        if (r?.clear) {
          for (const f of FIELDS) values[f.key] = ""
          return { row, values, clear: true }
        }
        for (const f of FIELDS) {
          /** 前端漏传的字段按表里现有值处理：宁可不动，也不能当空串把内容清掉 */
          values[f.key] = src[f.key] !== undefined ? String(src[f.key]).trim() : String(before?.[f.key] ?? "").trim()
        }
        return { row, values }
      })

      const ignored = []
      /** 给前端看的"顺带做了什么"提示（与 ignored 区分：那是被拒的字段） */
      const notices = []

      /**
       * 没填的字段按默认值落表
       *
       *   帮帮完成情况 → 按各榜开榜时间（剧诗排队中 / 深渊看日子 / 危战等待开启）。
       * 只对"有内容的行"生效：整行留空是删除，不能被默认值救回来。
       */
      const isAttack = /攻炼|绝境/.test(String(sheet ?? ""))
      const defaults = { status: isAttack ? WAITING_STATUS : defaultStatusOf(sheet) }
      /** 服务端按枪战模式派生的状态：不受“本人只能填排队中”与主播锁回退 */
      const autoStatusRows = new Set()
      for (const r of normalized) {
        if (FIELDS.every(f => blank(r.values[f.key]))) continue
        if (!r.values.status) {
          r.values.status = isAttack ? attackPendingStatus(r.values.goal) : defaults.status
          autoStatusRows.add(r.row)
        }
        /**
         * 枪战的待处理状态跟随模式：已开放版本 → `7.0/7.2排队中`；
         * 未开放版本 → `7.3等待开启`；只改「等待开启 / 排队中」，不动完成状态。
         */
        if (
          isAttack &&
          r.values.goal &&
          (String(r.values.status).trim() === WAITING_STATUS || String(r.values.status).trim() === QUEUED_STATUS)
        ) {
          r.values.status = attackPendingStatus(r.values.goal)
          autoStatusRows.add(r.row)
        }
      }

      /**
       * 「本人已完成」落成这一行的群昵称
       *
       * 这次点的、以及表里早先留下的字面值，都一起换掉——否则界面上一直挂着「本人已完成」。
       * 换完的值和原值一样就什么都不做。
       */
      for (const r of normalized) {
        const before = model.rows.find(x => x.row === r.row)
        const next = statusWithSelfDone(r.values.status, r.values.nickname || before?.nickname)
        if (next === r.values.status) continue
        r.values.status = next
        notices.push({ row: r.row, text: `第 ${r.row} 行的「${SELF_DONE}」已按群昵称写成「${next}」` })
      }
      /**
       * 枪战完成状态带上版本：`7.2阿修Axiu 7.3等待开启`。
       * 只动枪战，且只包裸完成人；已经是复合状态的保持原样。
       */
      if (isAttack) {
        for (const r of normalized) {
          if (!r.values.goal) continue
          if (!parseAttackGoal(r.values.goal)) continue
          const s = String(r.values.status ?? "").trim()
          if (!s || s === WAITING_STATUS || s === QUEUED_STATUS) continue
          const before = model.rows.find(row => row.row === r.row)
          const followsChangedGoal = before && String(before.goal ?? "").trim() !== String(r.values.goal ?? "").trim() &&
            String(before.status ?? "").trim() === s
          const parts = attackStatusParts(s)
          if (!parts && statusTokens(s).some(token => attackStatusParts(token)))
            throw new Error("攻炼完成情况不能混用版本状态与裸姓名，请重新选择完成情况")
          r.values.status = attackCompletedStatus(r.values.goal, s)
          if (followsChangedGoal || (parts && !parts.some(part => part.kind === "done"))) autoStatusRows.add(r.row)
        }
      }
      /**
       * 按完成情况自动决定选择主播：
       * - 完成人全是本榜主播 ⇒ 写成这些主播（多人就多选）；
       * - 完成人混有本人/特殊人 ⇒ 写成「都可以」；
       * - 没有本榜主播（全是本人/特殊人/等待中）⇒ 不动。
       *
       * 放在完成情况归一之后，兼容 `7.1/7.2默秦 7.3等待开启` 这种复合值。
       */
      for (const r of normalized) {
        const before = model.rows.find(x => x.row === r.row)
        /**
         * 原始输入本身非法（「都可以」和其他主播并选）时不要自动改写，
         * 否则会绕过独占校验、把一次本该拒绝的保存变成成功。
         */
        const rawSelected = String(r.values.anchor ?? "")
          .split(/[,，、]/)
          .map(s => s.trim())
          .filter(Boolean)
        if (rawSelected.includes(PUBLIC_ANCHOR) && rawSelected.length > 1) continue
        const auto = autoAnchorOfStatus(
          statusLabels(r.values.status),
          r.values.nickname || before?.nickname,
          model.anchors,
        )
        if (auto.mode === "none") continue
        const selected = String(r.values.anchor ?? "")
          .split(/[,，、]/)
          .map(s => s.trim())
          .filter(Boolean)
        if (!selected.length) continue
        const wanted = auto.mode === "public" ? PUBLIC_ANCHOR : auto.anchors.join(",")
        if (selected.join(",") === wanted) continue
        const wasPublic = selected.includes(PUBLIC_ANCHOR)
        r.values.anchor = wanted
        if (auto.mode === "public") {
          notices.push({
            row: r.row,
            text: `完成人含本人/特殊人，选择主播已改为「${PUBLIC_ANCHOR}」`,
          })
        } else if (auto.anchors.length > 1) {
          notices.push({
            row: r.row,
            text: `完成人为多位主播，选择主播已改为「${auto.anchors.join("、")}」`,
          })
        } else {
          notices.push({
            row: r.row,
            text: wasPublic
              ? `「${PUBLIC_ANCHOR}」已按完成情况改为「${auto.anchors[0]}」`
              : `主播已按完成情况收窄为「${auto.anchors[0]}」`,
          })
        }
      }
      /** 属于自己的行：以 QQ 绑定为准（昵称兜底），与机器人 #排队 同一套口径 */
      const mine = new Set(
        caller.role === "self" ? [locateSelf(model, bindView(binds), sheet, qq, nick).row].filter(Boolean) : [],
      )

      if (caller.role === "self") {
        /** 这一轮动了几个"别人的行"（`roam` 时才可能非零）；额度只在这一轮**写表成功之后**记账 */
        const others = []
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const isMine = mine.has(r.row)
          const isNew = !before
          /**
           * 放行三类：**自己名下的行**、**表里还没有的空行**、以及（`roam` 时）**别人的行**。
           *
           * 新行**不按昵称判归属**：身份里没有群名片时（云端没收到群名单，链接身份里的 `n` 是空的），
           * 按昵称比会把新行判成"不是自己的"，于是**永远建不了行**。空行本来就没有主人，
           * 谁在页面里建都行，这不影响 AQ-02 要防的"同名抢已有行"。
           */
          if (isMine || isNew) continue
          /**
           * `roam`（名单可信且他在名单里）⇒ 别人的行也能改，但先过**三条红线里能在这里判的两条**。
           *
           * 这两条都是"不可逆 / 改身份"的动作，没有任何正常协作需要它们：
           * 清空别人的行 = 把人踢出队列；改别人那一行的群昵称 = 把别人顶掉（群昵称是"这行是谁"的依据）。
           * 它们**不计入额度**（额度是给"帮忙改"用的），直接拒 + 每次都私聊告警主人。
           */
          if (roam) {
            if (FIELDS.every(f => blank(r.values[f.key]))) {
              alertOwner(caller, {
                kind: "redline",
                force: true,
                text: `他试图**清空第 ${r.row} 行**（表里是「${String(before.nickname ?? "").trim() || "（无名）"}」）——已拒绝。这一行不是他的。`,
              })
              throw redLine(`清空第 ${r.row} 行（那是别人的行）`, "已经私聊告诉主人了；")
            }
            if (!blank(r.values.nickname) && String(before.nickname ?? "").trim() !== r.values.nickname) {
              alertOwner(caller, {
                kind: "redline",
                force: true,
                text: `他试图把第 ${r.row} 行的群昵称从「${String(before.nickname ?? "").trim() || "（空）"}」改成「${r.values.nickname}」——已拒绝。这一行不是他的。`,
              })
              throw redLine(`改第 ${r.row} 行的群昵称（那是别人的行，群昵称是"这一行是谁"的依据）`, "已经私聊告诉主人了；")
            }
            others.push(r.row)
            continue
          }
          throw new Error(`第 ${r.row} 行不是你的记录，只能改自己那一行`)
        }
        /**
         * 额度：**别人的行**一次最多 3 行、10 分钟最多 10 行（见 `editor/quota.js`）。
         *
         * 超了只拒**这一次**（一个字都不写）、并告警主人——被拒的尝试不占额度，
         * 否则一次手滑会把后面整个窗口锁死，用户明明只想补一格却怎么都存不进去。
         */
        if (others.length) {
          const verdict = quota.check(qq, others.length)
          if (!verdict.ok) {
            alertOwner(caller, {
              kind: "quota",
              text: `他一次要改 ${others.length} 位其他人的行（第 ${others.join("、")} 行）：${verdict.reason}——已拒绝。`,
            })
            throw redLine(`${verdict.reason}`, "已经私聊告诉主人了；")
          }
          quotaRows = others.length
        }
        /**
         * 主播改过的完成情况：本人不能再改，这一格忽略掉，其余照写
         *
         * **过期锁不算锁**（与下发 `statusLocked` 同一个判断，见 `lockIsLive`）：这一格现在已经
         * 是状态词（`排队中` / `等待开启`）或空时，那把锁不生效，本人照旧能改。
         */
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          if (autoStatusRows.has(r.row)) continue
          if (!before || !lockIsLive(before, lockRows, sheet)) continue
          if (r.values.status !== String(before.status ?? "").trim()) {
            r.values.status = String(before.status ?? "").trim()
            ignored.push({ row: r.row, label: "帮帮完成情况", reason: "已由主播填写" })
          }
        }
        /**
         * 普通人能把自己那一行填成的完成情况**只有两档**：`排队中`、`本人已完成`（2026-10-14 维护者口径）
         *
         * 判在「本人已完成 → 该行群昵称」转换**之后**：转换过的值就是这一行的群昵称，所以可写集合是
         * {「排队中」，本行群昵称}（群昵称为空时仍是字面「本人已完成」）。主播名 / 等待开启 / 任意文本
         * 一律**只忽略那一格并回报**——与"被主播锁住"同一套处理，同一发的备注 / 游戏名等不会被连带拒掉。
         *
         * 只管**自己那一行**：本群成员改别人的行仍按旧口径（受额度与主播锁约束），那是"帮别人打勾"，
         * 由主播锁与红线管，不在这里收窄。
         */
        for (const r of normalized) {
          /** 别人的行不在这里收窄（见上：额度 + 主播锁 + 红线） */
          if (!mine.has(r.row)) continue
          /** 这是服务端按目标模式归一出的状态，不是普通人手填的 token */
          if (autoStatusRows.has(r.row)) continue
          const before = model.rows.find(x => x.row === r.row)
          const prev = String(before?.status ?? "").trim()
          const now = String(r.values.status ?? "").trim()
          /** 没动这一格、或整行清空（＝删除）：不判 */
          if (!before || now === prev || blank(now)) continue
          const mineNick = String(r.values.nickname ?? before.nickname ?? "").trim()
          const writable = t => t === QUEUED_STATUS || t === SELF_DONE || (Boolean(mineNick) && t === mineNick)
          const labels = attackStatusParts(now)
            ? statusLabels(now).filter(token => !PENDING_STATUS.includes(token))
            : statusTokens(now)
          if (labels.every(writable)) continue
          r.values.status = prev
          ignored.push({ row: r.row, label: "帮帮完成情况", reason: `个人只能填「${QUEUED_STATUS}」或「${SELF_DONE}」` })
        }
      }

      const problems = validateRows(model, normalized.filter(r => !r.clear))
      if (problems.length) throw new Error(`校验未通过：\n${problems.slice(0, 6).join("\n")}`)

      /**
       * 行级冲突：我记的这一行，在我改它**之前**有没有被别人动过（只有带 `base` 的请求才走这里）
       *
       * 为什么按整行判、不去逐格比：页面提交一行 = 要把这一行**整个**写成它给我的样子
       * （自动保存提交的是整行，见 `editor.html` 的 `collectSaveRows`），所以"提交了 + 指纹对不上"
       * 就是冲突，不必再区分"改的是不是同一格"——那要逐格比三方（我的基线 / 我的新值 / 当前值），
       * 而页面已经把基线交出来了，逐行判既准又便宜。
       *
       * `base` 里**没有**这一行（页面认为这一行是空的、或者它是要新建的行）：要求表现在真的是空的，
       * 否则就是"这一行刚被别人填上了"——老口径下这种覆盖是静默发生的，正是要堵的那一类。
       */
      if (rowLevel) {
        const dirty = []
        for (const r of normalized) {
          if (!r.row) continue
          const want = String(base[r.row] ?? "")
          const before = model.rows.find(x => x.row === r.row)
          const now = before ? rowFingerprint(before) : ""
          if (want ? want !== now : Boolean(now)) dirty.push(r.row)
        }
        if (dirty.length) throw rowConflict(dirty)
      }

      /**
       * 昵称改了：「帮帮完成情况」里记着他旧昵称的 token 跟着换（口径见 `statusRenamePlan`）
       *
       * 放在「主播锁回退」与**校验之后**：提交上来的还是改名前的值（那一格写的就是旧昵称），
       * 先让校验按改之前的表判——换完的新昵称这一版表里还没有，拿去校验会被判成"不在下拉选项里"。
       *
       * 管理员改的是**别人**那一行，`caller.identity.qq` 是管理员自己的，不能当成这一行的主人；
       * 只有本人保存自己那一行时才把 QQ 交出去，其余一律按绑定反查（"宁可不动"）。
       */
      const statusWrites = new Map()
      const renames = normalized
        .map(r => ({ r, before: model.rows.find(x => x.row === r.row) }))
        .filter(
          ({ r, before }) =>
            before && r.row && !blank(r.values.nickname) && String(before.nickname ?? "").trim() !== r.values.nickname,
        )
      if (renames.length) {
        /** 这一轮每一行最终会写成什么完成情况：改名逐条叠加，后面的看得到前面几条的结果 */
        const working = new Map()
        const statusOf = row => {
          if (!working.has(row.row)) {
            const item = normalized.find(x => x.row === row.row)
            working.set(row.row, item ? item.values.status : String(row.status ?? "").trim())
          }
          return working.get(row.row)
        }
        for (const { r, before } of renames) {
          const plan = statusRenamePlan(model, {
            row: r.row,
            from: before.nickname,
            to: r.values.nickname,
            qq: caller.role === "self" ? qq : "",
            binds: bindView(binds),
            statusOf,
          })
          if (plan.skipped) notices.push({ row: r.row, text: plan.skipped })
          if (plan.changes.length)
            notices.push({
              row: r.row,
              text: `第 ${r.row} 行改名为「${r.values.nickname}」：帮帮完成情况里 ${plan.changes.length} 处跟着改了`,
            })
          for (const c of plan.changes) {
            working.set(c.row, c.status)
            const item = normalized.find(x => x.row === c.row)
            /** 这一轮提交里的行直接改提交值（写表循环会写它）；其余的行单独补写 */
            if (item) item.values.status = c.status
            else statusWrites.set(c.row, c.status)
          }
        }
      }

      /**
       * 管理员这一轮改动了哪些行的完成情况 → 这些行对本人上锁
       *
       * **锁记的是"有人把这一格写成了某位完成人"**（主播名，或落成群昵称的「本人已完成」）：
       * 写成状态词（`排队中` / `等待开启`）或清空**不是**"打完了"的标记，本人应当照旧能自己填——
       * 维护者口径（2026-10-14）：主播把完成情况改回「排队中」之后，本人可以继续改。
       * 所以"改了"不再等于"锁"，要看**改成的是什么值**（老口径是只要变了就锁）。
       */
      if (caller.role === "admin") {
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const after = String(r.values.status ?? "").trim()
          if (!before) continue
          if (after === String(before.status ?? "").trim()) continue
          const key = lockKey(sheet, r.row)
          const rowNick = String(r.values.nickname ?? before.nickname ?? "").trim()
          /** 状态词 / 空 / **本人自有标记**（本人已完成、本人群昵称）：删掉旧锁，那一格交还给本人 */
          if (!lockWorthy(after, rowNick)) delete lockRows[key]
          /** 锁上记下"锁的是谁"：整表替换 / 压紧行之后要靠它校验归属（AQ-03、AQ-08） */
          else lockRows[key] = { by: nick || "管理员", at: Date.now(), nickname: rowNick }
        }
      }
      /** 行被清空 = 这个人退队了，锁一并清掉 */
      for (const r of normalized)
        if (FIELDS.every(f => blank(r.values[f.key]))) delete lockRows[lockKey(sheet, r.row)]

      /**
       * 写表前留底：历史版本 + 每日/换月归档
       *
       * **这一条路要节流**（`AUTOSAVE_SNAPSHOT_MS` = 5 分钟）：页面上的改动是 1.5 秒防抖自动保存，
       * 每次写都留一份的话，一次编辑会话连存 20 次就把 `versionsKeep` 个版本位全吃光、
       * 滚动窗口只剩最近几秒（2026-10-08 复审 §2-#2，实测复现）。别的写入口（上传 / 回退 /
       * 整理 / 插队 / 名单同步 / 主播列表 / 归属重建）**不节流**：那些本来就少，而且都该留底。
       */
      const snapshot = await snapshotBeforeWrite({ throttleMs: AUTOSAVE_SNAPSHOT_MS })
      const m = ctx.model(sheet)
      /** 写之前先记下"这一轮新建出来的行"，写完再算就分不清新建和本来就有的行了 */
      const newRows = new Set(
        normalized.filter(r => r.row && !m.rows.some(x => x.row === r.row)).map(r => r.row),
      )
      let written = 0
      let cleared = 0
      for (const r of normalized) {
        if (!r.row) continue
        if (FIELDS.every(f => blank(r.values[f.key]))) {
          ctx.clearRow(sheet, r.row)
          /**
           * 只有"表里本来有内容的那一行"才算删掉了一行：空行被清空等于没动
           * （页面上的新增行点「取消」根本不提交，这里再兜一道）。
           */
          if (m.rows.some(x => x.row === r.row)) clearedRows.push(r.row)
          cleared++
          continue
        }
        for (const f of FIELDS) if (m.col?.[f.key]) ctx.setCell(sheet, r.row, f.key, r.values[f.key])
        written++
      }
      /**
       * 改名带出来的完成情况：这些行不在这一轮提交里（改的是**别人**对他的记录），单独补写
       *
       * 与上面那一批行号不重叠：提交里的行已经在 `r.values.status` 上改过（见 `statusRenamePlan` 那段）。
       */
      for (const [row, status] of statusWrites) if (m.col?.status) ctx.setCell(sheet, row, "status", status)

      /**
       * 这一轮「帮帮完成情况」**真的变了**的行 ⇒ 保存完成之后要立刻做一遍"昵称检测 + 整理"
       * （见 `afterSaveFollowUp`）
       *
       * 取的是**写表之前的表**与**这一轮最终要写进去的值**之差，所以三种改法都算数：
       * 提交里的那一格、服务端把「本人已完成」落成群昵称、以及改名连带改到的那一行（`statusWrites`）。
       * **整行清空的行不算**：那一行已经不在表里了（删行有自己的压紧动作），而删除本身改变不了
       * 剩下那些人的相对顺序——真乱序的话由每天那一趟兜底。
       * 新建的行也不算（表里本来没有它，谈不上"完成情况变了"）。
       */
      const statusChangedRows = []
      /** 攻炼的排序还吃目标；这格变了也要立刻整理，不能等第二天 */
      for (const r of normalized) {
        if (!r.row) continue
        const before = model.rows.find(x => x.row === r.row)
        if (!before) continue
        const clearedRow = FIELDS.every(f => blank(r.values[f.key]))
        if (clearedRow) continue
        if (String(r.values.status ?? "").trim() !== String(before.status ?? "").trim()) statusChangedRows.push(r.row)
        if (sheet === "绝境攻炼" && String(r.values.goal ?? "").trim() !== String(before.goal ?? "").trim())
          attackSortTouched = true
      }
      for (const [row, next] of statusWrites) {
        const before = model.rows.find(x => x.row === Number(row))
        if (!before) continue
        if (String(next ?? "").trim() !== String(before.status ?? "").trim()) statusChangedRows.push(Number(row))
      }
      statusTouched = statusChangedRows.length > 0

      /** 这一轮里手填的新名字（不在下拉里的）顺手归档成下拉选项 */
      writeValidationPlan(ctx, sheet, validationPlan(m))

      /** 归属变化：清空的行（退队）解绑；本人写过的行记下/刷新绑定，以后按 QQ 认人 */
      for (const r of normalized) {
        if (!r.row) continue
        if (FIELDS.every(f => blank(r.values[f.key]))) {
          dropBindsAt(binds, sheet, r.row)
          continue
        }
        /** 这一行现在的昵称变了：别人留下的旧绑定（昵称对不上）一并清掉 */
        dropBindsAt(binds, sheet, r.row, { keepNickname: r.values.nickname, keepQq: qq })
        /**
         * `newRows.has(r.row)`：本人**新建**的行也要绑给本人。
         * 否则没群名片的人在云端建完一行，下次再改就"又不是我的记录"了（表里已有内容、绑定却没建）。
         */
        if (
          caller.role === "self" &&
          qq &&
          (newRows.has(r.row) || mine.has(r.row) || sameNick(r.values.nickname, nick))
        ) {
          bindSet(binds, sheet, qq, { row: r.row, nickname: r.values.nickname || nick })
          renameLock(lockRows, sheet, r.row, r.values.nickname || nick)
        }
        /**
         * 从群名单候选里挑的那个群昵称 ⇒ **顺手把这一行绑给那个 QQ**
         *
         * 候选弹得出来只说明"名单读得到"，绑定是另一件事（只有本人写自己那行才有）——
         * 于是"从没领过行"的人改了群名片，谁也认不出来，也永远同步不了（维护者报"仅同步一半"、
         * 归属面板里只有寥寥几人）。判据沿用同一套：名字在这份群名单里**唯一命中**
         * （重名不绑，见 `rosterQqOfNick`），且那个 QQ **在这一榜还没绑到别的行**（不抢行）；
         * 上面那条 `dropBindsAt` 已经清掉"这一行原来绑给别人"的旧绑定。**只加绑定，表里一个值都不改。**
         */
        const nameQq = rosterQqOfNick(r.values.nickname)
        if (nameQq && !(binds[sheet] ?? {})[nameQq]) {
          binds[sheet] = binds[sheet] ?? {}
          bindSet(binds, sheet, nameQq, { row: r.row, nickname: r.values.nickname })
        }
      }
      /**
       * 留痕：这一轮**真正改了**哪些行、哪些字段
       *
       * 两处一起收口，缺一条就会答不出"这一格是谁改的"：
       *   1. `diffRows` 只认**实际差异**（提交整行 ≠ 改了这一行），且取的是**写完之后**的最终值
       *      （「本人已完成」落成群昵称、主播锁回退都发生在它之前）；
       *   2. 改名连带改到的那一行**不在这一轮提交里**（提交里那一行是改名的本人自己），
       *      单独补一条并标 `via: "改名连带"`——否则这些行一条记录都没有，
       *      而它们恰恰是"我怎么被改了"最需要看见的地方。
       *
       * `snapshot` 是**写这一笔之前**存下的那一份历史版本（`snapshotBeforeWrite` 的返回值）：
       * 页面上「回到这一笔之前」就靠它。自动保存那条路有 5 分钟节流，所以它常常是空串——
       * 空串 = 这一刻没有单独存底，面板会说明，不去猜是哪一份。
       */
      for (const item of diffRows(model, normalized)) changeRecords.push(editRecord(caller, sheet, item.row, item.changes, { snapshot }))
      for (const [row, to] of statusWrites) {
        const from = String(model.rows.find(x => x.row === Number(row))?.status ?? "").trim()
        changeRecords.push(editRecord(caller, sheet, Number(row), { status: [from, String(to ?? "").trim()] }, { via: "改名连带", snapshot }))
      }

      plan = { binds, locks: lockRows }
      return { written, cleared, ignored, notices, realigned }
    },
    {
      /** 行级判据已经在临界区里做过了；带了 `base` 就不再拿整表指纹连坐（见 `save` 的说明） */
      expect: rowLevel ? undefined : version,
      /** 表写成功之后、**仍在同一个临界区里**：归属状态 / 改动记录 / 额度搭同一趟车 */
      afterCommit: async info => {
        await persistState(info, plan)
        recordChanges(changeRecords.map(r => ({ ...r, version: info.fp })))
        if (clearedRows.length) changes.remap(sheet, Object.fromEntries(clearedRows.map(row => [row, 0])))
        /** 额度只在**写成功之后**记账（被拒的尝试不占额度，见 `editor/quota.js`） */
        if (quotaRows) quota.commit(qq, quotaRows)
      },
    },
  )

  /**
   * 删行之后**立刻**把下面的行提上来：页面上的序号从 14 跳到 17，就是因为中间那一行空着却还占着一个行号
   * （A 列是 `=ROW()-k` 的按行公式，而页面只画"还有内容的行"）。口径与"退群删行 / 主人确认删候选行"
   * 一样，共用 `dropRowsAndMigrate`（绑定与完成情况锁的行号一起搬）。没清空任何一行时一个字都不写。
   *
   * 这一步**另起一个临界区**，不塞进上面那一趟：那一趟里 `setCell` / `clearRow` 都还只是排队的写入，
   * 而 `compactSheet` 要按行读内容再搬，读到的会是清空前的旧值（等于把刚删的那一行搬回来）。
   */
  const compacted = await compactClearedRows(sheet, clearedRows)

  /**
   * 改了「帮帮完成情况」⇒ **立刻生效**：昵称检测（改名同步、退群只报不删）+ 新三段式整理
   * （已完成 → 等待开启 → 排队中，组内难度/目标/强度），
   * 见 `afterSaveFollowUp`。压紧之后才做，这样它读到的行号就是最终的。
   */
  const followUp = await afterSaveFollowUp(caller, sheet, statusTouched, attackSortTouched)

  /**
   * 这一轮**搬过行**的话，把"老行号 → 最终行号"一起回执给页面
   *
   * 两次搬动（删行压紧 / 改了完成情况立刻整理）合成一份：搬行的意思是"第 N 行换人了"，
   * 而页面上的草稿是按 (榜 × 行号) 存的——不搬草稿键，下一次自动保存就会拿这个人的值
   * 去写那一行现在的人（被红线拒掉、草稿永久卡住，或者把别人顶掉）。
   */
  const rowMap = composeRowMap(compacted?.shift, followUp?.shift)
  /**
   * 改动记录也要跟着人搬到最终行号：`row` / `currentRows` 是历史事实不动，
   * 只更新用于可见范围的 `current`。否则整理之后本人按新行号筛不到"别人改过我的行"。
   */
  if (followUp?.shift && Object.keys(followUp.shift).length) changes.remap(sheet, followUp.shift)

  return {
    ...result,
    ...(compacted?.compacted ? { compacted: compacted.compacted } : {}),
    ...(followUp ? { nickSync: followUp.nickSync, ...(followUp.tidied ? { tidied: followUp.tidied } : {}) } : {}),
    ...(Object.keys(rowMap).length ? { rowMap } : {}),
  }
}

  /**
   * 固定入口页的口令兑换：6 位口令 → 完整链接（**只读**，公开端点用）
   *
   * 实现在 `model/editor-links.js`（登记簿 + 5 分钟 TTL），这里只把"口令 → 链接"照原样包一层：
   * 逻辑与搬之前的 `/api/link-code` 端点一字不差，换不到就回 `url: null`，端点据此回 410。
   * `caller` 只为保持动作层的签名一致——这个端点**公开**，没有身份，也不该借它做权限。
   * @param {null|{qq?:string, nick?:string}} caller
   * @param {{code?: string}} [body]
   * @returns {Promise<{url: string|null}>}
   */
  const linkCode = async (caller, { code } = {}) => ({ url: linkByCode(String(code ?? "").trim()) ?? null })

  return { moveRow, tidy, roster, save, checkDone, cycleStatus, cycle, linkCode, health }
}
