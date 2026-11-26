/** 第 2、3 步：编辑器白名单 / 编辑器探活 */
import path from "node:path"
import { getEditorService } from "../../editor/service.js"
import { FAIL, OK, SKIP, oneLine, rel } from "./common.js"

export function stepWhitelist(ctx) {
  const { adminsFile, dataDir } = ctx.paths
  const qq = String(ctx.qq ?? "").trim()
  if (!qq) return FAIL("拿不到发送者的 QQ，无法写白名单")
  if (!ctx.fs.existsSync(dataDir)) ctx.fs.mkdirSync(dataDir, { recursive: true })
  if (ctx.fs.existsSync(adminsFile)) {
    const raw = ctx.fs.readFileSync(adminsFile, "utf8")
    let cur = null
    try {
      cur = JSON.parse(raw.replace(/^\uFEFF/, ""))
    } catch (err) {
      return FAIL(`${rel(ctx, adminsFile)} 不是合法 JSON，插件不敢覆盖（${oneLine(err?.message)}）：请主人先修好或删掉它`)
    }
    const owners = (Array.isArray(cur?.owner) ? cur.owner : []).map(s => String(s).trim()).filter(Boolean)
    if (owners.length)
      return SKIP(
        `已有 owner：${owners.join("、")}，未改动（增删管理员请手工编辑 ${path.basename(adminsFile)}，或走编辑器的 /api/admins）`,
      )
    const admins = [...new Set([...(Array.isArray(cur?.admins) ? cur.admins : []), qq])]
    ctx.fs.writeFileSync(adminsFile, JSON.stringify({ ...cur, owner: [qq], admins }, null, 2) + "\n", "utf8")
    return OK(`没有 owner，已补上：owner = ${qq}（admins 保留原有条目并加入发送者）`)
  }
  ctx.fs.writeFileSync(adminsFile, JSON.stringify({ owner: [qq], admins: [qq] }, null, 2) + "\n", "utf8")
  return OK(`已写入：owner / admins = ${qq}`)
}

export async function stepHealth(ctx) {
  const service = getEditorService()
  if (typeof service?.health !== "function")
    return SKIP("编辑器没有在进程内挂载：重启一次机器人，它会带着编辑器一起起来（独立跑的编辑器不参与本进程）")
  let h
  try {
    h = await service.health()
  } catch (err) {
    return SKIP(`编辑器在进程内，但探活失败（${oneLine(err?.message) || "未知原因"}）：看一眼机器人的日志（编辑器与机器人同一个日志出口）`)
  }
  return OK(`编辑器在跑：版本 ${h?.version || "?"} · mount ${h?.mount || "（根目录）"} · 群名单 ${h?.roster ?? "?"} 人`)
}
