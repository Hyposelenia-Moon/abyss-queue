/**
 * #排队初始化（主人专用 · 遇错即停）
 *
 * 这条指令把「本机编辑器」那套手工初始化一次做完：
 * 口令/签名密钥 → 启动器产物（editor-path.txt + mjs + 两个 vbs）
 * → 白名单 → 计划任务 AbyssQueueEditor → 探活。
 *
 * **数据目录与本地表格副本不在初始化里**：前者由编辑器写文件时 / 启动器复制表格时按需建，
 * 后者由启动器在"本机还没有表"时用 `resources/空模板.xlsx` 起一份。
 *
 * 全部断言都在**临时假插件根**里跑，副作用一律走注入的桩：
 *   - 文件操作走注入的 fs（真实现是 node:fs，但落点全在系统临时目录）
 *   - 注册计划任务走注入的 exec（**绝不真的注册计划任务**）
 *   - 探活走注入的 fetch（不起服务、不打真实端口）
 * 所以这套回归不碰真实机器，也不动仓库的 data/。
 *
 * 用例对应任务里的四条要求：一次跑通 / 重复执行幂等 / 遇错即停 / 非 master 被拒。
 *
 * 用法：node test/init.test.mjs
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createChecker, installFrameworkStubs, pluginRoot } from "./_helper.mjs"

/** 框架全局桩必须在 import 插件代码之前装好（apps/queue.js 的基类要吃 plugin / Bot / logger） */
installFrameworkStubs()

const { check: rawCheck, finish } = createChecker("排队初始化")

/**
 * 单条断言失败**不打断**后面的用例
 *
 * `createChecker` 的 `check` 在同步断言失败时会抛 `__CHECK_FAILED__`（那是给"一次只看一条"的套件用的）。
 * 这套回归断言多，又要求"改动前必须红、红了要看全"，所以在这里接住它：一次跑完，把失败列齐。
 */
const check = (name, fn) => {
  try {
    rawCheck(name, fn)
  } catch (err) {
    if (err?.message !== "__CHECK_FAILED__") throw err
  }
}

/**
 * 实现还不存在时也要给出**可读的红**
 *
 * 不然改动前只能看到运行器里一行 ERR_MODULE_NOT_FOUND，看不出这套回归在验什么。
 * 缺实现就记一条失败并收尾（失败 = 退出码 1 = 红，不是 skip）。
 */
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

const { INIT_DENIED, TASK_NAME, renderInitReport, runInit } = init

/** 发送者（主人）与目标机器上的 wscript：断言里只用来比对，不写死任何维护者路径 */
const SENDER = "1733491779"
const WSCRIPT = "C:\\Windows\\System32\\wscript.exe"
const HEALTH = { ok: true, version: "2026.10.04", mount: "", roster: 7, auth: true }

/* ------------------------------------------------------------------ 用具 */

const MIN_CONFIG = [
  "# 假插件根里的最小配置",
  "remote:",
  "  # 本机联调：云端地址就是本机编辑器",
  '  url: "http://127.0.0.1:7788"',
  '  token: ""',
  "  ttl_ms: 30000",
  "",
  "default_sheet: 幽境危战",
  "",
].join("\n")

/**
 * 造一个假插件根（临时目录）
 *
 * 只搬初始化真正需要的东西：`resources/init` 的启动器模板、一份最小 config.yaml、一个编辑器桩。
 * **故意没有 sign_key 行、token 是空串**，用来验「缺了就补上 / 空就生成」这条路。
 *
 * 不搬 `resources/空模板.xlsx`：本地表格副本不由初始化负责（启动器会按需起一份），
 * 所以这个夹具跑得通说明初始化**不依赖**空模板在不在。
 */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-init-"))
  fs.mkdirSync(path.join(root, "config"), { recursive: true })
  fs.mkdirSync(path.join(root, "editor"), { recursive: true })
  fs.cpSync(path.join(pluginRoot, "resources", "init"), path.join(root, "resources", "init"), { recursive: true })
  fs.writeFileSync(path.join(root, "editor", "editor.mjs"), "// 编辑器桩（只验路径，不启动）\n", "utf8")
  fs.writeFileSync(path.join(root, "config", "config.yaml"), MIN_CONFIG, "utf8")
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
      copyFileSync: (a, b) => {
        writes.push(["copy", b])
        return fs.copyFileSync(a, b)
      },
      rmSync: (p, o) => {
        writes.push(["rm", p])
        return fs.rmSync(p, o)
      },
    },
  }
}

/**
 * schtasks 桩：一个极小的状态机
 *
 * `/query` 在没注册时按 Windows 的中文报错返回非零；`/create` 把 XML 读出来（**按 UTF-16LE**，
 * 读成乱码就取不到 <Arguments>，后面的复核会失败），把动作记下来；再 `/query` 就能查到。
 * 这样"注册一次"这条断言是真的走了一遍"查不到 → 注册 → 查得到"。
 */
function makeExec() {
  const calls = []
  let action = null
  const exec = (cmd, args) => {
    calls.push([cmd, ...args])
    const verb = args[0]
    if (verb === "/query") {
      if (!action) return { status: 1, stdout: "", stderr: "错误: 系统找不到指定的文件。" }
      return {
        status: 0,
        stdout: `<Task><Actions Context="Author"><Exec><Command>${WSCRIPT}</Command><Arguments>${action}</Arguments></Exec></Actions></Task>`,
        stderr: "",
      }
    }
    if (verb === "/create") {
      const file = args[args.indexOf("/xml") + 1]
      const xml = fs.readFileSync(file, "utf16le")
      action = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1] ?? null
      if (!action) return { status: 1, stdout: "", stderr: "XML 取不到动作" }
      return { status: 0, stdout: "成功: 成功创建计划任务。", stderr: "" }
    }
    return { status: 1, stdout: "", stderr: `未知参数：${verb}` }
  }
  return {
    exec,
    calls,
    creates: () => calls.filter(c => c[1] === "/create"),
    action: () => action,
    setAction: v => (action = v),
  }
}

/** 探活桩：默认回一份 /healthz 的内容；down 时不抛（模拟端口没人听） */
function makeFetch(payload) {
  const calls = []
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, opts })
      if (!payload) throw new Error("fetch failed")
      return { ok: true, status: 200, json: async () => payload }
    },
  }
}

/** 逐字节快照整个假插件根（幂等断言：产物一个字节都不许变） */
const walk = (dir, out = []) => {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name)
    if (it.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const snapshot = dir =>
  Object.fromEntries(
    walk(dir)
      .sort()
      .map(f => [path.relative(dir, f), createHash("sha256").update(fs.readFileSync(f)).digest("hex")]),
  )

/** 读 editor-path.txt：同时报出「是不是 UTF-16LE（带 BOM）」「行尾是不是纯 CRLF」 */
const readPathFile = file => {
  const buf = fs.readFileSync(file)
  const bom = buf[0] === 0xff && buf[1] === 0xfe
  const text = bom ? buf.toString("utf16le", 2) : buf.toString("utf8")
  const lines = text.split("\r\n")
  if (lines.at(-1) === "") lines.pop()
  return { bom, text, lines, crlfOnly: !text.replace(/\r\n/g, "").includes("\n") }
}

/** 从 config.yaml 文本里取 remote 段某个键的值（只认带引号的写法，与插件生成的一致） */
const keyOf = (text, key) => new RegExp(`^\\s+${key}:\\s*"([^"]*)"`, "m").exec(text)?.[1] ?? ""
const statusOf = (res, no) => res.steps.find(s => s.no === no)?.status ?? "（缺）"

const run = (root, { exec, fetch, fs: fsApi }) =>
  runInit({ qq: SENDER, pluginRoot: root.root, fs: fsApi, exec, fetch, wscript: WSCRIPT, port: 7788 })

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
const e1 = makeExec()
const f1 = makeFetch(HEALTH)
const res1 = await run(R1, { exec: e1.exec, fetch: f1.fetch, fs: t1.api })

const pathFile1 = path.join(R1.data, "editor-path.txt")
const adminsFile1 = path.join(R1.data, "abyss-editor-admins.json")
const cfg1 = fs.readFileSync(path.join(R1.root, "config", "config.yaml"), "utf8")
const token1 = keyOf(cfg1, "token")
const signKey1 = keyOf(cfg1, "sign_key")
const ep1 = readPathFile(pathFile1)
const report1 = renderInitReport(res1)

/* ------------------------------------------------- 二、同一个根再跑一遍 */

const before2 = snapshot(R1.root)
const t2 = trackedFs()
const f2 = makeFetch(HEALTH)
const res2 = await run(R1, { exec: e1.exec, fetch: f2.fetch, fs: t2.api })
const after2 = snapshot(R1.root)
const report2 = renderInitReport(res2)

/* ------------------------------------ 三、配置里没有 remote 段（第 1 步） */

const R3 = makeRoot()
/** 没有 remote 段 → 口令与签名密钥无处可写，第 1 步必须 ❌（而不是"跳过"） */
fs.writeFileSync(path.join(R3.root, "config", "config.yaml"), "default_sheet: 幽境危战\n", "utf8")
const t3 = trackedFs()
const e3 = makeExec()
const f3 = makeFetch(HEALTH)
const res3 = await run(R3, { exec: e3.exec, fetch: f3.fetch, fs: t3.api })
const report3 = renderInitReport(res3)

/* ------------------------------------ 四、任务动作指向别处（第 3 步不一致） */

const R4 = makeRoot()
const t4 = trackedFs()
const e4 = makeExec()
e4.setAction('"D:\\别处\\editor-launch.vbs"')
const res4 = await run(R4, { exec: e4.exec, fetch: makeFetch(HEALTH).fetch, fs: t4.api })

/* ------------------------------------- 五、第 1 步就炸（未预期的异常也算） */

const R5 = makeRoot()
const t5 = trackedFs()
const res5 = await run(R5, {
  exec: makeExec().exec,
  fetch: makeFetch(HEALTH).fetch,
  fs: { ...t5.api, mkdirSync: () => { throw new Error("磁盘满了") } },
})

/* ------------------------------------------- 六、handler 层：非 master 被拒 */

const { apps } = await import("../index.js")
const APPS = Object.values(apps).filter(c => typeof c === "function")
const INIT_APP = APPS.find(C => (new C()).rule?.some(r => r.fnc === "queueInit"))

const makeEvent = isMaster => ({
  msg: "#排队初始化",
  user_id: SENDER,
  self_id: "970464854",
  group_id: "965272093",
  isGroup: true,
  isMaster,
  sender: { card: "测试主人", nickname: "测试主人" },
})

/** 非 master：装上注入点（临时根），若守卫失效就会写到这个临时根里 —— 真实机器仍然碰不到 */
const RN = makeRoot()
const tN = trackedFs()
const eN = makeExec()
const fN = makeFetch(HEALTH)
const denied = Object.assign(new INIT_APP(), {
  e: makeEvent(false),
  __replies: [],
  initDeps: { pluginRoot: RN.root, fs: tN.api, exec: eN.exec, fetch: fN.fetch, wscript: WSCRIPT, port: 7788 },
})
const deniedResult = await denied.queueInit()

/** master：同一条 handler 真跑一遍（证明守卫不是"永远拒绝"） */
const RO = makeRoot()
const tO = trackedFs()
const eO = makeExec()
const fO = makeFetch(HEALTH)
const allowed = Object.assign(new INIT_APP(), {
  e: makeEvent(true),
  __replies: [],
  initDeps: { pluginRoot: RO.root, fs: tO.api, exec: eO.exec, fetch: fO.fetch, wscript: WSCRIPT, port: 7788 },
})
const allowedResult = await allowed.queueInit()

/* ------------------------------------------------------------------ 断言 */

try {
  /* ---- 一、一次跑通 ---- */

  caseRun(() => {
    check("全新假插件根：五步全过，没有一步 ❌", () => {
      if (res1.steps.length !== 5) throw new Error(`步骤数不是 5：${res1.steps.length}`)
      const bad = res1.steps.filter(s => s.status === "fail")
      if (!res1.ok || res1.failedAt || bad.length)
        throw new Error(`不该失败：failedAt=${res1.failedAt} ${bad.map(s => `${s.no} ${s.detail}`).join("；")}`)
    })

    /**
     * 数据目录与本地表格副本**不由初始化负责**，所以这里反过来钉住"没人替它做"：
     * 跑完五步之后，这两样只该是"口令 / 启动器那几步顺手碰出来的"，不该有"专门建它们"的步骤。
     */
    check("初始化不管数据目录与本地表格副本（它们由编辑器 / 启动器按需建）", () => {
      if (res1.steps.some(s => /数据目录|本地表格副本/.test(s.title)))
        throw new Error(`还有这两步：${res1.steps.map(s => s.title).join("、")}`)
    })

    check("第 1 步：token 生成 32 位 hex、sign_key 补上 48 位 hex（缺行也要补）", () => {
      if (!/^[0-9a-f]{32}$/.test(token1)) throw new Error(`token 不是 16 字节 hex：${token1 || "(空)"}`)
      if (!/^[0-9a-f]{48}$/.test(signKey1)) throw new Error(`sign_key 不是 24 字节 hex：${signKey1 || "(空)"}`)
      if (token1 === signKey1) throw new Error("口令与签名密钥相同（必须各自独立）")
    })

    check("第 1 步：config.yaml 只改这两行，注释与其它内容原样保留", () => {
      const expected = MIN_CONFIG.replace('  token: ""', `  token: "${token1}"\n  sign_key: "${signKey1}"`)
      if (cfg1 !== expected)
        throw new Error(`config.yaml 不是「只改这两行」的结果：\n--- 期望 ---\n${expected}\n--- 实际 ---\n${cfg1}`)
    })

    check("第 2 步：editor-path.txt 是 UTF-16LE（带 BOM）+ 纯 CRLF + 5 行", () => {
      if (!ep1.bom) throw new Error("没有 UTF-16LE BOM（启动器按 utf16le 读，会全是乱码）")
      if (!ep1.crlfOnly) throw new Error("行尾不是纯 CRLF")
      if (ep1.lines.length !== 5) throw new Error(`不是 5 行：${ep1.lines.length} 行 → ${JSON.stringify(ep1.lines)}`)
    })

    check("第 2 步：editor-path.txt 五项 = 编辑器 / 本地副本 / 刚生成的口令 / 云端(本机→空) / 刚生成的签名密钥", () => {
      const [editor, xlsx, token, cloud, signKey] = ep1.lines
      if (path.resolve(editor) !== path.join(R1.root, "editor", "editor.mjs")) throw new Error(`编辑器路径不对：${editor}`)
      if (path.resolve(xlsx) !== path.join(R1.data, "排队表-本地.xlsx")) throw new Error(`本地副本路径不对：${xlsx}`)
      if (token !== token1) throw new Error("第 3 行不是刚生成的口令")
      if (signKey !== signKey1) throw new Error("第 5 行不是刚生成的签名密钥")
      /** 配置里的 remote.url 就是本机编辑器 → 不该让启动器"从自己拉快照" */
      if (cloud !== "") throw new Error(`本机地址不该写进云端行：${cloud}`)
    })

    check("第 2 步：启动器 mjs 与模板逐字节一致，且是主人专用 + 自定位", () => {
      const made = fs.readFileSync(path.join(R1.data, "editor-launch.mjs"))
      const tpl = fs.readFileSync(path.join(R1.root, "resources", "init", "editor-launch.mjs"))
      if (!made.equals(tpl)) throw new Error("生成的启动器与模板不一致")
      const text = made.toString("utf8")
      for (const need of ["import.meta.url", "editor-path.txt", "editor-url.txt", "--owner-only", "api/snapshot"])
        if (!text.includes(need)) throw new Error(`启动器缺少 ${need}`)
    })

    check("第 2 步：两个 vbs 是纯 ASCII + CRLF（cscript 按 ANSI 读，混了编码就废）", () => {
      for (const [name, need] of [
        ["editor-launch.vbs", "editor-launch.mjs"],
        ["启动排队表编辑器.vbs", TASK_NAME],
      ]) {
        const file = path.join(R1.data, name)
        if (!fs.existsSync(file)) throw new Error(`没有生成 ${name}`)
        const buf = fs.readFileSync(file)
        const text = buf.toString("utf8")
        if ([...buf].some(b => b > 0x7f)) throw new Error(`${name} 不是纯 ASCII`)
        if (buf.includes(0x0a) && !/^([^\n]*\r\n)*[^\n]*$/.test(text)) throw new Error(`${name} 行尾不是纯 CRLF`)
        if (!text.includes(need)) throw new Error(`${name} 里没有 ${need}`)
      }
    })

    check("第 3 步：白名单 owner / admins 都写成发送者的 QQ", () => {
      const raw = JSON.parse(fs.readFileSync(adminsFile1, "utf8"))
      if (JSON.stringify(raw.owner) !== JSON.stringify([SENDER])) throw new Error(`owner 不对：${JSON.stringify(raw.owner)}`)
      if (!raw.admins?.includes(SENDER)) throw new Error(`admins 里没有发送者：${JSON.stringify(raw.admins)}`)
    })

    check("第 4 步：注册一次计划任务，动作 = wscript.exe \"<数据目录>\\editor-launch.vbs\"", () => {
      if (e1.creates().length !== 1) throw new Error(`注册次数不是 1：${e1.creates().length}`)
      const create = e1.creates()[0]
      if (create[1] !== "/create" || create[3] !== TASK_NAME) throw new Error(`命令行不对：${create.join(" ")}`)
      const expected = `"${path.join(R1.data, "editor-launch.vbs")}"`
      if (e1.action() !== expected) throw new Error(`任务动作是 ${e1.action()}，期望 ${expected}`)
      if (fs.existsSync(path.join(R1.data, "abyss-editor-task.tmp.xml"))) throw new Error("临时 XML 没清掉")
    })

    check("第 5 步：探活打到 127.0.0.1:7788/healthz?k=<口令>，并报告版本 / mount / 名单", () => {
      if (f1.calls.length !== 1) throw new Error(`探活次数不是 1：${f1.calls.length}`)
      const want = `http://127.0.0.1:7788/healthz?k=${token1}`
      if (f1.calls[0].url !== want) throw new Error(`探活地址不对：${f1.calls[0].url}`)
      if (!/2026\.10\.04/.test(report1)) throw new Error("报告里没有编辑器版本")
      if (!/名单\s*7/.test(report1)) throw new Error(`报告里没有名单人数：${report1}`)
    })

    check("报告：五步逐行 + ✅/⏭ 标记 + 结尾交代完成", () => {
      for (const s of res1.steps) if (!report1.includes(`${s.no}. `)) throw new Error(`报告缺第 ${s.no} 步`)
      if (!report1.includes("✅") || !report1.includes("全部步骤完成")) throw new Error(`报告不像完成态：\n${report1}`)
    })
  })

  /* ---- 二、幂等 ---- */

  caseRun(() => {
    check("重复执行：四步全部「已存在跳过」，探活仍然 ✅（不报失败）", () => {
      if (!res2.ok || res2.failedAt) throw new Error(`第二次不该失败：${report2}`)
      for (const no of [1, 2, 3, 4])
        if (statusOf(res2, no) !== "skip") throw new Error(`第 ${no} 步不是 ⏭：${statusOf(res2, no)}（${report2}）`)
      if (statusOf(res2, 5) !== "done") throw new Error("第 5 步应当仍然探活成功")
    })

    check("重复执行：**一次磁盘写入都没有**（已有产物只报告、不覆盖）", () => {
      if (t2.writes.length) throw new Error(`第二次执行仍有落盘：${JSON.stringify(t2.writes)}`)
    })

    check("重复执行：所有产物逐字节不变（含 config.yaml 与 editor-path.txt）", () => {
      const changed = Object.keys(after2).filter(k => before2[k] !== after2[k])
      if (changed.length) throw new Error(`这些文件被改了：${changed.join("、")}`)
      if (before2[path.join("config", "config.yaml")] !== after2[path.join("config", "config.yaml")])
        throw new Error("config.yaml 被重写（口令应当保持不变）")
    })

    check("重复执行：不再注册计划任务（create 总共只发生一次）", () => {
      if (e1.creates().length !== 1) throw new Error(`create 次数：${e1.creates().length}`)
      if (f2.calls.length !== 1) throw new Error(`第二次没有探活：${f2.calls.length}`)
    })
  })

  /* ---- 三、遇错即停 ---- */

  caseRun(() => {
    check("配置里没有 remote 段：第 1 步 ❌ 立刻停，第 2–5 步标成「未做」", () => {
      if (res3.ok || res3.failedAt !== 1) throw new Error(`应当停在 1：${report3}`)
      if (statusOf(res3, 1) !== "fail") throw new Error("第 1 步不是 ❌")
      for (const no of [2, 3, 4, 5])
        if (statusOf(res3, no) !== "todo") throw new Error(`第 ${no} 步不该被执行：${statusOf(res3, no)}`)
      if (!/没有 remote/.test(res3.steps[0].detail)) throw new Error(`❌ 原因没说清：${res3.steps[0].detail}`)
    })

    check("遇错即停：密钥没写、启动器没生成、白名单没建、任务没注册、没探活", () => {
      if (fs.existsSync(path.join(R3.data, "editor-path.txt"))) throw new Error("第 2 步的产物被生成了")
      if (fs.existsSync(path.join(R3.data, "editor-launch.mjs"))) throw new Error("启动了却被生成")
      if (fs.existsSync(path.join(R3.data, "abyss-editor-admins.json"))) throw new Error("白名单被建了")
      const cfg3 = fs.readFileSync(path.join(R3.root, "config", "config.yaml"), "utf8")
      if (cfg3 !== "default_sheet: 幽境危战\n") throw new Error("第 1 步竟然改动了配置")
      if (e3.calls.length) throw new Error(`不该调用 schtasks：${JSON.stringify(e3.calls)}`)
      if (f3.calls.length) throw new Error("不该探活")
    })

    check("失败报告：列清「已完成」与「未做」", () => {
      if (!/第 1 步失败/.test(report3)) throw new Error(`报告没点明停在第几步：\n${report3}`)
      if (!/已完成：\s*（无）/.test(report3)) throw new Error(`第 1 步就失败，应当没有"已完成"：\n${report3}`)
      if (!/未做：\s*2、3、4、5/.test(report3)) throw new Error(`报告没列未做：\n${report3}`)
    })
  })

  /* ---- 四、任务动作不一致 / 未预期异常 ---- */

  caseRun(() => {
    check("任务已存在但动作指向别处：第 4 步 ❌，且**不覆盖**（不调 /create）", () => {
      if (res4.ok || res4.failedAt !== 4) throw new Error(`应当停在 4：${JSON.stringify(res4.steps)}`)
      if (e4.creates().length) throw new Error("发现不一致还去注册（会覆盖主人的任务）")
      if (!/别处/.test(res4.steps[3].detail)) throw new Error(`❌ 没说清差异：${res4.steps[3].detail}`)
    })

    /**
     * 异常来自 `mkdirSync`（磁盘满），而第一步建目录的是**第 2 步启动器产物**：
     * 第 1 步只读配置、不建目录，所以"第 N 步抛异常"这条要按新编号对到 2。
     */
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

    check("非 master：一个字节都不写、不注册任务、不探活、连数据目录都不建", () => {
      if (tN.writes.length) throw new Error(`写盘了：${JSON.stringify(tN.writes)}`)
      if (eN.calls.length) throw new Error(`碰了 schtasks：${JSON.stringify(eN.calls)}`)
      if (fN.calls.length) throw new Error("探活了")
      if (fs.existsSync(RN.data)) throw new Error("数据目录被建了")
      if (fs.readFileSync(path.join(RN.root, "config", "config.yaml"), "utf8") !== MIN_CONFIG)
        throw new Error("config.yaml 被改了")
    })

    check("master 走同一条 handler：真跑一遍并回五步报告", () => {
      const text = String(allowed.__replies.at(-1) ?? "")
      if (allowedResult?.ok !== true) throw new Error(`master 跑不通：${text}`)
      if (!text.includes("✅") || !text.includes("全部步骤完成")) throw new Error(`没有报告：${text}`)
      if (!fs.existsSync(path.join(RO.data, "editor-path.txt"))) throw new Error("该生成的产物没生成")
    })
  })
} finally {
  for (const r of [R1, R3, R4, R5, RN, RO]) fs.rmSync(r.root, { recursive: true, force: true })
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在 undici 句柄收尾途中触发 libuv 断言崩溃 */
