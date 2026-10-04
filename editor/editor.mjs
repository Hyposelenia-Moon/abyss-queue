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
 *   - 可部署到云服务器：监听地址、端口、数据文件、口令都可用环境变量/参数指定
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
 *   --file <xlsx>         表格文件
 *   --port <n>            端口，默认 7788
 *   --bind <addr>         监听地址，默认 127.0.0.1；对外服务填 0.0.0.0
 *   --token <口令>        访问口令；留空则不校验（仅本机测试用）
 *   --admin-token <口令>  管理口令：用它打开 `?a=<口令>` 可维护白名单
 *   --admins <json>       白名单文件，默认与表格同目录的 abyss-editor-admins.json
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, "editor.html")

const args = process.argv.slice(2)
const flag = (name, fallback = "") => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

/**
 * 开关型参数：裸写 `--owner-only` 或 `--owner-only 1/true/yes/on` 都算开；
 * 没写这个参数时用环境变量（`ABYSS_EDITOR_OWNER_ONLY`）。
 */
const boolFlag = (name, envValue = "") => {
  const i = args.indexOf(name)
  if (i < 0) return /^(1|true|yes|on)$/i.test(String(envValue ?? "").trim())
  const next = args[i + 1]
  const raw = next && !next.startsWith("--") ? next : "1"
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/**
 * 日志文件（可选）：`--log <file>` / 环境变量 ABYSS_EDITOR_LOG
 *
 * 存在的理由：本机快捷方式为了不留控制台窗口，是**直接起 node.exe** 的，
 * 没有控制台就没法用 `>>` 重定向；而且挂在控制台上的进程容易被外部的 Ctrl+C 顺手带走。
 * 自己写文件既不依赖外壳，也更稳。
 */
const LOG_FILE = String(flag("--log", process.env.ABYSS_EDITOR_LOG ?? "")).trim()
if (LOG_FILE) {
  const stream = fs.createWriteStream(LOG_FILE, { flags: "a" })
  const tee = original => (...parts) => {
    try {
      const line = parts.map(p => (typeof p === "string" ? p : String(p))).join(" ")
      stream.write(`[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 写日志失败不影响服务 */
    }
    original(...parts)
  }
  console.log = tee(console.log.bind(console))
  console.error = tee(console.error.bind(console))
  console.warn = tee(console.warn.bind(console))
}

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
 * 插件目录
 *
 * **表格读写只保留一份实现**：复制一套 xlsx/表格逻辑迟早会跟插件漂移，那才是真正会污染数据的做法，
 * 所以这里按绝对路径从插件目录加载共用模块。
 *
 * 编辑器就住在插件里（`<plugin>/editor/editor.mjs`），插件根是上一级；
 * 也兼容旧布局（编辑器单独放在插件旁边、两个仓库并排）。
 * 两种都能用 `--plugin <dir>` / 环境变量 ABYSS_PLUGIN_DIR 覆盖。
 */
const pluginDir = () => {
  const inside = path.resolve(HERE, "..")
  return fs.existsSync(path.join(inside, "components", "pluginVersion.js")) ? inside : path.resolve(HERE, "..", "abyss-queue")
}
const PLUGIN_DIR = path.resolve(flag("--plugin", process.env.ABYSS_PLUGIN_DIR ?? pluginDir()))
const shared = rel => import(pathToFileURL(path.join(PLUGIN_DIR, rel)).href)

const { decodeIdentity, signIdentity, verifyIdentity, verifyTicket, SHORT_PATH } = await shared("lib/identity.js")
const { openWorkbook } = await shared("lib/xlsx.js")
const { config } = await shared("components/config.js")
const { ensureFont } = await shared("components/font.js")

const PORT = Number(flag("--port", process.env.ABYSS_EDITOR_PORT ?? 7788))
const BIND = flag("--bind", process.env.ABYSS_EDITOR_BIND ?? "127.0.0.1")
const TOKEN = String(flag("--token", process.env.ABYSS_EDITOR_TOKEN ?? "")).trim()
/**
 * 身份签名密钥（`u/s` 的签名用它，**不进链接**）
 *
 * 与访问口令分开配：口令会出现在每个人的链接里，如果签名也用口令，
 * 任何拿到链接的人都能伪造别人的身份（包括主人）。没配才退回口令，仅适合本机联调。
 */
const SIGN_KEY = String(flag("--sign-key", process.env.ABYSS_EDITOR_SIGN_KEY ?? "")).trim() || TOKEN
const ADMIN_TOKEN = String(flag("--admin-token", process.env.ABYSS_EDITOR_ADMIN_TOKEN ?? "")).trim()
/**
 * 只给主人用（本机编辑器开着这个开关）
 *
 * 本机那份是云端数据的备份/工作副本，只让主人打开：其他人一律 403，
 * 免得群友在本机界面上改到备份、又被传回云端。云端编辑器不开这个开关。
 * 例外：`/api/snapshot` 与 `/healthz` 只凭口令放行（机器人取数、运维探活）。
 */
const OWNER_ONLY = boolFlag("--owner-only", process.env.ABYSS_EDITOR_OWNER_ONLY ?? "")
/**
 * 云端编辑器地址（本机编辑器才配）：配了以后页面上才有「上传覆盖云端」
 *
 * 本机保存只写本机文件；要覆盖云端得主人自己点、再确认一次。
 * 云端与本机用**同一套**访问口令与签名密钥，本机才能代表主人上传。
 */
const CLOUD_URL = String(flag("--cloud", process.env.ABYSS_EDITOR_CLOUD ?? "")).trim().replace(/\/+$/, "")

/**
 * 挂载前缀
 *
 * 部署在 `https://域名/queue` 这类子路径时，nginx 可能把带前缀的路径原样转发过来
 * （`proxy_pass http://127.0.0.1:7788;` 不带尾部斜杠），也可能已经剥掉前缀。
 * 这里两种都接受：带前缀就把前缀去掉再路由，不带就直接用。
 */
const MOUNT = String(flag("--mount", process.env.ABYSS_EDITOR_MOUNT ?? "/queue")).replace(/\/+$/, "")

const innerPath = pathname => {
  if (MOUNT && (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`))) {
    const rest = pathname.slice(MOUNT.length)
    return rest === "" ? "/" : rest
  }
  return pathname
}

/**
 * 数据文件：优先 --file / 环境变量；否则用插件配置里的 xlsx_path。
 * 之所以要能独立指定，是为了让编辑器能单独部署到云服务器。
 */
const resolveFile = () => {
  const direct = flag("--file", process.env.ABYSS_EDITOR_FILE ?? "")
  return direct ? path.resolve(direct) : config.xlsxPath
}

const xlsxPath = resolveFile()
if (!xlsxPath) {
  console.error("没有指定表格文件：用 --file <xlsx> 或环境变量 ABYSS_EDITOR_FILE")
  process.exit(1)
}
if (!fs.existsSync(xlsxPath)) {
  console.error(`表格不存在：${xlsxPath}`)
  process.exit(1)
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
 * 那正是最危险的一类污染。绑定文件同样放在表格旁边，不碰插件的 data/。
 */
let TABLE = null
let STORE = null
const table = () => (TABLE ??= new Table({ file: xlsxPath, backup: config.backup !== false }))
const store = () => (STORE ??= new BindStore(path.join(path.dirname(xlsxPath), "abyss-editor-bindings.json")).load())

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

const sibling = name => path.join(path.dirname(xlsxPath), name)

const ADMINS_FILE = path.resolve(flag("--admins", process.env.ABYSS_EDITOR_ADMINS_FILE ?? sibling("abyss-editor-admins.json")))
const LOCKS_FILE = path.resolve(process.env.ABYSS_EDITOR_LOCKS_FILE ?? sibling("abyss-editor-locks.json"))
/**
 * 历史版本目录（放在表格旁边，和数据一起备份）
 *
 * 每次**写表前**把当前那份存进去，主人可以在页面上回退；只留最近 VERSIONS_KEEP 份。
 * 空目录也有意义：默认为空 = 从第一次写表开始攒，不预置任何版本。
 */
const VERSIONS_DIR = path.resolve(process.env.ABYSS_EDITOR_VERSIONS_DIR ?? sibling("versions"))
const VERSIONS_KEEP = Number(process.env.ABYSS_EDITOR_VERSIONS_KEEP ?? 20) >= 0 ? Number(process.env.ABYSS_EDITOR_VERSIONS_KEEP ?? 20) : 20
/**
 * 归档目录：前月数据留档（可下载归档）
 *
 *   archives/queue-YYYY-MM.xlsx     **每月最后一次修改**（长期保留，默认留 12 个月）
 *   archives/queue-YYYY-MM-DD.xlsx  每日起始状态（只留最近 ARCHIVE_DAYS 天）
 */
const ARCHIVES_DIR = path.resolve(process.env.ABYSS_EDITOR_ARCHIVES_DIR ?? sibling("archives"))
const ARCHIVE_DAYS = Number(process.env.ABYSS_EDITOR_ARCHIVE_DAYS ?? 7) >= 0 ? Number(process.env.ABYSS_EDITOR_ARCHIVE_DAYS ?? 7) : 7
const ARCHIVES_KEEP = Number(process.env.ABYSS_EDITOR_ARCHIVES_KEEP ?? 12) >= 0 ? Number(process.env.ABYSS_EDITOR_ARCHIVES_KEEP ?? 12) : 12
const pad2 = n => String(n).padStart(2, "0")
/** 本地日期戳（归档文件名用） */
const dayStamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
/**
 * 群成员名单文件（机器人推来的）：群昵称候选 + 按 QQ 对账
 */
const ROSTER_FILE = path.resolve(process.env.ABYSS_EDITOR_ROSTER_FILE ?? sibling("abyss-editor-roster.json"))
/**
 * 机器人专用 QQ：名单只有它（或主人）能推
 *
 * 成员从 #排队 拿到的是**自己 QQ** 的签名，拿不到这个身份，所以推不动名单。
 */
const ROSTER_QQ = String(flag("--roster-qq", process.env.ABYSS_EDITOR_ROSTER_QQ ?? "0")).trim() || "0"

/** 环境变量里写死的白名单：管理接口删不掉，只能改环境变量 */
const ENV_ADMINS = String(process.env.ABYSS_EDITOR_ADMINS ?? "")
  .split(/[,，\s]+/)
  .map(s => s.trim())
  .filter(Boolean)

/**
 * 主人（类似群主）：白名单里"还能再管白名单"的那个人
 *
 * 与普通白名单管理员只差一条——主人能增删白名单（右上角「权限管理」）。
 * 三种来源合并：`--owner`、环境变量 ABYSS_EDITOR_OWNER、白名单文件里的 `owner` 数组。
 */
const ENV_OWNERS = String(flag("--owner", process.env.ABYSS_EDITOR_OWNER ?? ""))
  .split(/[,，\s]+/)
  .map(s => s.trim())
  .filter(Boolean)

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
}

/** 白名单：环境变量 + 文件（文件可热改） */
const loadAdmins = () => {
  const fromFile = readJson(ADMINS_FILE)?.admins
  const list = [...ENV_ADMINS, ...(Array.isArray(fromFile) ? fromFile : [])]
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))]
}

/** 主人：环境变量/启动参数 + 文件。主人自动也是管理员，不用重复写进 admins */
const loadOwners = () => {
  const fromFile = readJson(ADMINS_FILE)?.owner
  const list = [...ENV_OWNERS, ...(Array.isArray(fromFile) ? fromFile : [])]
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))]
}

/** 只改 admins 一项：文件里还有 owner 等键，不能顺手抹掉 */
const saveAdmins = list => {
  const cur = readJson(ADMINS_FILE) ?? {}
  writeJson(ADMINS_FILE, { ...cur, admins: [...new Set(list.map(s => String(s).trim()).filter(Boolean))] })
}

/** 完成情况锁：主播改过某行的完成情况后，本人不能再改 */
const lockKey = (sheet, row) => `${sheet}#${row}`
const loadLocks = () => readJson(LOCKS_FILE)?.rows ?? {}
const saveLocks = rows => writeJson(LOCKS_FILE, { rows })


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
  const locks = loadLocks()
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
    },
  }
}

/** 群昵称比对：忽略首尾空白与大小写（英文昵称常见） */
const sameNick = (a, b) => {
  const x = String(a ?? "").trim()
  const y = String(b ?? "").trim()
  return Boolean(x) && Boolean(y) && x.toLowerCase() === y.toLowerCase()
}

/** 这个人在各榜里属于自己的行号：`{ 榜名 → Set(行号) }`（有 QQ 绑定认绑定，否则按群昵称兜底） */
const mineRows = async caller => {
  const bindStore = await store()
  const qq = caller.identity?.qq
  const nick = caller.identity?.nick
  const out = new Map()
  await table().read(({ models }) => {
    for (const model of models.values()) {
      const hit = locateSelf(model, bindStore, model.name, qq, nick)
      out.set(model.name, new Set(hit.row ? [hit.row] : []))
    }
  })
  return out
}

/**
 * 按 QQ 定位账号（与机器人同一套口径，见 lib/queue.js 的 locateSelf）：
 *   - 本人改了群名片 → 把表里的群昵称同步成新名片（只动昵称，游戏名不动）
 *   - 首次按昵称认出来 → 记下 QQ 绑定，以后按 QQ 认人
 *   - 绑定失效（那一行没了，或已经是别人的了）→ 删掉
 * @returns {Promise<{renamed:number, bound:number, dropped:number}>}
 */
const syncIdentity = async caller => {
  const result = { renamed: 0, bound: 0, dropped: 0 }
  if (caller.role !== "self" || !caller.identity?.qq) return result
  const bindStore = await store()
  const qq = caller.identity.qq

  const actions = await table().read(({ models }) =>
    [...models.values()].map(model => ({ model, hit: locateSelf(model, bindStore, model.name, qq, caller.identity.nick) })),
  )

  /** 改了群名片：把表里的群昵称同步过来 */
  const renames = actions.filter(a => a.hit.renamedFrom !== undefined && a.hit.row)
  if (renames.length) {
    try {
      await table().mutate(async ctx => {
    /** 写表前留底：历史版本 + 每日/换月归档 */
    await snapshotBeforeWrite()
        for (const { model, hit } of renames)
          if (ctx.model(model.name)?.col?.nickname) ctx.setCell(model.name, hit.row, "nickname", hit.nick)
      })
      result.renamed = renames.length
      console.log(
        `[editor] QQ ${qq} 改了群名片，已同步表里的群昵称：` +
          renames.map(({ model, hit }) => `${model.name} 第 ${hit.row} 行「${hit.renamedFrom}」→「${hit.nick}」`).join("；"),
      )
    } catch (err) {
      console.error(`[editor] 同步群昵称失败：${err.message}`)
    }
  }

  let dirty = false
  for (const { model, hit } of actions) {
    if (hit.stale) {
      if (bindStore.del(model.name, qq)) {
        dirty = true
        result.dropped++
      }
      continue
    }
    /** 改了名片的那些行，绑定里记的昵称也刷新成新名片 */
    if (hit.renamedFrom !== undefined && hit.row) {
      bindStore.set(model.name, qq, { row: hit.row, nickname: hit.nick })
      dirty = true
      result.bound++
      continue
    }
    if (hit.bind) {
      bindStore.set(model.name, qq, { row: hit.bind.row, nickname: hit.bind.nickname })
      dirty = true
      result.bound++
    }
  }
  if (dirty) await bindStore.save()
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
  return { ...(model.options ?? {}), anchor: list.length ? list : fallback }
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
  const anchorSet = new Set(anchors)
  const fixed = current.filter(v => !anchorSet.has(v))
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
 */
const applySave = async (caller, { sheet, rows }) => {
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 500) throw new Error("一次提交的行数过多（>500）")
  if (caller.role === "guest") throw new Error("这个链接里没有你的身份，只能查看，不能修改（请在群里发 #排队 取你自己的链接）")

  const model = await table().read(({ models }) => models.get(sheet) ?? null)
  if (!model) throw new Error(`表格里没有工作表「${sheet}」`)

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

  const locks = loadLocks()
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
  const bindStore = await store()
  const qq = caller.identity?.qq
  const mine = new Set(
    caller.role === "self"
      ? [locateSelf(model, bindStore, sheet, qq, caller.identity?.nick).row].filter(Boolean)
      : [],
  )

  if (caller.role === "self") {
    for (const r of normalized) {
      const isMine = mine.has(r.row)
      const isNew = !model.rows.some(x => x.row === r.row)
      const becomingMine = sameNick(r.values.nickname, caller.identity?.nick)
      if (isMine || (isNew && becomingMine)) continue
      throw new Error(`第 ${r.row} 行不是你的记录，只能改自己那一行`)
    }
    /** 主播改过的完成情况：本人不能再改，这一格忽略掉，其余照写 */
    for (const r of normalized) {
      const before = model.rows.find(x => x.row === r.row)
      const locked = locks[lockKey(sheet, r.row)]
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
  const nowLocks = { ...locks }
  if (caller.role === "admin") {
    for (const r of normalized) {
      const before = model.rows.find(x => x.row === r.row)
      const after = r.values.status
      if (!before) continue
      if (after === String(before.status ?? "").trim()) continue
      if (blank(after)) delete nowLocks[lockKey(sheet, r.row)]
      else nowLocks[lockKey(sheet, r.row)] = { by: caller.identity?.nick ?? "管理员", at: Date.now() }
    }
  }
  /** 行被清空 = 这个人退队了，锁一并清掉 */
  for (const r of normalized)
    if (FIELDS.every(f => blank(r.values[f.key]))) delete nowLocks[lockKey(sheet, r.row)]

  const result = await table().mutate(async ctx => {
    /** 写表前留底：历史版本 + 每日/换月归档 */
    await snapshotBeforeWrite()
    const m = ctx.model(sheet)
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
    return { written, cleared }
  })

  /** 归属变化：清空的行（退队）解绑；本人写过的行记下/刷新绑定，以后按 QQ 认人 */
  let dirty = false
  for (const r of normalized) {
    if (!r.row) continue
    if (FIELDS.every(f => blank(r.values[f.key]))) {
      if (bindStore.dropRow(sheet, r.row)) dirty = true
      continue
    }
    /** 这一行现在的昵称变了：别人留下的旧绑定（昵称对不上）一并清掉 */
    if (bindStore.dropStale(sheet, r.row, r.values.nickname, qq)) dirty = true
    if (caller.role === "self" && qq && (mine.has(r.row) || sameNick(r.values.nickname, caller.identity?.nick))) {
      bindStore.set(sheet, qq, { row: r.row, nickname: r.values.nickname || caller.identity?.nick })
      dirty = true
    }
  }
  if (dirty) await bindStore.save()

  saveLocks(nowLocks)
  return { ...result, ignored, notices }
}

/**
 * 保存表头上方的「主播列表」（只有管理员能改）
 *
 * 只改表里已经存在的那几行（按行号对齐），不新增/删除行：
 *   A 列 = 主播名 + 【推荐度】、C 强项、D 专职、G/H 直播入口
 * 顺手把「选择主播」那一列的下拉列表也改成同一份名单（**以主播列表为准**），
 * 否则表格自己的下拉会一直停在旧名字上。
 * @returns {Promise<{written:number, options:number}>}
 */
const applyAnchors = async (caller, { sheet, rows }) => {
  if (caller.role !== "admin") throw new Error("只有白名单管理员可以改主播列表")
  if (!sheet || !Array.isArray(rows)) throw new Error("请求格式不对：需要 { sheet, rows }")
  if (rows.length > 100) throw new Error("一次提交的主播行数过多（>100）")

  const model = await table().read(({ models }) => models.get(sheet) ?? null)
  if (!model) throw new Error(`表格里没有工作表「${sheet}」`)
  /** 行号必须是表里已有的主播行，避免把内容写到数据区或其它地方 */
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
  const anchorCol = model.col?.anchor
  const statusCol = model.col?.status
  const plan = validationPlan(model, names.map(n => n.name))
  const options = plan.anchor

  const result = await table().mutate(async ctx => {
    /** 写表前留底：历史版本 + 每日/换月归档 */
    await snapshotBeforeWrite()
    let written = 0
    for (const { row, values } of normalized) {
      /** A 列原文是「主播名【推荐度】」，推荐度单独一格填，这里拼回去 */
      const name = values.recommend ? `${values.name}【${values.recommend}】` : values.name
      for (const f of ANCHOR_FIELDS) {
        if (!f.col) continue
        ctx.setRef(sheet, `${f.col}${row}`, f.key === "name" ? name : values[f.key])
      }
      written++
    }
    /**
     * 两列下拉都同步成同一份名单，并把校验强度从 stop 调成 warning：
     * Excel/腾讯文档的数据验证不支持真多选，stop 会把「阿修Axiu,听雨」这种手写多值直接打回，
     * 改成 warning 后仍然给下拉、仍然提示，但允许填多值。
     */
    writeValidationPlan(ctx, sheet, plan)
    return { written, options: options.length }
  })

  return result
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
 */
const archiveOptions = async caller => {
  if (caller.role !== "admin") return 0
  const work = await table().read(({ models }) =>
    [...models.values()]
      .map(model => {
        const plan = validationPlan(model)
        const known = new Set([...(model.options?.anchor ?? []), ...(model.options?.status ?? [])])
        /** 两份名单里出现了当前验证列表没有的值 → 需要归档 */
        const fresh = [...plan.anchor, ...plan.status].filter(v => v && !known.has(v))
        return { name: model.name, plan, fresh: [...new Set(fresh)] }
      })
      .filter(x => x.fresh.length),
  )
  if (!work.length) return 0
  await table().mutate(async ctx => {
    /** 写表前留底：历史版本 + 每日/换月归档 */
    await snapshotBeforeWrite()
    for (const { name, plan } of work) writeValidationPlan(ctx, name, plan)
  })
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
  const opened = await table().read(({ models }) =>
    [...models.values()]
      .filter(m => OPEN_RULES.some(r => r.test.test(m.name)) && defaultStatusOf(m.name) === QUEUED_STATUS)
      .flatMap(m =>
        m.rows
          .filter(r => String(r.status ?? "").trim() === WAITING_STATUS)
          .map(r => ({ sheet: m.name, row: r.row, nickname: String(r.nickname ?? "").trim() })),
      ),
  )
  if (!opened.length) return 0
  await table().mutate(async ctx => {
    /** 写表前留底：历史版本 + 每日/换月归档 */
    await snapshotBeforeWrite()
    for (const o of opened) ctx.setCell(o.sheet, o.row, "status", QUEUED_STATUS)
  })
  console.log(
    `[editor] 开榜时间已到，把 ${opened.length} 行的「${WAITING_STATUS}」改成「${QUEUED_STATUS}」：` +
      opened.map(o => `${o.sheet} 第 ${o.row} 行${o.nickname ? `「${o.nickname}」` : ""}`).join("；"),
  )
  return opened.length
}

/* ------------------------- 历史版本 / 归档 / 覆盖写入 ------------------------- */

/** 版本文件名：queue-YYYYMMDD-HHMMSS.xlsx（同秒重复就加序号） */
const versionName = (d = new Date()) =>
  `queue-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.xlsx`

/** 已存的历史版本，新的在前 */
const listVersions = () => {
  try {
    return fs
      .readdirSync(VERSIONS_DIR)
      .filter(f => /^queue-\d{8}-\d{6}(-\d+)?\.xlsx$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(VERSIONS_DIR, f))
        return { id: f, at: st.mtime.toISOString(), size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

/** 只留最近 VERSIONS_KEEP 份 */
const pruneVersions = () => {
  if (VERSIONS_KEEP <= 0) return
  for (const v of listVersions().slice(VERSIONS_KEEP)) {
    try {
      fs.rmSync(path.join(VERSIONS_DIR, v.id))
    } catch {
      /* 删不掉下次再说 */
    }
  }
}

/**
 * 把当前这份表存成一个历史版本（**写表前**调用）
 *
 * 空版本目录也就从这里开始攒：不预置任何版本，第一次写表才有第一份。
 * @returns {Promise<string>} 版本文件名（没存成返回空串）
 */
const snapshotVersion = async () => {
  if (VERSIONS_KEEP <= 0) return ""
  try {
    if (!fs.existsSync(xlsxPath)) return ""
    await fsp.mkdir(VERSIONS_DIR, { recursive: true })
    const bytes = await fsp.readFile(xlsxPath)
    /** 和最新版本一模一样就不重复存（空保存不去占用版本位） */
    const newest = listVersions()[0]
    if (newest) {
      const same = await fsp.readFile(path.join(VERSIONS_DIR, newest.id))
      if (Buffer.compare(same, bytes) === 0) return ""
    }
    let name = versionName()
    let n = 1
    while (fs.existsSync(path.join(VERSIONS_DIR, name))) name = versionName().replace(/\.xlsx$/, `-${n++}.xlsx`)
    await fsp.writeFile(path.join(VERSIONS_DIR, name), bytes)
    pruneVersions()
    console.log(`[editor] 已存历史版本 ${name}（写表前）`)
    return name
  } catch (err) {
    console.error(`[editor] 存历史版本失败（不影响写表）：${err?.message ?? err}`)
    return ""
  }
}

/**
 * 写表前的存底：历史版本（滚动）+ 每日归档 + 换月归档
 *
 * - 历史版本：最近的滚动 N 份，用于"刚才那步撤销"
 * - 每日归档：`archives/queue-YYYY-MM-DD.xlsx`，当天第一次写表时留一份，**只留最近 ARCHIVE_DAYS 天**
 * - 换月归档：`archives/queue-YYYY-MM.xlsx`，**前月最后一次修改**（长期保留，默认留 12 个月）
 *
 * 归档失败只记日志，绝不影响写表。
 */
const snapshotBeforeWrite = async () => {
  const version = await snapshotVersion()
  try {
    if (!fs.existsSync(xlsxPath)) return version
    const bytes = await fsp.readFile(xlsxPath)
    await fsp.mkdir(ARCHIVES_DIR, { recursive: true })

    /** 每日归档：同一天只留第一份（那天的起始状态） */
    const day = `queue-${dayStamp()}.xlsx`
    if (!fs.existsSync(path.join(ARCHIVES_DIR, day))) {
      await fsp.writeFile(path.join(ARCHIVES_DIR, day), bytes)
      console.log(`[editor] 已归档当天起始状态 ${day}`)
    }

    /**
     * 换月归档：这份表最后一次修改还是上个月（或更早）→ 那正是"前月最后一次修改"
     *
     * 换月时通常先有人用空模板覆盖/回退，覆盖动作也会走这里，所以上月的收尾状态留得住。
     */
    const mtime = fs.statSync(xlsxPath).mtime
    const month = `${mtime.getFullYear()}-${pad2(mtime.getMonth() + 1)}`
    const nowMonth = `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`
    if (month < nowMonth) {
      const monthly = `queue-${month}.xlsx`
      if (!fs.existsSync(path.join(ARCHIVES_DIR, monthly))) {
        await fsp.writeFile(path.join(ARCHIVES_DIR, monthly), bytes)
        console.log(`[editor] 已归档 ${month} 的最后一次修改：${monthly}`)
      }
    }
    pruneArchives()
  } catch (err) {
    console.error(`[editor] 归档失败（不影响写表）：${err?.message ?? err}`)
  }
  return version
}

/** 归档清单（新的在前）：月度在前，其次每日 */
const listArchives = () => {
  try {
    return fs
      .readdirSync(ARCHIVES_DIR)
      .filter(f => /^queue-\d{4}-\d{2}(-\d{2})?\.xlsx$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(ARCHIVES_DIR, f))
        return { id: f, at: st.mtime.toISOString(), size: st.size, mtime: st.mtimeMs, monthly: /^queue-\d{4}-\d{2}\.xlsx$/.test(f) }
      })
      .sort((a, b) => (a.monthly === b.monthly ? b.mtime - a.mtime : a.monthly ? -1 : 1))
  } catch {
    return []
  }
}

/**
 * 归档只留需要的那部分
 *
 * 每日归档：只留最近 ARCHIVE_DAYS 天（默认 7 天，到点就删）；
 * 月归档：最多留 ARCHIVES_KEEP 个月（默认 12，0 = 一直留着）。
 * 已经下载走的归档不受影响，这里只清服务器上的副本。
 */
const pruneArchives = () => {
  const list = listArchives()
  const now = new Date()
  const keepFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ARCHIVE_DAYS)
  for (const a of list) {
    if (a.monthly) continue
    const m = a.id.match(/^queue-(\d{4})-(\d{2})-(\d{2})\.xlsx$/)
    if (!m) continue
    if (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) >= keepFrom) continue
    try {
      fs.rmSync(path.join(ARCHIVES_DIR, a.id))
      console.log(`[editor] 每日归档超过 ${ARCHIVE_DAYS} 天，已删除：${a.id}`)
    } catch {
      /* 删不掉下次再说 */
    }
  }
  if (ARCHIVES_KEEP <= 0) return
  const monthly = list.filter(a => a.monthly)
  for (const a of monthly.slice(ARCHIVES_KEEP)) {
    try {
      fs.rmSync(path.join(ARCHIVES_DIR, a.id))
    } catch {
      /* 删不掉下次再说 */
    }
  }
}

/**
 * 用一份字节替换当前表（回退 / 云端上传共用）
 *
 * 三步都要过：能被解析、工作表清单与现在一致（防传错文件把表搞坏）、先存底再原子替换。
 * @param {Buffer} bytes 新的表文件
 * @param {string} label 日志里用的来源说明
 * @returns {Promise<{version: string, size: number}>}
 */
const replaceTable = async (bytes, label) => {
  if (!bytes?.length) throw new Error("内容是空的")
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`文件过大（${Math.round(bytes.length / 1024 / 1024)}MB），拒绝替换`)

  let names
  try {
    const wb = await openWorkbook(bytes)
    names = wb.sheets.map(s => s.name)
  } catch (err) {
    throw new Error(`这份文件不是能读的 xlsx：${err?.message ?? err}`)
  }
  const now = await table().read(({ names: current }) => current)
  if (names.join("|") !== now.join("|"))
    throw new Error(`工作表对不上：文件里是「${names.join("、")}」，当前表是「${now.join("、")}」，拒绝替换`)

  const version = await snapshotBeforeWrite()
  const tmp = path.join(path.dirname(xlsxPath), `.${path.basename(xlsxPath)}.replace.tmp`)
  await fsp.writeFile(tmp, bytes)
  await fsp.rename(tmp, xlsxPath)
  console.log(`[editor] 已用 ${label} 覆盖当前表（${bytes.length} 字节，替换前存了 ${version || "未存版本"}）`)
  return { version, size: bytes.length }
}

/* ------------------------- 群成员名单（候选人 + 按 QQ 对账） ------------------------- */

const loadRoster = () => readJson(ROSTER_FILE) ?? { group: "", updatedAt: 0, members: [] }

/** 群昵称候选：名单里的昵称（去重、按中文排序） */
const nickCandidates = () => {
  const set = new Set()
  for (const m of loadRoster().members ?? []) {
    const n = String(m?.nick ?? "").trim()
    if (n) set.add(n)
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"))
}

/**
 * 按 QQ 取这个人**现在的群名片**：群名单（机器人每天推）优先，其次本机绑定记录
 *
 * 短链里的码不放群昵称（中文名一进码就长了），所以身份的 `n` 由这里补上——
 * 机器人签长链接时带的也是同一个东西（发送者当前的群名片）。
 */
const nickOf = async qq => {
  const id = String(qq ?? "").trim()
  if (!id) return ""
  const fromRoster = String((loadRoster().members ?? []).find(m => String(m?.qq ?? "").trim() === id)?.nick ?? "").trim()
  if (fromRoster) return fromRoster
  const bindStore = await store()
  for (const sheet of bindStore.sheetsOf(id)) {
    const nick = String(bindStore.get(sheet, id)?.nickname ?? "").trim()
    if (nick) return nick
  }
  return ""
}

/**
 * 把某一榜的数据行压紧：删掉 dropRows，其余整体上移，队列不留空洞
 *
 * 序号是按行算的公式（=ROW()-偏移），所以只搬 B–H，尾部多出来的行清空，序号自然还是 1..N。
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
    for (const f of FIELDS) {
      if (!model.col?.[f.key]) continue
      ctx.setCell(model.name, target, f.key, item ? String(item[f.key] ?? "") : "")
    }
  }
  for (let r = model.dataStart + kept.length; r <= model.dataEnd; r++) ctx.clearRow(model.name, r)
  return { removed: drop.size, moved: kept.length }
}

/**
 * 按名单对账：改了群名片 → 同步表里该 QQ 那行的群昵称；退群/被移出 → 删掉那一行并压紧
 *
 * 删行前会自动存历史版本（在 mutate 里做），所以退群删错能回退。
 * @returns {Promise<{renamed:number, removed:number}>}
 */
const reconcileRoster = async members => {
  const byQq = new Map()
  for (const m of members) {
    const qq = String(m?.qq ?? "").trim()
    if (qq) byQq.set(qq, String(m?.nick ?? "").trim())
  }
  const bindStore = await store()
  const binds = bindStore.data.binds ?? {}
  const renamed = []
  const gone = []
  for (const [sheet, list] of Object.entries(binds)) {
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

  const locks = loadLocks()
  const nowLocks = { ...locks }
  let removedRows = 0

  await table().mutate(async ctx => {
    await snapshotBeforeWrite()

    /** 1) 改名：直接改那一行的群昵称 */
    for (const r of renamed) {
      const model = ctx.model(r.sheet)
      if (model.col?.nickname) ctx.setCell(r.sheet, r.row, "nickname", r.nick)
    }

    /** 2) 退群：按榜分组，删行 + 压紧 + 绑定/锁定跟着挪 */
    const bySheet = new Map()
    for (const g of gone) {
      if (!bySheet.has(g.sheet)) bySheet.set(g.sheet, [])
      bySheet.get(g.sheet).push(g.row)
    }
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
      for (const qq of Object.keys(bindStore.data.binds?.[sheet] ?? {})) {
        const info = bindStore.get(sheet, qq)
        const row = Number(info?.row)
        if (drop.has(row)) {
          bindStore.del(sheet, qq)
          continue
        }
        if (shift.has(row) && shift.get(row) !== row) bindStore.set(sheet, qq, { ...info, row: shift.get(row) })
      }
      for (const key of Object.keys(nowLocks)) {
        const [s, r] = key.split("#")
        if (s !== sheet) continue
        const row = Number(r)
        if (drop.has(row)) {
          delete nowLocks[key]
          continue
        }
        if (shift.has(row) && shift.get(row) !== row) {
          nowLocks[`${sheet}#${shift.get(row)}`] = nowLocks[key]
          delete nowLocks[key]
        }
      }
      const out = await compactSheet(ctx, model, [...drop])
      removedRows += out.removed
      console.log(`[editor] 群成员退群，已从「${sheet}」删掉 ${out.removed} 行并压紧（${out.moved} 行上移）`)
    }
  })

  await bindStore.save()
  saveLocks(nowLocks)
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
  const list = loadAdmins()
  const inList = Boolean(identity) && (list.includes(identity.qq) || list.includes(identity.nick))
  /** 主人：白名单里唯一能增删白名单的人（管理口令是它的备用入口） */
  const owners = loadOwners()
  const owner = Boolean(identity) && (owners.includes(identity.qq) || owners.includes(identity.nick))
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

/** 未授权时给一个极简的「输入口令」页，避免直接 403 让人摸不着头脑 */
const denialPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 需要口令</title>
<style>body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16);width:min(92vw,340px)}
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
</script></div></body></html>`

/** 只给主人用的时候，别人打开首页看到的话 */
const ownerOnlyPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 仅主人可用</title>
<style>body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16);width:min(92vw,360px)}
h1{font-size:17px;margin:0 0 8px}p{color:#6b7590;font-size:13px;margin:0 0 10px}
b{color:#23283a}</style></head>
<body><div class="card"><h1>这是本机编辑器</h1>
<p>本机这份是云端数据的备份，<b>只有主人</b>能打开。</p>
<p>群友请用群里 <b>#排队</b> 拿到的链接，那是服务器上的在线编辑器。</p>
</div></body></html>`

/** 短链验不过（过期 / 被改过 / 换了签名密钥）时的提示页 */
const expiredLinkPage = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>排队表 · 链接已失效</title>
<style>body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#eef1f8;color:#23283a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 6px 24px rgba(43,53,102,.16);width:min(92vw,380px)}
h1{font-size:17px;margin:0 0 8px}p{color:#6b7590;font-size:13px;margin:0 0 10px}b{color:#23283a}</style></head>
<body><div class="card"><h1>这个填表链接已经失效</h1>
<p>链接有有效期（30 天），也可能是换了签名密钥、或被人改过。</p>
<p>请回到群里重新发一次 <b>#排队</b>，取一条新链接再点。</p>
</div></body></html>`

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
   * 例外两个只读口子：`/api/snapshot`（机器人只拉快照）与 `/healthz`（启动器/运维探活），
   * 它们本来就只凭口令放行。
   */
  if (OWNER_ONLY && pathname !== "/api/snapshot" && pathname !== "/healthz") {
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

    const caller = callerOf(req)
    if (req.method === "GET" && pathname === "/api/data") {
      /** 先按 QQ 认人（顺手同步改了名片的昵称、记下绑定），再按身份裁剪数据 */
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

    /** 表头上方的「主播列表」：只有白名单管理员能改 */
    if (req.method === "POST" && pathname === "/api/anchors") {
      const body = await readBody(req)
      return json(res, 200, { ok: true, ...(await applyAnchors(caller, body)) })
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
      const candidates = [
        { file: path.join(VERSIONS_DIR, id), ok: /^queue-\d{8}-\d{6}(-\d+)?\.xlsx$/.test(id) },
        { file: path.join(ARCHIVES_DIR, id), ok: /^queue-\d{4}-\d{2}(-\d{2})?\.xlsx$/.test(id) },
      ]
      const hit = candidates.find(c => c.ok && fs.existsSync(c.file))
      if (!hit) return json(res, 404, { ok: false, error: `没有这一份：${id}` })
      const buf = await fsp.readFile(hit.file)
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
      if (!/^queue-\d{8}-\d{6}(-\d+)?\.xlsx$/.test(id)) return json(res, 400, { ok: false, error: "版本号不对" })
      const file = path.join(VERSIONS_DIR, id)
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: `没有这个版本：${id}` })
      const out = await replaceTable(await fsp.readFile(file), `历史版本 ${id}`)
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
      const out = await replaceTable(bytes, `上传的表（${caller.identity?.nick || caller.identity?.qq || "主人"}）`)
      return json(res, 200, { ok: true, ...out })
    }

    /**
     * 本机编辑器 → 云端：把本机这份表推上去覆盖云端（只有配了 --cloud 的本机才有）
     *
     * 认证用同一套口令与签名密钥：本机按调用者的身份重新签一次，云端验签后按主人放行。
     */
    if (req.method === "POST" && pathname === "/api/push-cloud") {
      if (!canManageAdmins(caller)) return json(res, 403, { ok: false, error: "只有主人能把本机的表传上云端" })
      if (!CLOUD_URL) return json(res, 400, { ok: false, error: "本机没配云端地址（--cloud / ABYSS_EDITOR_CLOUD）" })
      const bytes = await fsp.readFile(xlsxPath)
      const id = signIdentity({ qq: caller.identity?.qq ?? "", nick: caller.identity?.nick ?? "" }, SIGN_KEY)
      const target = `${CLOUD_URL}/api/upload?k=${encodeURIComponent(TOKEN)}&u=${encodeURIComponent(id.u)}&s=${encodeURIComponent(id.s)}`
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
      console.log(`[editor] 上传覆盖云端 ${CLOUD_URL}：HTTP ${res2.status} ${out?.ok ? "成功" : out?.error ?? ""}`)
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

      writeJson(ROSTER_FILE, {
        group: String(body?.group ?? "").trim(),
        updatedAt: Date.now(),
        members: members.map(m => ({ qq: String(m?.qq ?? "").trim(), nick: String(m?.nick ?? "").trim() })).filter(m => m.qq),
      })
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
      const fromFile = readJson(ADMINS_FILE)?.admins ?? []
      if (req.method === "GET") return json(res, 200, { ok: true, admins: loadAdmins(), owners: loadOwners(), env: ENV_ADMINS, file: fromFile })
      const body = await readBody(req)
      const add = Array.isArray(body?.add) ? body.add : []
      const remove = Array.isArray(body?.remove) ? body.remove : []
      const next = fromFile
        .map(s => String(s).trim())
        .filter(s => s && !remove.some(x => String(x).trim().toLowerCase() === s.toLowerCase()))
      for (const item of add) {
        const s = String(item).trim()
        if (s && !next.includes(s) && !ENV_ADMINS.includes(s)) next.push(s)
      }
      saveAdmins(next)
      return json(res, 200, { ok: true, admins: loadAdmins(), owners: loadOwners(), env: ENV_ADMINS, file: next })
    }

    /* 健康检查：部署时用来确认服务活着，也用来确认"跑的是哪一版"（升级后忘了重启会在这里看出来） */
    if (req.method === "GET" && pathname === "/healthz")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        features: FEATURES,
        fields: FIELDS.map(f => f.key),
        file: xlsxPath,
        bind: BIND,
        port: PORT,
        mount: MOUNT,
        auth: Boolean(TOKEN),
        sign_key: SIGN_KEY !== TOKEN,
        owner_only: OWNER_ONLY,
        admins: loadAdmins().length,
        owners: loadOwners().length,
        roster: (loadRoster().members ?? []).length,
        roster_group: loadRoster().group || "",
        versions_keep: VERSIONS_KEEP,
        archive_days: ARCHIVE_DAYS,
        cloud: CLOUD_URL,
        admin_api: Boolean(ADMIN_TOKEN),
        aliases: compileAliases(config.anchor_aliases).length,
      })
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    json(res, 400, { ok: false, error: err?.message ?? String(err) })
  }
})

/**
 * 主人专用模式却没有主人名单 = 谁都进不来
 *
 * 与其让人对着 403 猜，不如启动时就把话说清楚（fail closed，不会因为漏配就放开）。
 */
if (OWNER_ONLY && !loadOwners().length) {
  console.error(`[editor] 开了「主人专用」但白名单里没有 owner（${ADMINS_FILE}）：没人能打开。请先补上主人的 QQ 或群昵称`)
  process.exit(1)
}

server.listen(PORT, BIND, () => {
  console.log(`排队表编辑器已启动：http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${PORT}`)
  console.log(`  版本：${pluginVersion}`)
  console.log(`  监听：${BIND}:${PORT}${BIND === "0.0.0.0" ? "（对外）" : "（仅本机）"}`)
  console.log(`  挂载前缀：${MOUNT || "（无，直接挂在根路径）"}`)
  console.log(`  表格：${xlsxPath}`)
  console.log(`  口令：${TOKEN ? "已设置" : "未设置（任何人都能改，仅本机测试）"}`)
  console.log(
    `  身份签名密钥：${
      SIGN_KEY !== TOKEN ? "单独配置（推荐）" : "与口令相同 —— 拿到链接的人能伪造别人的身份，正式部署请配 ABYSS_EDITOR_SIGN_KEY"
    }`,
  )
  console.log(`  白名单：${loadAdmins().length} 人（${ADMINS_FILE}）`)
  console.log(`  主人：${loadOwners().join(" / ") || "（未设置，白名单只能靠管理口令维护）"}`)
  console.log(`  主人专用：${OWNER_ONLY ? "是（其他人打不开，只有 /api/snapshot 与 /healthz 放行）" : "否（按身份分权）"}`)
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
