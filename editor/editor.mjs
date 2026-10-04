/**
 * 排队表在线编辑器（零额外依赖：只用 node 内置模块 + jszip）
 *
 * 群友在浏览器里填表，机器人在群里发链接。设计要点：
 *   - 只暴露「需要填的字段」：群昵称 / 原神游戏名 / 选择主播 / 难度及目标 / 账号强度 / 帮帮完成情况 / 备注
 *   - 权限：链接带发送者身份签名（lib/identity.js）——
 *       白名单里的人（qq 或群昵称）可改所有人的信息；
 *       其余人只拿得到、也只改得动自己那一行；
 *       没有签名（链接被转发、直接打开域名）只能只读浏览
 *   - 完成情况：普通人可以填自己那一行，但**主播（白名单）改过之后这一行就锁上**，不再让本人改
 *   - 写入走插件自己的 Table.mutate：写前备份 `.bak`、写入后回读自检，校验不过放弃写入
 *   - 可部署到云服务器：监听地址、端口、口令都可用环境变量/参数指定
 *   - **数据落点固定**：表与它派生的一切（`.bak` / 绑定 / 白名单 / 锁 / 群名单 / versions / archives）
 *     都必须在 `<插件根>\data` 里；`--file` 或 `xlsx_path` 解析到插件外就**拒绝启动**（见 resolveFile）。
 *     唯一例外是回归套件的 `ABYSS_EDITOR_TEST_PATHS=1`（允许指到系统临时目录），生产不许设。
 *
 * 本机测试：
 *   node tools/editor.mjs
 *   → http://127.0.0.1:7788/（没设口令时本机等同管理员）
 *
 * 云服务器（详见 tools/DEPLOY.md）：
 *   ABYSS_EDITOR_FILE=/srv/abyss/queue.xlsx \
 *   ABYSS_EDITOR_TOKEN=<随机口令> \
 *   ABYSS_EDITOR_ADMIN_TOKEN=<管理口令> \
 *   ABYSS_EDITOR_BIND=0.0.0.0 \
 *   node editor.mjs
 *
 * 参数（优先级高于环境变量）：
 *   --file <xlsx>         表格文件（生产中必须落在 <插件根>\data 内）
 *   --port <n>            端口，默认 7788
 *   --bind <addr>         监听地址，默认 127.0.0.1；对外服务填 0.0.0.0
 *   --token <口令>        访问口令；留空则不校验（仅本机测试用）
 *   --admin-token <口令>  管理口令：用它打开 `?a=<口令>` 可维护白名单
 *   --admins <json>       白名单文件；生产固定 <插件根>\data\abyss-editor-admins.json（仅测试模式可改）
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { createConfig } from "./config.js"
import { ACL_QQ, aclQq, createAcl, lockKey, lockRowOf, lockSheetOf } from "./acl.js"
import { createRoster } from "./roster.js"
import { createVersions, resolveStoredFile, RE_VERSION } from "./versions.js"
import { bindView, bindDel, bindSet, createOwnership, dropBindsAt, rebuildOwnership, renameLock } from "./ownership.js"
import { dayStamp, pad2, readJson, writeJson } from "./util.js"

/**
 * 退出与崩溃自述
 *
 * 这台机器上编辑器偶尔会"无声消失"，日志里什么都没有。把退出原因写清楚，
 * 下次再死就能一眼看出是被信号带走、还是自己崩了。
 */
process.on("exit", code => console.log(`[editor] 进程退出，code=${code}`))
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])
  process.on(sig, () => {
    console.log(`[editor] 收到 ${sig}，退出`)
    process.exit(0)
  })
process.on("uncaughtException", err => {
  console.error(`[editor] 未捕获异常：${err?.stack ?? err}`)
  process.exit(1)
})
process.on("unhandledRejection", err => {
  console.error(`[editor] 未处理的 Promise 拒绝：${err?.stack ?? err}`)
})

/**
 * 启动装配：路径 / 开关 / 落点 全部由 `editor/config.js` 算清（含 fail-closed 的拒绝启动）；
 * 这里只把结果摊平成下面的常量，其余代码不用改取值方式。
 */
const { cfg, internal, envOwners: ENV_OWNERS, envAdmins: ENV_ADMINS } = await createConfig()
const {
  pluginDir: PLUGIN_DIR,
  dataDir: DATA_DIR,
  testPaths: TEST_PATHS,
  xlsxPath,
  dataBase: DATA_BASE,
  template: TEMPLATE,
  token: TOKEN,
  allowNoToken: ALLOW_NO_TOKEN,
  signKey: SIGN_KEY,
  adminToken: ADMIN_TOKEN,
  ownerOnly: OWNER_ONLY,
  port: PORT,
  bind: BIND,
  mount: MOUNT,
  cloudUrl: CLOUD_URL,
  footerHtml: FOOTER_HTML,
  adminsFile: ADMINS_FILE,
  locksFile: LOCKS_FILE,
  rosterFile: ROSTER_FILE,
  rosterQq: ROSTER_QQ,
  versionsDir: VERSIONS_DIR,
  versionsKeep: VERSIONS_KEEP,
  archivesDir: ARCHIVES_DIR,
  archiveDays: ARCHIVE_DAYS,
  archivesKeep: ARCHIVES_KEEP,
} = cfg

/** 插件侧的运行时配置（`backup` 等）——表实例要用它 */
const { config } = internal

/* ------------------------- 编辑器自己的小工具 ------------------------- */
/**
 * 日期戳与 JSON 读写已抽到 `editor/util.js`（顶部 import）——
 * 版本归档、群名单、白名单三处都要用，放一处避免各写一份。
 */

const shared = rel => import(pathToFileURL(path.join(PLUGIN_DIR, rel)).href)

const { decodeIdentity, signIdentity, verifyIdentity, verifyTicket, SHORT_PATH } = await shared("lib/identity.js")
const { openWorkbook } = await shared("lib/xlsx.js")
const { ensureFont } = await shared("components/font.js")

/**
 * 挂载前缀：部署在 `https://域名/queue` 这类子路径时，nginx 可能把带前缀的路径原样转发过来
 * （`proxy_pass http://127.0.0.1:7788;` 不带尾部斜杠），也可能已经剥掉前缀。
 * 这里两种都接受：带前缀就把前缀去掉再路由，不带就直接用。
 */
const innerPath = pathname => {
  if (MOUNT && (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`))) {
    const rest = pathname.slice(MOUNT.length)
    return rest === "" ? "/" : rest
  }
  return pathname
}

/* 数据层与渲染从插件目录引入（见上面的 PLUGIN_DIR） */
const { Table } = await shared("model/table.js")
const { BindStore } = await shared("model/store.js")
const { matchOption, locateSelf } = await shared("lib/queue.js")
const { canonicalAnchor, compileAliases } = await shared("lib/aliases.js")
const { pluginVersion } = await shared("components/pluginVersion.js")

/**
 * 表与绑定都由**编辑器自己**按 `--file` 建实例，不用插件的数据层单例
 *
 * 单例绑的是插件配置里的 `xlsx_path`：那个键现在只属于编辑器场景，插件侧已经没有了；
 * 更关键的是——用它会出现"编辑器服务的文件"和"它实际读写的文件"不是同一份，
 * 那正是最危险的一类污染。绑定文件跟着 DATA_BASE 走（生产 = 插件内的 data/）。
 */
let TABLE = null
let STORE = null
const table = () => (TABLE ??= new Table({ file: xlsxPath, backup: config.backup !== false }))
const store = () => (STORE ??= new BindStore(path.join(DATA_BASE, "abyss-editor-bindings.json")).load())

/* ------------------------- 装配：群名单 / 白名单 / 锁 ------------------------- */

/** 群名单：给页面的昵称候选、给短链补身份昵称；`nickOf` 会回退到本机绑定记录 */
const roster = createRoster({ rosterFile: ROSTER_FILE, store })
const { loadRoster, saveRoster, nickCandidates, nickOf } = roster

/** 群名单里这个群昵称对应谁（唯一命中才给建议；重名/查不到就空）——白名单审计要用 */
const rosterQqOfNick = nick => {
  const want = String(nick ?? "").trim().toLowerCase()
  if (!want) return ""
  const hits = (loadRoster().members ?? []).filter(m => String(m?.nick ?? "").trim().toLowerCase() === want)
  return hits.length === 1 ? String(hits[0].qq ?? "") : ""
}

/** 白名单与完成情况锁（名单解析 + 锁的存取） */
const acl = createAcl({
  adminsFile: ADMINS_FILE,
  locksFile: LOCKS_FILE,
  envAdmins: ENV_ADMINS,
  envOwners: ENV_OWNERS,
  rosterQqOfNick,
})
const { loadAdmins, loadOwners, aclAudit, saveAdmins, loadLocks, saveLocks, adminFileList } = acl

/** 历史版本与归档：写表前的存底（`replaceTable` 的 `beforeWrite` 就用它） */
const versions = createVersions({
  versionsDir: VERSIONS_DIR,
  archivesDir: ARCHIVES_DIR,
  xlsxPath,
  versionsKeep: VERSIONS_KEEP,
  archiveDays: ARCHIVE_DAYS,
  archivesKeep: ARCHIVES_KEEP,
})
const { listVersions, listArchives, snapshotBeforeWrite } = versions

/** 归属状态：绑定/锁与表的对账、审计、按 QQ 重建（实现见 editor/ownership.js） */
const ownership = createOwnership({ store, table, loadLocks, saveLocks, loadRoster, locateSelf })
const { ownershipIn, persistState, alignOwnership, ownershipAudit, rebuildOwnershipNow, mineRows } = ownership

/** 编辑器可写的字段（顺序与原表的 B–H 列一致：序号与其它列一律不动） */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  /** 主播与完成情况都可能是一格多个值（"阿修Axiu,听雨"），校验时按逗号拆开逐项比对 */
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]

/**
 * 表头上方「主播列表」的可写字段 —— 与 #主播 渲染出来的列一一对应
 *
 * 单元格位置按原表：A 主播名、C 核心强项、D 专职（C:F 合并区里的空格）、G/H 直播入口。
 * 只在表里已有的那几行上改，不新增/删除行（挪行要动数据区，风险太大）。
 */
const ANCHOR_FIELDS = [
  { key: "name", label: "主播", col: "A", required: true },
  { key: "recommend", label: "推荐度", col: "" },
  { key: "duty", label: "专职", col: "D" },
  { key: "skills", label: "核心强项", col: "C" },
  { key: "platform", label: "直播入口", col: "G" },
  { key: "link", label: "直播入口（第二格）", col: "H" },
]

/* ------------------------- 白名单与完成情况锁 ------------------------- */

/**
 * 白名单 / 锁 / 群名单 / 版本 / 归档的**落点**都在启动装配时算好了（见上方解构）：
 * `<插件根>/data` 下，生产不接受覆盖；测试模式才认 `--admins` 与 `ABYSS_EDITOR_*_FILE` / `_DIR`。
 * 口径与 fail-closed 全在 `editor/config.js`——这里不再自己算一遍。
 */

/* ------------------------- 白名单与完成情况锁 ------------------------- */

/**
 * 白名单 / 完成情况锁 / 群名单的**落点**在启动装配时算好（见上方解构）；
 * 三块实现分别在 `editor/acl.js` 与 `editor/roster.js`，本文件只做装配与鉴权：
 *   - `acl`：名单解析（只认 QQ，AQ-01）+ 完成情况锁（连昵称与表指纹一起记，AQ-03/08）
 *   - `roster`：群成员名单（昵称候选 + 按 QQ 取当前名片）
 * 装配点放在下方「表与绑定」之后——它们要等 `store()` 就绪。
 */

const blank = v => !String(v ?? "").trim()

/* ------------------------- 新行的默认值 ------------------------- */

const WAITING_STATUS = "等待开启"
const QUEUED_STATUS = "排队中"

/**
 * 各榜的开榜时间（新行的「帮帮完成情况」默认值按它算）
 *
 *   幻想真境剧诗：每月 1 号 4 点开，**不设「等待开启」**，默认就是「排队中」
 *   深境螺旋：每月 16 号 4 点开，到点前默认「等待开启」，到点后默认「排队中」
 *   幽境危战：按版本开放、没有固定日子，默认「等待开启」，要排队请手动改成「排队中」
 */
const OPEN_RULES = [
  { test: /剧诗/, day: 1 },
  { test: /螺旋/, day: 16 },
]

const defaultStatusOf = (sheetName, now = new Date()) => {
  const rule = OPEN_RULES.find(r => r.test.test(String(sheetName ?? "")))
  if (!rule) return WAITING_STATUS
  /** 1 号开的榜不用「等待开启」 */
  if (rule.day <= 1) return QUEUED_STATUS
  const openAt = new Date(now.getFullYear(), now.getMonth(), rule.day, 4, 0, 0, 0)
  return now.getTime() >= openAt.getTime() ? QUEUED_STATUS : WAITING_STATUS
}

/** 账号强度不填时的默认值；备注默认留空 */
const DEFAULT_STRENGTH = "中配"

/**
 * 「本人已完成」→ 这一行的群昵称
 *
 * 编辑器里点「本人已完成」会直接落成群昵称，但表格（腾讯文档那份）里能直接选到这个字面值，
 * 所以两头都换一遍：显示时换（界面上不再挂着「本人已完成」）、保存时换（真写回表里）。
 */
const statusWithSelfDone = (status, nickname) => {
  const parts = String(status ?? "")
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  if (!parts.includes(SELF_DONE)) return parts.join(",")
  const nick = String(nickname ?? "").trim()
  if (!nick) return parts.join(",")
  return [...new Set(parts.map(p => (p === SELF_DONE ? nick : p)))].join(",")
}

/**
 * 汇总为前端可用的结构
 *
 * 按调用者身份裁剪：
 *   admin —— 全部行，可改所有人（另有白名单可维护）
 *   self  —— 只给**按 QQ 定位到的**自己那些行（昵称兜底），且只能改这些行
 *   guest —— 全部行只读（链接被转发、或直接打开域名）
 */
const buildPayload = async caller => {
  const locks = loadLocks().rows
  const mine = caller.role === "self" ? await mineRows(caller) : null
  const data = await table().read(({ models }) => {
    const sheets = []
    for (const model of models.values()) {
      const rows = model.rows
        .filter(r => caller.role !== "self" || mine.get(model.name)?.has(r.row))
        .map(r => {
          /** seq 是表里 A 列那个序号（公式算出来的 1..N），界面第一列要显示它，不能拿表格行号冒充 */
          const o = { row: r.row, seq: r.seq ?? "" }
          for (const f of FIELDS) o[f.key] = r[f.key] ?? ""
          /** 表里还挂着字面「本人已完成」的旧值：界面上直接显示成这一行的群昵称 */
          o.status = statusWithSelfDone(o.status, o.nickname)
          o.statusLocked = caller.role !== "admin" && Boolean(locks[lockKey(model.name, r.row)])
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
        anchors,
        rows,
        /**
         * 别人占了哪些行号（只发给本人）
         *
         * 本人只拿得到自己那几行，前端「新增一行」如果只按拿到的行号找空位，
         * 会挑中别人正占着的行，保存时被拒（第 N 行不是你的记录）。
         */
        taken: caller.role === "self" ? model.rows.map(r => r.row) : undefined,
        /** 新行的默认值：完成情况按这个榜的开榜时间算（账号强度「中配」由服务端在保存时补） */
        defaults: { status: defaultStatusOf(model.name) },
        /** 表头上方的主播列表：只有管理员能改，所以只给管理员发 */
        anchorRows:
          caller.role === "admin"
            ? model.anchors.map(a => ({
                row: a.row,
                name: a.name,
                recommend: a.recommend,
                duty: a.duty,
                skills: a.skills,
                platform: a.cells?.platform ?? "",
                link: a.cells?.link ?? "",
                entry: a.entry,
              }))
            : undefined,
      })
    }
    return { sheets }
  })
  return {
    file: xlsxPath,
    fields: FIELDS,
    /**
     * 这一版表的编号（文件指纹）
     *
     * 页面拿它做乐观并发：保存时原样带回来，服务端发现表已经变了就报冲突，
     * 而不是把别人刚提交的改动无声盖掉（AQ-06）。
     */
    version: table().version,
    /** 群昵称候选（机器人推来的群成员名单）：本地编辑器收不到名单，这里是空的 */
    roster: (() => {
      const r = loadRoster()
      return { group: r.group, updatedAt: r.updatedAt, count: (r.members ?? []).length, candidates: nickCandidates() }
    })(),
    sheets: data.sheets,
    savedAt: fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath).mtime.toLocaleString("zh-CN") : "",
    perm: {
      role: caller.role,
      readonly: caller.role === "guest",
      nick: caller.identity?.nick ?? "",
      /** 主人比管理员多一个「权限管理」面板；管理口令（?a=）是它的备用入口 */
      owner: caller.owner,
      showAdmins: caller.owner || caller.adminTokenOk,
      /** 历史版本 / 归档 / 上传覆盖云端：都只有主人能看到 */
      versions: caller.owner || caller.adminTokenOk,
      versionsKeep: VERSIONS_KEEP,
      archiveDays: ARCHIVE_DAYS,
      cloud: CLOUD_URL,
      /**
       * 白名单里当不了权限的历史条目（群昵称等）：只发给能管白名单的人
       *
       * 权限已经不再看昵称了，所以这些条目必须**当场说清楚**，
       * 否则主人会以为"我配了那个人"或者"我配的是 QQ 怎么就不好使"（AQ-01）。
       */
      acl: caller.owner || caller.adminTokenOk ? aclAudit() : undefined,
    },
  }
}

/** 群昵称比对：忽略首尾空白与大小写（英文昵称常见） */
const sameNick = (a, b) => {
  const x = String(a ?? "").trim()
  const y = String(b ?? "").trim()
  return Boolean(x) && Boolean(y) && x.toLowerCase() === y.toLowerCase()
}

/* ------------------------- 归属状态：绑定 / 完成情况锁 ------------------------- */

/**
 * 归属这一整块的实现都在 `editor/ownership.js`（绑定/锁与表的对账、审计、按 QQ 重建），
 * 装配点在上方「装配：归属」。本文件只留两处**必须与表写在同一个临界区**的编排：
 * `syncIdentity`（改名片要写表）与 `replaceTable`（整表替换后重建归属）。
 */


/**
 * 按 QQ 定位账号（与机器人同一套口径，见 lib/queue.js 的 locateSelf）：
 *   - 本人改了群名片 → 把表里的群昵称同步成新名片（只动昵称，游戏名不动）
 *   - 首次按昵称认出来 → 记下 QQ 绑定，以后按 QQ 认人
 *   - 绑定失效（那一行没了，或已经是别人的了）→ 删掉
 *
 * 读表、写表、改绑定都在**同一个临界区**里：以前是"先读一次算清楚、再进队列写"，
 * 中间隔着别的写入口，算出来的行号可能已经不是那一版表的了（AQ-03、AQ-06）。
 * @returns {Promise<{renamed:number, bound:number, dropped:number}>}
 */
const syncIdentity = async caller => {
  const result = { renamed: 0, bound: 0, dropped: 0 }
  if (caller.role !== "self" || !caller.identity?.qq) return result
  const bindStore = await store()
  const qq = caller.identity.qq
  const nick = caller.identity.nick
  let plan = null
  let renamedRows = []

  await table().mutate(
    async ctx => {
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      const lockRows = state.locks
      const realigned = state.realigned
      const view = bindView(binds)
      const actions = [...ctx.models.values()].map(model => ({
        model,
        hit: locateSelf(model, view, model.name, qq, nick),
      }))

      /** 改了群名片：把表里那一行的群昵称同步过来 */
      renamedRows = actions.filter(a => a.hit.renamedFrom !== undefined && a.hit.row)
      for (const { model, hit } of renamedRows)
        if (ctx.model(model.name)?.col?.nickname) ctx.setCell(model.name, hit.row, "nickname", hit.nick)

      let dirty = false
      for (const { model, hit } of actions) {
        if (hit.stale) {
          if (bindDel(binds, model.name, qq)) {
            dirty = true
            result.dropped++
          }
          continue
        }
        /** 改了名片的那些行，绑定里记的昵称也刷新成新名片 */
        if (hit.renamedFrom !== undefined && hit.row) {
          bindSet(binds, model.name, qq, { row: hit.row, nickname: hit.nick })
          renameLock(lockRows, model.name, hit.row, hit.nick)
          dirty = true
          result.bound++
          continue
        }
        if (hit.bind) {
          bindSet(binds, model.name, qq, { row: hit.bind.row, nickname: hit.bind.nickname })
          dirty = true
          result.bound++
        }
      }
      if (renamedRows.length) await snapshotBeforeWrite()
      if (dirty || renamedRows.length || realigned) plan = { binds, locks: lockRows }
      return { renamed: renamedRows.length }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (renamedRows.length) {
    result.renamed = renamedRows.length
    console.log(
      `[editor] QQ ${qq} 改了群名片，已同步表里的群昵称：` +
        renamedRows.map(({ model, hit }) => `${model.name} 第 ${hit.row} 行「${hit.renamedFrom}」→「${hit.nick}」`).join("；"),
    )
  }
  return result
}

/**
 * 下拉选项（前端展示与后端校验共用一份，避免"界面能选、保存却说不在选项里"）
 *
 * 「选择主播」**以表头上方的主播列表为准**（表里的下拉验证常跟不上主播区的增删改）：
 *   1. 主播列表里的每一位，按表内顺序排在前面 —— 这是权威名单
 *   2. 表里已经在用、但不在主播列表里的值（例如「都可以」）追加在后面，免得老数据没法选
 *   3. 认得出是哪位主播的别名（如「璃月第一深情」→ 摸头妹）不算独立选项，直接归到正名
 *   4. 主播列表为空时才整份退回原来的下拉验证值
 */
const effectiveOptions = model => {
  const known = compileAliases(config.anchor_aliases)
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
  const anchor = list.length ? list : fallback
  /**
   * 完成情况也下发"净化后的名单"（与写回表时同一份）
   *
   * 这一列的候选口径与写回口径必须一致：以前下发的是 xlsx 里那份下拉验证原样，
   * 而归档只增不减 ⇒ 早年用过、现在没人用的名字会永久留在页面的下拉里
   * （现场：「幽境危战的完成情况里有神秘的『小伙01』残留」—— 该榜没有任何一行的 status 是他）。
   * 净化口径见 `mergeStatusOptions`：状态词 ∪ 主播名单 ∪ 表里在用的值。
   */
  const status = model.col?.status ? mergeStatusOptions(model, anchors) : model.options?.status
  return { ...(model.options ?? {}), anchor, ...(status ? { status } : {}) }
}

/**
 * 完成情况里的「未开始 / 进行中」：它们与「某完成人」（主播名 / 本人已完成）互斥
 * 前端点选时会互相挤掉，这里是服务端的兜底校验
 */
const PENDING_STATUS = ["等待开启", "排队中"]

/** 一键"我完成了"：落成这一行的群昵称，表里看到的就是完成人 */
const SELF_DONE = "本人已完成"

/** 只能单独选的值：选了它就不能再和别的并存（如「都可以」）；前端点选时也会清，这里是兜底 */
const EXCLUSIVE_VALUES = ["都可以"]

/**
 * 「帮帮完成情况」的下拉：固定状态（排队中 / 等待开启 / 本人已完成…）+ 主播名 + 表里在用的其它值
 *
 * 这一列同样是多选（可以同时写多位主播），所以名单也要跟着主播区走。
 */
const mergeStatusOptions = (model, anchors) => {
  const current = [...new Set(model.options?.status ?? [])]
  /**
   * 只留**状态词**（等待开启 / 排队中 / 本人已完成），表里下拉验证里的其它历史值不再当候选
   *
   * 归档（`archiveOptions`）只增不减：表里当年用过的名字会被写进 xlsx 的下拉验证列表，
   * 之后再没人用时**永远留在那里**——现场就是「幽境危战的完成情况里有神秘的『小伙01』残留」。
   * 真正在用的值由下面的 `used` 兜底，一个都不会少；而且保存/归档时会把这份净化后的名单
   * 写回表里，那批残留会顺手清掉（自愈）。
   */
  const fixed = current.filter(v => PENDING_STATUS.includes(v) || v === SELF_DONE)
  const used = []
  for (const r of model.rows) {
    for (const part of String(r.status ?? "")
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean))
      if (!used.includes(part)) used.push(part)
  }
  return [...new Set([...fixed, ...anchors, ...used])]
}

/** 业务校验：必填、同榜不重名、下拉值必须命中 */
const validateRows = (model, rows) => {
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
    /** 表里原本那一行：值没动就不校验（旧值可能已经不在主播列表里了，不该逼着人改） */
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
      const opts = options[f.option] ?? []
      if (!opts.length) continue
      /** 完成情况允许多个值（"阿修Axiu,听雨"），逐个比对 */
      const parts = f.multi ? val.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [val]
      for (const part of parts) {
        if (opts.includes(part) || matchOption(part, opts)) continue
        /** 认得出的别名（如「阿修」→ 阿修Axiu）也算命中 */
        if (f.key === "anchor" && opts.includes(canonicalAnchor(part, compileAliases(config.anchor_aliases)))) continue
        /** 完成人可以直接是某位群友的群昵称（点「本人已完成」就是这么落表的） */
        if (f.key === "status" && (nicknames.has(part) || sameNick(part, before?.nickname))) continue
        problems.push(`${who}：${f.label}「${part}」不在下拉选项里`)
      }
      /** 独占值（如「都可以」）不能和别的并选 */
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
 * 保存：校验 → 逐格写；整行空 = 清空该行（序号公式列不动）
 *
 * 权限在服务端落实，不依赖前端：
 *   self 只能碰「本来就是自己那一行」或「新增的、昵称是自己的」行
 *   self 改不动已被主播锁定的完成情况（其余字段照常保存，被忽略的那格回报给前端）
 *
 * **读表、校验、写表、改绑定与锁全在 table() 的同一个临界区里**：
 * 以前是"先在队列外读一次算清楚、再进队列写"，中间别的写入口（上传/回退/名单整理）
 * 可能已经把表换掉了，于是写回去的是过期快照，改动凭空消失（AQ-06）。
 * 请求可以带 `version`（页面加载时拿到的表版本）：对不上就报冲突，不覆盖别人的改动。
 */
const applySave = async (caller, { sheet, rows, version }) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 500) throw new Error("一次提交的行数过多（>500）")
  if (caller.role === "guest") throw new Error("这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）")

  const bindStore = await store()
  const qq = caller.identity?.qq
  const nick = caller.identity?.nick
  let plan = null

  const result = await table().mutate(
    async ctx => {
      /** 表里没有这个榜就在这里抛错——和写入读的是同一版表 */
      const model = ctx.model(sheet)
      /** 版本对不上（整表替换过 / 外部改过表）：先按群昵称重新对账，再谈权限 */
      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      let lockRows = state.locks
      const realigned = state.realigned

      const normalized = rows.map(r => {
        const src = r?.values ?? {}
        const before = model.rows.find(x => x.row === Number(r?.row))
        const values = {}
        for (const f of FIELDS) {
          /** 前端漏传的字段按表里现有值处理：宁可不动，也不能当空串把内容清掉 */
          values[f.key] = src[f.key] !== undefined ? String(src[f.key]).trim() : String(before?.[f.key] ?? "").trim()
        }
        return { row: Number(r?.row) || 0, values }
      })

      const ignored = []
      /** 给前端看的"顺带做了什么"提示（与 ignored 区分：那是被拒的字段） */
      const notices = []

      /**
       * 没填的字段按默认值落表
       *
       *   账号强度 → 「中配」；帮帮完成情况 → 按各榜开榜时间（剧诗排队中 / 深渊看日子 / 危战等待开启）
       * 只对"有内容的行"生效：整行留空是删除，不能被默认值救回来。
       */
      const defaults = { strength: DEFAULT_STRENGTH, status: defaultStatusOf(sheet) }
      for (const r of normalized) {
        if (FIELDS.every(f => blank(r.values[f.key]))) continue
        if (!r.values.strength) r.values.strength = defaults.strength
        if (!r.values.status) r.values.status = defaults.status
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
      /** 属于自己的行：以 QQ 绑定为准（昵称兜底），与机器人 #排队 同一套口径 */
      const mine = new Set(
        caller.role === "self" ? [locateSelf(model, bindView(binds), sheet, qq, nick).row].filter(Boolean) : [],
      )

      if (caller.role === "self") {
        for (const r of normalized) {
          const isMine = mine.has(r.row)
          const isNew = !model.rows.some(x => x.row === r.row)
          /**
           * 放行两类：**自己名下的行**，以及**表里还没有的空行**。
           *
           * 以前新行还额外要求 `sameNick(values.nickname, nick)`，于是"身份里没有群名片"的人
           * **永远建不了行**：云端没收到群名单时，短链展开出来的身份 `n` 是空的，新建行就被判成
           * 不是自己的（现场报错：`第 8 行不是你的记录，只能改自己那一行`）。
           * 空行本来就没有主人，谁在页面里建都行，这不影响 AQ-02 要防的"同名抢已有行"。
           */
          if (isMine || isNew) continue
          throw new Error(`第 ${r.row} 行不是你的记录，只能改自己那一行`)
        }
        /** 主播改过的完成情况：本人不能再改，这一格忽略掉，其余照写 */
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const locked = lockRows[lockKey(sheet, r.row)]
          if (!before || !locked) continue
          if (r.values.status !== String(before.status ?? "").trim()) {
            r.values.status = String(before.status ?? "").trim()
            ignored.push({ row: r.row, label: "帮帮完成情况", reason: "已由主播填写" })
          }
        }
      }

      const problems = validateRows(model, normalized)
      if (problems.length) throw new Error(`校验未通过：\n${problems.slice(0, 6).join("\n")}`)

      /** 管理员这一轮改动了哪些行的完成情况 → 这些行对本人上锁 */
      if (caller.role === "admin") {
        for (const r of normalized) {
          const before = model.rows.find(x => x.row === r.row)
          const after = r.values.status
          if (!before) continue
          if (after === String(before.status ?? "").trim()) continue
          const key = lockKey(sheet, r.row)
          if (blank(after)) delete lockRows[key]
          /** 锁上记下"锁的是谁"：整表替换 / 压紧行之后要靠它校验归属（AQ-03、AQ-08） */
          else lockRows[key] = { by: nick || "管理员", at: Date.now(), nickname: String(r.values.nickname ?? before.nickname ?? "").trim() }
        }
      }
      /** 行被清空 = 这个人退队了，锁一并清掉 */
      for (const r of normalized)
        if (FIELDS.every(f => blank(r.values[f.key]))) delete lockRows[lockKey(sheet, r.row)]

      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
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
          cleared++
          continue
        }
        for (const f of FIELDS) if (m.col?.[f.key]) ctx.setCell(sheet, r.row, f.key, r.values[f.key])
        written++
      }
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
      }
      plan = { binds, locks: lockRows }
      return { written, cleared, ignored, notices, realigned }
    },
    { expect: version, afterCommit: info => persistState(info, plan) },
  )

  return result
}

/**
 * 保存表头上方的「主播列表」（只有管理员能改）
 *
 * 只改表里已经存在的那几行（按行号对齐），不新增/删除行：
 *   A 列 = 主播名 + 【推荐度】、C 强项、D 专职、G/H 直播入口
 * 顺手把「选择主播」那一列的下拉列表也改成同一份名单（**以主播列表为准**），
 * 否则表格自己的下拉会一直停在旧名字上。
 *
 * 与成员保存**同一套并发语义**：请求可以带 `version`（页面读到的那一版表指纹），
 * 对不上就报冲突（409）而不是把别人刚提交的改动盖掉（AQ-06）。主播列表也是写表，
 * 没有理由比数据行少这一层保护。
 * @returns {Promise<{written:number, options:number}>}
 */
const applyAnchors = async (caller, { sheet, rows, version }) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以改主播列表")
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 100) throw new Error("一次提交的主播行数过多（>100）")

  let plan = null
  return table().mutate(
    async ctx => {
      /** 行号必须是表里已有的主播行，避免把内容写到数据区或其它地方（读的是同一版表） */
      const model = ctx.model(sheet)
      const known = new Map(model.anchors.map(a => [a.row, a]))

      const normalized = []
      for (const r of rows) {
        const row = Number(r?.row) || 0
        const before = known.get(row)
        if (!before) throw new Error(`第 ${row} 行不是主播列表里的行，不能改`)
        const values = Object.fromEntries(ANCHOR_FIELDS.map(f => [f.key, String(r?.values?.[f.key] ?? "").trim()]))
        if (!values.name) throw new Error(`第 ${row} 行：主播名不能为空（要删掉这位主播请在表格里删行）`)
        normalized.push({ row, values })
      }

      /** 改完之后的主播名单 → 就是「选择主播」下拉该有的选项（表里在用的旧值追加在后面） */
      const names = model.anchors.map(a => ({ row: a.row, name: a.name }))
      for (const n of normalized) {
        const hit = names.find(x => x.row === n.row)
        if (hit) hit.name = n.values.name
      }
      const listPlan = validationPlan(model, names.map(n => n.name))
      const options = listPlan.anchor

      /** 写表前留底：历史版本 + 每日/换月归档 */
      await snapshotBeforeWrite()
      for (const { row, values } of normalized) {
        /** A 列原文是「主播名【推荐度】」，推荐度单独一格填，这里拼回去 */
        const name = values.recommend ? `${values.name}【${values.recommend}】` : values.name
        for (const f of ANCHOR_FIELDS) {
          if (!f.col) continue
          ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? name : values[f.key])
        }
      }
      /**
       * 两列下拉都同步成同一份名单，并把校验强度从 stop 调成 warning：
       * Excel/腾讯文档的数据验证不支持真多选，stop 会把「阿修Axiu,听雨」这种手写多值直接打回，
       * 改成 warning 后仍然给下拉、仍然提示，但允许填多值。
       */
      writeValidationPlan(ctx, sheet, listPlan)
      /** 表换了版本：绑定与锁要跟着盖上新版本，否则下次对账会把它们全作废 */
      const state = await ownershipIn(ctx, await store())
      plan = { binds: state.binds, locks: state.locks }
      return { written: normalized.length, options: options.length }
    },
    { expect: version, afterCommit: info => persistState(info, plan) },
  )
}

/**
 * 两份下拉名单的"计划"：选择主播 与 帮帮完成情况
 *
 * 规则（两列一致）：
 *   1. 表头上方主播列表里的正名在前（去重）
 *   2. 表里手填/在用的其它值（不在名单里的主播、都可以、排队中…）**自动收进来当选项**
 *      —— 这就是"手填的主播自动归档为下拉选项"，免得表里能用、下拉里却没有
 * @param {object} model 榜模型
 * @param {string[]|null} anchorsOverride 主播区刚改完的名单（保存主播列表时用）
 */
const validationPlan = (model, anchorsOverride = null) => {
  const names = (anchorsOverride ?? model.anchors.map(a => a.name)).map(s => String(s ?? "").trim()).filter(Boolean)
  const anchors = [...new Set(names)]
  const anchorCol = model.col?.anchor
  const statusCol = model.col?.status
  const anchor = anchorCol ? effectiveOptions({ ...model, anchors: anchors.map(name => ({ name })) }).anchor : []
  const status = statusCol ? mergeStatusOptions(model, anchors) : []
  return { anchorCol, statusCol, anchor, status }
}

/** 把两份名单写进表（统一用 warning：Excel 的数据验证不支持真多选，stop 会把「A,B」这种手填值拦下） */
const writeValidationPlan = (ctx, sheet, plan) => {
  if (plan.anchorCol && plan.anchor.length) ctx.setValidationList(sheet, plan.anchorCol, plan.anchor, { errorStyle: "warning" })
  if (plan.statusCol && plan.status.length) ctx.setValidationList(sheet, plan.statusCol, plan.status, { errorStyle: "warning" })
}

/**
 * 表里手填了新名字就把它归档进下拉选项（只有管理员打开时做，且只在真有新名字时才写表）
 *
 * 读与写同样在同一个临界区里：不然"读出来要归档"和"真写进去"之间表可能已经被换掉（AQ-06）。
 */
const archiveOptions = async caller => {
  if (caller.role !== "admin") return 0
  let work = []
  let plan = null
  await table().mutate(
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
      await snapshotBeforeWrite()
      for (const { name, plan: p } of work) writeValidationPlan(ctx, name, p)
      const state = await ownershipIn(ctx, await store())
      plan = { binds: state.binds, locks: state.locks }
      return { archived: work.reduce((n, x) => n + x.fresh.length, 0) }
    },
    { afterCommit: info => persistState(info, plan) },
  )
  if (!work.length) return 0
  const total = work.reduce((n, x) => n + x.fresh.length, 0)
  console.log(`[editor] 已把手填的 ${total} 个名字归档进下拉选项：${work.map(x => `${x.name}（${x.fresh.join("、")}）`).join("；")}`)
  return total
}

/**
 * 开榜时间到了、表里还写着「等待开启」的行：自动翻成「排队中」
 *
 * 剧诗每月 1 号 4 点、深渊每月 16 号 4 点开，到点之后表里不该再留着「等待开启」。
 * 只由管理员打开页面时顺带做（危战没有固定开榜日子，它的「等待开启」是正常值，不动）。
 * @returns {Promise<number>} 改了几行
 */
const catchUpOpenStatus = async caller => {
  if (caller.role !== "admin") return 0
  let opened = []
  let plan = null
  await table().mutate(
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
      await snapshotBeforeWrite()
      for (const o of opened) ctx.setCell(o.sheet, o.row, "status", QUEUED_STATUS)
      const state = await ownershipIn(ctx, await store())
      plan = { binds: state.binds, locks: state.locks }
      return { opened: opened.length }
    },
    { afterCommit: info => persistState(info, plan) },
  )
  if (!opened.length) return 0
  console.log(
    `[editor] 开榜时间已到，把 ${opened.length} 行的「${WAITING_STATUS}」改成「${QUEUED_STATUS}」：` +
      opened.map(o => `${o.sheet} 第 ${o.row} 行${o.nickname ? `「${o.nickname}」` : ""}`).join("；"),
  )
  return opened.length
}

/* ------------------------- 历史版本 / 归档 / 覆盖写入 ------------------------- */

/**
 * 版本与归档的实现都在 `editor/versions.js`（连文件名正则一起），装配点在上方；
 * 本文件只留**整表替换**——它要和绑定/锁的归属重建在同一次状态转换里，不能搬走。
 */

/** 归档清单（新的在前）：月度在前，其次每日 —— 见 `editor/versions.js` */

/**
 * 整表替换必须带的列（表头识别出来的列字母）
 *
 * 编辑器会写这些列，缺任何一列都会让对应字段"界面能填、保存却悄悄丢掉"；
 * 业务读取（机器人出图、锁、进度）也依赖它们。空模板允许（结构在、一行数据都没有），
 * 但连表头都没有的表一律拒绝，并把缺什么说清楚（AQ-07）。
 */
const REPLACE_REQUIRED_COLUMNS = [
  ["seq", "序号"],
  ["nickname", "群昵称"],
  ["gameName", "原神游戏名"],
  ["anchor", "选择主播"],
  ["goal", "难度及目标"],
  ["strength", "账号强度"],
  ["status", "帮帮完成情况"],
  ["note", "备注"],
]

/**
 * 替换前的结构校验（AQ-07）
 *
 * 以前只比工作表名字：名字对得上、内容却是空表或别的表，照样"上传成功"，
 * 结果编辑器和机器人都读不出任何数据。这里逐表确认表头、必要列与建模结果。
 * @throws {Error} 带具体缺失项的中文说明
 */
const validateReplacement = (after, before) => {
  if (after.names.join("|") !== before.names.join("|"))
    throw new Error(`工作表对不上：文件里是「${after.names.join("、")}」，当前表是「${before.names.join("、")}」，拒绝替换`)
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
 * 走 table().replace —— 与普通保存同一条队列，读/校验/存底/提交都在一个临界区里（AQ-06）。
 *
 * @param {Buffer} bytes 新的表文件
 * @param {string} label 日志里用的来源说明
 * @param {object} [opts]
 * @param {string} [opts.expect] 调用方读到的那一版指纹；不一致 → 冲突（不覆盖别人的改动）
 * @returns {Promise<{version:string, size:number, fp:string, bindings:object, locks:object}>}
 */
const replaceTable = async (bytes, label, { expect } = {}) => {
  if (!bytes?.length) throw new Error("内容是空的")
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`文件过大（${Math.round(bytes.length / 1024 / 1024)}MB），拒绝替换`)

  /** 先探一次"这到底是不是 xlsx"：错的是文件类型，不该报成"结构不完整" */
  try {
    const probe = await openWorkbook(bytes)
    if (!probe.sheets?.length) throw new Error("里面没有任何工作表")
  } catch (err) {
    throw new Error(`这份文件不是能读的 xlsx：${err?.message ?? err}`)
  }

  const bindStore = await store()
  let snapshot = ""
  let plan = null
  let rebuilt = { bindKept: 0, bindDropped: 0, lockKept: 0, lockDropped: 0 }
  let out
  try {
    out = await table().replace(bytes, {
      expect,
      validate: validateReplacement,
      /**
       * 关联状态迁移：绑定与锁按**新表**的群昵称重新对账
       * 昵称在新表里唯一命中 → 跟过去（改名/挪行都认）；命中不了 → 作废，绝不按旧行号认人
       */
      transition: ({ before, after }) => {
        rebuilt = rebuildOwnership(after.models, bindStore.data.binds ?? {}, loadLocks().rows ?? {}, before.models)
        plan = { binds: rebuilt.binds, locks: rebuilt.locks }
        return rebuilt
      },
      beforeWrite: async () => {
        snapshot = await snapshotBeforeWrite()
      },
      afterCommit: info => persistState(info, plan),
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

/* ------------------------- 群成员名单（候选人 + 按 QQ 对账） ------------------------- */

/**
 * `loadRoster` / `saveRoster` / `nickCandidates` / `nickOf` 的实现都在 `editor/roster.js`，
 * 装配点在上方「装配：群名单 / 白名单 / 锁」。这里只留"按 QQ 对账表"那段业务（见下）。
 */

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
const compactSheet = async (ctx, model, dropRows) => {
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
 * 按名单对账：改了群名片 → 同步表里该 QQ 那行的群昵称；退群/被移出 → 删掉那一行并压紧
 *
 * 删行前会自动存历史版本（同一临界区里做），所以退群删错能回退。
 *
 * 绑定与锁的迁移**只从不可变旧快照读、写进全新对象、最后整体替换**（AQ-08）：
 * 以前锁是"原地读旧键、写新键、删旧键"，新键可能正好是还没迁移的另一条锁，
 * 结果一条被覆盖、另一条落在错的行上——被锁住的人变成了别人。
 * @returns {Promise<{renamed:number, removed:number}>}
 */
const reconcileRoster = async members => {
  const byQq = new Map()
  for (const m of members) {
    const qq = String(m?.qq ?? "").trim()
    if (qq) byQq.set(qq, String(m?.nick ?? "").trim())
  }
  const bindStore = await store()
  const renamed = []
  const gone = []
  for (const [sheet, list] of Object.entries(bindStore.data.binds ?? {})) {
    for (const [qq, info] of Object.entries(list ?? {})) {
      const row = Number(info?.row)
      if (!row) continue
      if (!byQq.has(String(qq))) {
        gone.push({ sheet, row, qq })
        continue
      }
      const nick = byQq.get(String(qq))
      const old = String(info?.nickname ?? "").trim()
      if (nick && nick !== old) renamed.push({ sheet, row, qq, from: old, nick })
    }
  }
  if (!renamed.length && !gone.length) return { renamed: 0, removed: 0 }

  let removedRows = 0
  let plan = null

  await table().mutate(
    async ctx => {
      await snapshotBeforeWrite()

      const state = await ownershipIn(ctx, bindStore)
      const binds = state.binds
      const lockRows = state.locks

      /** 1) 改名：直接改那一行的群昵称；绑定与锁上记的昵称一起换（否则归属就"对不上"了） */
      for (const r of renamed) {
        const model = ctx.model(r.sheet)
        if (model.col?.nickname) ctx.setCell(r.sheet, r.row, "nickname", r.nick)
        bindSet(binds, r.sheet, r.qq, { row: r.row, nickname: r.nick })
        renameLock(lockRows, r.sheet, r.row, r.nick)
      }

      /** 2) 退群：按榜分组，删行 + 压紧 */
      const bySheet = new Map()
      for (const g of gone) {
        if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, [])
        bySheet.get(g.sheet).push(g.row)
      }

      /** 先把各榜的 drop / 位移算出来：迁移绑定与锁都只读这一份，不再回头改表 */
      const moves = new Map()
      for (const [sheet, rows] of bySheet) {
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

      /**
       * 锁：从不可变旧快照（lockRows）生成全新的对象，迁移完整体替换，
       * 并且**校验归属** —— 锁上记的人必须就是被搬走那一行上的人，否则作废
       */
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
        /** 锁错人比不锁更糟：归属对不上就丢掉，让主播重新填一次 */
        if (nick && atRow && nick !== atRow) continue
        const to = lockKey(sheet, move.shift.get(row))
        if (nextLocks[to]) continue
        nextLocks[to] = { ...lock, ...(nick ? { nickname: nick } : {}) }
      }

      for (const [sheet, { model, drop }] of moves) {
        const out = await compactSheet(ctx, model, [...drop])
        removedRows += out.removed
        console.log(`[editor] 群成员退群，已从「${sheet}」删掉 ${out.removed} 行并压紧（${out.moved} 行上移）`)
      }

      plan = { binds, locks: nextLocks }
      return { renamed: renamed.length, removed: removedRows }
    },
    { afterCommit: info => persistState(info, plan) },
  )

  if (renamed.length)
    console.log(
      `[editor] 按群名单同步群昵称：` + renamed.map(r => `${r.sheet} 第 ${r.row} 行「${r.from}」→「${r.nick}」`).join("；"),
    )
  return { renamed: renamed.length, removed: removedRows }
}

/* ------------------------------ HTTP ------------------------------ */
const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body), "utf8")
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length })
  res.end(buf)
}

const readBody = req =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", c => {
      chunks.push(c)
      if (Buffer.concat(chunks).length > 4 * 1024 * 1024) reject(new Error("请求体过大"))
    })
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`))
      }
    })
    req.on("error", reject)
  })

/** 原始字节的请求体（上传整张表用）：上限 32MB，与 replaceTable 的校验一致 */
const readRawBody = (req, limit = 32 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", c => {
      size += c.length
      if (size > limit) {
        reject(new Error(`请求体过大（>${Math.round(limit / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })

/**
 * 功能清单：写进 /healthz，用来比对「在线编辑器」与「本地编辑器」是不是同一版
 * 加了新功能就补一条，两台机器的 healthz 一比就知道谁落后了
 */
const FEATURES = [
  "identity", // 个人链接签名身份
  "acl", // 白名单（可热改）
  "status-lock", // 主播改过的完成情况锁定
  "anchors", // 表头主播列表可维护
  "anchor-options", // 下拉以主播列表为准
  "alias", // 主播别名
  "multi-select", // 选择主播 / 完成情况多选
  "exclusive-done", // 等待开启·排队中 与完成人互斥
  "self-done-nick", // 本人已完成 落成群昵称
  "archive-options", // 手填名字自动归档进下拉
  "warning-validation", // 表格下拉放宽为 warning（允许手写多值）
  "fields-status", // 完成情况字段
  "owner", // 主人（能维护白名单、看历史版本）
  "owner-only", // 本机编辑器：只有主人能打开
  "sign-key", // 身份签名密钥与访问口令分开
  "versions", // 历史版本 + 回退
  "archives", // 每月最后一次修改 + 每日归档（可下载）
  "upload", // 上传覆盖当前表 / 本机推云端
  "roster", // 群成员名单（群昵称候选 + 按 QQ 对账）
  "required4", // 必填四项：群昵称/游戏名/选择主播/难度
  "auto-status", // 完成情况按各榜开榜时间自动填
  "open-catchup", // 到点自动把「等待开启」翻成「排队中」
  "acl-qq", // 权限只认 QQ（群昵称不再当权限，历史昵称条目会被拒绝并提示）
  "table-version", // 表版本（文件指纹）：/api/data 下发，保存/上传可带回来做冲突检测
  "replace-transition", // 整表替换时绑定与完成情况锁一起对账（换表不转移归属）
  "upload-validate", // 上传前逐表校验表头与必要列（空模板可以，空表壳不行）
  "lock-owner", // 完成情况锁带群昵称，压紧/换表时校验归属
  "anchor-version", // 主播列表保存也带表版本（与成员保存同一套 409 冲突检测）
  "reload-keep-drafts", // 「重新读取」默认保留草稿并列差异；丢草稿要显式点「丢弃草稿并重读」
  "ownership-audit", // 主人专用：归属状态审计 + 按当前表重建（方案 B：不给表加成员 ID 列）
]

/**
 * 访问口令 + 身份
 *
 * 口令（?k=）决定「能不能用这个服务」，身份签名（?u= & ?s=）决定「你是谁」。
 * 两者都在链接里，前端存进 localStorage 后随请求带上。
 */
const queryOf = req => new URL(req.url, "http://localhost")
const tokenOf = req => {
  const u = queryOf(req)
  return u.searchParams.get("k") ?? u.searchParams.get("token") ?? ""
}
const authorized = req => !TOKEN || tokenOf(req) === TOKEN

/**
 * 认出调用者
 *
 * 本机没设口令时（TOKEN 为空）等同管理员，方便本机调试；
 * 设了口令就必须验签，验不过的当作没有身份的访客（只读）。
 */
const callerOf = req => {
  const u = queryOf(req)
  const identity = verifyIdentity(u.searchParams.get("u"), u.searchParams.get("s"), SIGN_KEY)
  const adminTokenOk = Boolean(ADMIN_TOKEN) && u.searchParams.get("a") === ADMIN_TOKEN
  /**
   * 权限**只按稳定 QQ 判断**（AQ-01）
   *
   * 群昵称是本人随时能改的展示名：以前白名单里写主人 QQ 数字时，
   * 任何人把群名片改成同一串数字就能拿到主人权限；与主人同名的也一样。
   * 昵称条目现在在 loadAdmins/loadOwners 里已经解析不出来（被忽略），这里连比都不比。
   */
  const qq = String(identity?.qq ?? "").trim()
  const inList = Boolean(qq) && loadAdmins().includes(qq)
  /** 主人：白名单里唯一能增删白名单的人（管理口令是它的备用入口） */
  const owner = Boolean(qq) && loadOwners().includes(qq)
  const isAdmin = !TOKEN || adminTokenOk || owner || inList
  return {
    identity,
    adminTokenOk,
    owner,
    role: isAdmin ? "admin" : identity ? "self" : "guest",
  }
}

/** 谁能维护白名单：主人，或拿着管理口令的人（本机没设口令时照旧全放开，方便调试） */
const canManageAdmins = caller => !TOKEN || caller.owner || caller.adminTokenOk

/* ----------------------------- 页脚与三个提示页 ----------------------------- */

/**
 * 页脚 HTML：插件配置 `footer.html` 里的内容**原样**插进页面（留空 = 整块不渲染）。
 *
 * 为什么不拆字段、不做转义：版权与备案怎么排是维护者的事（行数、链接、公安备案的图），
 * 编辑器只负责"有就画、没有就不画"。它是**维护者自己写的内容**，不是群友输入——
 * 别把用户可控的字符串接到这里。
 */
const footerHtml = () => String(FOOTER_HTML ?? "").trim()

/** 首页的隐藏页脚容器（脚本拉到 `/api/meta` 后填） */
const footerHome = `<div class="site-footer" id="siteFooter" hidden></div>`

/** 三个提示页共同的样式：卡片居中 + 页脚贴底（`botPad` 是给页脚留的高度） */
const pageCss = botPad => `body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;position:relative;padding-bottom:${botPad}}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16)}
.site-footer{position:absolute;left:0;right:0;bottom:14px;text-align:center;font-size:12px;line-height:1.9;color:#7b8399}
.site-footer a{color:#5c6b96;text-decoration:none}
.site-footer a:hover{text-decoration:underline}
.site-footer img{vertical-align:middle}`

/** 提示页的页脚块（贴底）；没有配置就不渲染 */
const pageFooter = () => {
  const html = footerHtml()
  return html ? `<div class="site-footer">${html}</div>` : ""
}

/** 未授权时给一个极简的「输入口令」页，避免直接 403 让人摸不着头脑 */
const denialPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 需要口令</title>
<style>${pageCss("120px")}
.card{width:min(92vw,340px)}
h1{font-size:17px;margin:0 0 6px}p{color:#6b7590;font-size:13px;margin:0 0 16px}
input{width:100%;padding:10px;border:1px solid #d6deef;border-radius:8px;font:inherit;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#c8a35a;color:#3a2c07;font:inherit;font-weight:700;cursor:pointer}
.err{color:#a53c2e;font-size:13px;margin-top:10px;display:none}</style></head>
<body><div class="card"><h1>排队表</h1><p>请输入群里的访问口令</p>
<form onsubmit="go(event)"><input id="k" placeholder="访问口令" autocomplete="off"><button>进入</button></form>
<div class="err" id="e">口令不对，请重新输入</div>
<script>
const q=new URLSearchParams(location.search);
if(q.get('bad'))document.getElementById('e').style.display='block';
/**
 * 编辑器页面会把地址栏清干净（避免截图带走口令），所以"刷新一下"会落到这里。
 * 口令与身份都还在这台浏览器里，直接拼回地址栏，不用再输一遍。
 * 带了口令却仍然被拦（口令不对）时不自动跳，免得来回弹。
 */
const saved=localStorage.getItem('abyss-editor-token');
if(saved&&!q.get('k')){
  const u=sessionStorage.getItem('abyss-editor-identity'),s=sessionStorage.getItem('abyss-editor-sign');
  location.replace(location.pathname+'?k='+encodeURIComponent(saved)+(u&&s?'&u='+encodeURIComponent(u)+'&s='+encodeURIComponent(s):''));
}
function go(ev){ev.preventDefault();const k=document.getElementById('k').value.trim();if(!k)return;location.href=location.pathname+'?k='+encodeURIComponent(k)}
</script></div>${pageFooter()}</body></html>`

/** 只给主人用的时候，别人打开首页看到的话 */
const ownerOnlyPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 仅主人可用</title>
<style>${pageCss("120px")}
.card{width:min(92vw,360px)}
h1{font-size:17px;margin:0 0 8px}p{color:#6b7590;font-size:13px;margin:0 0 10px}
b{color:#23283a}</style></head>
<body><div class="card"><h1>这是本机编辑器</h1>
<p>本机这份是云端数据的备份，<b>只有主人</b>能打开。</p>
<p>群友请用群里 <b>#排队</b> 拿到的链接，那是服务器上的在线编辑器。</p>
</div>${pageFooter()}</body></html>`

/** 短链验不过（过期 / 被改过 / 换了签名密钥）时的提示页 */
const expiredLinkPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 链接已失效</title>
<style>${pageCss("120px")}
.card{width:min(92vw,380px)}
h1{font-size:17px;margin:0 0 8px}p{color:#6b7590;font-size:13px;margin:0 0 10px}b{color:#23283a}</style></head>
<body><div class="card"><h1>这个填表链接已经失效</h1>
<p>链接有有效期（30 天），也可能是换了签名密钥、或被人改过。</p>
<p>请回到群里重新发一次 <b>#排队</b>，取一条新链接再点。</p>
</div>${pageFooter()}</body></html>`

/**
 * 问一下云端现在是哪一版表（推表前用）
 *
 * 拿不到就返回空串：老版本云端没有 /api/version，推表照旧（不带版本 = 不做冲突检测），
 * 不能因为一个新接口没上线就把"上传覆盖云端"整个弄坏。
 */
const cloudVersion = async () => {
  try {
    const res = await fetch(`${CLOUD_URL}/api/version?k=${encodeURIComponent(TOKEN)}`, { signal: AbortSignal.timeout(15000) })
    const out = await res.json()
    return res.ok && out?.ok ? String(out.version ?? "") : ""
  } catch (err) {
    console.warn(`[editor] 取云端版本失败（推表将不做冲突检测）：${err?.message ?? err}`)
    return ""
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const pathname = innerPath(url.pathname)

  /**
   * 短链：`<editor_url>/s/<码>` → 换成带身份的长地址再跳过去
   *
   * 群里发的是这个短链（机器人用 signTicket 签的，见 lib/identity.js）：
   * 码只有 16 个字符、看不出结构（QQ 经置换 + MAC），群名片在这里按 QQ 从群名单补上，
   * 所以链接能短到四十来个字符。
   * 这一步**先于口令校验**：码本身就是凭证，验过才换到带 `k=` 的地址；
   * 验不过就给一页"回群里重新发 #排队"，而不是落回"输入口令"那页（免得让人以为口令错了）。
   */
  if (req.method === "GET" && (pathname === `/${SHORT_PATH}` || pathname.startsWith(`/${SHORT_PATH}/`))) {
    let code = ""
    try {
      code = decodeURIComponent(pathname.slice(SHORT_PATH.length + 2))
    } catch {}
    const ticket = verifyTicket(code, SIGN_KEY)
    const id = ticket ? signIdentity({ qq: ticket.qq, nick: await nickOf(ticket.qq) }, SIGN_KEY) : null
    if (!id) {
      res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(expiredLinkPage())
    }
    const params = new URLSearchParams()
    if (TOKEN) params.set("k", TOKEN)
    params.set("u", id.u)
    params.set("s", id.s)
    /**
     * 跳回哪一段路径：请求里带了前缀（nginx 原样转发）就用请求里那段，否则用挂载配置
     * （nginx 把前缀剥掉、或本机挂在根目录 `/` 时，请求里没有前缀可依）
     */
    const at = url.pathname.lastIndexOf(`/${SHORT_PATH}/`)
    const prefix = at > 0 ? url.pathname.slice(0, at) : MOUNT
    res.writeHead(302, { location: `${prefix}/?${params}`, "cache-control": "no-store" })
    return res.end()
  }

  if (!authorized(req)) {
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(denialPage())
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }

  /**
   * 只给主人用（本机编辑器用这个开关开着）
   *
   * 本机那份是云端数据的备份/工作副本，只让主人碰：其他人一律挡在门外，
   * 免得群友在本机界面上改到备份、又被传回云端。
   * 例外是几个**只读且不含表格数据**的口子，它们本来就只凭口令放行：
   *   - `/api/snapshot`：机器人拉快照
   *   - `/api/version`：推表前问一版（只回表指纹）
   *   - `/api/meta`：页面元信息（页脚 HTML / 版本 / 版本份数）——不给的话"需要口令"页也拉不到页脚
   *   - `/healthz`：启动器 / 运维探活
   */
  if (
    OWNER_ONLY &&
    pathname !== "/api/snapshot" &&
    pathname !== "/api/version" &&
    pathname !== "/api/meta" &&
    pathname !== "/healthz"
  ) {
    const caller = callerOf(req)
    if (!caller.owner && !caller.adminTokenOk) {
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" })
        return res.end(ownerOnlyPage())
      }
      return json(res, 403, { ok: false, error: "本机编辑器只有主人能打开；群友请用群里 #排队 拿到的链接（云端编辑器）" })
    }
  }

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await fsp.readFile(TEMPLATE, "utf8")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(html)
    }

    /**
     * 表格快照：把当前 xlsx 原样吐出来，给机器人当**只读数据源**
     *
     * 机器人不碰本地文件，每次按 TTL 从这里拉一份；这里是全量取（不按身份裁剪），
     * 所以同样要口令 —— `?k=<ABYSS_EDITOR_TOKEN>`。
     */
    if (req.method === "GET" && pathname === "/api/snapshot") {
      const buf = await fsp.readFile(xlsxPath)
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(buf.length),
        "cache-control": "no-store",
      })
      return res.end(buf)
    }

    /**
     * 编辑器页面的中文字体（原神标准字体：汉仪文黑-65W）
     *
     * 字体不入库，先看 `data/fonts` 缓存，没有就按 components/font.js 的镜像列表拉一次；
     * 拿不到就 404，页面自动回落到系统中文（英文数字由页面的 Times New Roman 负责）。
     */
    if (req.method === "GET" && pathname === "/font/cn.woff") {
      const file = await ensureFont("body")
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        return res.end("font unavailable")
      }
      const buf = await fsp.readFile(file)
      res.writeHead(200, { "content-type": "font/woff", "cache-control": "public, max-age=604800" })
      return res.end(buf)
    }

    /**
     * 当前表版本（只凭口令，和 /api/snapshot 一样）
     *
     * "本机 → 云端"推表之前先问一句云端现在是哪一版，再由上传把它带回来：
     * 中间要是有人改过云端，上传会被拒（冲突），而不是把别人的改动盖掉（AQ-06）。
     */
    if (req.method === "GET" && pathname === "/api/version")
      return json(res, 200, { ok: true, version: await table().fingerprint() })

    /**
     * 页面元信息：**只凭口令**（与 /api/version、/api/snapshot 同一档）
     *
     * 只回"画页面要用"的东西，不碰表格数据：
     *   - `footer`：插件配置 `footer.html` 的**原样 HTML**（空串 = 不显示页脚）。
     *     它是维护者自己写的内容，不是群友输入，所以前端**故意用 innerHTML 插进去**；
     *     别把用户可控的字符串接到这里（那等于给公网页面开一个 XSS 口子）。
     *   - `versionsKeep`：页面上「历史版本」那句提示里的份数。
     *
     * 为什么不并进 /api/data：那一份是表格数据（含按身份裁剪的行），
     * 而页脚在"还没有表格数据"时也该画得出来；分开也让这个响应天然可缓存。
     */
    if (req.method === "GET" && pathname === "/api/meta")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        footer: footerHtml(),
        versionsKeep: VERSIONS_KEEP,
      })

    const caller = callerOf(req)
    if (req.method === "GET" && pathname === "/api/data") {
      /**
       * 先确认绑定/锁是**对着这一版表**的（整表替换或外部改表之后就不是了）：
       * 对不上就按群昵称重新对账，绝不拿旧行号认人（AQ-03）
       */
      await alignOwnership()
      /** 再按 QQ 认人（顺手同步改了名片的昵称、记下绑定），最后按身份裁剪数据 */
      const sync = await syncIdentity(caller)
      /** 管理员打开时，把表里手填、下拉里没有的名字归档成选项 */
      const archived = await archiveOptions(caller)
      /** 管理员打开时，到点的榜把残留的「等待开启」翻成「排队中」 */
      const opened = await catchUpOpenStatus(caller)
      const payload = await buildPayload(caller)
      return json(res, 200, { ...payload, sync: { ...sync, archived, opened } })
    }

    if (req.method === "POST" && pathname === "/api/save") {
      const body = await readBody(req)
      return json(res, 200, { ok: true, ...(await applySave(caller, body)) })
    }

    /** 表头上方的「主播列表」：只有白名单管理员能改（带 `version` 就做版本冲突检测） */
    if (req.method === "POST" && pathname === "/api/anchors") {
      const body = await readBody(req)
      return json(res, 200, { ok: true, ...(await applyAnchors(caller, body)) })
    }

    /**
     * 归属状态（**主人专用**，与 /api/admins 同一口径）
     *
     *   GET  → 当前 QQ → 行 的绑定到底还可不可信（stale / conflict / 记的昵称 vs 表里现在的昵称）+ 锁的摘要
     *   POST { action: "rebuild" } → 按当前表 + 群名单重建（能确认的保留、对不上账的作废），回报做了什么
     *
     * 为什么不给表加"稳定成员 ID"列（方案 B）与这个接口补上了什么，见 editor/README.md。
     * 权限**只认主人**：白名单管理员与本人链接都拿不到（他们要么不该看到全表的归属，
     * 要么本来就只该看到自己那一行）。
     */
    if (pathname === "/api/ownership") {
      if (!canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有主人能查看 / 重建归属状态" })
      if (req.method === "GET") return json(res, 200, { ok: true, ...(await ownershipAudit()) })
      if (req.method === "POST") {
        const body = await readBody(req)
        const action = String(body?.action ?? "").trim()
        /** 只认显式动作：不写 action 就当参数错误，免得一个手滑的 POST 就把归属全重建了 */
        if (action !== "rebuild") return json(res, 400, { ok: false, error: '请求格式不对：需要 { action: "rebuild" }' })
        return json(res, 200, { ok: true, ...(await rebuildOwnershipNow()) })
      }
    }

    /**
     * 历史版本 + 归档清单（主人或管理口令）
     *
     * 版本目录默认是空的——从第一次写表开始攒，不预置任何版本。
     * 归档里：`queue-YYYY-MM.xlsx` = 每月最后一次修改；`queue-YYYY-MM-DD.xlsx` = 每日起始状态（只留最近几天）。
     */
    if (req.method === "GET" && pathname === "/api/versions") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能看历史版本" })
      const st = fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath) : null
      return json(res, 200, {
        ok: true,
        keep: VERSIONS_KEEP,
        archiveDays: ARCHIVE_DAYS,
        dir: VERSIONS_DIR,
        archivesDir: ARCHIVES_DIR,
        current: st ? { at: st.mtime.toISOString(), size: st.size } : null,
        versions: listVersions(),
        archives: listArchives(),
      })
    }

    /**
     * 下载某个历史版本 / 归档（主人或管理口令）—— 归档可以随身带走
     *
     * id 只允许是版本或归档目录里的文件名（挡掉路径穿越）。
     */
    if (req.method === "GET" && pathname === "/api/download") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能下载历史版本/归档" })
      const id = path.basename(String(url.searchParams.get("id") ?? ""))
      /** 认不认这个文件名，只由 `editor/versions.js` 的两条正则决定（与列表/存版本同一份口径） */
      const target = resolveStoredFile(VERSIONS_DIR, ARCHIVES_DIR, id)
      if (!target.kind || !fs.existsSync(target.file)) return json(res, 404, { ok: false, error: `没有这一份：${id}` })
      const buf = await fsp.readFile(target.file)
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(buf.length),
        "content-disposition": `attachment; filename="${id}"`,
        "cache-control": "no-store",
      })
      return res.end(buf)
    }

    /**
     * 回退到某个历史版本（主人或管理口令）
     *
     * 替换前会先把"当前状态"也存成一个版本，所以回退错了还能再退回来。
     */
    if (req.method === "POST" && pathname === "/api/restore") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能回退版本" })
      const body = await readBody(req)
      const id = path.basename(String(body?.id ?? ""))
      if (!RE_VERSION.test(id)) return json(res, 400, { ok: false, error: "版本号不对" })
      const file = path.join(VERSIONS_DIR, id)
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: `没有这个版本：${id}` })
      const out = await replaceTable(await fsp.readFile(file), `历史版本 ${id}`, { expect: body?.version })
      return json(res, 200, { ok: true, restored: id, ...out })
    }

    /**
     * 覆盖当前表（云端上传入口，主人或管理口令）
     *
     * 本机编辑器把「本机那份表」直接 POST 上来：校验 → 存底（版本 + 归档）→ 原子替换。
     */
    if (req.method === "POST" && pathname === "/api/upload") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能覆盖云端表" })
      const bytes = await readRawBody(req)
      /** `?v=<读到的版本>`：上传方声明"我是照着哪一版改的"，对不上就报冲突，不覆盖别人刚提交的改动（AQ-06） */
      const out = await replaceTable(bytes, `上传的表（${caller.identity?.nick || caller.identity?.qq || "主人"}）`, {
        expect: url.searchParams.get("v") ?? "",
      })
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 本机编辑器 → 云端：把本机这份表推上去覆盖云端（只有配了 --cloud 的本机才有）
     *
     * 认证用同一套口令与签名密钥：本机按调用者的身份重新签一次，云端验签后按主人放行。
     * 推之前先问一下云端当前版本并原样带回去：中间云端有人写过就变成冲突，而不是把人家的改动盖掉。
     */
    if (req.method === "POST" && pathname === "/api/push-cloud") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能把本机的表传上云端" })
      if (!CLOUD_URL) return json(res, 400, { ok: false, error: "本机没配云端地址（--cloud / ABYSS_EDITOR_CLOUD）" })
      const bytes = await fsp.readFile(xlsxPath)
      const id = signIdentity({ qq: caller.identity?.qq ?? "", nick: caller.identity?.nick ?? "" }, SIGN_KEY)
      const remoteVersion = await cloudVersion()
      const target =
        `${CLOUD_URL}/api/upload?k=${encodeURIComponent(TOKEN)}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}` +
        (remoteVersion ? `&v=${encodeURIComponent(remoteVersion)}` : "")
      const res2 = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(60000),
      })
      const text = await res2.text()
      let out = null
      try {
        out = JSON.parse(text)
      } catch {
        out = { ok: false, error: `云端返回了非 JSON（HTTP ${res2.status}）：${text.slice(0, 200)}` }
      }
      console.log(
        `[editor] 上传覆盖云端 ${CLOUD_URL}：HTTP ${res2.status} ${out?.ok ? "成功" : out?.error ?? ""}` +
          (remoteVersion ? `（推之前云端版本 ${remoteVersion.slice(0, 12)}）` : ""),
      )
      return json(res, res2.status === 200 && out?.ok ? 200 : 400, { ...out, cloud: CLOUD_URL })
    }

    /**
     * 群成员名单推送（机器人 → 编辑器）
     *
     * 只认机器人身份（ROSTER_QQ）或主人：成员拿不到机器人身份的签名，所以推不动。
     * 收到后就地按 QQ 对账：改名同步表里的群昵称；退群删行并压紧（删前自动存底）。
     */
    if (req.method === "POST" && pathname === "/api/roster") {
      const fromBot = Boolean(caller.identity) && String(caller.identity.qq) === ROSTER_QQ
      if (!fromBot && !canManageAdmins(caller))
        return json(res, 403, { ok: false, error: "只有机器人或主人能推送群成员名单" })
      const body = await readBody(req)
      const members = Array.isArray(body?.members) ? body.members.slice(0, 5000) : null
      if (!members) return json(res, 400, { ok: false, error: "缺少 members" })
      /** 空名单绝不用于对账：那等于把绑定过的人都判成退群 */
      const previous = loadRoster()
      if (!members.length && (previous.members ?? []).length)
        return json(res, 400, { ok: false, error: "推来的是空名单，拒绝按它对账（先确认机器人取成员是否正常）" })

      saveRoster({ group: body?.group, members })
      const out = await reconcileRoster(members)
      return json(res, 200, { ok: true, total: members.length, ...out, candidates: nickCandidates().length })
    }

    /** 白名单维护：主人（或管理口令 ?a=），普通管理员与个人链接都不行 */
    if (pathname === "/api/admins") {
      if (!canManageAdmins(caller))
        return json(res, 403, {
          ok: false,
          error: ADMIN_TOKEN ? "只有主人或管理口令能维护白名单" : "服务端没设主人名单（owner / --owner），无法维护白名单",
        })
      const audit = aclAudit()
      /** fromFile 是**原始条目**：历史昵称条目要能被主人删掉，所以不先过滤 */
      const fromFile = adminFileList("admins")
      const payload = {
        ok: true,
        admins: loadAdmins(),
        owners: loadOwners(),
        env: ENV_ADMINS,
        file: fromFile,
        /** 当不了权限的历史条目（群昵称等）+ "该改成哪个 QQ"的建议（仍要主人确认）（AQ-01） */
        ignored: audit.ignored,
        suggestions: audit.suggestions,
      }
      if (req.method === "GET") return json(res, 200, payload)
      const body = await readBody(req)
      const add = Array.isArray(body?.add) ? body.add : []
      const remove = Array.isArray(body?.remove) ? body.remove : []
      /** 加人只收 QQ：群昵称本人随时能改，收进来就等于留了一条越权口子（AQ-01） */
      const bad = add.map(s => String(s).trim()).filter(s => s && !aclQq(s))
      if (bad.length)
        return json(res, 400, {
          ok: false,
          error:
            `白名单只能填 QQ 号：「${bad.join("、")}」解析不出 QQ。` +
            "群昵称是可修改的展示名，不能当权限（改了名片就顶替别人的权限了）。" +
            (Object.keys(audit.suggestions).length ? ` 群名单里对应的 QQ：${JSON.stringify(audit.suggestions)}（确认后再填）` : ""),
          ignored: audit.ignored,
          suggestions: audit.suggestions,
        })
      const next = fromFile
        .map(s => String(s).trim())
        .filter(s => s && !remove.some(x => String(x).trim().toLowerCase() === s.toLowerCase()))
      for (const item of add) {
        const qq = aclQq(item)
        if (qq && !next.includes(qq) && !ENV_ADMINS.some(e => aclQq(e) === qq)) next.push(qq)
      }
      saveAdmins(next)
      return json(res, 200, { ...payload, file: next })
    }

    /**
     * 健康检查：部署时用来确认服务活着，也用来确认"跑的是哪一版"（升级后忘了重启会在这里看出来）
     *
     * **只凭口令就能看**，所以这里不回吐服务器路径与云端地址（那两样对排障没帮助，泄露了反而多余）；
     * 只给布尔开关与计数。
     */
    if (req.method === "GET" && pathname === "/healthz")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        features: FEATURES,
        fields: FIELDS.map(f => f.key),
        bind: BIND,
        port: PORT,
        mount: MOUNT,
        auth: Boolean(TOKEN),
        sign_key: SIGN_KEY !== TOKEN,
        owner_only: OWNER_ONLY,
        /** 只数"能当权限的 QQ"（AQ-01）；解析不出来的历史昵称条目在 acl_invalid 里 */
        admins: loadAdmins().length,
        owners: loadOwners().length,
        acl_invalid: aclAudit().ignored.length,
        roster: (loadRoster().members ?? []).length,
        roster_group: loadRoster().group || "",
        versions_keep: VERSIONS_KEEP,
        archive_days: ARCHIVE_DAYS,
        admin_api: Boolean(ADMIN_TOKEN),
        aliases: compileAliases(config.anchor_aliases).length,
      })
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    /** 版本冲突（表在保存期间被换掉了）要能和普通参数错误区分开：409 + 明确提示（AQ-06） */
    json(res, err?.conflict ? 409 : 400, { ok: false, conflict: Boolean(err?.conflict), error: err?.message ?? String(err) })
  }
})

/**
 * 主人专用模式却没有主人名单 = 谁都进不来；没配口令 = 谁来都是管理员 —— 两种漏配都**拒绝启动**
 *
 * 与其让人对着 403 猜、或者干脆敞着门，不如启动时就把话说清楚（fail closed，不会因为漏配就放开）。
 * 注意"主人名单"现在只认 QQ（AQ-01）：只写群昵称等于没写。
 */
if (OWNER_ONLY && !loadOwners().length) {
  const audit = aclAudit()
  console.error(
    `[editor] 开了「主人专用」但白名单里没有能用的 owner（${ADMINS_FILE}）：没人能打开。` +
      "请把主人的 **QQ 号**填进 owner（群昵称本人随时能改，不能当权限）" +
      (audit.ownerIgnored.length ? `。当前这些条目解析不出 QQ：${audit.ownerIgnored.join("、")}` : ""),
  )
  process.exit(1)
}
if (!TOKEN && !ALLOW_NO_TOKEN) {
  console.error(
    "[editor] 没配访问口令（--token / ABYSS_EDITOR_TOKEN）：这种状态下**任何人都能改表、覆盖云端、改白名单**。" +
      "已拒绝启动；本机测试要裸跑请显式加 --allow-no-token（或 ABYSS_EDITOR_ALLOW_NO_TOKEN=1）",
  )
  process.exit(1)
}
/**
 * 白名单里解析不出 QQ 的历史条目：权限已经不再看昵称，这些条目必须**当场说清楚**
 *
 * 否则表现是"配了那个人却进不来"（或者反过来，以为配了昵称就等于授权）。
 */
{
  const audit = aclAudit()
  if (audit.ignored.length)
    console.warn(
      `[editor] 白名单里有 ${audit.ignored.length} 条解析不出 QQ 的历史条目，已**拒绝作为权限**（群昵称是可以随时改的展示名，不能当身份）：` +
        `${audit.ignored.join("、")}。请改填对应成员的 QQ 号；` +
        (Object.values(audit.suggestions).some(Boolean)
          ? `群名单里能对上的：${Object.entries(audit.suggestions)
              .filter(([, qq]) => qq)
              .map(([nick, qq]) => `${nick}→${qq}`)
              .join("、")}（确认无误再填）`
          : "群里发一次 #排队 让机器人推群名单后，页面上会给出候选 QQ"),
    )
}

server.listen(PORT, BIND, () => {
  console.log(`排队表编辑器已启动：http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${PORT}`)
  console.log(`  版本：${pluginVersion}`)
  console.log(`  监听：${BIND}:${PORT}${BIND === "0.0.0.0" ? "（对外）" : "（仅本机）"}`)
  console.log(`  挂载前缀：${MOUNT || "（无，直接挂在根路径）"}`)
  console.log(
    `  数据目录：${DATA_BASE}${TEST_PATHS ? "（测试模式：ABYSS_EDITOR_TEST_PATHS=1，允许指到插件外）" : "（固定在插件内，不可配置）"}`,
  )
  console.log(`  表文件：${xlsxPath}`)
  console.log(`  口令：${TOKEN ? "已设置" : ALLOW_NO_TOKEN ? "未设置（--allow-no-token，任何人都能改，仅本机测试）" : "未设置"}`)
  console.log(
    `  身份签名密钥：${
      SIGN_KEY !== TOKEN ? "单独配置（推荐）" : "与口令相同 —— 拿到链接的人能伪造别人的身份，正式部署请配 ABYSS_EDITOR_SIGN_KEY"
    }`,
  )
  console.log(`  白名单：${loadAdmins().length} 人（${ADMINS_FILE}）${aclAudit().ignored.length ? `；另有 ${aclAudit().ignored.length} 条解析不出 QQ 的条目已被拒绝作为权限` : ""}`)
  console.log(`  主人：${loadOwners().join(" / ") || "（未设置，白名单只能靠管理口令维护）"}`)
  console.log(`  主人专用：${OWNER_ONLY ? "是（其他人打不开，只有 /api/snapshot、/api/version 与 /healthz 放行）" : "否（按身份分权）"}`)
  console.log(`  历史版本：${VERSIONS_KEEP > 0 ? `保留最近 ${VERSIONS_KEEP} 份（${VERSIONS_DIR}）` : "已关闭"}`)
  console.log(`  归档：每月最后一次修改长期保留（最多 ${ARCHIVES_KEEP} 个月），每日归档只留最近 ${ARCHIVE_DAYS} 天（${ARCHIVES_DIR}）`)
  console.log(`  云端地址：${CLOUD_URL || "（未配置：本机没有「上传覆盖云端」入口）"}`)
  {
    const roster = loadRoster()
    console.log(
      `  群名单：${
        (roster.members ?? []).length
          ? `${(roster.members ?? []).length} 人（群 ${roster.group}，${new Date(roster.updatedAt).toLocaleString("zh-CN")}）`
          : "（还没有收到机器人推来的群成员名单）"
      }`,
    )
  }
  console.log(`  管理接口：${ADMIN_TOKEN ? "已启用（?a=<管理口令>）" : "未启用（主人仍可在「权限管理」里维护白名单）"}`)
  console.log(`  填写字段：${FIELDS.map(f => f.label).join(" / ")}`)
  console.log("  按任意键退出")
})
