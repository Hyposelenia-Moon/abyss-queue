/**
 * 临时脚本：把腾讯文档里的排表同步到机器人读的 xlsx
 *
 * 测试阶段的权宜之计：表格还在腾讯文档里维护，机器人与编辑器读的是本地 xlsx，
 * 两者会越走越远。这里把文档里的**数值**搬过来（不动本地文件的格式、公式、下拉、合并）。
 * 编辑器正式接管之后，这个脚本和配置里的 sync 段都可以删掉。
 *
 * 用法：
 *   node tools/sync-doc.mjs --login                # 首次：在弹出的窗口里登录腾讯文档（只需一次）
 *   node tools/sync-doc.mjs --forget               # 删掉专用窗口的登录态（Cookie 一并清掉）
 *   node tools/sync-doc.mjs --from latest          # 用下载目录里最新的导出文件同步（推荐，最稳）
 *   node tools/sync-doc.mjs --from 导出.xlsx        # 指定某个导出文件
 *   node tools/sync-doc.mjs                       # 在线导出并同步（Cookie 自动从本机取）
 *   node tools/sync-doc.mjs --dry                 # 只列出会改哪些格，不写文件
 *   node tools/sync-doc.mjs --to D:/别的表.xlsx    # 指定同步到哪份表（默认取插件配置的 xlsx_path）
 *
 * 关于"在线直读"（结论写在前面，免得踩坑）：
 *   腾讯文档不给匿名读这个文档（`dop-api/opendoc` 返回 blankpage），而它自己那套导出接口
 *   需要登录态的浏览器会话；拿到会话后还得解 protobuf 才能读单元格。所以要真正无人值守，
 *   三选一：① 文档分享权限改成「获得链接的人可查看」② 在腾讯文档里点「导出为 xlsx」后跑
 *   `--from latest` ③ 申请腾讯文档开放平台应用（access_token + async_export）。
 *   本脚本把能自动的都自动了：Cookie 从本机浏览器取（含 v10 解密）、导出文件自动找最新的。
 *
 * Cookie 的取用顺序（都是本机自动取，不会打印 Cookie 值）：
 *   1. 命令行 --cookie / 环境变量 ABYSS_DOC_COOKIE
 *   2. 本脚本的专用浏览器窗口（tools/doc-cookie.mjs，登录一次长期复用）
 *   3. 本机 Edge / Chrome 的默认配置（需要浏览器当时是关着的，否则文件被独占锁定）
 *   4. 都没有就按匿名请求，失败时给出明确原因
 *
 * 关于 Cookie 的安全约定（本脚本与 tools/doc-cookie.mjs 都遵守）：
 *   - Cookie 只在内存里用，不落盘、不打印；日志里最多出现 Cookie 的**名字**与条数
 *   - 读浏览器 Cookie 时先拷一份到 %TEMP%，**无论成功失败都在 finally 里删掉**（启动时还会顺手清历史残留）
 *   - 所有要打印的文本都过一遍 redact()，即使网络报错把 header 带出来也会被替换成 <已隐藏>
 *   - 专用窗口的登录态是浏览器自己的加密存储（Windows DPAPI 绑当前用户），`--forget` 可一键删除
 *
 * 同步规则（只搬值，不搬格式）：
 *   - 数据区：B–H（群昵称 … 帮帮完成情况）按行号覆盖；文档里整行为空 → 本地也清掉
 *   - 主播区：A（主播名【推荐度】）、C 强项、D 专职、G/H 直播入口按行号覆盖
 *   - 不碰：A 列序号公式、合并单元格、下拉验证、条件格式、超链接
 *   - 写之前照例备份 `.bak`，写之后回读自检（走插件的 Table.mutate）
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { LOGIN_PROFILE, autoCookie, browserProfiles, cleanTempCopies, edgeExe, readCookies, redact } from "./doc-cookie.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback = "") => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const has = name => args.includes(name)

const { config } = await import("../components/config.js")
const { openWorkbook } = await import("../lib/xlsx.js")
const { buildModel, DATA_COLUMNS } = await import("../lib/schema.js")
const { Table } = await import("../model/table.js")

/**
 * 直接对目标文件开一张表
 *
 * 注意两点：
 *   1. **不要**用 model/index.js 的单例 —— 那个绑的是插件配置里的 xlsx_path，跟 --to 不是一回事
 *   2. 同步一律强制备份（不看配置里的 backup），万一搬错了还能从 .bak 退回去
 */
const openTarget = () => new Table({ file: TO, backup: true })

const DRY = has("--dry")
/** 文档里没有、本地还有的行：默认清掉（文档为准）；加这个参数就只提示不动 */
const KEEP_EXTRAS = has("--keep-extras")
const FROM_ARG = flag("--from", process.env.ABYSS_SYNC_FROM ?? config.sync?.from ?? "")
const TO = path.resolve(flag("--to", process.env.ABYSS_SYNC_TO ?? config.sync?.to ?? config.xlsxPath ?? ""))
const DOC = flag("--doc", process.env.ABYSS_DOC_URL ?? config.sync?.doc_url ?? "")
const MANUAL_COOKIE = flag("--cookie", process.env.ABYSS_DOC_COOKIE ?? config.sync?.cookie ?? "")
const DOC_HOSTS = ["docs.qq.com", "qq.com"]

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

/** 顺手清掉以前跑崩留在 %TEMP% 的 cookie 库副本（本脚本自己也用 finally 保证不再留） */
cleanTempCopies()

/**
 * `--from latest`：在下载目录里找最新的导出文件（腾讯文档「导出为 xlsx」默认落这儿）
 * @returns {string} 找到的文件路径；没有就返回空
 */
function latestDownload() {
  const dirs = [path.join(os.homedir(), "Downloads"), path.join(os.homedir(), "下载")].filter(d => fs.existsSync(d))
  const files = []
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.xlsx$/i.test(name) || name.startsWith("~$")) continue
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      files.push({ full, at: st.mtimeMs })
    }
  }
  files.sort((a, b) => b.at - a.at)
  return files[0]?.full ?? ""
}

/** 从文档地址里抠出 padId：https://docs.qq.com/sheet/XXXX?tab=yyy → XXXX */
const docIdOf = input => {
  const text = String(input ?? "").trim()
  if (!text) return ""
  const m = /docs\.qq\.com\/(?:sheet|slide|doc)\/([A-Za-z0-9_-]+)/.exec(text)
  return m ? m[1] : text.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop()
}

/** 用本脚本的专用窗口登录一次（登录后自动优雅关窗，Cookie 才会落盘） */
async function loginOnce() {
  const exe = edgeExe()
  if (!exe) {
    log("没找到 Edge，无法自动登录；可以改用 --cookie 或 --from")
    return 1
  }
  const padId = docIdOf(DOC)
  const url = padId ? `https://docs.qq.com/sheet/${padId}` : "https://docs.qq.com/"
  const port = 9300 + Math.floor(Math.random() * 200)
  fs.mkdirSync(LOGIN_PROFILE, { recursive: true })
  log(`打开专用窗口（配置目录 ${LOGIN_PROFILE}）`)
  log("请在弹出的窗口里登录腾讯文档；登录完成后回到这个命令行按回车（或等 3 分钟自动继续）")
  const child = spawn(
    exe,
    [`--user-data-dir=${LOGIN_PROFILE}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", url],
    { stdio: "ignore" },
  )

  await new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    if (process.stdin.isTTY) {
      process.stdin.setEncoding("utf8")
      process.stdin.once("data", finish)
    }
    setTimeout(finish, 180000)
  })

  /** 关标签页让 Edge 正常退出，cookie 才会写回磁盘 */
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    for (const t of list) if (t.id) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {})
  } catch {}
  await sleep(2500)
  try {
    child.kill()
  } catch {}
  await sleep(1500)

  const profile = browserProfiles().find(p => p.browser === "专用窗口")
  if (!profile) {
    log("❌ 专用窗口没有留下 Cookie 文件")
    return 1
  }
  try {
    const rows = await readCookies(profile, DOC_HOSTS)
    log(`专用窗口里腾讯文档相关 Cookie：${rows.length} 条（${[...new Set(rows.map(r => r.name))].slice(0, 6).join("、")}…）`)
    log(rows.length ? "✅ 登录信息已保存，以后直接跑 node tools/sync-doc.mjs 即可自动同步" : "⚠ 没读到 Cookie，可能没登录成功")
    return rows.length ? 0 : 1
  } catch (err) {
    log(`❌ 读取 Cookie 失败：${redact(err.message)}`)
    return 1
  }
}

if (has("--forget")) {
  /** 把专用窗口的登录态整个删掉（Cookie 也随之消失）；下次 --login 会重新建 */
  try {
    fs.rmSync(LOGIN_PROFILE, { recursive: true, force: true })
    log(`已删除专用窗口目录（含登录 Cookie）：${LOGIN_PROFILE}`)
  } catch (err) {
    log(`删除失败（可能浏览器还开着）：${err.message}`)
  }
  process.exit(0)
}

if (has("--login")) process.exit(await loginOnce())

/** 在线导出：按顺序试几个入口，拿到 zip（xlsx）就算成功 */
async function downloadDoc(padId, cookie) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    referer: `https://docs.qq.com/sheet/${padId}`,
    accept: "*/*",
  }
  if (cookie) headers.cookie = cookie

  const attempts = [
    `https://docs.qq.com/v1/export/export_office?docId=${padId}&type=xlsx`,
    `https://docs.qq.com/v1/export/export_office?docId=${padId}&exportType=xlsx`,
    `https://docs.qq.com/v1/export/export_office?docId=${padId}&type=xlsx&exportType=xlsx&downType=xlsx`,
  ]
  const seen = []
  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers, redirect: "follow" })
      const buf = Buffer.from(await res.arrayBuffer())
      const zip = buf[0] === 0x50 && buf[1] === 0x4b
      seen.push(`${url} → HTTP ${res.status} ${buf.length}B${zip ? " (xlsx)" : ""}`)
      if (zip) return { buffer: buf, from: url }
    } catch (err) {
      /** 网络错误的 message 也先过一遍 redact，防止 header 片段被带进日志 */
      seen.push(`${url} → ${redact(err?.message ?? err, cookie)}`)
    }
  }

  /** 拿不到就再问一句文档本身的状态，好给出人话解释 */
  let reason = "导出接口没有返回 xlsx"
  try {
    const res = await fetch(`https://docs.qq.com/dop-api/opendoc?id=${padId}&normal=1&outformat=1`, { headers })
    const j = await res.json().catch(() => ({}))
    const cv = j.clientVars ?? {}
    if (cv.isBlankPage || /blankpage/i.test(cv.errmsg ?? ""))
      reason = cookie
        ? "带着登录 Cookie 仍然被拒（可能是这个账号没有该文档权限，或 Cookie 已过期）：先跑一次 --login 重新登录"
        : "腾讯文档不给匿名读取（blankpage）：跑一次 `node tools/sync-doc.mjs --login` 登录，或把分享权限改成「获得链接的人可查看」"
  } catch {}
  return { error: [reason, ...seen].join("\n  ") }
}

/** 源表（Buffer）→ { 榜名: {dataRows, anchors, model} } */
async function readSource(buffer) {
  const wb = await openWorkbook(buffer)
  const out = new Map()
  for (const sheet of wb.sheets) {
    const xml = await wb.sheetXml(sheet.name)
    out.set(sheet.name, buildModel({ name: sheet.name, xml, shared: wb.shared }))
  }
  return out
}

const clean = s => String(s ?? "").trim()

/** 算出一张榜要写的格子：数据区 B–H、主播区 A/C/D/G/H */
function diffSheet(dest, src) {
  const sets = []
  const clears = []
  const notes = []

  /** --- 数据区：按行号对齐，B–H（不动 A 列公式） --- */
  for (const row of src.rows) {
    const mirror = dest.rows.find(r => r.row === row.row)
    const inRange = row.row >= dest.dataStart && row.row <= dest.dataEnd
    const hasData = DATA_COLUMNS.some(k => clean(row[k]))
    if (!hasData) {
      /** 文档里这一行被清空了 → 本地也清掉 */
      if (mirror && DATA_COLUMNS.some(k => clean(mirror[k]))) clears.push({ kind: "row", row: row.row })
      continue
    }
    if (!inRange) {
      notes.push(`第 ${row.row} 行超出本地数据区（${dest.dataStart}–${dest.dataEnd}），跳过`)
      continue
    }
    for (const key of DATA_COLUMNS) {
      const want = clean(row[key])
      const now = clean(mirror?.[key])
      if (want === now) continue
      sets.push({ kind: "cell", row: row.row, key, ref: `${dest.col[key]}${row.row}`, value: want })
    }
  }

  /** --- 数据区：本地有、文档里整行都没了 → 本地也清掉（文档是准） --- */
  const srcRows = new Set(src.rows.map(r => r.row))
  for (const row of dest.rows) {
    if (row.row < dest.dataStart || row.row > dest.dataEnd) continue
    if (srcRows.has(row.row)) continue
    if (!DATA_COLUMNS.some(k => clean(row[k]))) continue
    if (KEEP_EXTRAS) {
      notes.push(`第 ${row.row} 行（${clean(row.nickname)}）文档里没有，按 --keep-extras 保留`)
      continue
    }
    clears.push({ kind: "row", row: row.row })
  }

  /** --- 主播区：表头上方按行号覆盖 A/C/D/G/H --- */
  for (const a of src.anchors) {
    const mirror = dest.anchors.find(x => x.row === a.row)
    if (!mirror) {
      notes.push(`主播区第 ${a.row} 行在本地不存在，跳过`)
      continue
    }
    const pairs = [
      ["A", clean(a.cells.name), clean(mirror.cells.name)],
      ["C", clean(a.cells.skills), clean(mirror.cells.skills)],
      ["D", clean(a.cells.duty), clean(mirror.cells.duty)],
      ["G", clean(a.cells.platform), clean(mirror.cells.platform)],
      ["H", clean(a.cells.link), clean(mirror.cells.link)],
    ]
    for (const [col, want, now] of pairs) {
      if (want === now) continue
      sets.push({ kind: "anchor", row: a.row, col, ref: `${col}${a.row}`, value: want })
    }
  }

  /** --- 主播区：本地有、文档里没有的行（文档删了这位主播）→ 只提示，不自动删 --- */
  for (const a of dest.anchors) {
    if (src.anchors.some(x => x.row === a.row)) continue
    notes.push(`主播区第 ${a.row} 行（${a.name}）文档里没有，保留本地不动`)
  }
  return { sets, clears, notes }
}

/* ------------------------------- 主流程 ------------------------------- */

if (!TO) {
  console.error("没有目标表格：用 --to 或配置里的 xlsx_path")
  process.exit(1)
}
if (!fs.existsSync(TO)) {
  console.error(`目标表格不存在：${TO}`)
  process.exit(1)
}

let sourceBuffer = null
let sourceLabel = ""
const FROM = FROM_ARG === "latest" ? latestDownload() : FROM_ARG
if (FROM_ARG) {
  if (!FROM) {
    console.error(`--from latest 没在下载目录里找到 .xlsx（先导出一次），或路径写错了：${FROM_ARG}`)
    process.exit(1)
  }
  if (!fs.existsSync(FROM)) {
    console.error(`--from 指定的文件不存在：${FROM}`)
    process.exit(1)
  }
  sourceBuffer = await fsp.readFile(FROM)
  sourceLabel = `${FROM}${FROM_ARG === "latest" ? "（下载目录里最新的）" : ""}`
} else {
  const padId = docIdOf(DOC)
  if (!padId) {
    console.error("没有文档地址：用 --doc 或配置里的 sync.doc_url")
    process.exit(1)
  }
  /** Cookie：先手工给的，再自动从本机取（不会打印 Cookie 值） */
  let cookie = MANUAL_COOKIE
  let cookieFrom = cookie ? "命令行/环境变量" : ""
  if (!cookie) {
    const got = await autoCookie({ hosts: DOC_HOSTS, log })
    if (got.cookie) {
      cookie = got.cookie
      cookieFrom = got.from
    } else if (got.error) {
      log(`（自动取 Cookie 没成功：${redact(got.error)}）`)
    }
  }
  log(`在线导出：${padId}${cookie ? `（带 Cookie：${cookieFrom}）` : "（匿名）"}`)
  const got = await downloadDoc(padId, cookie)
  if (got.error) {
    console.error(`❌ 在线同步失败：\n  ${redact(got.error)}`)
    process.exit(2)
  }
  sourceBuffer = got.buffer
  sourceLabel = got.from
}

const src = await readSource(sourceBuffer)
/** `--from latest` 是"猜"出来的文件：必须三张榜都在，否则可能是别的表格，宁可不写 */
if (FROM_ARG === "latest") {
  const destNames = await openTarget().read(({ models }) => [...models.keys()])
  const missing = destNames.filter(n => !src.has(n))
  if (missing.length) {
    console.error(`❌ 下载目录里最新的 xlsx 不像是这张排表（缺少工作表：${missing.join("、")}）：${FROM}`)
    console.error("   请确认导出的是同一张表，或用 --from <文件> 明确指定")
    process.exit(3)
  }
}
log(`来源：${sourceLabel}`)
log(`目标：${TO}${DRY ? "（--dry，只看不改）" : ""}`)
log(`来源工作表：${[...src.keys()].join(" / ")}`)
if (path.resolve(TO) !== path.resolve(config.xlsxPath ?? ""))
  log(`⚠ 注意：目标不是插件配置里的表（${config.xlsxPath || "未配置"}），只改 --to 指定的这一份`)

const target = openTarget()
const dest = await target.read(({ models }) => models)
let totalSets = 0
let totalClears = 0

for (const [name, srcModel] of src) {
  const destModel = dest.get(name)
  if (!destModel) {
    log(`\n【${name}】本地没有这个工作表，跳过`)
    continue
  }
  const { sets, clears, notes } = diffSheet(destModel, srcModel)
  log(`\n【${name}】需要改 ${sets.length} 格，清空 ${clears.length} 行`)
  for (const s of sets.slice(0, 8)) log(`   · ${s.ref} ← ${JSON.stringify(s.value).slice(0, 60)}`)
  if (sets.length > 8) log(`   … 另有 ${sets.length - 8} 格`)
  for (const n of notes) log(`   ⚠ ${n}`)
  totalSets += sets.length
  totalClears += clears.length

  if (DRY || (!sets.length && !clears.length)) continue
  await target.mutate(ctx => {
    for (const c of clears) ctx.clearRow(name, c.row)
    for (const s of sets) {
      if (s.kind === "cell") ctx.setCell(name, s.row, s.key, s.value)
      else ctx.setRef(name, s.ref, s.value)
    }
  })
}

log(`\n${DRY ? "（未写入）" : "已同步"}：共 ${totalSets} 格${totalClears ? `、清空 ${totalClears} 行` : ""}`)
if (!DRY && (totalSets || totalClears)) log(`旧文件已备份为 ${path.basename(TO)}.bak`)
