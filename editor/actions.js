/** 编辑器的"动作"层：一个动作 = 一次表变更 + 审计 + 改动记录 */

const cycleError = (statusCode, extra, message) => Object.assign(new Error(message), { statusCode, ...extra })

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
    linkByCode,
    CYCLE_PROTOCOL,
    cycleExclusive,
    loadCycleLedger,
    saveCycleLedger,
    readCycleIntent,
    createCycleIntent,
    removeCycleIntent,
    isDoneStatus,
    loadRoster,
    saveRoster,
    reconcileRoster,
    nickCandidates,
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
  const health = () => {
    const roster = loadRoster()
    return { version, mount: mount || "", roster: (roster.members ?? []).length }
  }
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
  const tidy = async (caller, { sheet } = {}) => {
    const out = await tidySheetsCore(String(sheet ?? "").trim())
    for (const [name, map] of Object.entries(out.shiftRows ?? {}))
      if (map && Object.keys(map).length) changes.remap(name, map)
    return out
  }
  const roster = async (caller, body) => {
    const members = Array.isArray(body?.members) ? body.members.slice(0, 5000) : null
    if (!members) throw rosterError("缺少 members")
    const previous = loadRoster()
    if (!members.length && (previous.members ?? []).length)
      throw rosterError("推来的是空名单，拒绝按它对账（先确认机器人取成员是否正常）")
    saveRoster({ group: body?.group, members })
    const out = await reconcileRoster(members)
    return { ok: true, total: members.length, ...out, candidates: nickCandidates().length }
  }
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
            const auto = isAttack
              ? parts?.some(part => part.kind === "done")
                ? attackCompletedStatus(r.goal, raw)
                : attackPendingStatus(r.goal)
              : QUEUED_STATUS
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
      rowMap: changeRowMap,
    }
  }
  const cycleStatus = async (caller, { eventKey } = {}) => {
    const key = String(eventKey ?? "").trim()
    if (!key) throw new Error("缺少 eventKey")
    const ledger = await loadCycleLedger()
    const done = Boolean(ledger.done[key])
    const pending = !done && Boolean(await readCycleIntent(key))
    return { protocol: CYCLE_PROTOCOL, done, pending }
  }
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
          await removeCycleIntent(eventKey).catch(() => {})
          throw cycleError(409, { conflict: true }, err?.message ?? "表格版本冲突")
        }
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
        throw cycleError(500, { pending: true }, `清榜已提交，但完成账本写入失败，已停止自动重放：${err?.message ?? err}`)
      }
      try {
        await removeCycleIntent(eventKey)
      } catch {
      }
      return out
    })
  }
const save = async (caller, { sheet, rows, version, base }, req = null) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 500) throw new Error("一次提交的行数过多（>500）")
  const rowLevel = base !== undefined && base !== null && typeof base === "object"
  for (const r of rows) if (r?.values && typeof r.values.nickname === "string") r.values.nickname = cleanNickValue(r.values.nickname)
  const rowNums = rowNumbersOf(rows)
  if (caller.role === "guest") throw new Error("这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）")
  const bindStore = await store()
  const qq = caller.identity?.qq
  const nick = caller.identity?.nick
  const member = memberStateOf(caller)
  if (member === false)
    throw new Error(
      "这个链接的身份不在本群成员名单里：只能查看，不能修改。若你确实在这个群里，请在群里发一次 #排队 取你自己那条链接；" +
        "若这是别人转发的链接，也请自己发 #排队。",
    )
  const roam = member === true
  let plan = null
  let changeRecords = []
  let quotaRows = 0
  let clearedRows = []
  let statusTouched = false
  let attackSortTouched = false
  const result = await table().mutate(
    async ctx => {
      const model = ctx.model(sheet)
      assertMemberRows(model, rowNums)
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      let lockRows = state.locks
      const realigned = state.realigned
      const normalized = rowNums.map((row, i) => {
        const r = rows[i]
        const src = r?.values ?? {}
        const before = model.rows.find(x => x.row === row)
        const values = {}
        if (r?.clear) {
          for (const f of FIELDS) values[f.key] = ""
          return { row, values, clear: true }
        }
        for (const f of FIELDS) {
          values[f.key] = src[f.key] !== undefined ? String(src[f.key]).trim() : String(before?.[f.key] ?? "").trim()
        }
        return { row, values }
      })
      const ignored = []
      const notices = []
      const isAttack = /攻炼|绝境/.test(String(sheet ?? ""))
      const defaults = { status: isAttack ? WAITING_STATUS : defaultStatusOf(sheet) }
      const autoStatusRows = new Set()
      for (const r of normalized) {
        if (FIELDS.every(f => blank(r.values[f.key]))) continue
        if (!r.values.status) {
          r.values.status = isAttack ? attackPendingStatus(r.values.goal) : defaults.status
          autoStatusRows.add(r.row)
        }
        if (
          isAttack &&
          r.values.goal &&
          (String(r.values.status).trim() === WAITING_STATUS || String(r.values.status).trim() === QUEUED_STATUS)
        ) {
          r.values.status = attackPendingStatus(r.values.goal)
          autoStatusRows.add(r.row)
        }
      }
      for (const r of normalized) {
        const before = model.rows.find(x => x.row === r.row)
        const next = statusWithSelfDone(r.values.status, r.values.nickname || before?.nickname)
        if (next === r.values.status) continue
        r.values.status = next
        notices.push({ row: r.row, text: `第 ${r.row} 行的「${SELF_DONE}」已按群昵称写成「${next}」` })
      }
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
      for (const r of normalized) {
        const before = model.rows.find(x => x.row === r.row)
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
      const mine = new Set(
        caller.role === "self" ? [locateSelf(model, bindView(binds), sheet, qq, nick).row].filter(Boolean) : [],
      )
      if (caller.role === "self") {
        const others = []
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const isMine = mine.has(r.row)
          const isNew = !before
          if (isMine || isNew) continue
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
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          if (autoStatusRows.has(r.row)) continue
          if (!before || !lockIsLive(before, lockRows, sheet)) continue
          if (r.values.status !== String(before.status ?? "").trim()) {
            r.values.status = String(before.status ?? "").trim()
            ignored.push({ row: r.row, label: "帮帮完成情况", reason: "已由主播填写" })
          }
        }
        for (const r of normalized) {
          if (!mine.has(r.row)) continue
          if (autoStatusRows.has(r.row)) continue
          const before = model.rows.find(x => x.row === r.row)
          const prev = String(before?.status ?? "").trim()
          const now = String(r.values.status ?? "").trim()
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
      const statusWrites = new Map()
      const renames = normalized
        .map(r => ({ r, before: model.rows.find(x => x.row === r.row) }))
        .filter(
          ({ r, before }) =>
            before && r.row && !blank(r.values.nickname) && String(before.nickname ?? "").trim() !== r.values.nickname,
        )
      if (renames.length) {
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
            if (item) item.values.status = c.status
            else statusWrites.set(c.row, c.status)
          }
        }
      }
      if (caller.role === "admin") {
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const after = String(r.values.status ?? "").trim()
          if (!before) continue
          if (after === String(before.status ?? "").trim()) continue
          const key = lockKey(sheet, r.row)
          const rowNick = String(r.values.nickname ?? before.nickname ?? "").trim()
          if (!lockWorthy(after, rowNick)) delete lockRows[key]
          else lockRows[key] = { by: nick || "管理员", at: Date.now(), nickname: rowNick }
        }
      }
      for (const r of normalized)
        if (FIELDS.every(f => blank(r.values[f.key]))) delete lockRows[lockKey(sheet, r.row)]
      const snapshot = await snapshotBeforeWrite({ throttleMs: AUTOSAVE_SNAPSHOT_MS })
      const m = ctx.model(sheet)
      const newRows = new Set(
        normalized.filter(r => r.row && !m.rows.some(x => x.row === r.row)).map(r => r.row),
      )
      let written = 0
      let cleared = 0
      for (const r of normalized) {
        if (!r.row) continue
        if (FIELDS.every(f => blank(r.values[f.key]))) {
          ctx.clearRow(sheet, r.row)
          if (m.rows.some(x => x.row === r.row)) clearedRows.push(r.row)
          cleared++
          continue
        }
        for (const f of FIELDS) if (m.col?.[f.key]) ctx.setCell(sheet, r.row, f.key, r.values[f.key])
        written++
      }
      for (const [row, status] of statusWrites) if (m.col?.status) ctx.setCell(sheet, row, "status", status)
      const statusChangedRows = []
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
      writeValidationPlan(ctx, sheet, validationPlan(m))
      for (const r of normalized) {
        if (!r.row) continue
        if (FIELDS.every(f => blank(r.values[f.key]))) {
          dropBindsAt(binds, sheet, r.row)
          continue
        }
        dropBindsAt(binds, sheet, r.row, { keepNickname: r.values.nickname, keepQq: qq })
        if (
          caller.role === "self" &&
          qq &&
          (newRows.has(r.row) || mine.has(r.row) || sameNick(r.values.nickname, nick))
        ) {
          bindSet(binds, sheet, qq, { row: r.row, nickname: r.values.nickname || nick })
          renameLock(lockRows, sheet, r.row, r.values.nickname || nick)
        }
        const nameQq = rosterQqOfNick(r.values.nickname)
        if (nameQq && !(binds[sheet] ?? {})[nameQq]) {
          binds[sheet] = binds[sheet] ?? {}
          bindSet(binds, sheet, nameQq, { row: r.row, nickname: r.values.nickname })
        }
      }
      for (const item of diffRows(model, normalized)) changeRecords.push(editRecord(caller, sheet, item.row, item.changes, { snapshot }))
      for (const [row, to] of statusWrites) {
        const from = String(model.rows.find(x => x.row === Number(row))?.status ?? "").trim()
        changeRecords.push(editRecord(caller, sheet, Number(row), { status: [from, String(to ?? "").trim()] }, { via: "改名连带", snapshot }))
      }
      plan = { binds, locks: lockRows }
      return { written, cleared, ignored, notices, realigned }
    },
    {
      expect: rowLevel ? undefined : version,
      afterCommit: async info => {
        await persistState(info, plan)
        recordChanges(changeRecords.map(r => ({ ...r, version: info.fp })))
        if (clearedRows.length) changes.remap(sheet, Object.fromEntries(clearedRows.map(row => [row, 0])))
        if (quotaRows) quota.commit(qq, quotaRows)
      },
    },
  )
  const compacted = await compactClearedRows(sheet, clearedRows)
  const followUp = await afterSaveFollowUp(caller, sheet, statusTouched, attackSortTouched)
  const rowMap = composeRowMap(compacted?.shift, followUp?.shift)
  if (followUp?.shift && Object.keys(followUp.shift).length) changes.remap(sheet, followUp.shift)
  return {
    ...result,
    ...(compacted?.compacted ? { compacted: compacted.compacted } : {}),
    ...(followUp ? { nickSync: followUp.nickSync, ...(followUp.tidied ? { tidied: followUp.tidied } : {}) } : {}),
    ...(Object.keys(rowMap).length ? { rowMap } : {}),
  }
}

  const linkCode = async (caller, { code } = {}) => ({ url: linkByCode(String(code ?? "").trim()) ?? null })
  return { moveRow, tidy, roster, save, checkDone, cycleStatus, cycle, linkCode, health }
}
