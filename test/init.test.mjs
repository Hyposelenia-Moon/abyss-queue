/** #排队初始化（主人专用 · 遇错即停 · **三步**） */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import { createSoftChecker, installFrameworkStubs, pluginRoot } from "./_helper.mjs"
import { registerEditorService, resetEditorService } from "../editor/service.js"

/** 框架全局桩必须在 import 插件代码之前装好（apps/init.js 的基类要吃 plugin / Bot / logger） */
installFrameworkStubs()

const { check, finish } = createSoftChecker("排队初始化")

// 实现还不存在时也要给出**可读的红**
let init = null
let importError = null
try {
  init = await import("../components/init/index.js")
} catch (err) {
  importError = err
}

if (!init) {
  try {
    check("components/init/ 已实现（#排队初始化 的落点）", () => {
      throw new Error(`还没有这条指令的实现：#排队初始化（${importError?.message ?? "import 失败"}）`)
    })
  } catch {
    /* check 已经记下失败，直接收尾 */
  }
  await finish()
  process.exit(process.exitCode || 1)
}

const { INIT_DENIED, renderInitReport, runInit } = init

/** 发送者（主人） */
const SENDER = "1000000001"
/** 假编辑器的 `health()` 回执：只回版本 / 挂载前缀 / 名单人数（与 `editor/actions.js` 同形） */
const HEALTH = { version: "2026.10.04", mount: "/queue", roster: 7 }

/* ------------------------------------------------------------------ 用具 */

// 假插件根里的配置：**直接拿仓库里那份参考文件**，只把 `url` 改成"本机编辑器"
const REFERENCE_CONFIG = fs.readFileSync(path.join(pluginRoot, "config", "config.yaml.example"), "utf8")
const LOCAL_EDITOR_URL = "http://127.0.0.1:7788"
const MIN_CONFIG = REFERENCE_CONFIG.replace(/^ {2}public_url: ""/m, `  public_url: "${LOCAL_EDITOR_URL}"`)
/** 夹具自证：url 必须真的被换成了本机地址（漏个 `m` 就会静默不换，后面的断言会看不出来） */
if (!MIN_CONFIG.includes(`  public_url: "${LOCAL_EDITOR_URL}"`)) throw new Error("夹具构造失败：public_url 没换成本机地址")
/** 某一行在配置文本里的行号（1 起） */
const lineOf = (text, re) => text.split("\n").findIndex(l => re.test(l)) + 1

/** 造一个假插件根（临时目录）：只要一份 config.yaml，编辑器不在这儿 */
function makeRoot(config = MIN_CONFIG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-init-"))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.writeFileSync(path.join(root, "config", "config.yaml"), config, "utf8")
  return { root, data: path.join(root, "data") }
}

/** 记账的 fs：行为与 node:fs 一致，但把所有"会改动磁盘"的调用记下来（幂等断言靠它） */
function trackedFs() {
  const writes = []
  return {
    writes,
    api: {
      existsSync: p => fs.existsSync(p),
      mkdirSync: (p, o) => {
        writes.push(["mkdir", p])
        return fs.mkdirSync(p, o)
      },
      readFileSync: (p, e) => fs.readFileSync(p, e),
      writeFileSync: (p, d, e) => {
        writes.push(["write", p])
        return fs.writeFileSync(p, d, e)
      },
      rmSync: (p, o) => {
        writes.push(["rm", p])
        return fs.rmSync(p, o)
      },
    },
  }
}

// 假编辑器：注册进进程内注册表，记下 `health()` 被调了几次
function makeEditor(health = HEALTH) {
  const calls = []
  registerEditorService({
    health: async () => {
      calls.push("health")
      return health
    },
  })
  return { calls }
}

/** 目录快照：相对路径 → 内容 sha1（比"逐字节不变"用） */
const snapshot = root => {
  const out = {}
  const walk = dir => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name)
      if (name.isDirectory()) walk(p)
      else out[path.relative(root, p)] = fs.readFileSync(p).toString("base64")
    }
  }
  walk(root)
  return out
}

const statusOf = (res, no) => res.steps.find(s => s.no === no)?.status ?? "（缺）"

// 跑一次三步；**探活用的是当前注册表里的编辑器**
const run = (root, { fs: fsApi } = {}) => runInit({ qq: SENDER, fs: fsApi, pluginRoot: root.root })

/** 一个用例段挂了也不影响别的段（段内的单条断言已由上面的 check 各自接住） */
const caseRun = fn => {
  try {
    fn()
  } catch (err) {
    if (err?.message !== "__CHECK_FAILED__") throw err
  }
}

/* ------------------------------------------------------- 一、全新假插件根 */

const R1 = makeRoot()
const t1 = trackedFs()
const f1 = makeEditor()
const res1 = await run(R1, { fs: t1.api })

const cfg1 = fs.readFileSync(path.join(R1.root, "config", "config.yaml"), "utf8")
const doc1 = YAML.parse(cfg1)
const token1 = String(doc1.editor.token ?? "")
const signKey1 = String(doc1.editor.sign_key ?? "")
const adminsFile1 = path.join(R1.data, "abyss-editor-admins.json")
const report1 = renderInitReport(res1)

/* ------------------------------------------------- 二、同一个根再跑一遍 */

const before2 = snapshot(R1.root)
const t2 = trackedFs()
const f2 = makeEditor()
const res2 = await run(R1, { fs: t2.api })
const after2 = snapshot(R1.root)
const report2 = renderInitReport(res2)

/* ------------------- 二点五、编辑器没在进程内挂载：第 3 步跳过并点明原因 */

const RP = makeRoot()
const tP = trackedFs()
resetEditorService()
// 注册表空着 = 编辑器没挂进这个进程（例如配置读错没挂上，或只跑了独立进程的 7788 调试版）：
const resP = await runInit({ qq: SENDER, fs: tP.api, pluginRoot: RP.root })
const reportP = renderInitReport(resP)

check("编辑器未在进程内挂载：第 3 步跳过并点明原因（不猜端口、不发任何请求）", () => {
  if (statusOf(resP, 1) !== "done" || statusOf(resP, 2) !== "done") throw new Error(`前两步应当完成：\n${reportP}`)
  if (statusOf(resP, 3) !== "skip") throw new Error(`第 3 步应当跳过：${statusOf(resP, 3)}（${reportP}）`)
  if (!/进程内挂载/.test(reportP)) throw new Error(`报告没点明"没在进程内挂载"：\n${reportP}`)
  if (!/重启一次机器人/.test(reportP)) throw new Error(`报告没给出处置办法：\n${reportP}`)
})

/* ------------------------------------ 三、配置里没有 editor 段（第 1 步） */

const R3 = makeRoot("default_sheet: 幽境危战\n")
const t3 = trackedFs()
resetEditorService()
const res3 = await run(R3, { fs: t3.api })
const report3 = renderInitReport(res3)

/* ------------------------------- 三点五、坏配置：第 1 步必须 ❌ 且零落盘（事故现场） */

// 造一份**坏配置**：把「值 + 行尾注释」整段当成口令，再套一层引号写回去 —— 就是 `"""…"`
const BROKEN_CONFIG = MIN_CONFIG.replace(
  /^ {2}token:.*$/m,
  `  token: "${MIN_CONFIG.split("\n").find(l => /^ {2}token:/.test(l)).replace(/^ {2}token:/, "").trim()}"`,
)
const R6 = makeRoot(BROKEN_CONFIG)
const t6 = trackedFs()
resetEditorService()
const res6 = await run(R6, { fs: t6.api })

/* ------------------------------------- 四、第 2 步就炸（未预期的异常也算） */

const R5 = makeRoot()
const t5 = trackedFs()
const res5 = await run(R5, {
  fs: { ...t5.api, mkdirSync: () => { throw new Error("磁盘满了") } },
})

/* ------------------------------------------- 五、handler 层：非 master 被拒 */

const { apps } = await import("../index.js")
const APPS = Object.values(apps).filter(c => typeof c === "function")
const INIT_APP = APPS.find(C => (new C()).rule?.some(r => r.fnc === "queueInit"))

const makeEvent = isMaster => ({
  msg: "#排队初始化",
  user_id: SENDER,
  self_id: "100000001",
  group_id: "100000002",
  isGroup: true,
  isMaster,
  sender: { card: "测试主人", nickname: "测试主人" },
})

/** 非 master：装上注入点（临时根），若守卫失效就会写到这个临时根里 —— 真实机器仍然碰不到 */
const RN = makeRoot()
const tN = trackedFs()
resetEditorService()
const denied = Object.assign(new INIT_APP(), {
  e: makeEvent(false),
  __replies: [],
  initDeps: { pluginRoot: RN.root, fs: tN.api },
})
const deniedResult = await denied.queueInit()

/** master：同一条 handler 真跑一遍（证明守卫不是"永远拒绝"） */
const RO = makeRoot()
const tO = trackedFs()
const fO = makeEditor()
const allowed = Object.assign(new INIT_APP(), {
  e: makeEvent(true),
  __replies: [],
  initDeps: { pluginRoot: RO.root, fs: tO.api },
})
const allowedResult = await allowed.queueInit()

/* ------------------------------------------------------------------ 用例 */

try {
  /* ---- 一、一次跑通 ---- */
  caseRun(() => {
    check("全新假插件根：三步全过，没有一步 ❌", () => {
      if (res1.steps.length !== 3) throw new Error(`步骤数不是 3：${res1.steps.length}`)
      const bad = res1.steps.filter(s => s.status === "fail")
      if (!res1.ok || res1.failedAt || bad.length)
        throw new Error(`不该失败：failedAt=${res1.failedAt} ${bad.map(s => `${s.no} ${s.detail}`).join("；")}`)
    })
    check("第 1 步：token 生成 32 位 hex、sign_key 生成 48 位 hex", () => {
      if (!/^[0-9a-f]{32}$/.test(token1)) throw new Error(`token 不是 16 字节 hex：${token1 || "(空)"}`)
      if (!/^[0-9a-f]{48}$/.test(signKey1)) throw new Error(`sign_key 不是 24 字节 hex：${signKey1 || "(空)"}`)
      if (token1 === signKey1) throw new Error("口令与签名密钥相同（必须各自独立）")
    })
    // 这条是这条写入路径的正面口径：**动过的行只有那两行，且行尾注释必须还在**
    check("第 1 步：只改这两行，行尾注释与其余每一个字节都原样保留", () => {
      const before = MIN_CONFIG.split("\n")
      const after = cfg1.split("\n")
      if (before.length !== after.length) throw new Error(`行数变了：${before.length} → ${after.length}`)
      const changed = before.map((l, i) => (l === after[i] ? null : i + 1)).filter(Boolean)
      const tokenLine = lineOf(MIN_CONFIG, /^ {2}token:/)
      const signLine = lineOf(MIN_CONFIG, /^ {2}sign_key:/)
      if (JSON.stringify(changed) !== JSON.stringify([tokenLine, signLine]))
        throw new Error(`动的行不是那两行：${JSON.stringify(changed)}（期望 ${JSON.stringify([tokenLine, signLine])}）`)
      if (!after[tokenLine - 1].includes("# 编辑器用的就是这一份（宿主注入给它）"))
        throw new Error(`token 行的行尾注释被吃掉了：${JSON.stringify(after[tokenLine - 1])}`)
      if (!after[signLine - 1].startsWith("  sign_key: ")) throw new Error(`sign_key 行不对：${JSON.stringify(after[signLine - 1])}`)
    })
    /** 写出来的东西必须读得回来——这条以前没人验，事故就是从这儿漏过去的 */
    check("第 1 步：改写后的 config.yaml 解析得回来，且三个键读出来是干净的", () => {
      if (doc1.editor.token !== token1) throw new Error(`token 读回来是 ${JSON.stringify(doc1.editor.token)}`)
      if (doc1.editor.sign_key !== signKey1) throw new Error(`sign_key 读回来是 ${JSON.stringify(doc1.editor.sign_key)}`)
      if (doc1.editor.public_url !== LOCAL_EDITOR_URL) throw new Error(`public_url 被动了：${JSON.stringify(doc1.editor.public_url)}`)
      for (const [key, value] of Object.entries(doc1.editor))
        if (typeof value === "string" && /[\s#]/.test(value)) throw new Error(`${key} 里混进了空白或注释：${JSON.stringify(value)}`)
    })
    check("第 2 步：白名单 owner / admins 都写成发送者的 QQ（数据目录按需建）", () => {
      const raw = JSON.parse(fs.readFileSync(adminsFile1, "utf8"))
      if (JSON.stringify(raw.owner) !== JSON.stringify([SENDER])) throw new Error(`owner 不对：${JSON.stringify(raw.owner)}`)
      if (!raw.admins?.includes(SENDER)) throw new Error(`admins 里没有发送者：${JSON.stringify(raw.admins)}`)
      if (!t1.writes.some(([act, p]) => act === "mkdir" && p === R1.data)) throw new Error("数据目录不是这一步按需建的")
    })
    check("第 3 步：问进程内注册表（恰好一次、不带口令），并报告版本 / mount / 名单", () => {
      if (f1.calls.length !== 1) throw new Error(`探活次数不是 1：${f1.calls.length}`)
      if (!/2026\.10\.04/.test(report1)) throw new Error("报告里没有编辑器版本")
      if (!/名单\s*7/.test(report1)) throw new Error(`报告里没有名单人数：${report1}`)
      /** 口令不再出现在探活里：进程内调用没有"凭证怎么带"这回事 */
      if (report1.includes(token1)) throw new Error("报告里带出了访问口令")
    })
    check("报告：三步逐行 + ✅/⏭ 标记 + 结尾交代完成（并提醒重启才挂载）", () => {
      for (const s of res1.steps) if (!report1.includes(`${s.no}. `)) throw new Error(`报告缺第 ${s.no} 步`)
      if (!report1.includes("✅") || !report1.includes("全部步骤完成")) throw new Error(`报告不像完成态：\n${report1}`)
      /** 编辑器是在插件加载时挂载、凭证也是那时取走的：收尾语必须提醒重启，别写"重载即生效" */
      if (!/重启一次机器人/.test(report1)) throw new Error(`收尾语没提醒要重启：\n${report1}`)
      if (/重载即生效/.test(report1)) throw new Error(`收尾语还在说"重载即生效"（凭证不是热重载的）：\n${report1}`)
    })
  })
  /* ---- 二、幂等 ---- */
  caseRun(() => {
    check("重复执行：两步「已存在跳过」+ 探活 ✅（不报失败）", () => {
      if (!res2.ok || res2.failedAt) throw new Error(`第二次不该失败：${report2}`)
      for (const no of [1, 2]) if (statusOf(res2, no) !== "skip") throw new Error(`第 ${no} 步不是 ⏭：${statusOf(res2, no)}（${report2}）`)
      if (statusOf(res2, 3) !== "done") throw new Error("第 3 步应当仍然探活成功")
    })
    check("重复执行：**一次磁盘写入都没有**（既有产物只报告、不覆盖）", () => {
      if (t2.writes.length) throw new Error(`第二次执行仍有落盘：${JSON.stringify(t2.writes)}`)
    })
    check("重复执行：所有文件逐字节不变（含 config.yaml 与白名单）", () => {
      const changed = Object.keys(after2).filter(k => before2[k] !== after2[k])
      if (changed.length) throw new Error(`这些文件被改了：${changed.join("、")}`)
    })
  })
  /* ---- 三、遇错即停 ---- */
  caseRun(() => {
    check("配置里没有 editor 段：第 1 步 ❌ 立刻停，第 2–3 步标成「未做」", () => {
      if (res3.ok || res3.failedAt !== 1) throw new Error(`应当停在 1：${report3}`)
      if (statusOf(res3, 1) !== "fail") throw new Error("第 1 步不是 ❌")
      for (const no of [2, 3]) if (statusOf(res3, no) !== "todo") throw new Error(`第 ${no} 步不该被执行：${statusOf(res3, no)}`)
      if (!/没有 editor/.test(res3.steps[0].detail)) throw new Error(`❌ 原因没说清：${res3.steps[0].detail}`)
    })
    check("遇错即停：白名单没建、没探活、数据目录也没建", () => {
      if (fs.existsSync(path.join(R3.data, "abyss-editor-admins.json"))) throw new Error("白名单被建了")
      if (fs.existsSync(R3.data)) throw new Error("数据目录被建了")
      const cfg3 = fs.readFileSync(path.join(R3.root, "config", "config.yaml"), "utf8")
      if (cfg3 !== "default_sheet: 幽境危战\n") throw new Error("第 1 步竟然改动了配置")
      if (res3.steps.filter(s => s.no === 3)[0]?.status !== "todo") throw new Error("第 3 步不该被执行")
    })
    check("失败报告：列清「已完成」与「未做」", () => {
      if (!/第 1 步失败/.test(report3)) throw new Error(`报告没点明停在第几步：\n${report3}`)
      if (!/已完成：\s*（无）/.test(report3)) throw new Error(`第 1 步就失败，应当没有"已完成"：\n${report3}`)
      if (!/未做：\s*2、3/.test(report3)) throw new Error(`报告没列未做：\n${report3}`)
    })
  })
  /* ---- 三点五、坏配置：不许接着改、不许泄口令 ---- */
  caseRun(() => {
    check("夹具就是现场那份坏文件（先自证：它确实解析不了）", () => {
      let bad = false
      try {
        YAML.parse(BROKEN_CONFIG)
      } catch {
        bad = true
      }
      if (!bad) throw new Error("这份夹具竟然能解析——这条用例就没在验坏文件")
    })
    check("坏配置：第 1 步 ❌ 停下，且**一个字节都没写**", () => {
      if (res6.ok || res6.failedAt !== 1) throw new Error(`应当停在 1：${renderInitReport(res6)}`)
      if (!/解析不了/.test(res6.steps[0].detail)) throw new Error(`❌ 没说清原因：${res6.steps[0].detail}`)
      if (t6.writes.length) throw new Error(`还是落盘了：${JSON.stringify(t6.writes)}`)
      if (fs.readFileSync(path.join(R6.root, "config", "config.yaml"), "utf8") !== BROKEN_CONFIG)
        throw new Error("坏文件被改动了——插件不许在坏文件上做行级改写")
      if (fs.existsSync(R6.data)) throw new Error("数据目录被建了")
    })
    check("坏配置：❌ 的原因里不带配置行内容（那行就是口令）", () => {
      const detail = res6.steps[0].detail
      if (/ABYSS_EDITOR_TOKEN|token:/.test(detail)) throw new Error(`原因里带了配置内容：${detail}`)
    })
  })
  /* ---- 四、未预期异常也即停 ---- */
  caseRun(() => {
    // 异常来自 `mkdirSync`（磁盘满），而第 1 步只读配置、不建目录：
    check("第 2 步抛异常：也算 ❌ 并即停（异常不吞、不继续）", () => {
      if (res5.ok || res5.failedAt !== 2) throw new Error(`应当停在 2：${JSON.stringify(res5.steps)}`)
      if (!/磁盘满了/.test(res5.steps[1].detail)) throw new Error(`❌ 没带出原因：${res5.steps[1].detail}`)
      if (statusOf(res5, 3) !== "todo") throw new Error("后面步骤不该被执行")
    })
  })
  /* ---- 五、指令层：只认 master ---- */
  caseRun(() => {
    check("规则注册：^#排队初始化$ → queueInit，且带 permission=master", () => {
      if (!INIT_APP) throw new Error("apps 里没有带 queueInit 的入口类（规则没注册？）")
      const rule = (new INIT_APP()).rule.find(r => r.fnc === "queueInit")
      if (!rule) throw new Error("rule 里没有 queueInit")
      if (!new RegExp(rule.reg).test("#排队初始化")) throw new Error(`规则匹配不上：${rule.reg}`)
      if (rule.permission !== "master") throw new Error(`没带 permission=master：${rule.permission}`)
    })
    check("#排队初始化 不会被 #排队 的榜名规则抢走", () => {
      /** `#排队` 的规则在另一个入口类里（apps/queue.js），要在全部 app 的规则里找 */
      const allRules = APPS.flatMap(C => new C().rule ?? [])
      const menu = allRules.find(r => r.fnc === "menu")
      if (!menu) throw new Error("找不到 #排队 的规则")
      if (new RegExp(menu.reg).test("#排队初始化")) throw new Error("被 SHEET_CMD_REGEX 命中了，菜单会先接管")
    })
    check("非 master：只回一句拒绝，其它什么都不做", () => {
      const text = String(denied.__replies.at(-1) ?? "")
      if (text !== INIT_DENIED) throw new Error(`回复不对：${text}`)
      if (deniedResult?.denied !== true || deniedResult?.steps?.length) throw new Error("拒绝路径不该跑任何步骤")
    })
    check("非 master：一个字节都不写、不探活、连数据目录都不建", () => {
      if (tN.writes.length) throw new Error(`写盘了：${JSON.stringify(tN.writes)}`)
      if (deniedResult?.ok !== false) throw new Error("拒绝路径不该给出 ok")
      if (fs.existsSync(RN.data)) throw new Error("数据目录被建了")
      if (fs.readFileSync(path.join(RN.root, "config", "config.yaml"), "utf8") !== MIN_CONFIG)
        throw new Error("config.yaml 被改了")
    })
    check("master 走同一条 handler：真跑一遍并回三步报告", () => {
      const text = String(allowed.__replies.at(-1) ?? "")
      if (allowedResult?.ok !== true) throw new Error(`master 跑不通：${text}`)
      if (!text.includes("✅") || !text.includes("全部步骤完成")) throw new Error(`没有报告：${text}`)
      if (!fs.existsSync(path.join(RO.data, "abyss-editor-admins.json"))) throw new Error("该生成的白名单没生成")
    })
  })
} finally {
  for (const r of [R1, R3, R5, R6, RN, RO]) fs.rmSync(r.root, { recursive: true, force: true })
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
