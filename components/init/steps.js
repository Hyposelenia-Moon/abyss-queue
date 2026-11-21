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
import { getEditorService } from "../../editor/service.js"
import { FAIL, OK, SKIP, oneLine, rel } from "./common.js"

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

/**
 * 3) 探活：没跑也只报告（不重启机器人、不 kill 进程——那些是主人的决定）
 *
 * 编辑器与插件同进程，所以这里**不需要发请求**：直接问进程内注册表有没有编辑器。
 * 独立进程（`7788` 调试模式）注册不进来，这时报"没在进程内挂载"，比去探一个
 * 自己猜的端口更准确——端口不对时探到的可能是路由器、别的服务，甚至站点首页。
 */
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
