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
import { fileURLToPath } from "node:url"
import { decodeIdentity, verifyIdentity } from "../lib/identity.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, "editor.html")

const args = process.argv.slice(2)
const flag = (name, fallback = "") => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const PORT = Number(flag("--port", process.env.ABYSS_EDITOR_PORT ?? 7788))
const BIND = flag("--bind", process.env.ABYSS_EDITOR_BIND ?? "127.0.0.1")
const TOKEN = String(flag("--token", process.env.ABYSS_EDITOR_TOKEN ?? "")).trim()
const ADMIN_TOKEN = String(flag("--admin-token", process.env.ABYSS_EDITOR_ADMIN_TOKEN ?? "")).trim()
const ONLINE_URL = process.env.ABYSS_EDITOR_ONLINE ?? ""

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
const resolveFile = async () => {
  const direct = flag("--file", process.env.ABYSS_EDITOR_FILE ?? "")
  if (direct) return path.resolve(direct)
  const { config } = await import("../components/config.js")
  return config.xlsxPath
}

const xlsxPath = await resolveFile()
if (!xlsxPath) {
  console.error("没有指定表格文件：用 --file <xlsx> 或环境变量 ABYSS_EDITOR_FILE")
  process.exit(1)
}
if (!fs.existsSync(xlsxPath)) {
  console.error(`表格不存在：${xlsxPath}`)
  process.exit(1)
}

/* 数据层与渲染只在这一步引入：独立部署时这些文件必须一起带上 */
const { getTable, getStore } = await import("../model/index.js")
const { matchOption, locateSelf } = await import("../lib/queue.js")
const { pluginVersion } = await import("../components/pluginVersion.js")

const table = () => getTable()
const store = () => getStore()

/** 编辑器可写的字段（顺序与原表的 B–H 列一致：序号与其它列一律不动） */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  /** 主播与完成情况都可能是一格多个值（"阿修Axiu,听雨"），校验时按逗号拆开逐项比对 */
  { key: "anchor", label: "选择主播", option: "anchor", multi: true },
  { key: "goal", label: "难度及目标", option: "goal" },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]

/* ------------------------- 白名单与完成情况锁 ------------------------- */

const sibling = name => path.join(path.dirname(xlsxPath), name)

const ADMINS_FILE = path.resolve(flag("--admins", process.env.ABYSS_EDITOR_ADMINS_FILE ?? sibling("abyss-editor-admins.json")))
const LOCKS_FILE = path.resolve(process.env.ABYSS_EDITOR_LOCKS_FILE ?? sibling("abyss-editor-locks.json"))

/** 环境变量里写死的白名单：管理接口删不掉，只能改环境变量 */
const ENV_ADMINS = String(process.env.ABYSS_EDITOR_ADMINS ?? "")
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

const saveAdmins = list => writeJson(ADMINS_FILE, { admins: [...new Set(list.map(s => String(s).trim()).filter(Boolean))] })

/** 完成情况锁：主播改过某行的完成情况后，本人不能再改 */
const lockKey = (sheet, row) => `${sheet}#${row}`
const loadLocks = () => readJson(LOCKS_FILE)?.rows ?? {}
const saveLocks = rows => writeJson(LOCKS_FILE, { rows })


const blank = v => !String(v ?? "").trim()

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
          const o = { row: r.row }
          for (const f of FIELDS) o[f.key] = r[f.key] ?? ""
          o.statusLocked = caller.role !== "admin" && Boolean(locks[lockKey(model.name, r.row)])
          return o
        })
      sheets.push({
        name: model.name,
        title: model.title,
        dataStart: model.dataStart,
        dataEnd: model.dataEnd,
        options: model.options ?? {},
        anchors: model.anchors.map(a => a.name).filter(Boolean),
        rows,
      })
    }
    return { sheets }
  })
  return {
    file: xlsxPath,
    online: ONLINE_URL,
    fields: FIELDS,
    sheets: data.sheets,
    savedAt: fs.existsSync(xlsxPath) ? fs.statSync(xlsxPath).mtime.toLocaleString("zh-CN") : "",
    perm: {
      role: caller.role,
      readonly: caller.role === "guest",
      nick: caller.identity?.nick ?? "",
      showAdmins: caller.adminTokenOk,
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
      await table().mutate(ctx => {
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

/** 业务校验：必填、同榜不重名、下拉值必须命中 */
const validateRows = (model, rows) => {
  const problems = []
  const seen = new Map()
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
      const opts = model.options?.[f.option] ?? []
      if (!opts.length) continue
      /** 完成情况允许多个值（"阿修Axiu,听雨"），逐个比对 */
      const parts = f.multi ? val.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [val]
      for (const part of parts)
        if (!opts.includes(part) && !matchOption(part, opts)) problems.push(`${who}：${f.label}「${part}」不在下拉选项里`)
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

  const normalized = rows.map(r => ({
    row: Number(r?.row) || 0,
    values: Object.fromEntries(FIELDS.map(f => [f.key, String(r?.values?.[f.key] ?? "").trim()])),
  }))

  const model = await table().read(({ models }) => models.get(sheet) ?? null)
  if (!model) throw new Error(`表格里没有工作表「${sheet}」`)

  const locks = loadLocks()
  const ignored = []
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

  const result = await table().mutate(ctx => {
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
  return { ...result, ignored }
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
  const identity = verifyIdentity(u.searchParams.get("u"), u.searchParams.get("s"), TOKEN)
  const adminTokenOk = Boolean(ADMIN_TOKEN) && u.searchParams.get("a") === ADMIN_TOKEN
  const list = loadAdmins()
  const inList = Boolean(identity) && (list.includes(identity.qq) || list.includes(identity.nick))
  const isAdmin = !TOKEN || adminTokenOk || inList
  return {
    identity,
    adminTokenOk,
    role: isAdmin ? "admin" : identity ? "self" : "guest",
  }
}

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
function go(ev){ev.preventDefault();const k=document.getElementById('k').value.trim();if(!k)return;location.href=location.pathname+'?k='+encodeURIComponent(k)}
</script></div></body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const pathname = innerPath(url.pathname)

  if (!authorized(req)) {
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(denialPage())
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("forbidden")
  }

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await fsp.readFile(TEMPLATE, "utf8")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      return res.end(html)
    }

    const caller = callerOf(req)
    if (req.method === "GET" && pathname === "/api/data") {
      /** 先按 QQ 认人（顺手同步改了名片的昵称、记下绑定），再按身份裁剪数据 */
      const sync = await syncIdentity(caller)
      const payload = await buildPayload(caller)
      return json(res, 200, { ...payload, sync })
    }

    if (req.method === "POST" && pathname === "/api/save") {
      const body = await readBody(req)
      return json(res, 200, { ok: true, ...(await applySave(caller, body)) })
    }

    /** 白名单维护：需要管理口令（?a=），普通口令与个人链接都不行 */
    if (pathname === "/api/admins") {
      if (!ADMIN_TOKEN) return json(res, 403, { ok: false, error: "服务端没有设置 ABYSS_EDITOR_ADMIN_TOKEN，无法维护白名单" })
      if (!caller.adminTokenOk) return json(res, 403, { ok: false, error: "需要管理口令" })
      const fromFile = readJson(ADMINS_FILE)?.admins ?? []
      if (req.method === "GET") return json(res, 200, { ok: true, admins: loadAdmins(), env: ENV_ADMINS, file: fromFile })
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
      return json(res, 200, { ok: true, admins: loadAdmins(), env: ENV_ADMINS, file: next })
    }

    /* 健康检查：部署时用来确认服务活着，也用来确认"跑的是哪一版"（升级后忘了重启会在这里看出来） */
    if (req.method === "GET" && pathname === "/healthz")
      return json(res, 200, {
        ok: true,
        version: pluginVersion,
        fields: FIELDS.map(f => f.key),
        file: xlsxPath,
        bind: BIND,
        port: PORT,
        auth: Boolean(TOKEN),
        admins: loadAdmins().length,
        admin_api: Boolean(ADMIN_TOKEN),
      })
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("not found")
  } catch (err) {
    json(res, 400, { ok: false, error: err?.message ?? String(err) })
  }
})

server.listen(PORT, BIND, () => {
  console.log(`排队表编辑器已启动：http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${PORT}`)
  console.log(`  版本：${pluginVersion}`)
  console.log(`  监听：${BIND}:${PORT}${BIND === "0.0.0.0" ? "（对外）" : "（仅本机）"}`)
  console.log(`  挂载前缀：${MOUNT || "（无，直接挂在根路径）"}`)
  console.log(`  表格：${xlsxPath}`)
  console.log(`  口令：${TOKEN ? "已设置" : "未设置（任何人都能改，仅本机测试）"}`)
  console.log(`  白名单：${loadAdmins().length} 人（${ADMINS_FILE}）`)
  console.log(`  管理接口：${ADMIN_TOKEN ? "已启用（?a=<管理口令>）" : "未启用（设 ABYSS_EDITOR_ADMIN_TOKEN 后可用）"}`)
  console.log(`  填写字段：${FIELDS.map(f => f.label).join(" / ")}`)
  console.log("  按 Ctrl+C 退出")
})
