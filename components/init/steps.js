/**
 * 第 1、2、5、7 步：数据目录 / 本地表格副本 / 编辑器白名单 / 编辑器探活
 *
 * 这四步的动作用不了几十行，合成一个文件；各自**导出独立函数**，编排与回归都能单独拿到它们
 * （`init/index.js` 会用 `缺少第 N 步的实现` 显式校验，别改成"少一个也不报错"的写法）。
 */
import path from "node:path"
import { FAIL, OK, PROBE_TIMEOUT_MS, SKIP, oneLine, rel } from "./common.js"

/** 1) 数据目录（固定在插件里：`<插件根>/data`） */
export function stepDataDir(ctx) {
  if (ctx.fs.existsSync(ctx.paths.dataDir)) return SKIP(`已存在：${rel(ctx, ctx.paths.dataDir)}`)
  ctx.fs.mkdirSync(ctx.paths.dataDir, { recursive: true })
  return OK(`已创建：${rel(ctx, ctx.paths.dataDir)}`)
}

/** 2) 本地表格副本：**存在就绝不覆盖**（本机那份可能已经有数据） */
export function stepLocalXlsx(ctx) {
  const { localXlsx, templateXlsx } = ctx.paths
  if (ctx.fs.existsSync(localXlsx)) return SKIP(`已存在（不覆盖）：${rel(ctx, localXlsx)}`)
  if (!ctx.fs.existsSync(templateXlsx))
    return FAIL(`找不到空模板：${rel(ctx, templateXlsx)}（插件里的 resources/空模板.xlsx 是不是没同步过去？）`)
  ctx.fs.copyFileSync(templateXlsx, localXlsx)
  return OK(`已从空模板复制：${rel(ctx, localXlsx)}`)
}

/** 5) 白名单：没有 owner 才写（发送者 QQ 当 owner + admins） */
export function stepWhitelist(ctx) {
  const { adminsFile } = ctx.paths
  const qq = String(ctx.qq ?? "").trim()
  if (!qq) return FAIL("拿不到发送者的 QQ，无法写白名单")

  if (ctx.fs.existsSync(adminsFile)) {
    const raw = ctx.fs.readFileSync(adminsFile, "utf8")
    let cur = null
    try {
      cur = JSON.parse(raw.replace(/^\uFEFF/, ""))
    } catch (err) {
      /** 不是合法 JSON 时**不敢覆盖**：可能是主人手改坏了，覆盖掉就再也找不回来 */
      return FAIL(`${rel(ctx, adminsFile)} 不是合法 JSON，插件不敢覆盖（${oneLine(err?.message)}）：请主人先修好或删掉它`)
    }
    const owners = (Array.isArray(cur?.owner) ? cur.owner : []).map(s => String(s).trim()).filter(Boolean)
    if (owners.length)
      return SKIP(
        `已有 owner：${owners.join("、")}，未改动（增删管理员请手工编辑 ${path.basename(adminsFile)}，或走编辑器的 /api/admins）`,
      )
    /** 有 admins 没 owner：补 owner，并把发送者并进 admins（**不丢**已有的管理员） */
    const admins = [...new Set([...(Array.isArray(cur?.admins) ? cur.admins : []), qq])]
    ctx.fs.writeFileSync(adminsFile, JSON.stringify({ ...cur, owner: [qq], admins }, null, 2) + "\n", "utf8")
    return OK(`没有 owner，已补上：owner = ${qq}（admins 保留原有条目并加入发送者）`)
  }

  ctx.fs.writeFileSync(adminsFile, JSON.stringify({ owner: [qq], admins: [qq] }, null, 2) + "\n", "utf8")
  return OK(`已写入：owner / admins = ${qq}`)
}

/** 7) 探活：没跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定） */
export async function stepHealth(ctx) {
  const { token } = ctx.secrets
  const url = `http://127.0.0.1:${ctx.port}/healthz?k=${encodeURIComponent(token)}`
  let res
  try {
    res = await ctx.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    return SKIP(
      `编辑器没在跑（${oneLine(err?.message) || "连不上"}）：下一步要么重启机器人（remote.autostart 会把它拉起来），要么双击 data/${path.basename(ctx.paths.startVbs)}`,
    )
  }
  if (!res?.ok) return SKIP(`编辑器有应答但 /healthz 返回 HTTP ${res?.status}：先看一眼它的日志 data/editor.log`)
  let h = {}
  try {
    h = await res.json()
  } catch (err) {
    return SKIP(`/healthz 的响应不是 JSON（${oneLine(err?.message)}）：可能端口上是别的东西`)
  }
  return OK(`编辑器在跑：版本 ${h.version ?? "?"} · mount ${h.mount || "（根目录）"} · 群名单 ${h.roster ?? "?"} 人`)
}
