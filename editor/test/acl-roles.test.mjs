/**
 * 权限只按稳定 QQ 判断（AQ-01）
 *
 * 群昵称是**本人随时能改的展示名**。以前 `callerOf` 拿 `identity.nick` 一起去比白名单，
 * 于是：
 *   - 主人列表里写的是 QQ 数字时，任何成员把群名片改成同一串数字就成了主人；
 *   - 与主人/管理员同名的成员也一样。
 * 验签只证明"这是你自己的 QQ 与当前名片"，不能证明"名片对应那份权力"。
 *
 * 这个套件不碰真实表格（用仓库里的空模板），所以不会因为缺数据而跳过。
 * 覆盖：昵称=主人QQ / 昵称=管理员QQ / 与主人同昵称但 QQ 不同 / 真主人真管理员 /
 *       历史昵称条目的安全迁移（拒绝当权限 + 明确提示 + 只收 QQ 的维护接口）。
 */
import fs from "node:fs"
import path from "node:path"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("权限只按 QQ")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过权限角色套件`)
  process.exit(0)
}

const ws = makeWorkspace("acl-roles")
const TOKEN = "acl-roles-token"
const SIGN_KEY = "acl-roles-sign-key"
/** 主人 / 管理员都只写在白名单里，且**只有 QQ 有效**；后面那些昵称条目属于历史遗留 */
const OWNER_QQ = "424242"
const ADMIN_QQ = "777777"
const OWNER_NICK = "主人的群名片"
const LEGACY_ADMIN_NICK = "老管理昵称"
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER_QQ, OWNER_NICK], admins: [ADMIN_QQ, LEGACY_ADMIN_NICK] }), "utf8")

let editor = null
try {
  editor = await startEditor({
    label: "权限只按 QQ",
    ports: [7812, 7816, 7817],
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile,
    args: ["--file", ws.fixture],
    env: {
      ABYSS_QUEUE_CONFIG: ws.cfg,
      ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
      /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
  })

  const asWho = who => editor.request("/api/data", { who })
  const rosterOfSheet = "幽境危战"
  /** 随便挑一行空行号：模板里没有成员，这个行号一定不属于任何人 */
  const futureRow = 12

  await check("昵称等于主人 QQ 的成员：仍然是普通成员（不是主人、不是管理员）", async () => {
    const r = await asWho({ qq: "300001", nick: OWNER_QQ })
    if (r.json.perm.role !== "self") throw new Error(`role=${r.json.perm.role}`)
    if (r.json.perm.owner) throw new Error("被当成了主人")
    if (r.json.perm.showAdmins) throw new Error("拿到了「权限管理」入口")
    const sheet = r.json.sheets.find(s => s.name === rosterOfSheet)
    if (sheet?.anchorRows) throw new Error("普通成员不该拿到主播列表（那是管理员能力）")
  })

  await check("昵称等于主人 QQ 的成员：读不到白名单、也改不动白名单", async () => {
    const read = await editor.request("/api/admins", { who: { qq: "300001", nick: OWNER_QQ } })
    if (read.status !== 403) throw new Error(`读白名单 HTTP ${read.status}`)
    const write = await editor.request("/api/admins", { who: { qq: "300001", nick: OWNER_QQ }, body: { add: ["300001"] } })
    if (write.status !== 403) throw new Error(`改白名单 HTTP ${write.status} ${JSON.stringify(write.json)}`)
  })

  await check("昵称等于主人 QQ 的成员：不能改别人的行（管理员才行）", async () => {
    const r = await editor.request("/api/save", {
      who: { qq: "300001", nick: OWNER_QQ },
      body: { sheet: rosterOfSheet, rows: [{ row: futureRow, values: { nickname: "别人的名字", gameName: "x", anchor: "a", goal: "g" } }] },
    })
    if (r.json.ok) throw new Error("竟然写成功了")
    if (!String(r.json.error).includes("只能改自己那一行")) throw new Error(r.json.error)
  })

  await check("昵称等于管理员 QQ 的成员：也只是普通成员", async () => {
    const r = await asWho({ qq: "300002", nick: ADMIN_QQ })
    if (r.json.perm.role !== "self") throw new Error(`role=${r.json.perm.role}`)
    if (r.json.perm.showAdmins) throw new Error("拿到了「权限管理」入口")
  })

  await check("与主人同昵称但 QQ 不同：不是主人", async () => {
    const r = await asWho({ qq: "300003", nick: OWNER_NICK })
    if (r.json.perm.role !== "self") throw new Error(`role=${r.json.perm.role}`)
    if (r.json.perm.owner) throw new Error("同名就被当成主人了")
  })

  await check("真主人（按 QQ）：仍是主人，且能看到「权限管理」", async () => {
    const r = await asWho({ qq: OWNER_QQ, nick: "随便改个名片" })
    if (r.json.perm.role !== "admin") throw new Error(`role=${r.json.perm.role}`)
    if (r.json.perm.owner !== true) throw new Error("没有标记 owner")
    if (!r.json.perm.showAdmins) throw new Error("没给权限管理入口")
  })

  await check("真管理员（按 QQ）：是管理员但不是主人，与名片怎么写无关", async () => {
    const r = await asWho({ qq: ADMIN_QQ, nick: "我也改了名片" })
    if (r.json.perm.role !== "admin") throw new Error(`role=${r.json.perm.role}`)
    if (r.json.perm.owner) throw new Error("普通管理员不该是主人")
    if (r.json.perm.showAdmins) throw new Error("普通管理员不该有权限管理入口")
  })

  await check("历史昵称条目：拒绝作为权限，并在页面上明确告知主人（含建议的 QQ）", async () => {
    const r = await asWho({ qq: OWNER_QQ, nick: "主人" })
    const acl = r.json.perm.acl
    if (!acl) throw new Error("主人拿不到白名单体检信息")
    if (!acl.ignored.includes(OWNER_NICK) || !acl.ignored.includes(LEGACY_ADMIN_NICK))
      throw new Error(`没有报出被拒绝的昵称条目：${JSON.stringify(acl.ignored)}`)
    if (!acl.admins.includes(ADMIN_QQ) || !acl.owners.includes(OWNER_QQ))
      throw new Error(`能当权限的 QQ 应当照常生效：${JSON.stringify(acl)}`)
  })

  await check("healthz 如实报出「解析不出 QQ 的条目」条数", async () => {
    const h = await editor.request("/healthz")
    if (h.json.admins !== 1 || h.json.owners !== 1) throw new Error(`admins=${h.json.admins} owners=${h.json.owners}`)
    if (h.json.acl_invalid !== 2) throw new Error(`acl_invalid=${h.json.acl_invalid}`)
  })

  await check("启动日志里说清「历史昵称条目已拒绝作为权限」", async () => {
    const log = editor.log()
    if (!log.includes("拒绝作为权限")) throw new Error(`启动日志没有提示：\n${log.slice(-600)}`)
    if (!log.includes(OWNER_NICK)) throw new Error("没有点名是哪条条目")
  })

  await check("维护白名单：只收 QQ，收昵称会被明确拒绝", async () => {
    const bad = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { add: ["某个群昵称"] } })
    if (bad.json.ok) throw new Error("竟然把昵称加进了白名单")
    if (!String(bad.json.error).includes("QQ")) throw new Error(bad.json.error)
    if (!bad.json.ignored?.includes(LEGACY_ADMIN_NICK)) throw new Error("没有回报仍被拒绝的历史条目")
  })

  await check("维护白名单：加 QQ 立即生效；移除后立即失效", async () => {
    const added = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { add: ["123456"] } })
    if (!added.json.ok) throw new Error(added.json.error || "添加失败")
    const promoted = await asWho({ qq: "123456", nick: "新管理员" })
    if (promoted.json.perm.role !== "admin") throw new Error(`新加的 QQ role=${promoted.json.perm.role}`)
    const removed = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { remove: ["123456"] } })
    if (!removed.json.ok) throw new Error(removed.json.error || "移除失败")
    const demoted = await asWho({ qq: "123456", nick: "新管理员" })
    if (demoted.json.perm.role !== "self") throw new Error(`移除后 role=${demoted.json.perm.role}`)
  })

  await check("安全迁移：主人能把历史昵称条目从白名单里删掉（删的是原始条目）", async () => {
    const removed = await editor.request("/api/admins", { who: { qq: OWNER_QQ, nick: "主人" }, body: { remove: [LEGACY_ADMIN_NICK] } })
    if (!removed.json.ok) throw new Error(removed.json.error || "移除失败")
    const raw = JSON.parse(fs.readFileSync(adminsFile, "utf8"))
    if (raw.admins.includes(LEGACY_ADMIN_NICK)) throw new Error(`文件里还留着：${JSON.stringify(raw)}`)
    if (!raw.admins.includes(ADMIN_QQ)) throw new Error("把能用的 QQ 一起删掉了")
    const h = await editor.request("/healthz")
    if (h.json.acl_invalid !== 1) throw new Error(`删掉一条后 acl_invalid 应为 1，实际 ${h.json.acl_invalid}`)
  })
} catch (err) {
  await check("套件执行", async () => {
    throw err
  })
} finally {
  if (editor) await editor.stop()
  ws.cleanup()
}

await finish()
process.exit(process.exitCode || 0)
