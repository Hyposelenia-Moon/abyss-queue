/**
 * 队列视图：把表读成前端要的 payload（`buildPayload`）以及它用到的行/视图小工具。
 *
 * 从 `editor.mjs` 抽出来的原因：装配根里这一坨是「读」的一半（另一半是写），
 * 混在路由与写动作中间看不出边界。这里只读表、只算展示值，不写任何东西。
 *
 * 依赖怎么来：服务单例（表、绑定、名单、版本、额度、审计）由装配根先 `installCtx`
 * 放进 `ctx`，本模块只读——直接 import 那些服务会与装配根成环。
 */
import fs from "node:fs"
import { attackStatusParts } from "../components/attack.js"
import { canonicalAnchor, compileAliases } from "../components/aliases.js"
import { groupNameOfAnchor, readAnchorNames } from "../model/anchor-names.js"
import { extraNamesOf } from "./cycle-ledger.js"
import { ctx } from "./ctx.js"
import { FIELDS, MOVE_COLUMN_KEYS, ANCHOR_FIELDS, blank, WAITING_STATUS, QUEUED_STATUS, OPEN_RULES, PUBLIC_ANCHOR, PUBLIC_QUEUE_NAME, SHEET_SHORT, sheetShortOf, ANCHOR_CALL_COOLDOWN_MS, ANY_ANCHOR, PENDING_STATUS, SELF_DONE, EXCLUSIVE_VALUES, ANCHOR_FIRST_ROW, APPEND_ROWS_MAX, REPLACE_REQUIRED_COLUMNS, CYCLE_PROTOCOL } from "./defs.js"
import { bindView } from "./ownership.js"
import { attackDisplayStatus, cycleDisplayStatus, defaultStatusOf, isDoneStatus, statusLabels, statusWithSelfDone } from "./status.js"



/**
 * 群昵称里的**不可见字符**（C0/C1 控制符）——落表前清掉、比较时也清掉
 *
 * 现场（维护者报"群昵称没有自动同步 / 仅同步一半"）：某位成员的群昵称里夹着
 * `\u0005\u0012\u0003`、`\n` 之类，而且表里那份与群名单那份**还不一样**
 * （一处夹**空格**、一处夹**换行**）——两边看着都是「随伦」，逐字比却永远不相等，
 * 于是认不出人、绑不上、也同步不了（还会一直被列进「退群候选行」）。
 *
 * 维护者定的口径：**"特殊字符特殊处理，例如直接用 `随伦` 显示"** ⇒
 *   - `cleanNickValue`：**写入口**用它，表里存的就是干净的名字（界面上自然显示成「随伦」）；
 *   - `normNick`：**只用于比较**，对面是群名单（那份不归我们改）时靠它兜底。
 */
export const cleanNickValue = value => String(value ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "")

/** 比群昵称用（清理 + trim + 小写）；**不改任何要落表的值**，见 `cleanNickValue` 的注释 */

export const normNick = value => cleanNickValue(value).trim().toLowerCase()

/** 群名单里这个群昵称对应谁（**唯一命中**才给建议；重名 / 查不到就空）——白名单审计与"选名字就绑 QQ"共用 */

export const rosterQqOfNick = nick => {
  const want = normNick(nick)
  if (!want) return ""
  const hits = (ctx.roster.loadRoster().members ?? []).filter(m => normNick(m?.nick) === want)
  return hits.length === 1 ? String(hits[0].qq ?? "") : ""
}

/**
 * 主播名 → QQ。
 *
 * 先看 `data/anchor-names.json`（`表内名 → 群名/QQ`，开榜播报的同一份映射），
 * 再按 `anchor_aliases` 归一后查群名单。现场表里写「赐次」、群名单写「S赐次」，
 * 单靠 `anchor_aliases` 不一定覆盖，必须让名字映射优先。
 */
export const anchorQqOf = (name, mapping = null) => {
  const text = String(name ?? "").trim()
  if (!text) return ""
  const names = mapping ?? readAnchorNames()
  const mapped = String(groupNameOfAnchor(text, names) ?? "").trim()
  const list = compileAliases(ctx.config.anchor_aliases)
  const canonical = canonicalAnchor(text, list)
  const mappedCanonical =
    canonical === text ? mapped : String(groupNameOfAnchor(canonical, names) ?? "").trim()
  /**
   * 候选四个方向都试：表名、正名、名字映射值、正名对应的映射值。
   * 映射值可能是群昵称，也可能直接是 QQ——两种都要认。
   */
  const candidates = new Set([text, canonical, mapped, mappedCanonical])
  for (const a of list) {
    if (a.name !== canonical && !a.re.test(text) && !a.re.test(canonical)) continue
    candidates.add(a.name)
    /** 正则 pattern 只当规则用，不能当群昵称字面量；字面量才加入候选 */
    if (!/[.*+?^${}()|[\]\\]/.test(a.pattern)) candidates.add(a.pattern)
  }
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim()
    if (!value) continue
    if (/^\d{5,12}$/.test(value)) return value
    const qq = rosterQqOfNick(value)
    if (qq) return qq
  }
  return ""
}

/**
 * 主播级排队人数（当前榜只读计算，不写表）。
 *
 * 同一行多主播只按主播各计一次；攻炼复合状态里只要有排队中就算 queued，
 * 否则有等待开启算 waiting，全部段都完成才算 done；空行不计。
 */
export const anchorQueueCounts = model => {
  const out = new Map()
  const anchorNames = new Set(
    (model?.anchors ?? []).map(a => String(a.name ?? "").trim()).filter(Boolean),
  )
  const bump = (name, kind) => {
    if (!name) return
    const c = out.get(name) ?? { queued: 0, waiting: 0, done: 0 }
    c[kind] += 1
    out.set(name, c)
  }

  for (const row of model?.rows ?? []) {
    const parts = attackStatusParts(row.status)
    const kind = parts
      ? parts.some(p => p.kind === "queued")
        ? "queued"
        : parts.some(p => p.kind === "waiting")
          ? "waiting"
          : "done"
      : String(row.status ?? "").trim() === QUEUED_STATUS
        ? "queued"
        : String(row.status ?? "").trim() === WAITING_STATUS
          ? "waiting"
          : isDoneStatus(row.status)
            ? "done"
            : ""
    if (!kind) continue

    const selected = new Set(
      String(row.anchor ?? "")
        .split(/[,，、]/)
        .map(s => s.trim())
        .filter(Boolean),
    )

    /**
     * 完成数按**真正写在完成情况里的完成人**统计，不按“选的主播”统计：
     * - 本人完成（status == 行昵称）不记给任何主播；
     * - 别人替打时，记给实际完成人，哪怕不是本行选的主播。
     *
     * 排队/等待仍按本行选的主播统计；`公共队列` 单独进公共队列。
     */
    if (kind === "done") {
      if (selected.has(PUBLIC_ANCHOR)) {
        bump(PUBLIC_ANCHOR, "done")
        continue
      }
      const nick = String(row.nickname ?? "").trim()
      const labels = statusLabels(row.status)
        .map(s => s.trim())
        .filter(s => s && s !== nick && s !== SELF_DONE && !PENDING_STATUS.includes(s))
      for (const label of new Set(labels)) {
        if (anchorNames.has(label)) bump(label, "done")
      }
      continue
    }

    for (const name of selected) bump(name, kind)
  }
  return out
}

export const queueTextOf = c => {
  const bits = []
  if (c?.queued) bits.push(`排队 ${c.queued}`)
  if (c?.waiting) bits.push(`等待 ${c.waiting}`)
  if (c?.done) bits.push(`完成 ${c.done}`)
  return bits.join(" · ") || "排队 0"
}

/**
 * 主播名右侧的状态胶囊：按状态分颗显示，不把等待/完成藏进“主导状态”。
 *
 * 只显示非 0 项；三类都为 0 时仍保留蓝色「排队中 0」，
 * 与旧版「排队中 0 人」的视觉口径一致。
 */
export const queuePillsOf = c => {
  const pills = []
  if (c?.queued) pills.push({ label: `排队中 ${c.queued}`, tone: "status-queued" })
  if (c?.waiting) pills.push({ label: `等待开启 ${c.waiting}`, tone: "status-attack-waiting" })
  if (c?.done) pills.push({ label: `已完成 ${c.done}`, tone: "status-self" })
  return pills.length ? pills : [{ label: "排队中 0", tone: "status-queued" }]
}

/** 公共队列：表中“公共队列”不是某位主播，但它的单量要单独成行展示 */
import {
  assertMemberRows,
  changeAuthor,
  composeRowMap,
  diffRows,
  editRecord,
  redLine,
  rowConflict,
  rowFingerprint,
  rowNumbersOf,
  sameNick,
  validateRows,
} from "./rows.js"
import { effectiveOptions } from "./anchors.js"

export const buildPayload = async (caller, req = null, seen = null) => {
  const locks = ctx.acl.loadLocks().rows
  /**
   * 本群守卫只算一次：`/api/data` 里先算好再传进来（判定「只读」与裁行要用同一份）。
   * 分头各算一遍，两处口径迟早漂移。
   */
  /** 本群守卫：`true` 在名单里、`false` 不在、`null` 名单不可信 */
  const member = seen ? seen.member : memberStateOf(caller)
  /**
   * **读的口径跟着写的口径走**：本群成员既然能（按额度）改别人的行，就必须看得到整张表——
   * 否则"能改一条看不见的行"没有意义。这也是 `AGENTS.md` §十-1 定的**口径 A**
   * （本群成员可见整表；代价是别人的游戏名 / 备注 / 完成情况对他们可见）。
   *
   * 名单不可信时**退回老口径**（只给自己那些行）：那时也谈不上"改别人的行"。
   */
  const roam = member === true
  const mine = caller.role === "self" ? await ctx.ownership.mineRows(caller) : null
  /** 呼叫列只给管理员：顺手把每一行能不能呼叫算好，前端不用再猜 */
  const bindStore = caller.role === "admin" ? await ctx.store() : null
  const binds = bindStore ? bindView(bindStore.data.binds ?? {}) : null
  const data = await ctx.table().read(({ models }) => {
    const sheets = []
    for (const model of models.values()) {
      const rows = model.rows
        .filter(r => caller.role !== "self" || roam || mine.get(model.name)?.has(r.row))
        .map(r => {
          /** seq 是表里 A 列那个序号（公式算出来的 1..N），界面第一列要显示它，不能拿表格行号冒充 */
          const o = { row: r.row, seq: r.seq ?? "" }
          for (const f of FIELDS) o[f.key] = r[f.key] ?? ""
          /** 表里还挂着字面「本人已完成」时：界面上直接显示成这一行的群昵称 */
          o.status = statusWithSelfDone(o.status, o.nickname)
          /** 裸「排队中/等待开启」按当前日历显示；旧周期留下的值不应继续骗人 */
          o.status = cycleDisplayStatus(model.name, o.status)
          /** 枪战状态随版本开放时间派生：刷新页面就要看到 7.2排队中，不必等下一次保存 */
          o.status = attackDisplayStatus(model.name, o.goal, o.status)
          o.statusLocked = caller.role !== "admin" && ctx.lockIsLive(r, locks, model.name)
          if (caller.role === "admin") {
            const call = callTargetOf(binds, model.name, r.row, o.nickname)
            const parts = attackStatusParts(o.status)
            const queued = parts ? parts.some(part => part.kind === "queued") : o.status === QUEUED_STATUS
            o.callable = call.ok && queued
            o.callReason = !queued ? "该成员不在排队中，无法呼叫" : call.ok ? "" : call.error
          }
          /**
           * 这一行的指纹（乐观并发的凭据）：页面存着它，保存时原样带回来当 `base`
           *
           * **算的是表里的原值 `r`，不是上面改造过的 `o`**：`o.status` 可能已被换成群昵称，
           * 而保存时手上拿到的 `before` 是原值——同一个来源才对得上（见 `rowFingerprint`）。
           */
          o.fp = rowFingerprint(r)
          return o
        })
      const anchors = model.anchors.map(a => a.name).filter(Boolean)
      sheets.push({
        name: model.name,
        title: model.title,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        /**
         * 「选择主播」的下拉**以主播列表为准**（表格里的下拉验证常常跟不上主播区的改动）：
         * 选项就是表头上方那几位主播，顺序也按表内顺序；表里已有的旧值由前端按行补上，不会丢。
         */
        options: effectiveOptions(model),
        /** 本月本榜手动收录的临时成员：页面用紫色胶囊区分，不写进 xlsx 下拉 */
        statusTemp: extraNamesOf(model.name),
        anchors,
        rows,
        /**
         * 别人占了哪些行号（只发给本人）
         *
         * 本人只拿得到自己那几行，前端「新增一行」如果只按拿到的行号找空位，
         * 会挑中别人正占着的行，保存时被拒（第 N 行不是你的记录）。
         */
        taken: caller.role === "self" ? model.rows.map(r => r.row) : undefined,
        /** 新行的默认值：完成情况按这个榜的开榜时间算 */
        defaults: { status: /攻炼|绝境/.test(model.name) ? WAITING_STATUS : defaultStatusOf(model.name) },
        /** 表头上方的主播列表：所有人可读；只有管理员能改（前端按 role 决定输入框/保存按钮） */
        anchorRows: (() => {
          const counts = anchorQueueCounts(model)
          const rowOf = (a, c, extra = {}) => {
            const queuePills = queuePillsOf(c)
            return {
              row: a.row,
              name: a.name,
              recommend: a.recommend,
              duty: a.duty,
              skills: a.skills,
              platform: a.cells?.platform ?? "",
              link: a.cells?.link ?? "",
              entry: a.entry,
              queued: c.queued,
              waiting: c.waiting,
              done: c.done,
              queueText: queueTextOf(c),
              queuePills,
              callable: Boolean(extra.callable),
              callReason: extra.callReason ?? "",
              isPublic: Boolean(extra.isPublic),
            }
          }
          const out = []
          for (const a of model.anchors) {
            /** “公共队列”只作为公共队列展示，不能混进真实主播行 */
            if (String(a.name ?? "").trim() === PUBLIC_ANCHOR) continue
            const callQq = anchorQqOf(a.name)
            const c = counts.get(String(a.name ?? "").trim()) ?? { queued: 0, waiting: 0, done: 0 }
            out.push(rowOf(a, c, {
              callable: Boolean(callQq),
              callReason: callQq ? "" : "群名单里找不到唯一对应的主播 QQ（含别名归一）",
            }))
          }
          return out
        })(),
        /**
         * 公共队列（选“公共队列”的人）挂在主播表头右侧，不再单独占一行。
         * 计数仍来自同一份 anchorQueueCounts；前端只读展示。
         */
        publicQueue: (() => {
          const c = anchorQueueCounts(model).get(PUBLIC_ANCHOR)
          /**
           * 公共队列保留「排队中」和「等待开启」。
           * 完成人可能根本不是主播或本人，公共队列的「已完成」有歧义，仍不展示。
           */
          const queuePills = []
          if (c?.queued) queuePills.push({ label: `排队中 ${c.queued}`, tone: "status-queued" })
          if (c?.waiting) queuePills.push({ label: `等待开启 ${c.waiting}`, tone: "status-attack-waiting" })
          if (!queuePills.length) return null
          return {
            name: PUBLIC_QUEUE_NAME,
            queued: c.queued,
            queuePills,
          }
        })(),
      })
    }
    return { sheets }
  })
  return {
    file: ctx.xlsxPath,
    fields: FIELDS,
    /**
     * 这一版表的编号（文件指纹）
     *
     * 页面拿它做乐观并发：保存时原样带回来，服务端发现表已经变了就报冲突，
     * 而不是把别人刚提交的改动无声盖掉（AQ-06）。
     */
    version: ctx.table().version,
    /**
     * 群昵称候选（机器人推来的群成员名单）：本地编辑器收不到名单，这里是空的
     *
     * **只给本群的人**：候选就是整群一百多号人的名片，名单判定为"不在本群"的人
     * （`member === false`，拿着别群链接进来）没有理由拿到——他们连别人的行都看不到。
     * 只凭口令进来、没有链接身份的只读访客照旧能拿（他们本来就看得到整张表的名片）。
     */
    roster: (() => {
      const r = ctx.roster.loadRoster()
      const canSee = member !== false
      return {
        group: r.group,
        updatedAt: r.updatedAt,
        count: (r.members ?? []).length,
        candidates: canSee ? ctx.roster.nickCandidates() : [],
      }
    })(),
    sheets: data.sheets,
    /**
     * 服务端认出来的「本人行」：`{ 榜名: [行号] }`，每榜最多一行
     *
     * 填写页据此显示「我的报名」，不再自己按昵称猜——导入过同名历史行时，
     * 页面按昵称找会把别人那行当成自己（复查 2026-11-24 第 5 条）。
     * 只有本人身份（`role=self`）才有值；管理员 / 访客视图不下发。
     */
    mineRows: mine
      ? Object.fromEntries([...mine].map(([name, rows]) => [name, [...rows]]))
      : undefined,
    savedAt: fs.existsSync(ctx.statePath) ? fs.statSync(ctx.statePath).mtime.toLocaleString("zh-CN") : "",
    /** 四榜的清榜安排（页面「清榜安排」页只负责显示，不自己算日期） */
    cycles: ctx.cyclePlan(),
    perm: {
      role: caller.role,
      /**
       * 只读：访客，或**本群守卫判定他不在本群里**（转发到群外 / 退群了）
       */
      readonly: caller.role === "guest" || member === false,
      /**
       * 这条链接的身份**不在本群成员名单里**（名单可信时才可能为 true）
       *
       * 页面按它说清"为什么你只能看"：不是链接失效、也不是口令错，而是"这条链接的身份不在本群里"——
       * 要填就自己在群里发一次 `#排队`。
       */
      outOfGroup: member === false,
      /**
       * **本群成员**（名单可信 + 他在名单里）：能改整张排队区（受额度与红线），也能看到整表
       *
       * 页面据此把"这条链接只对本群成员有效"那类提示收掉，并在越界被拒时说清是哪一条规矩。
       */
      roam,
      nick: caller.identity?.nick ?? "",
      /**
       * 左下角那张头像：同源代理（`<img>` 带不了身份头，CSP 又只允许 `'self'`）
       *
       * 链接身份里有 QQ 才给；访客（没有身份）是空串，页面退回"昵称首字"那枚金圆章。
       */
      avatar: (() => {
        const qq = String(caller.identity?.qq ?? "").trim()
        return qq ? `api/avatar?qq=${encodeURIComponent(qq)}` : ""
      })(),
      /** 主人比管理员多一个「权限管理」面板；管理口令（?a=）是它的备用入口 */
      owner: caller.owner,
      showAdmins: caller.owner || caller.adminTokenOk,
      /**
       * 历史版本 / 归档 / 回退：**主人、管理口令、以及白名单管理员**都能用
       *
       * 维护者要求（报告：历史版本可供白名单成员使用）：回退前会自动把"当前状态"也存一份，
       * 点错了再退回来就是，所以它是**可逆的管理动作**，与「插队」同一档权力；
       * 而「上传覆盖云端」与「归属状态」是跨部署 / 重建归属的重动作，仍然只给主人（见 `manage`）。
       */
      versions: caller.owner || caller.adminTokenOk || caller.role === "admin",
      /**
       * 改动记录：**有身份就能看**（本人看"自己发的 + 改到我自己那些行的"，管理员看全部）
       *
       * 与「历史版本」不同：那份是"整表回退"的动作，只给管理员；这一份是"谁动了我的行"，
       * 恰恰是本人最需要看的东西——看不到就等于没有留痕（见 `editor/changes.js`）。
       */
      changes: caller.role !== "guest",
      /** 主人（或管理口令）：上传覆盖云端、归属状态、白名单维护 —— 这些都是主人专属 */
      manage: caller.owner || caller.adminTokenOk,
      versionsKeep: ctx.cfg.versionsKeep,
      archiveDays: ctx.cfg.archiveDays,
      cloud: ctx.cfg.cloudUrl,
      /**
       * 白名单里当不了权限的历史条目（群昵称等）：只发给能管白名单的人
       *
       * 权限只认 QQ，所以白名单里那些解析不出 QQ 的条目必须**当场说清楚**，
       * 否则主人会以为"我配了那个人"或者"我配的是 QQ 怎么就不好使"（AQ-01）。
       */
      acl: caller.owner || caller.adminTokenOk ? ctx.acl.aclAudit() : undefined,
    },
  }
}

/**
 * 这条链接的身份现在能不能"在本群里"（**本群守卫**）
 *
 * @returns {true|false|null} `true` 在名单里、`false` 不在、**`null` = 名单不可信（空 / 超 48 小时）判不了**
 *
 * 判不了时**不放权也不拒人**：退回"只能改自己那一行"的老口径（理由写在 `editor/roster.js`
 * 的 `trusted()` 上——名单同步失败一次就把全群变只读，比"个别退群的人还能写"严重得多）。
 */
export const memberStateOf = caller =>
  caller?.role === "self" ? ctx.roster.isMember(String(caller.identity?.qq ?? "")) : null

/** 变更流水落盘（`changes` 是本模块的服务单例，行模块只负责造记录） */

/**
 * 这一行该呼叫谁
 *
 * 只认**绑定里记的昵称与表里当前昵称一致**的绑定：整理 / 清榜 / 手工改表后
 * 残留的旧行号不能拿来 @ 人（否则就是把别人喊出来）。
 *
 * @returns {{ok: true, qq: string} | {ok: false, error: string}}
 */
export const callTargetOf = (binds, sheet, row, nickname) => {
  const ids = [...new Set((binds?.qqsOf?.(sheet, row) ?? []).map(id => String(id ?? "").trim()).filter(Boolean))]
  const rosterQq = rosterQqOfNick(nickname)
  /**
   * 绑定是首选，但不是唯一来源：整理/换表后旧绑定常常对不上，
   * 而群名单里当前昵称还是唯一的——这时按名单认人，呼叫才不会整列变灰。
   */
  if (ids.length === 1) {
    const info = binds?.get?.(sheet, ids[0])
    if (info?.nickname && sameNick(info.nickname, nickname)) return { ok: true, qq: ids[0] }
  }
  if (rosterQq) return { ok: true, qq: rosterQq }
  if (!ids.length) return { ok: false, error: "这一行还没有绑定 QQ，群名单里也找不到唯一对应的成员" }
  if (ids.length > 1) return { ok: false, error: "这一行有多个绑定 QQ，群名单里也找不到唯一对应的成员" }
  return { ok: false, error: "这一行的绑定和当前群昵称对不上，群名单里也找不到唯一对应的成员" }
}
