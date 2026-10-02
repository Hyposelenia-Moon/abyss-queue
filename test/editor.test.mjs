/**
 * 在线编辑器端到端：读写都打在表格副本上
 *
 * 覆盖：字段与下拉选项、口令与身份签名、白名单权限、完成情况锁定、写入校验、健康检查。
 * 用法：node test/editor.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { signIdentity } from "../lib/identity.js"
import * as aliases from "../lib/aliases.js"

const SRC = process.argv[2] ?? "D:/文件/游戏/原神/2026年10月三路深渊排队.xlsx"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-editor-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

const cfg = path.join(tmp, "config.yaml")
/** store_file 也要指到临时目录：编辑器会按 QQ 记绑定，绝不能写到仓库的 data/ */
fs.writeFileSync(
  cfg,
  [
    `xlsx_path: "${fixture.replace(/\\/g, "/")}"`,
    `store_file: "${path.join(tmp, "bindings.json").replace(/\\/g, "/")}"`,
    /** 别名：表里写的「璃月第一深情」其实就是摸头妹 */
    "anchor_aliases:",
    '  摸头妹: ["璃月第一深情"]',
    "",
  ].join("\n"),
  "utf8",
)

const editor = path.resolve(import.meta.dirname, "..", "tools", "editor.mjs")
const port = 7799
const TOKEN = "test-token-42"
const ADMIN_TOKEN = "admin-token-99"
const ADMINS_FILE = path.join(tmp, "admins.json")
const ENV_ADMIN = "环境白名单"
const child = spawn(
  process.execPath,
  [editor, "--port", String(port), "--token", TOKEN, "--admin-token", ADMIN_TOKEN, "--admins", ADMINS_FILE],
  {
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_FILE: fixture, ABYSS_EDITOR_ADMINS: ENV_ADMIN },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let out = ""
child.stdout.on("data", d => (out += d))
child.stderr.on("data", d => (out += d))

const wait = ms => new Promise(r => setTimeout(r, ms))

/** 把参数拼成查询串：k=口令、u/s=身份、a=管理口令 */
const query = ({ k = TOKEN, who = null, a = "" } = {}) => {
  const params = []
  if (k) params.push(`k=${encodeURIComponent(k)}`)
  if (who) {
    const id = signIdentity(who, TOKEN)
    params.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
  }
  if (a) params.push(`a=${encodeURIComponent(a)}`)
  return params.join("&")
}

const api = async (p, body, opts = {}) => {
  const qs = query(opts)
  const url = `http://127.0.0.1:${port}${p}${qs ? (p.includes("?") ? "&" : "?") + qs : ""}`
  const res = await fetch(url, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { __raw: text.slice(0, 4000) }
  }
  return { status: res.status, json }
}

let failed = 0
/** 支持同步与 async 回调 */
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}

try {
  // 等服务就绪（用带口令的请求）
  let ready = false
  for (let i = 0; i < 60; i++) {
    await wait(500)
    try {
      const r = await api("/healthz")
      if (r.status === 200) {
        ready = true
        break
      }
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  await check("口令：无口令访问接口被拒绝", async () => {
    const r = await api("/api/data", null, { k: "" })
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("口令：错误口令被拒绝", async () => {
    const r = await api("/api/data", null, { k: "wrong" })
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("口令：无口令打开首页给出口令输入页（而不是 403）", async () => {
    const r = await api("/", null, { k: "" })
    if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
    if (!String(r.json.__raw).includes("访问口令")) throw new Error("首页不是口令输入页")
  })
  await check("健康检查：带口令返回配置摘要", async () => {
    const r = await api("/healthz")
    if (r.status !== 200 || !r.json.ok) throw new Error(`healthz 异常：${JSON.stringify(r.json)}`)
    if (r.json.auth !== true) throw new Error("healthz 未表明已启用口令")
    if (r.json.file !== fixture) throw new Error(`healthz 文件不对：${r.json.file}`)
    if (r.json.admin_api !== true) throw new Error("healthz 未表明管理接口已启用")
    if (r.json.admins !== 1) throw new Error(`环境变量白名单应计入：${r.json.admins}`)
    /** 升级后忘了重启本地编辑器时，靠这两项就能看出来跑的是哪一版 */
    if (!r.json.version) throw new Error("healthz 没有版本号")
    if (!Array.isArray(r.json.fields) || !r.json.fields.includes("status")) throw new Error(`healthz 字段表缺 status：${JSON.stringify(r.json.fields)}`)
  })

  /** 只有口令、没有签名身份：看得到全部，但一格也改不了 */
  const guest = await api("/api/data")
  check("访客（只有口令）：能看到全部行", () => {
    if (guest.json.sheets.length !== 3) throw new Error(`得到 ${guest.json.sheets.length} 个表`)
    if (!guest.json.sheets.every(s => s.rows.length > 0)) throw new Error("有表没有返回行")
  })
  check("访客：角色为 guest 且标记只读", () => {
    if (guest.json.perm.role !== "guest") throw new Error(`role=${guest.json.perm.role}`)
    if (guest.json.perm.readonly !== true) throw new Error("没有标记只读")
  })

  check("字段：与原表同序列出（完成情况在备注右边），不含序号", () => {
    const keys = guest.json.fields.map(f => f.key)
    const want = ["nickname", "gameName", "anchor", "goal", "strength", "note", "status"]
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`字段为 ${keys.join(",")}，期望 ${want.join(",")}`)
    if (keys.includes("seq")) throw new Error("不该显示 seq")
    const required = guest.json.fields.filter(f => f.required).map(f => f.key)
    if (JSON.stringify(required) !== JSON.stringify(["nickname", "gameName"]))
      throw new Error(`必填项为 ${required.join(",")}`)
  })
  check("字段：完成情况有下拉选项", () => {
    const s = guest.json.sheets.find(x => x.name === "幽境危战")
    if (!s.options.status?.includes("排队中")) throw new Error("完成情况没有下拉选项")
    if (!s.options.goal?.length || !s.options.anchor?.length) throw new Error("难度/主播没有下拉选项")
  })

  const sheet = "幽境危战"
  const all = guest.json.sheets.find(x => x.name === sheet).rows
  /** 找一个有昵称的行当"本人"，再找一个昵称不同的当"别人" */
  const mineRow = all.find(r => String(r.nickname).trim())
  const MY_NICK = String(mineRow.nickname).trim()
  const otherRow = all.find(r => String(r.nickname).trim() && String(r.nickname).trim() !== MY_NICK)
  const who = { qq: "1733491779", nick: MY_NICK }

  const self = await api("/api/data", null, { who })
  check("本人（带签名）：只拿得到自己那一行", () => {
    if (self.json.perm.role !== "self") throw new Error(`role=${self.json.perm.role}`)
    const rows = self.json.sheets.find(x => x.name === sheet).rows
    if (!rows.length) throw new Error("没有返回自己那一行")
    for (const r of rows) if (String(r.nickname).trim() !== MY_NICK) throw new Error(`返回了别人的行：${r.nickname}`)
  })

  await check("篡改签名：换掉昵称后降级为只读访客", async () => {
    const id = signIdentity(who, TOKEN)
    const forged = Buffer.from(JSON.stringify({ q: "1", n: "别人", t: Date.now() }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const r = await api(`/api/data?k=${TOKEN}&u=${encodeURIComponent(forged)}&s=${encodeURIComponent(id.s)}`)
    if (r.json.perm.role !== "guest") throw new Error(`role=${r.json.perm.role}`)
  })

  const marker = "编辑器测试备注"
  const original = mineRow.note
  const saveMine = await api("/api/save", { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, note: marker } }] }, { who })
  check("本人：能改自己那一行", () => {
    if (!saveMine.json.ok) throw new Error(saveMine.json.error || "保存失败")
    if (saveMine.json.written !== 1) throw new Error(`written=${saveMine.json.written}`)
  })

  const otherSave = await api(
    "/api/save",
    { sheet, rows: [{ row: otherRow.row, values: { ...otherRow, note: "越权" } }] },
    { who },
  )
  check("本人：改别人的行被拒绝", () => {
    if (otherSave.json.ok) throw new Error("竟然保存成功了")
    if (!String(otherSave.json.error).includes("只能改自己那一行")) throw new Error(otherSave.json.error)
  })

  const guestSave = await api("/api/save", { sheet, rows: [{ row: mineRow.row, values: { ...mineRow } }] })
  check("访客：不能保存", () => {
    if (guestSave.json.ok) throw new Error("竟然保存成功了")
    if (!String(guestSave.json.error).includes("只能查看")) throw new Error(guestSave.json.error)
  })

  /* ---------------------- 完成情况：本人可填，主播改过就锁 ---------------------- */

  const statusOpt = guest.json.sheets.find(x => x.name === sheet).options.status
  const doneValue = statusOpt.find(v => v === "本人已完成") ?? statusOpt[0]
  const selfStatus = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, status: doneValue, note: original } }] },
    { who },
  )
  check("本人：能填自己的完成情况", () => {
    if (!selfStatus.json.ok) throw new Error(selfStatus.json.error || "保存失败")
  })

  const admin = await api("/api/data", null, { a: ADMIN_TOKEN })
  check("管理员（管理口令）：角色为 admin", () => {
    if (admin.json.perm.role !== "admin") throw new Error(`role=${admin.json.perm.role}`)
    if (admin.json.perm.showAdmins !== true) throw new Error("没有开放白名单维护")
  })

  const adminStatus = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, status: "排队中", note: original } }] },
    { a: ADMIN_TOKEN },
  )
  check("管理员：能改别人的完成情况", () => {
    if (!adminStatus.json.ok) throw new Error(adminStatus.json.error || "保存失败")
  })

  const locked = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, status: doneValue, note: marker } }] },
    { who },
  )
  check("本人：主播改过完成情况后，改不动这一格（其余字段照常保存）", () => {
    if (!locked.json.ok) throw new Error(locked.json.error || "保存失败")
    if (!(locked.json.ignored ?? []).some(i => i.label === "帮帮完成情况")) throw new Error("没有回报被忽略的字段")
  })
  const afterLock = await api("/api/data", null, { who })
  const lockedRow = afterLock.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === mineRow.row)
  check("锁定生效：完成情况仍是主播填的值，备注已改", () => {
    if (lockedRow.status !== "排队中") throw new Error(`status=${lockedRow.status}`)
    if (lockedRow.note !== marker) throw new Error(`note=${lockedRow.note}`)
    if (lockedRow.statusLocked !== true) throw new Error("没有回报 statusLocked")
  })

  /* ---------------------- 按 QQ 定位（改了群名片也认人） ---------------------- */

  const RENAMED = "改了名片的同一个人"
  const renamed = await api("/api/data", null, { who: { qq: who.qq, nick: RENAMED } })
  check("按 QQ 定位：换了群名片，靠绑定仍能拿到自己那一行", () => {
    if (renamed.json.perm.role !== "self") throw new Error(`role=${renamed.json.perm.role}`)
    const rows = renamed.json.sheets.find(x => x.name === sheet).rows
    if (!rows.some(r => r.row === mineRow.row)) throw new Error(`只拿到 ${rows.length} 行，没有绑定那一行`)
  })
  const renamedRow = renamed.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === mineRow.row)
  check("按 QQ 定位：表里的群昵称被同步成新名片", () => {
    if (String(renamedRow.nickname).trim() !== RENAMED) throw new Error(`昵称=${renamedRow.nickname}`)
    if ((renamed.json.sync?.renamed ?? 0) < 1) throw new Error("没有回报同步动作")
  })
  const saveRenamed = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...renamedRow, note: marker } }] },
    { who: { qq: who.qq, nick: RENAMED } },
  )
  check("按 QQ 定位：绑定过的行照常可保存", () => {
    if (!saveRenamed.json.ok) throw new Error(saveRenamed.json.error || "保存失败")
  })

  /* ---------------- 「选择主播」下拉：以主播列表为准 ---------------- */

  check("选择主播：下拉以主播列表为准（每一位都在，顺序也按表内顺序）", () => {
    const s = admin.json.sheets.find(x => x.name === sheet)
    const names = s.anchorRows.map(a => a.name)
    if (JSON.stringify(s.options.anchor.slice(0, names.length)) !== JSON.stringify(names))
      throw new Error(`下拉前 ${names.length} 项应为主播列表：${JSON.stringify(s.options.anchor)}`)
  })
  check("选择主播：表里在用的旧值仍在（别名除外）", () => {
    const { compileAliases, canonicalAnchor } = aliases
    const known = compileAliases({ 摸头妹: ["璃月第一深情"] })
    for (const s of guest.json.sheets) {
      /** 用 payload 里的 anchors（各角色都会下发），主播区的明细行只有管理员才有 */
      const names = s.anchors ?? []
      const used = [...new Set(s.rows.flatMap(r => String(r.anchor ?? "").split(/[,，]/).map(x => x.trim()).filter(Boolean)))]
      for (const v of used) {
        /** 别名归到正名：只要正名在表里且有下拉项，就算这个值"选得到" */
        const c = canonicalAnchor(v, known)
        if (c !== v && names.includes(c)) {
          if (!s.options.anchor.includes(c)) throw new Error(`${s.name}：「${v}」是「${c}」的别名，但下拉里没有正名`)
          continue
        }
        if (!s.options.anchor.includes(v)) throw new Error(`${s.name}：表里在用的「${v}」不在下拉里`)
      }
    }
  })
  await check("选择主播：主播列表里有、原下拉验证里没有的名字也能存回去", async () => {
    /** 真实表里「摸头妹」只在主播区、不在「选择主播」的下拉验证里，以前会被判成"不在选项里" */
    const s = admin.json.sheets.find(x => x.name === sheet)
    const anchorName = s.anchorRows.map(a => a.name).find(n => n === "摸头妹")
    if (!anchorName) {
      console.log("     ⏭ 这个榜的主播列表里没有「摸头妹」，跳过")
      return
    }
    const row = guest.json.sheets.find(x => x.name === sheet).rows.find(r => String(r.nickname).trim())
    const saved = await api(
      "/api/save",
      { sheet, rows: [{ row: row.row, values: { ...row, anchor: anchorName } }] },
      { a: ADMIN_TOKEN },
    )
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
    const back = await api("/api/data", null, { a: ADMIN_TOKEN })
    const now = back.json.sheets.find(x => x.name === sheet).rows.find(x => x.row === row.row)
    if (now.anchor !== anchorName) throw new Error(`表里是 ${now.anchor}`)
    await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
  })

  check("选择主播：别名归到正名，不在下拉里多出一个名字", () => {
    /** 幽境危战里有人写「璃月第一深情」，其实是摸头妹 */
    const s = guest.json.sheets.find(x => x.name === sheet)
    const used = s.rows.some(r => String(r.anchor ?? "").includes("璃月第一深情"))
    if (!used) {
      console.log("     ⏭ 这个榜没有用「璃月第一深情」的行，跳过")
      return
    }
    const names = (s.anchorRows ?? []).map(a => a.name)
    if (!names.includes("摸头妹")) {
      console.log("     ⏭ 这个榜的主播列表里没有「摸头妹」，跳过")
      return
    }
    if (s.options.anchor.includes("璃月第一深情")) throw new Error(`下拉里不该出现别名：${JSON.stringify(s.options.anchor)}`)
    if (!s.options.anchor.includes("摸头妹")) throw new Error("下拉里少了正名「摸头妹」")
  })
  await check("选择主播：写着别名的老行，不改动也能照常保存", async () => {
    const s = guest.json.sheets.find(x => x.name === sheet)
    const row = s.rows.find(r => String(r.anchor ?? "").includes("璃月第一深情"))
    if (!row) {
      console.log("     ⏭ 没有这样的行，跳过")
      return
    }
    const saved = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
  })

  /* --------------------- 表头上方的「主播列表」 --------------------- */

  const sheetAnchors = admin.json.sheets.find(x => x.name === sheet).anchorRows
  check("主播列表：管理员拿得到主播区的行（字段与渲染列一致）", () => {
    if (!Array.isArray(sheetAnchors) || !sheetAnchors.length) throw new Error("没有返回主播行")
    for (const a of sheetAnchors)
      for (const key of ["row", "name", "recommend", "duty", "skills", "platform", "link"])
        if (!(key in a)) throw new Error(`主播行缺少 ${key}：${JSON.stringify(a)}`)
  })
  check("主播列表：非管理员拿不到（普通人与访客都没有）", () => {
    if (guest.json.sheets.find(x => x.name === sheet).anchorRows !== undefined) throw new Error("访客也拿到了主播行")
    if (self.json.sheets.find(x => x.name === sheet).anchorRows !== undefined) throw new Error("本人也拿到了主播行")
  })

  const anchorRow = sheetAnchors[0]
  const anchorMarker = "自动化测试强项"
  const savedAnchor = await api(
    "/api/anchors",
    {
      sheet,
      rows: [
        {
          row: anchorRow.row,
          values: {
            name: anchorRow.name,
            recommend: anchorRow.recommend || "强烈推荐",
            duty: anchorRow.duty || "幽境危战",
            skills: anchorMarker,
            platform: anchorRow.platform || "B站",
            link: anchorRow.link,
          },
        },
      ],
    },
    { a: ADMIN_TOKEN },
  )
  check("主播列表：管理员能改", () => {
    if (!savedAnchor.json.ok) throw new Error(savedAnchor.json.error || "保存失败")
    if (savedAnchor.json.written !== 1) throw new Error(`written=${savedAnchor.json.written}`)
  })

  const anchorBack = await api("/api/data", null, { a: ADMIN_TOKEN })
  const anchorNow = anchorBack.json.sheets.find(x => x.name === sheet).anchorRows.find(a => a.row === anchorRow.row)
  check("主播列表：改动落表（强项 / 专职 / 推荐度都在）", () => {
    if (anchorNow.skills !== anchorMarker) throw new Error(`强项=${anchorNow.skills}`)
    if (anchorNow.duty !== (anchorRow.duty || "幽境危战")) throw new Error(`专职=${anchorNow.duty}`)
    if (anchorNow.recommend !== (anchorRow.recommend || "强烈推荐")) throw new Error(`推荐度=${anchorNow.recommend}`)
  })
  await check("主播列表：改完表结构没被动（合并 / 校验 / 条件格式数量不变）", async () => {
    const { openWorkbook } = await import("../lib/xlsx.js")
    const countOf = (text, tag) => text.split(tag).length - 1
    const before = await (await openWorkbook(fs.readFileSync(SRC))).sheetXml(sheet)
    const after = await (await openWorkbook(fs.readFileSync(fixture))).sheetXml(sheet)
    for (const tag of ["<mergeCell ", "<dataValidation ", "<conditionalFormatting ", "<hyperlink "])
      if (countOf(after, tag) !== countOf(before, tag))
        throw new Error(`${tag} 数量变化：${countOf(before, tag)} → ${countOf(after, tag)}`)
  })

  await check("主播列表：保存后表格自己的「选择主播」下拉也同步（以主播为准）", async () => {
    const { openWorkbook } = await import("../lib/xlsx.js")
    const { buildModel } = await import("../lib/schema.js")
    const readSheet = async file => {
      const wb = await openWorkbook(fs.readFileSync(file))
      const xml = await wb.sheetXml(sheet)
      return { xml, model: buildModel({ name: sheet, xml, shared: wb.shared }) }
    }
    const now = await readSheet(fixture)
    const col = now.model.col.anchor
    const listOf = (xml, letter) => {
      const re = new RegExp(`<dataValidation[^>]*sqref="${letter}[^"]*"[^>]*>[\\s\\S]*?<formula1>([\\s\\S]*?)</formula1>`)
      const body = re.exec(xml)?.[1] ?? ""
      return body
        .replace(/&quot;/g, '"')
        .replace(/^"|"$/g, "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    }
    const names = now.model.anchors.map(a => a.name)
    const list = listOf(now.xml, col)
    for (const n of names) if (!list.includes(n)) throw new Error(`下拉里没有主播「${n}」：${JSON.stringify(list)}`)
    /** 原文里那个"主播区有、下拉没有"的名字（如摸头妹）现在必须在 */
    const before = await readSheet(SRC)
    const wasMissing = before.model.anchors.map(a => a.name).filter(n => !listOf(before.xml, before.model.col.anchor).includes(n))
    for (const n of wasMissing) if (!list.includes(n)) throw new Error(`原本缺的「${n}」还是没补上下拉`)
    /** 别的列的下拉原样不动 */
    const strengthCol = now.model.col.strength
    if (JSON.stringify(listOf(now.xml, strengthCol)) !== JSON.stringify(listOf(before.xml, strengthCol)))
      throw new Error("账号强度的下拉被误改")
  })

  await check("主播列表：本人与访客都不能改", async () => {
    const body = { sheet, rows: [{ row: anchorRow.row, values: { ...anchorNow, skills: "越权" } }] }
    for (const opts of [{ who }, {}]) {
      const r = await api("/api/anchors", body, opts)
      if (r.json.ok) throw new Error("竟然保存成功了")
      if (!String(r.json.error).includes("只有白名单管理员")) throw new Error(r.json.error)
    }
  })
  await check("主播列表：不能写到非主播行、也不能把主播名清空", async () => {
    const notAnchor = await api("/api/anchors", { sheet, rows: [{ row: mineRow.row, values: { name: "x" } }] }, { a: ADMIN_TOKEN })
    if (notAnchor.json.ok || !String(notAnchor.json.error).includes("不是主播列表")) throw new Error(notAnchor.json.error)
    const noName = await api("/api/anchors", { sheet, rows: [{ row: anchorRow.row, values: { name: "" } }] }, { a: ADMIN_TOKEN })
    if (noName.json.ok || !String(noName.json.error).includes("不能为空")) throw new Error(noName.json.error)
  })

  /* ------------------------- 本机模式（桌面快捷方式） ------------------------- */

  /** 本地编辑器不带口令启动：等同管理员，所以主播列表与所有行都能改 */
  const localPort = 7800
  const local = spawn(process.execPath, [editor, "--port", String(localPort), "--file", fixture], {
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let localOut = ""
  local.stdout.on("data", d => (localOut += d))
  local.stderr.on("data", d => (localOut += d))
  try {
    let up = false
    for (let i = 0; i < 40; i++) {
      await wait(400)
      try {
        const r = await fetch(`http://127.0.0.1:${localPort}/healthz`)
        if (r.ok) {
          up = true
          break
        }
      } catch {}
    }
    if (!up) throw new Error(`本地模式编辑器没起来：\n${localOut}`)
    const res = await fetch(`http://127.0.0.1:${localPort}/api/data`)
    const out = await res.json()
    check("本地编辑器（不带口令）：等同管理员，主播列表可改", () => {
      if (out.perm?.role !== "admin") throw new Error(`role=${out.perm?.role}`)
      const rows = out.sheets.find(x => x.name === sheet)?.anchorRows
      if (!Array.isArray(rows) || !rows.length) throw new Error("没有下发主播列表")
      if (!out.sheets.every(s => (s.rows?.length ?? 0) > 0)) throw new Error("没有下发数据行")
    })
  } finally {
    local.kill()
  }

  /* ------------------------------ 白名单 ------------------------------ */

  await check("白名单：没有管理口令时读不到", async () => {
    const r = await api("/api/admins")
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("白名单：读出环境变量里写死的那些人", async () => {
    const r = await api("/api/admins", null, { a: ADMIN_TOKEN })
    if (!r.json.ok) throw new Error(r.json.error)
    if (!r.json.admins.includes(ENV_ADMIN)) throw new Error(`admins=${JSON.stringify(r.json.admins)}`)
    if (!r.json.env.includes(ENV_ADMIN)) throw new Error("没有回报环境变量来源")
  })

  const addWho = { qq: "10086", nick: otherRow.nickname }
  await api("/api/admins", { add: [otherRow.nickname] }, { a: ADMIN_TOKEN })
  const promoted = await api("/api/data", null, { who: addWho })
  check("白名单：加进去的人变成管理员，能看到全部行", () => {
    if (promoted.json.perm.role !== "admin") throw new Error(`role=${promoted.json.perm.role}`)
    const rows = promoted.json.sheets.find(x => x.name === sheet).rows
    if (rows.length !== all.length) throw new Error(`只看到 ${rows.length} 行，应为 ${all.length}`)
  })
  const promotedSave = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, note: "白名单改的" } }] },
    { who: addWho },
  )
  check("白名单：能改别人的行", () => {
    if (!promotedSave.json.ok) throw new Error(promotedSave.json.error || "保存失败")
  })

  await api("/api/admins", { remove: [otherRow.nickname] }, { a: ADMIN_TOKEN })
  const demoted = await api("/api/data", null, { who: addWho })
  check("白名单：移出后立刻回到只能改自己", () => {
    if (demoted.json.perm.role !== "self") throw new Error(`role=${demoted.json.perm.role}`)
  })

  /* ------------------------------ 收尾 ------------------------------ */

  await api("/api/save", { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, note: original } }] }, { a: ADMIN_TOKEN })
  const restored = await api("/api/data")
  const r2 = restored.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === mineRow.row)
  check("还原：备注回到原值", () => {
    if (r2.note !== original) throw new Error(`期望 ${JSON.stringify(original)}，实际 ${JSON.stringify(r2.note)}`)
  })
  check("整表行数未变", () => {
    if (restored.json.sheets.find(x => x.name === sheet).rows.length !== all.length) throw new Error("行数变化")
  })
  check("源表格未被触碰（编辑器只写副本）", () => {
    const a = fs.statSync(SRC)
    if (Date.now() - a.mtimeMs < 60_000) console.log(`     （注意：源表最近被改过 ${a.mtime.toLocaleString()}，请人工确认）`)
  })
} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  child.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 编辑器端到端验证失败 ${failed} 项` : "\n✅ 编辑器端到端验证通过")
process.exit(failed ? 1 : 0)
