/**
 * 第 4、5 步：编辑器白名单 / 编辑器探活
 *
 * 这两步的动作用不了几十行，合成一个文件；各自**导出独立函数**，编排与回归都能单独拿到它们
 * （`init/index.js` 会用 `缺少第 N 步的实现` 显式校验，别改成"少一个也不报错"的写法）。
 *
 * 数据目录与本地表格副本**不在初始化里做**：前者由编辑器写文件时 / 启动器复制表格时按需建，
 * 后者由启动器在"本机还没有表"时用 `resources/空模板.xlsx` 起一份。两者都是"反正会有人建"的东西。
 */
import path from "node:path"
import { FAIL, OK, PROBE_TIMEOUT_MS, SKIP, oneLine, rel } from "./common.js"

/** 4) 白名单：没有 owner 才写（发送者 QQ 当 owner + admins） */
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

/** 5) 探活：没跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定） */
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
