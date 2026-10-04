/**
 * 第 5 步：白名单 —— 没有 owner 才写（发送者 QQ 当 owner + admins）
 *
 * 权限只认 QQ（AGENTS.md 九-1）：写昵称等于写一个可以随时改掉的"身份"。
 */
import path from "node:path"
import { FAIL, OK, SKIP, oneLine, rel } from "./shared.js"

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
