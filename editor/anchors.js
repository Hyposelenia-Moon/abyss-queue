/**
 * 主播区（下拉候选）的口径
 *
 * 这里回答一个问题：这一榜的「选择主播」下拉里，到底该出现哪些名字。
 * 口径 = 主播名单 ∪ 表里正在用的值 ∪ 公共队列；别名归一到主播本人。
 * 「完成情况」的下拉另走 `mergeStatusOptions` 净化，不直接用 xlsx 里那份旧验证。
 *
 * 配置从 `services.config` 读（装配根 `installCtx({ config })` 放进来）：
 * 配置是 `await createConfig()` 之后才有的，子模块直接 import 会成环。
 */
import { oneLine } from "./audit.js"
import { lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { compileAliases, canonicalAnchor } from "../components/aliases.js"
import { ATTACK_TARGET_NAMES, attackModeNames, attackVersions } from "../components/attack.js"
import { mergeStatusOptions } from "./cycle-ledger.js"
import { ctx as services } from "./ctx.js"
import { ANCHOR_FIELDS, ANY_ANCHOR } from "./defs.js"

/* ---------------------- 「难度及目标」的文字口径 ---------------------- */


export const effectiveOptions = model => {
  const known = compileAliases(services.config?.anchor_aliases)
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

/**
 * 主播行的可写值：字段与 ANCHOR_FIELDS 一一对应，值一律 trim。
 *
 * `base` 是这一行当前的表值：请求里**没有出现**的键沿用 base，而不是补空串。
 * 只提交部分字段的旧客户端/人工请求不能把 G/H 的直播入口抹掉；
 * 显式提交空串仍表示清空。
 */
export const anchorValuesOf = (values, base = null) =>
  Object.fromEntries(
    ANCHOR_FIELDS.map(f => {
      const provided = values && Object.prototype.hasOwnProperty.call(values, f.key)
      const v = provided ? values[f.key] : base?.[f.key]
      return [f.key, String(v ?? "").trim()]
    }),
  )


export const anchorBaseOf = a =>
  a
    ? {
        name: a.name,
        recommend: a.recommend,
        duty: a.duty,
        skills: a.skills,
        platform: a.cells?.platform ?? "",
        link: a.cells?.link ?? "",
      }
    : null


export const anchorNameOf = values => (values.recommend ? `${values.name}【${values.recommend}】` : values.name)


/**
 * 插行之后把绑定与锁里的行号一起搬走（只搬被插的那一榜、插入点及以下的行）
 *
 * **必须搬**：绑定/锁下一步会被盖上"新版本"的戳，行号却还指着上一行 —— 下次本人打开页面时
 * 版本对得上（于是不做重建），人就被认到别人的行上去了。搬法与群名单对账那边同一口径：
 * 从不可变旧快照读、写进全新对象、最后整体替换（原地读写会让新键覆盖还没搬的另一条）。
 */
export const shiftRowsOf = ({ binds, locks }, sheet, from, count) => {
  if (!count) return { binds, locks }
  const nextBinds = {}
  for (const [name, list] of Object.entries(binds ?? {})) {
    nextBinds[name] = {}
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      nextBinds[name][qq] = name === sheet && row >= from ? { ...info, row: row + count } : info
    }
  }
  const nextLocks = {}
  for (const [key, lock] of Object.entries(locks ?? {})) {
    const row = lockRowOf(key)
    nextLocks[lockSheetOf(key) === sheet && row >= from ? lockKey(sheet, row + count) : key] = lock
  }
  return { binds: nextBinds, locks: nextLocks }
}


/**
 * 按"哪一行的人去了哪一行"重排绑定与完成情况锁（挪行 / 插队用）
 *
 * 与 `shiftRowsOf`（整段 +count，插行用）不同：那里是"新插入一行、下面全体下移"，
 * 这里是"表里的内容换过位置"，每行的去向由调用方给的映射决定。**还是要从不可变旧快照读、
 * 写进全新对象、最后整体替换**——原地读写会让新键覆盖还没搬的另一条（与插行那边同一个坑）。
 *
 * @param {{binds: object, locks: object}} state 旧状态（只读）
 * @param {string} sheet 只重排这一榜（别的榜原样保留）
 * @param {(row: number) => number} toRow 行号 → 新行号（原样返回即不动）
 */
export const remapRowsOf = ({ binds, locks }, sheet, toRow) => {
  const nextBinds = {}
  for (const [name, list] of Object.entries(binds ?? {})) {
    nextBinds[name] = {}
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      nextBinds[name][qq] = name === sheet && row ? { ...info, row: toRow(row) } : info
    }
  }
  const nextLocks = {}
  for (const [key, lock] of Object.entries(locks ?? {})) {
    const row = lockRowOf(key)
    nextLocks[lockSheetOf(key) === sheet ? lockKey(sheet, toRow(row)) : key] = lock
  }
  return { binds: nextBinds, locks: nextLocks }
}


/**
 * 别名表里的「正名」集合（`config.anchor_aliases` 的键）
 *
 * 别名表是手写的 YAML（`config/config.yaml`）：键是正名、值是它的各种写法。改主播名时，
 * 如果旧名正好是这里的键，配置里的别名就再也指不到人了 —— 与其让编辑器偷偷去改配置文件
 * （那是运维手写的东西，改了会被下次覆盖 / 也可能根本改不动），不如**在写表之前就拦住**。
 *
 * 取键时按 `compileAliases()` 的同一口径去空白；另外把没写别名的空键也算进来：
 * 那种键改名之后同样是断的（只是断得没那么明显）。
 */
export const aliasCanonicalNames = () => {
  const out = new Set()
  for (const name of Object.keys(services.config?.anchor_aliases ?? {})) {
    const text = String(name ?? "").trim()
    if (text) out.add(text)
  }
  for (const a of compileAliases(services.config?.anchor_aliases)) out.add(a.name)
  return out
}


/**
 * 保存表头上方的「主播列表」（只有管理员能改）
 *
 * 两种改动走同一发请求：
 *   - `rows`：改表里**已有**的那几行（按行号对齐），行号必须是表里已有的主播行
 *   - `added`：新增主播。主播区没有空行可用，所以服务端在**最后一位主播下面插一行**，
 *     公告行 / 表头行 / 数据行连同它们的行号引用一起下移一格（`model/xlsx.js` 的
 *     `insertRowsAndShift`），绑定与锁里的行号同步搬走（`shiftRowsOf`）
 * 写的是：A 列 = 主播名 + 【推荐度】、C 强项、D 专职、G/H 直播入口。
 * 顺手把「选择主播」那一列的下拉列表也改成同一份名单（**以主播列表为准**），
 * 否则表格自己的下拉会一直停在旧名字上。
 *
 * 与成员保存**同一套并发语义**：请求可以带 `version`（页面读到的那一版表指纹），
 * 对不上就报冲突（409）而不是把别人刚提交的改动盖掉（AQ-06）。主播列表也是写表，
 * 没有理由比数据行少这一层保护。
 * @returns {Promise<{written:number, inserted:number, options:number}>}
 */
export const applyAnchors = async (caller, { sheet, rows, added, version }) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以改主播列表")
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  /** 页面上新加的主播还没有行号（要插入时才定得下来），单独放在 `added` 里 */
  const fresh = Array.isArray(added) ? added : []
  if (rows.length + fresh.length > 100) throw new Error("一次提交的主播行数过多（>100）")

  let plan = null
  let insertShift = null
  const out = await services.table().mutate(
    async ctx => {
      /** 行号必须是表里已有的主播行，避免把内容写到数据区或其它地方（读的是同一版表） */
      const model = ctx.model(sheet)
      const known = new Map(model.anchors.map(a => [a.row, a]))

      const normalized = []
      /** 别名表里登记过的正名：改名前要对一遍（见 `aliasCanonicalNames`） */
      const aliasNames = aliasCanonicalNames()
      for (const r of rows) {
        const row = Number(r?.row) || 0
        const before = known.get(row)
        if (!before) throw new Error(`第 ${row} 行不是主播列表里的行，不能改`)
        const values = anchorValuesOf(r?.values, anchorBaseOf(before))
        if (!values.name) throw new Error(`第 ${row} 行：主播名不能为空（要删掉这位主播请在表格里删行）`)
        /**
         * **改名前断言别名表已同步**：旧名是 `anchor_aliases` 的正名键时，表里改完名、
         * 配置里的别名就全指向一个不存在的名字了（群里按老昵称叫人也对不上）。
         * 编辑器不替人去改 YAML，只拒绝并说清楚要改哪一行。
         */
        if (before.name !== values.name && aliasNames.has(String(before.name ?? "").trim()))
          throw new Error(
            `第 ${row} 行：「${before.name}」是 config/services.config.yaml 里 anchor_aliases 的正名（别名都挂在它下面），` +
              `只改表会让别名失效。请先把 anchor_aliases 的键「${before.name}」改成「${values.name}」，再回来改名`,
          )
        normalized.push({ row, values })
      }

      const addedValues = fresh.map((r, i) => {
        const values = anchorValuesOf(r?.values)
        if (!values.name) throw new Error(`新增的第 ${i + 1} 位主播：主播名不能为空`)
        return values
      })

      /** 新行落在最后一位主播下面；主播区还空着就放在第一个能放主播的行上（见 ANCHOR_FIRST_ROW） */
      const insertedAt = model.anchors.length ? Math.max(...model.anchors.map(a => a.row)) + 1 : ANCHOR_FIRST_ROW
      /**
       * **守卫：插入行必须严格落在表头上方**（`insertedAt < headerRow`）
       *
       * 主播区（表头之上）与排队区（表头之下）是同一张表里的两个区，插行时表头与整个排队区要一起下移
       * （见 `model/xlsx.js` 的 `insertRowsAndShift`）——插入点跑到表头及以下，这一行就落进排队区了：
       * 序号轴、下拉、绑定与锁全都会串，出现"版本戳对得上、人却被认到别人的行上"。
       * 表头识别在第 3 行或更靠上的表（人工压过结构 / 合成表），`ANCHOR_FIRST_ROW` 这个"主播区还空着"
       * 的回退值就落到表头及以下；这种表不该由编辑器动手，宁可明确拒绝。
       *
       * 拒绝发生在**任何写之前**（`ctx.insertRows` / 写格 / 存底 / 换版本都在后面），
       * 抛出去由 `mutate()` 原样中止这一轮 —— 表、绑定、锁、版本一个字都不动。
       * 只改既有主播行（没有 `added`）不插行，不进这条守卫。
       */
      if (addedValues.length && insertedAt >= model.headerRow)
        throw new Error(
          `不能新增主播：算出来的插入行是第 ${insertedAt} 行，而表头在第 ${model.headerRow} 行 —— ` +
            `主播区（表头之上）与排队区（表头之下）不能混，请先在表格里把表头位置理清楚`,
        )
      if (addedValues.length) {
        /** 插在主播区末尾、排队区上面：插入点以下的数据行整体下移，历史记录的位置也要跟着搬 */
        insertShift = Object.fromEntries(
          model.rows.filter(r => r.row >= insertedAt).map(r => [r.row, r.row + addedValues.length]),
        )
        /**
         * 新行的样子：行属性与格子样式照抄**上面那一行**（最后一位主播），合并格照抄**第一位**主播
         * 那一行 —— A:B / C:F / G:H 三段合并才是规范布局，个别主播行自己缺一段（例如入口那两格
         * 没合并），照抄最后一行就会跟着缺。
         */
        const neighbour = model.anchors.length ? model.anchors.at(-1).row : 0
        ctx.insertRows(sheet, insertedAt, addedValues.length, { mergeTemplateRow: model.anchors[0]?.row ?? 0 })
        addedValues.forEach((values, i) => {
          const row = insertedAt + i
          for (const f of ANCHOR_FIELDS) {
            if (!f.col) continue
            const style = neighbour ? ctx.refStyle(sheet, `${f.col}${neighbour}`) : undefined
            ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? anchorNameOf(values) : values[f.key], style)
          }
        })
      }

      /** 改完之后的主播名单 → 就是「选择主播」下拉该有的选项（表里在用的旧值追加在后面） */
      const names = model.anchors.map(a => ({ row: a.row, name: a.name }))
      for (const n of normalized) {
        const hit = names.find(x => x.row === n.row)
        if (hit) hit.name = n.values.name
      }
      for (const values of addedValues) names.push({ row: 0, name: values.name })
      const listPlan = validationPlan(model, names.map(n => n.name))
      const options = listPlan.anchor

      /** 写表前留底：历史版本 + 每日/换月归档 */
      await services.snapshotBeforeWrite()
      for (const { row, values } of normalized) {
        for (const f of ANCHOR_FIELDS) {
          if (!f.col) continue
          ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? anchorNameOf(values) : values[f.key])
        }
      }
      /**
       * 两列下拉都同步成同一份名单，并把校验强度从 stop 调成 warning：
       * Excel/腾讯文档的数据验证不支持真多选，stop 会把「阿修Axiu,听雨」这种手写多值直接打回，
       * 改成 warning 后仍然给下拉、仍然提示，但允许填多值。
       */
      writeValidationPlan(ctx, sheet, listPlan, { single: false })
      /** 表换了版本：绑定与锁要跟着盖上新版本，否则下次对账会把它们全作废 */
      const state = await services.ownershipIn(ctx, await services.store())
      /** 插了行，插入点以下的行号全变了：绑定与锁搬完再盖章（漏搬 = 本人被认到别人的行上） */
      const moved = shiftRowsOf(state, sheet, insertedAt, addedValues.length)
      plan = { binds: moved.binds, locks: moved.locks }
      return { written: normalized.length + addedValues.length, inserted: addedValues.length, options: options.length }
    },
    { expect: version, afterCommit: info => services.persistState(info, plan) },
  )
  if (out?.inserted && insertShift) services.changes.remap(sheet, insertShift)
  return out
}

/**
 * 把"已排队的某个人"挪到这一榜所有「排队中」的人最前面
 *
 * **只给 `#插队` 用**（管理员在群里发指令，插件调 `/api/move-row`，见 apps/inserter.js）。
 * 位置由**编辑器**算：插件只给"哪一榜、哪一行、怎么挪"，算不出目标就整表不动。
 *
 * 口径（与插件侧同一份）：
 *   - 目标行 = 数据区里**第一条**「排队中」；这一行本来就在最前面 ⇒ 什么都不做
 *     （不是错误，返回 `moved:false` + `reason`），插件照原样回一句"已经在最前面"；
 *   - 动作 = 把 `[目标行, 来源行]` 这一段**整体轮转**：来源行的人 → 目标行，
 *     目标行及中间的人各后移一位。不是只交换两端——跨多位时要保证中间那一段真的让位；
 *   - 不新增行、不删除行、不改任何行号 ⇒ 排队区不出现空行/缺行，序号列（`=ROW()-k` 的缓存值）
 *     逐行不动，仍然是 1..N；
 *   - 样式随内容一起换（每格把**来源行**的 `s` 显式带上）：不这么做，隔行配色会留在原地，
 *     人一挪就顶着别人的底色；
 *   - 绑定与锁的行号由 `remapRowsOf` 搬（来源行 → 目标行，`[目标行, 来源行-1]` 各 +1）：这一步不能省——
 *     `ownershipIn` 在写表后按行号记归属，不搬就等于"表换了、归属还指着旧行号"。
 *
 * 失败即整表不动：任何一步不满足预期都抛错，由 `mutate()` 原样中止这一轮（表 / 绑定 / 锁 / 版本都不动）。
 * @param {{role: string}} caller 调用者（非管理员直接抛错）
 * @param {{sheet: string, row: number|string, mode: string, nick?: string}} body 请求体
 * @returns {Promise<{moved: boolean, sheet: string, from?: number, to?: number, fromSeq?: number,
 *   toSeq?: number, nickname?: string, crossed?: string, reason?: string}>}
 */
/**
 * 插队（实现搬到 `editor/actions.js`，这里只装配依赖）
 *
 * 依赖用箭头包一层：`moveCell` 定义在本文件更靠后的位置，直接取值会撞 TDZ。
 */

/** 把动作注册到进程内注册表：插件侧 getEditorService() 直接调，不再绕 HTTP */




/**
 * 两份下拉名单的"计划"：选择主播 与 帮帮完成情况
 * 规则（两列一致）：
 *   1. 表头上方主播列表里的正名在前（去重）
 *   2. 表里手填/在用的其它值（不在名单里的主播、公共队列、排队中…）**自动收进来当选项**
 *      —— 这就是"手填的主播自动归档为下拉选项"，免得表里能用、下拉里却没有
 * @param {object} model 榜模型
 * @param {string[]|null} anchorsOverride 主播区刚改完的名单（保存主播列表时用）
 */
export const validationPlan = (model, anchorsOverride = null) => {
  const names = (anchorsOverride ?? model.anchors.map(a => a.name)).map(s => String(s ?? "").trim()).filter(Boolean)
  const anchors = [...new Set(names)]
  const anchorCol = model.col?.anchor
  const statusCol = model.col?.status
  const anchor = anchorCol ? effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) }).anchor : []
  const status = statusCol ? mergeStatusOptions(model, anchors, { withExtra: false }) : []
  /**
   * 一个**单选**下拉列也要把名单写回表里（2026-10-18 维护者：「禁止此类下拉菜单的单元格的手写功能」）：
   * 它是单选（`goal`），所以用 `errorStyle: "stop"` —— 表格里手扫一个值会被拦下，
   * 只能从下拉里挑；而「选择主播」「帮帮完成情况」是**多值**列，必须留 `warning` 才能手打「A,B」。
   * 名单与页面下发的是同一份（`effectiveOptions`：老写法已归一化）。
   */
  const goalCol = model.col?.goal
  const opts = effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) })
  /** 绝境攻炼的 30 个组合值超过 Excel 内联下拉 255 字符，页面自己下发；不写表内验证 */
  const goal = goalCol && !/攻炼|绝境/.test(String(model.name ?? "")) ? (opts.goal ?? []) : []
  return { anchorCol, statusCol, anchor, status, goalCol, goal }
}


/**
 * 把这几份名单写进表
 *
 * 单选列（难度及目标）用 **stop**：拦手写；多值列（选择主播 / 帮帮完成情况）用
 * **warning**：Excel 的数据验证不支持真多选，stop 会把「A,B」这种手填值一并拦下。
 */
export const writeValidationPlan = (ctx, sheet, plan, { single = true } = {}) => {
  if (plan.anchorCol && plan.anchor.length) ctx.setValidationList(sheet, plan.anchorCol, plan.anchor, { errorStyle: "warning" })
  if (plan.statusCol && plan.status.length) ctx.setValidationList(sheet, plan.statusCol, plan.status, { errorStyle: "warning" })
  /**
   * 单选列**只在保存成员行的这条路上**写（`single = true`）：改主播列表 / 归档手填名字
   * 是另一件事，不该顺手把「难度及目标」的下拉也重写一遍。
   */
  if (!single) return
  if (plan.goalCol && plan.goal.length) ctx.setValidationList(sheet, plan.goalCol, plan.goal, { errorStyle: "stop" })
}


/**
 * 表里手填了新名字就把它归档进下拉选项（只有管理员打开时做，且只在真有新名字时才写表）
 *
 * 读与写同样在同一个临界区里：不然"读出来要归档"和"真写进去"之间表可能已经被换掉（AQ-06）。
 */
export const archiveOptions = async caller => {
  if (caller.role !== "admin") return 0
  let work = []
  let plan = null
  await services.table().mutate(
    async ctx => {
      work = [...ctx.models.values()]
        .map(model => {
          const listPlan = validationPlan(model)
          const known = new Set([...(model.options?.anchor ?? []), ...(model.options?.status ?? [])])
          /** 两份名单里出现了当前验证列表没有的值 → 需要归档 */
          const fresh = [...listPlan.anchor, ...listPlan.status].filter(v => v && !known.has(v))
          return { name: model.name, plan: listPlan, fresh: [...new Set(fresh)] }
        })
        .filter(x => x.fresh.length)
      if (!work.length) return { archived: 0 }
      /** 写表前留底：历史版本 + 每日/换月归档 */
      await services.snapshotBeforeWrite()
      for (const { name, plan: p } of work) writeValidationPlan(ctx, name, p, { single: false })
      const state = await services.ownershipIn(ctx, await services.store())
      plan = { binds: state.binds, locks: state.locks }
      return { archived: work.reduce((n, x) => n + x.fresh.length, 0) }
    },
    { afterCommit: info => services.persistState(info, plan) },
  )
  if (!work.length) return 0
  const total = work.reduce((n, x) => n + x.fresh.length, 0)
  console.log(
    `[editor] 已把手填的 ${total} 个名字归档进下拉选项：` +
      oneLine(work.map(x => `${x.name}（${x.fresh.join("、")}）`).join("；")),
  )
  return total
}
