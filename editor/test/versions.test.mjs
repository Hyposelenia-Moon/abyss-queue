/**
 * 历史版本 / 回退 / 上传覆盖云端
 *
 * 两个编辑器一起跑：左边当"云端"，右边当"本机"（配了 --cloud 指向左边）——
 * 上传覆盖这条路正是本机 → 云端，必须端到端验。
 *
 * 用法：node editor/test/versions.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { shared } from "./plugin.mjs"
/** 被测表格：显式参数 / XLSX_PATH / 维护者真实表 / 合成样本（缺真实表时也有样本可跑） */
import { SOURCE as SRC } from "./source.mjs"
/** 端口一律现要：套件之间不抢固定端口（见 test/_helper.mjs） */
import { freePort } from "../../test/_helper.mjs"
import { cookieJar } from "./harness.mjs"

const { signIdentity, signWindow } = await shared("model/identity.js")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-versions-"))
const TOKEN = "versions-token"
const SIGN_KEY = "versions-sign-key"
const OWNER = { qq: "1000000001", nick: "缄月" }
const OTHER = { qq: "10086", nick: "路人甲" }
const admins = path.join(tmp, "admins.json")
fs.writeFileSync(admins, JSON.stringify({ owner: [OWNER.qq], admins: [OWNER.qq] }), "utf8")

const start = (label, port, cloud = "") => {
  /**
   * 每个编辑器**各自一个数据目录**（生产里也是这样：一台编辑器一个 `<插件根>/data`）
   *
   * 测试模式下绑定 / 锁 / 群名单 / **认领记录**都落在"表格旁边"（见 `editor/config.js` 的
   * `dataBase`）。两个编辑器共用同一个目录时，云端的认领记录会出现在本机编辑器眼里，
   * 于是"本机那个主人"被当成别人的链接而只读——那是测试现场串了，不是产品口径。
   */
  const dir = path.join(tmp, label)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "queue.xlsx")
  fs.copyFileSync(SRC, file)
  const cfg = path.join(dir, "config.yaml")
  fs.writeFileSync(cfg, "default_sheet: 幽境危战\n", "utf8")
  const args = [
    path.resolve(import.meta.dirname, "..", "editor.mjs"),
    "--port", String(port),
    "--token", TOKEN,
    "--sign-key", SIGN_KEY,
    "--file", file,
    "--admins", admins,
    /**
     * ⏳ 这一项**当前不解析**（编辑器只读 ABYSS_EDITOR_VERSIONS_KEEP，默认值恰好也是 20），
     * 留着是为了盯住"参数接入后行为不变"。等 editor/config.js 的配置层统一时再接上，
     * 见那里 DEFAULTS 上的「待接接口」说明。
     */
    "--versions-keep", "20",
  ]
  // 版本目录/环境变量走 env（编辑器读 process.env）；ABYSS_EDITOR_TEST_PATHS 让临时目录里的表能起
  const env = {
    ...process.env,
    ABYSS_QUEUE_CONFIG: cfg,
    ABYSS_EDITOR_VERSIONS_DIR: path.join(tmp, `${label}-versions`),
    ABYSS_EDITOR_TEST_PATHS: "1",
  }
  if (cloud) args.push("--cloud", cloud)
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", d => (log += d))
  child.stderr.on("data", d => (log += d))
  return { label, port, file, child, log: () => log }
}

const CLOUD_PORT = await freePort()
const LOCAL_PORT = await freePort()
const cloud = start("cloud", CLOUD_PORT)
const local = start("local", LOCAL_PORT, `http://127.0.0.1:${CLOUD_PORT}`)

const wait = ms => new Promise(r => setTimeout(r, ms))
/**
 * 一台"设备"一个 cookie 罐（按 QQ 分）
 *
 * 认领那一层靠 cookie 认设备（`editor/claims.js`）：本套件会起两个编辑器进程，
 * 每个身份分别访问两次（本机那份 / 云端那份），两边各自认领、各自带自己的 cookie。
 */
const jars = new Map()
const jarOf = (port, who) => {
  const key = `${port}|${who ? `qq:${who.qq ?? ""}` : "(无身份)"}`
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}
const req = async (port, p, { who = null, body = null, raw = null, method, extraHeaders = {} } = {}) => {
  const q = [`k=${TOKEN}`]
  if (who) {
    const id = signIdentity(who, SIGN_KEY)
    q.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
    /** 带身份就必须带时间窗（本阶段起没有 w/ws 的身份链接一律 410，见 editor.mjs） */
    const win = signWindow(who, SIGN_KEY)
    if (win) q.push(`w=${win.w}`, `ws=${encodeURIComponent(win.ws)}`)
  }
  const jar = jarOf(port, who)
  const init = { method: method ?? (body || raw ? "POST" : "GET"), headers: { ...jar.headers, ...extraHeaders } }
  if (body) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(body)
  } else if (raw) {
    init.headers["content-type"] = "application/octet-stream"
    init.body = raw
  }
  const res = await fetch(`http://127.0.0.1:${port}${p}?${q.join("&")}`, init)
  jar.take(res)
  const text = await res.text()
  let out = null
  try {
    out = JSON.parse(text)
  } catch {
    out = { __raw: text.slice(0, 200) }
  }
  return { status: res.status, json: out }
}

let failed = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failed++
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`)
  }
}

try {
  for (const e of [cloud, local]) {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await wait(500)
      try {
        up = (await req(e.port, "/healthz")).status === 200
      } catch {}
    }
    if (!up) throw new Error(`${e.label} 没起来：\n${e.log()}`)
  }

  /** 版本目录默认是空的（“备份默认为空”） */
  const empty = await req(cloud.port, "/api/versions", { who: OWNER })
  check("历史版本默认是空的", empty.status === 200 && empty.json.versions.length === 0, JSON.stringify(empty.json))

  check("非主人看不到历史版本", (await req(cloud.port, "/api/versions", { who: OTHER })).status === 403)

  /** 先记下某一行的原值，改掉它 → 应当产生一个"修改之前"的版本 */
  const sheetBefore = (await req(cloud.port, "/api/data")).json.sheets[0]
  const row = sheetBefore.rows.find(r => String(r.nickname).trim())
  const originalNote = row.note
  const saved = await req(cloud.port, "/api/save", { who: OWNER, body: { sheet: sheetBefore.name, rows: [{ row: row.row, values: { ...row, note: "版本测试-A" } }] } })
  check("云端保存成功", saved.json.ok === true, JSON.stringify(saved.json).slice(0, 200))

  const after = await req(cloud.port, "/api/versions", { who: OWNER })
  check("写表前自动存了一个版本", after.json.versions.length === 1, JSON.stringify(after.json.versions))
  const version = after.json.versions[0]

  const nowNote = (await req(cloud.port, "/api/data")).json.sheets.find(s => s.name === sheetBefore.name).rows.find(r => r.row === row.row).note
  check("表里已经是新值", nowNote === "版本测试-A", nowNote)

  const restored = await req(cloud.port, "/api/restore", { who: OWNER, body: { id: version.id } })
  check("回退成功", restored.json.ok === true, JSON.stringify(restored.json).slice(0, 200))
  const backNote = (await req(cloud.port, "/api/data")).json.sheets.find(s => s.name === sheetBefore.name).rows.find(r => r.row === row.row).note
  check("回退后回到原值", backNote === originalNote, `${JSON.stringify(backNote)} ≠ ${JSON.stringify(originalNote)}`)

  const listed = await req(cloud.port, "/api/versions", { who: OWNER })
  check("回退也留下版本（回退错了能再退回来）", listed.json.versions.length >= 2, JSON.stringify(listed.json.versions.length))

  check("坏版本号被拒", (await req(cloud.port, "/api/restore", { who: OWNER, body: { id: "../../secret.xlsx" } })).status === 400)

  /** 上传覆盖云端：本机改一处 → 推到云端 */
  const localSheet = (await req(local.port, "/api/data", { who: OWNER })).json.sheets[0]
  const lrow = localSheet.rows.find(r => String(r.nickname).trim())
  await req(local.port, "/api/save", { who: OWNER, body: { sheet: localSheet.name, rows: [{ row: lrow.row, values: { ...lrow, note: "本机改的-B" } }] } })

  check("非主人不能上传覆盖云端", (await req(local.port, "/api/push-cloud", { who: OTHER, method: "POST" })).status === 403)

  /**
   * 本机推给云端时**带上本机那个主人的设备 cookie**（产品里就是这么转发的，见 `push-cloud`）：
   * 同一个浏览器、同一个域名，主人在云端那份上认领过的设备就是这一台。没有它，云端会把这条链接
   * 当成"别人的链接"按只读访客处理 → "只有主人能覆盖云端表"。
   */
  await req(cloud.port, "/api/data", { who: OWNER })
  const pushed = await req(local.port, "/api/push-cloud", {
    who: OWNER,
    method: "POST",
    extraHeaders: jarOf(cloud.port, OWNER).headers,
  })
  check("本机 → 云端 上传成功", pushed.json?.ok === true, JSON.stringify(pushed.json).slice(0, 300))
  const cloudRows = (await req(cloud.port, "/api/data", { who: OWNER })).json.sheets.find(s => s.name === sheetBefore.name).rows
  const cloudNote = cloudRows.find(r => r.row === lrow.row)?.note
  check("云端已经变成本机那份", cloudNote === "本机改的-B", cloudNote)

  const cloudVersions = await req(cloud.port, "/api/versions", { who: OWNER })
  check("覆盖云端前也存了版本", cloudVersions.json.versions.length >= 3, String(cloudVersions.json.versions.length))

  const bad = await req(cloud.port, "/api/upload", { who: OWNER, raw: Buffer.from("这不是 xlsx") })
  check("上传非 xlsx 被拒", bad.status === 400 && String(bad.json.error ?? "").includes("xlsx"), JSON.stringify(bad.json).slice(0, 200))
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  cloud.child.kill()
  local.child.kill()
  await wait(400)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 历史版本/上传 验证失败 ${failed} 项` : "\n✅ 历史版本/上传 验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
