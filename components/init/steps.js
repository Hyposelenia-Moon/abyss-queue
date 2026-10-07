/**
 * 第 2、3 步：编辑器白名单 / 编辑器探活
 *
 * 这两步的动作用不了几十行，合成一个文件；各自**导出独立函数**，编排与回归都能单独拿到它们
 * （`init/index.js` 会用 `缺少第 N 步的实现` 显式校验，别改成"少一个也不报错"的写法）。
 *
 * 数据目录**不在初始化里专门建**：第一个往那儿写东西的步骤顺手 `mkdirSync`（白名单就是这一步），
 * 编辑器自己写表时也会建——"反正会有人建"的东西不单列一步。
 */
import path from "node:path"
import { EDITOR_MOUNT } from "../constants.js"
import { FAIL, OK, PROBE_TIMEOUT_MS, SKIP, oneLine, rel } from "./common.js"

/** 2) 白名单：没有 owner 才写（发送者 QQ 当 owner + admins） */
export function stepWhitelist(ctx) {
  const { adminsFile, dataDir } = ctx.paths
  const qq = String(ctx.qq ?? "").trim()
  if (!qq) return FAIL("拿不到发送者的 QQ，无法写白名单")

  /** 数据目录按需建（只在缺的时候建：重复跑才能保持"零落盘"） */
  if (!ctx.fs.existsSync(dataDir)) ctx.fs.mkdirSync(dataDir, { recursive: true })

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

/** 3) 探活：没跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定） */
export async function stepHealth(ctx) {
  const { token } = ctx.secrets
  /**
   * 端口未知就别探：编辑器挂在 **bot 自己的 server** 上，端口只能来自框架配置；
   * 猜一个（例如编辑器独立调试用的 7788）只会探到别的东西或探空，报告反而误导。
   */
  if (!Number.isFinite(ctx.port) || ctx.port <= 0)
    return SKIP("拿不到机器人端口（框架 cfg.server.port 读不到）：探活跳过——编辑器随机器人起在 bot 端口上，端口未知时没法确认它在不在跑")
  /**
   * 编辑器挂在 bot 自己的 server 上，路径带挂载前缀（`/queue/healthz`）；
   * 独立调试模式下它自己 listen，同一路径同样成立——所以这里只有一种拼法。
   */
  const url = `http://127.0.0.1:${ctx.port}${EDITOR_MOUNT}/healthz?k=${encodeURIComponent(token)}`
  let res
  try {
    res = await ctx.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    return SKIP(`编辑器没在跑（${oneLine(err?.message) || "连不上"}）：重启一次机器人，它会带着编辑器一起起来`)
  }
  if (!res?.ok) return SKIP(`编辑器有应答但 /healthz 返回 HTTP ${res?.status}：看一眼机器人的日志（编辑器与机器人同进程、同一个日志出口）`)
  let h = {}
  try {
    h = await res.json()
  } catch (err) {
    return SKIP(`/healthz 的响应不是 JSON（${oneLine(err?.message)}）：可能端口上是别的东西`)
  }
  return OK(`编辑器在跑：版本 ${h.version ?? "?"} · mount ${h.mount || "（根目录）"} · 群名单 ${h.roster ?? "?"} 人`)
}
