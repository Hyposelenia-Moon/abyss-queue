/**
 * 归属状态：审计 + 按当前表重建（方案 B 的编辑器侧一半）
 *
 * 用户已定方案 B：**不给表加"稳定成员 ID"列**。稳定身份只存在编辑器侧（绑定文件里的 QQ + 表指纹），
 * 代价是"这条绑定现在还对不对得上表"必须能被主人看见、能主动重建，所以这一套要有回归：
 *   - `GET /api/ownership` 如实回报每榜的 QQ → 行：记的昵称、表里该行现在的昵称、是否 stale、是否与别人冲突，
 *     外加表指纹 / 绑定记的版本 / 锁的摘要；
 *   - `POST /api/ownership { action: "rebuild" }` 按当前表重建：能确认的保留（行号纠正过来）、
 *     对不上账的作废，并如实回报"保留几条 / 纠正几条 / 作废几条（其中重名无法确认几条）"；
 *   - **权限只认主人**：白名单管理员与本人链接一律 403（与 /api/admins 同口径）；
 *   - 最后一组在页面 VM 里钉「权限管理」面板：owners / admins / ignored 三样都要列出来
 *     （主人写在 owner 名单里也得看得见；解析不出 QQ 的条目要标明"不是权限"）。
 *
 * 脏绑定是**直接写绑定文件**造出来的（正常写入流程造不出这种状态）：
 *   指向空行、指向别人已占的行、记的昵称与表里不一致、重名看不出是哪一位、两个 QQ 争同一行。
 * 绑定文件在编辑器启动时读进内存，所以必须**先写好再起进程**。
 *
 * 用法：node editor/test/ownership.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import { createHash } from "node:crypto"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"
import { bootPage, makeData } from "./page-vm.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { Table } = await shared("model/table.js")
const { importWorkbook } = await shared("model/doc-import.js")
const { writeDoc, docFileOf } = await shared("model/queue-doc.js")
const { check, finish } = createChecker("归属审计与重建")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 套件跳过：缺少空模板（${TEMPLATE}）`)
  process.exit(0)
}

const SHEET = "幽境危战"
const OWNER = { qq: "424242", nick: "主人" }
/** 白名单里的管理员：能改所有人的行，但**不该**看到/重建归属 */
const ADMIN = { qq: "30099", nick: "管理员" }
/** 普通成员（本人链接）：只该看到自己那一行 */
const MEMBER = { qq: "20001", nick: "路人" }
const TOKEN = "ownership-token"
const SIGN_KEY = "ownership-sign-key"
const ADMIN_TOKEN = "ownership-admin-token"

const ws = makeWorkspace("ownership")
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [ADMIN.qq] }), "utf8")

/** 表里造出五个人：甲 / 乙 / 丙 / 丙（重名）/ 丁，后面再留两个空行 */
const table = new Table({ file: ws.fixture, backup: false })
let R0 = 0
await table.read(({ models }) => {
  R0 = models.get(SHEET)?.dataStart ?? 0
})
await table.mutate(ctx => {
  const put = (offset, nick, game) => {
    ctx.setCell(SHEET, R0 + offset, "nickname", nick)
    ctx.setCell(SHEET, R0 + offset, "gameName", game)
  }
  put(0, "甲", "游戏甲")
  put(1, "乙", "游戏乙")
  put(2, "丙", "游戏丙")
  put(3, "丙", "游戏丙二号")
  put(4, "丁", "游戏丁")
})
/**
 * 表版本（信任锚）＝状态文档 `queue.json` 的 sha256。
 *
 * 存储换成 JSON 之后，xlsx 只是导出镜像：绑定/锁记的是状态文档那一版，
 * 所以这里先把文档自举出来（等价于编辑器启动时做的第一件事），再取它的哈希。
 */
const statePath = docFileOf(ws.fixture)
const stateVersion = () => createHash("sha256").update(fs.readFileSync(statePath)).digest("hex")
await writeDoc(statePath, await importWorkbook(fs.readFileSync(ws.fixture)), { backup: false })
const FP = stateVersion()
if (!R0 || !FP) throw new Error("准备失败：表格结构没读出来")

/** 一份"脏"的绑定文件：每一种坏法各来一条 */
fs.writeFileSync(
  ws.bindingsFile,
  JSON.stringify(
    {
      version: 1,
      table: FP,
      binds: {
        [SHEET]: {
          "30003": { row: R0 + 1, nickname: "乙", at: 1 }, // 对得上 → 保留
          "30004": { row: R0 + 6, nickname: "甲", at: 1 }, // 指向空行，但"甲"唯一 → 纠正到 R0（改了几条数它）
          "30005": { row: R0 + 6, nickname: "丙", at: 1 }, // 表里两个"丙" → 无法确认
          "30001": { row: R0 + 0, nickname: "别人", at: 1 }, // 指向别人已占的行、记的昵称也对不上 → 作废
          "30002": { row: R0 + 5, nickname: "路人", at: 1 }, // 指向空行且表里没这个人 → 作废
          "30006": { row: R0 + 4, nickname: "丁", at: 1 }, // 与下面那条争同一行 → 两条都无法确认
          "30007": { row: R0 + 4, nickname: "丁", at: 1 },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
)
/** 锁也塞两条：一条归属对得上，一条指向空行（换表/删行之后的残渣） */
fs.writeFileSync(
  ws.locksFile,
  JSON.stringify({ table: FP, rows: { [`${SHEET}#${R0 + 1}`]: { by: "主播", at: 1, nickname: "乙" }, [`${SHEET}#${R0 + 5}`]: { by: "主播", at: 1, nickname: "路人" } } }, null, 2),
  "utf8",
)

console.log(`归属审计与重建（HTTP · ${SHEET} 从第 ${R0} 行起）`)

let editor = null
try {
  editor = await startEditor({
    label: "归属审计",
    token: TOKEN,
    signKey: SIGN_KEY,
    adminToken: ADMIN_TOKEN,
    adminsFile,
    args: ["--file", ws.fixture],
    env: {
      ABYSS_QUEUE_CONFIG: ws.cfg,
      ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
      /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
  })

  /* ------------------------- ① 审计返回真实状态 ------------------------- */

  let audit = null
  await check("GET /api/ownership：主人拿得到，回报表指纹 / 绑定版本 / 锁摘要", async () => {
    const res = await editor.request("/api/ownership", { who: OWNER })
    if (res.status !== 200 || !res.json.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.json)}`)
    audit = res.json
    if (audit.version !== FP) throw new Error(`当前表指纹不是刚写的那一版：${audit.version} vs ${FP}`)
    /** 版本**对得上**，但归属照样可以是脏的——这正是审计要盯的事 */
    if (audit.bindings.table !== FP || audit.bindings.stale) throw new Error(`绑定版本不该是 stale：${JSON.stringify(audit.bindings)}`)
    if (audit.bindings.count !== 7) throw new Error(`绑定条数是 ${audit.bindings.count}，应当是 7`)
    if (audit.locks.count !== 2) throw new Error(`锁条数是 ${audit.locks.count}，应当是 2`)
  })

  await check("GET /api/ownership：每榜列出 QQ → 行、记的昵称、表里该行现在的昵称", async () => {
    const sheet = audit.sheets.find(s => s.name === SHEET)
    if (!sheet) throw new Error(`没列出「${SHEET}」：${JSON.stringify(audit.sheets.map(s => s.name))}`)
    if (sheet.entries.length !== 7) throw new Error(`这一榜应当有 7 条绑定，实际 ${sheet.entries.length}`)
    const e = sheet.entries.find(x => x.qq === "30001")
    if (!e) throw new Error("少了 QQ 30001 那条")
    if (e.row !== R0) throw new Error(`QQ 30001 的行号是 ${e.row}，应当是 ${R0}`)
    if (e.nickname !== "别人") throw new Error(`记的昵称是 ${JSON.stringify(e.nickname)}，应当是「别人」`)
    if (e.current !== "甲") throw new Error(`表里该行现在的昵称是 ${JSON.stringify(e.current)}，应当是「甲」`)
    /**
     * **`seq` 是给人看的那个编号**（表里第一列「序号」，A 列 `=ROW()-k` 的缓存值）：
     * 三个榜表头行号不同，"同一个位置的行号"各不相同，页面上显示 `row` 会让人对着表对不上号。
     * R0 是数据区第一行 ⇒ 它的序号就是 1（行号 `R0` 与序号 1 差着一个表头偏移，正是这条断言的意义）。
     */
    if (e.seq !== 1) throw new Error(`SEQ 应当是 1（数据区第一行），实际 ${JSON.stringify(e.seq)}（row=${e.row}）`)
  })

  await check("GET /api/ownership：对不上账的标 stale（行没了 / 那一行换了人）", async () => {
    const entries = audit.sheets.find(s => s.name === SHEET).entries
    const stale = qq => entries.find(x => x.qq === qq)?.stale
    if (stale("30001") !== true) throw new Error("指向别人已占的行、昵称也对不上，却没标 stale")
    if (stale("30002") !== true) throw new Error("指向空行（那一行都没了），却没标 stale")
    if (stale("30004") !== true) throw new Error("指向空行，却没标 stale")
    if (stale("30005") !== true) throw new Error("指向空行且重名，却没标 stale")
    if (stale("30003") !== false) throw new Error("明明对得上却被标成 stale")
    const gone = entries.find(x => x.qq === "30002")
    if (gone.rowExists !== false) throw new Error(`指向空行时 rowExists 应当是 false：${JSON.stringify(gone)}`)
  })

  await check("GET /api/ownership：两个 QQ 争同一行时报冲突（而不是随便认一个）", async () => {
    const entries = audit.sheets.find(s => s.name === SHEET).entries
    for (const qq of ["30006", "30007"]) {
      const e = entries.find(x => x.qq === qq)
      if (!e?.conflict) throw new Error(`QQ ${qq} 与别人争第 ${R0 + 4} 行，却没标冲突：${JSON.stringify(e)}`)
      const other = qq === "30006" ? "30007" : "30006"
      if (!e.conflictWith.includes(other)) throw new Error(`冲突对象里没有 ${other}：${JSON.stringify(e.conflictWith)}`)
    }
    const single = entries.find(x => x.qq === "30003")
    if (single.conflict) throw new Error("独占了第 R0+1 行的那条不该被判成冲突")
  })

  await check("GET /api/ownership：锁的摘要也带上（哪一把已经对不上账）", async () => {
    const bad = audit.locks.rows.find(r => r.sheet === SHEET && r.row === R0 + 5)
    if (!bad) throw new Error(`没列出指向空行的那把锁：${JSON.stringify(audit.locks.rows)}`)
    if (bad.stale !== true) throw new Error("指向空行的锁应当标 stale")
    const good = audit.locks.rows.find(r => r.row === R0 + 1)
    if (!good || good.stale) throw new Error(`归属对得上的锁不该标 stale：${JSON.stringify(good)}`)
    if (good.nickname !== "乙" || good.by !== "主播") throw new Error(`锁上的人/来源没回报：${JSON.stringify(good)}`)
    /** 锁和绑定一样带上**序号**（给人看的那个数）：数据区第二行 ⇒ 序号 2 */
    if (good.seq !== 2) throw new Error(`锁的 seq 应当是 2，实际 ${JSON.stringify(good.seq)}`)
    if (!(bad.seq > 0)) throw new Error(`指向空行的锁也该给一个序号（按数据区第几行算）：${JSON.stringify(bad)}`)
  })

  /* ------------------------- ② 按当前表重建 ------------------------- */

  await check("POST /api/ownership rebuild：如实回报保留 / 纠正 / 作废（重名无法确认单列）", async () => {
    const res = await editor.request("/api/ownership", { who: OWNER, body: { action: "rebuild" } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.json)}`)
    const out = res.json
    if (out.kept !== 2) throw new Error(`保留 ${out.kept} 条，应当是 2（乙 + 纠正过来的甲）`)
    if (out.moved !== 1) throw new Error(`纠正行号 ${out.moved} 条，应当是 1`)
    if (out.dropped !== 5) throw new Error(`作废 ${out.dropped} 条，应当是 5`)
    if (out.unconfirmed !== 3) throw new Error(`无法确认 ${out.unconfirmed} 条，应当是 3（1 条重名 + 2 条争同一行）`)
    if (out.missing !== 2) throw new Error(`"人已不在" ${out.missing} 条，应当是 2`)
    if (out.locks?.kept !== 1 || out.locks?.dropped !== 1) throw new Error(`锁的处置不对：${JSON.stringify(out.locks)}`)
  })

  await check("重建之后：绑定文件里只剩能确认的那两条，脏绑定全清", async () => {
    const file = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8"))
    const list = file.binds?.[SHEET] ?? {}
    const qqs = Object.keys(list).sort()
    if (JSON.stringify(qqs) !== JSON.stringify(["30003", "30004"])) throw new Error(`留下来的绑定不对：${JSON.stringify(list)}`)
    if (Number(list["30004"].row) !== R0) throw new Error(`QQ 30004 的行号没纠正过来：${JSON.stringify(list["30004"])}`)
    if (file.table !== stateVersion()) throw new Error(`绑定文件没盖上当前表版本：${file.table}`)
  })

  await check("重建之后：审计里 stale 与冲突都归零（脏绑定真的被修好）", async () => {
    const res = await editor.request("/api/ownership", { who: OWNER })
    const now = res.json
    const entries = now.sheets.find(s => s.name === SHEET)?.entries ?? []
    if (entries.length !== 2) throw new Error(`重建后这一榜应当只剩 2 条，实际 ${entries.length}：${JSON.stringify(entries)}`)
    const dirty = entries.filter(e => e.stale || e.conflict)
    if (dirty.length) throw new Error(`重建后还有脏绑定：${JSON.stringify(dirty)}`)
    if (now.locks.count !== 1) throw new Error(`那把指向空行的锁该被丢掉，实际还剩 ${now.locks.count} 条`)
    if (now.bindings.stale || now.locks.stale) throw new Error(`重建后版本应当对上：${JSON.stringify({ b: now.bindings, l: now.locks })}`)
  })

  /* ------------------------- ③ 权限只认主人 ------------------------- */

  await check("白名单管理员：查看被拒（403），重建也被拒", async () => {
    const read = await editor.request("/api/ownership", { who: ADMIN })
    if (read.status !== 403) throw new Error(`白名单管理员竟然能看到归属状态：HTTP ${read.status} ${JSON.stringify(read.json)}`)
    const rebuild = await editor.request("/api/ownership", { who: ADMIN, body: { action: "rebuild" } })
    if (rebuild.status !== 403) throw new Error(`白名单管理员竟然能重建归属：HTTP ${rebuild.status}`)
    if (!/主人/.test(String(read.json.error))) throw new Error(`403 没说清为什么：${JSON.stringify(read.json)}`)
  })

  await check("本人链接与访客（只有口令）：一律 403", async () => {
    for (const opts of [{ who: MEMBER }, {}]) {
      const res = await editor.request("/api/ownership", opts)
      if (res.status !== 403) throw new Error(`${opts.who ? "本人链接" : "访客"}竟然能看归属状态：HTTP ${res.status} ${JSON.stringify(res.json)}`)
      const post = await editor.request("/api/ownership", { ...opts, body: { action: "rebuild" } })
      if (post.status !== 403) throw new Error(`${opts.who ? "本人链接" : "访客"}竟然能重建归属：HTTP ${post.status}`)
    }
  })

  await check("管理口令（主人的备用入口）照旧放行——与 /api/admins 同一口径", async () => {
    const res = await editor.request("/api/ownership", { params: { a: ADMIN_TOKEN } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`管理口令被拒了：HTTP ${res.status} ${JSON.stringify(res.json)}`)
  })

  await check("POST 只认显式动作：不写 action 一律 400（手滑不会重建）", async () => {
    const res = await editor.request("/api/ownership", { who: OWNER, body: {} })
    if (res.status !== 400) throw new Error(`期望 400，实际 HTTP ${res.status} ${JSON.stringify(res.json)}`)
    const before = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8"))
    if (Object.keys(before.binds?.[SHEET] ?? {}).length !== 2) throw new Error("400 的那次竟然动了绑定")
  })
} catch (err) {
  await check("套件执行", async () => {
    throw err
  })
} finally {
  if (editor) await editor.stop()
  ws.cleanup()
}

/* ------------- ④ 前端入口：查看 + 一键重建 + 二次确认（VM） -------------
 *
 * 九页重写后的口径：归属状态从"浮层面板"变成侧栏独立页（`.ni[data-nav="ownership"]`），
 * 列表直接写在 `#oList` 里，重建 / 删除无主行是卡片右上角的两颗 `.lnk`（`#oRebuild` / `#oPrune`）。
 * 旧的 `#ownershipBtn` / `#ownershipRebuild` / `#ownershipList` / `#missingList` 都不在了。
 */

console.log("\n前端入口（editor.html 原脚本 + 状态断言）")

/** 一个页面元素现在是否可见（新页面用 style.display = 'none' 收起来） */
const shown = el => String(el.style.display ?? "") !== "none"

/** 把 `#oList` / `#aList` 里一行一行的 `.vrow` 收成 [{ cells, title }] */
const rowsOf = host =>
  host.querySelectorAll(".vrow").map(tr => ({
    cells: tr.querySelectorAll("span").map(sp => String(sp.textContent ?? "").trim()),
    title: String(tr.attrs.title ?? ""),
    el: tr,
  }))

await check("归属状态入口：只有主人（perm.manage）看得到；白名单管理员看得到历史版本但看不到它", async () => {
  /**
   * `perm.manage` = 服务端的 owner || 管理口令，与 `/api/ownership` 的准入完全同一口径。
   * 历史版本是**另一档**（`perm.versions`，白名单管理员也有）——两个标志拆开就是为了这个：
   * 给管理员开历史版本，不能顺手把"重建归属"也开出去。
   */
  const owner = bootPage({ dataFor: () => makeData({ role: "admin", readonly: false, owner: true, versions: true, manage: true }) })
  await owner.ready()
  if (!shown(owner.navEl("ownership"))) throw new Error("主人看不到归属状态入口")

  const admin = bootPage({
    dataFor: () => makeData({ role: "admin", readonly: false, versions: true, manage: false }),
  })
  await admin.ready()
  if (shown(admin.navEl("ownership"))) throw new Error("白名单管理员看到了归属状态入口")
  /** 反面证据：同一位管理员**该**看得到历史版本（维护者要求），别把两档一起关了 */
  if (!shown(admin.navEl("versions"))) throw new Error("白名单管理员看不到历史版本")
})

await check("点「归属状态」：拉一次 /api/ownership 并把 QQ → 行 列出来", async () => {
  const h = bootPage({ dataFor: () => makeData() })
  await h.ready()
  const before = h.reads("api/ownership").length
  h.nav("ownership")
  await h.ready()
  const gets = h.reads("api/ownership").length - before
  if (gets !== 1) throw new Error(`期望 1 次 GET /api/ownership，实际 ${gets} 次`)
  const text = h.textOf(h.el("oList"))
  if (!/归属全部对得上/.test(text)) throw new Error(`空归属没给出说明：${JSON.stringify(text)}`)
})

/**
 * **页面上写的是序号，不是表格行号**（维护者报：三个榜里同一个人显示成「第 9 / 第 15 / 第 9 行」，
 * 跟表里第一列对不上）。行号只进悬浮提示（与表格里序号那一格同一口径），行动作仍用 `row`。
 *
 * 六列布局：`QQ 号 / 群昵称 / 对象 / 行 / 昵称 / 状态`——QQ 号只写数字，
 * 群昵称接在它右边（维护者要求：只给一串号码根本认不出是谁）。
 */
await check("归属页写的是**序号**：绑定与退群候选都按它写，真行号只进悬浮提示", async () => {
  const h = bootPage({
    dataFor: () => makeData(),
    ownershipGetReply: () => ({
      status: 200,
      body: {
        ok: true,
        version: "v1",
        bindings: { table: "v1", stale: false, count: 1 },
        locks: { table: "v1", stale: false, count: 0, rows: [] },
        roster: { group: "测试群", updatedAt: 0, count: 0 },
        nicks: { "30001": "小甲" },
        sheets: [
          {
            name: "剧诗",
            bound: 1,
            entries: [
              { qq: "30001", row: 10, seq: 3, nickname: "甲", current: "甲", rowExists: true, stale: false, conflict: false, conflictWith: [] },
            ],
          },
        ],
        missing: {
          supported: true,
          reason: "",
          rows: [{ sheet: "剧诗", row: 12, seq: 5, nickname: "查无此人", gameName: "孤儿游戏", status: "" }],
        },
      },
    }),
  })
  await h.ready()
  h.nav("ownership")
  await h.ready()

  const rows = rowsOf(h.el("oList"))
  const bound = rows.find(r => r.cells[0] === "30001")
  if (!bound) throw new Error(`绑定那条没画出来：${JSON.stringify(rows.map(r => r.cells))}`)
  if (bound.cells[0] !== "30001") throw new Error(`QQ 号那一列只该写数字：${JSON.stringify(bound.cells)}`)
  if (bound.cells[1] !== "小甲") throw new Error(`群昵称那一列没写出来：${JSON.stringify(bound.cells)}`)
  if (bound.cells[3] !== "序号 3") throw new Error(`绑定那条没按序号写：${JSON.stringify(bound.cells)}`)
  if (!bound.title.startsWith("表格第 10 行")) throw new Error(`悬浮提示里没有真行号：${JSON.stringify(bound.title)}`)
  if (bound.cells[2] !== "剧诗") throw new Error(`没写榜名：${JSON.stringify(bound.cells)}`)
  if (rows.some(r => r.cells.some(c => /第 10 行/.test(c)))) throw new Error("绑定那条还在正文里显示表格行号")

  /** 假 DOM 的 textContent 不含后代文本，所以状态那格（`<i>` 在 span 里）取不到，按昵称认行 */
  const miss = rows.find(r => /查无此人/.test(r.cells[4] || ""))
  if (!miss) throw new Error(`退群候选没画出来：${JSON.stringify(rows.map(r => r.cells))}`)
  if (miss.cells[0] !== "—") throw new Error(`没有 QQ 的行不该编一个号码：${JSON.stringify(miss.cells)}`)
  if (miss.cells[3] !== "序号 5") throw new Error(`候选行没按序号写：${JSON.stringify(miss.cells)}`)
  if (!miss.title.startsWith("表格第 12 行")) throw new Error(`候选行的悬浮提示里没有真行号：${JSON.stringify(miss.title)}`)
})

await check("一键重建：二次确认 → 只发一次 POST {action:'rebuild'}，并说清楚重建完了", async () => {
  const h = bootPage({
    dataFor: () => makeData(),
    ownershipReply: () => ({ status: 200, body: { ok: true, kept: 2, moved: 1, dropped: 5, unconfirmed: 3, missing: 2, locks: { kept: 1, dropped: 1 } } }),
  })
  await h.ready()
  h.nav("ownership")
  await h.ready()
  /** 先把草稿造出来：重建只是"重读归属"，不该动表格里没保存的改动 */
  h.nav("queue")
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  mustDraft(h)
  h.nav("ownership")
  await h.ready()
  await h.click("oRebuild")

  const posts = h.posts("api/ownership")
  if (posts.length !== 1) throw new Error(`期望 1 次 POST /api/ownership，实际 ${posts.length} 次`)
  if (posts[0].body?.action !== "rebuild") throw new Error(`请求体不对：${JSON.stringify(posts[0].body)}`)
  const said = h.toasts().join("\n")
  if (!/已重建归属/.test(said)) throw new Error(`没说重建完了：${JSON.stringify(said)}`)
  if (h.probe.dirty.length !== 1) throw new Error("重建归属把表格草稿弄丢了")
})

await check("一键重建：二次确认取消 → 一个请求都不发", async () => {
  const h = bootPage({ dataFor: () => makeData(), confirm: () => false })
  await h.ready()
  h.nav("ownership")
  await h.ready()
  await h.click("oRebuild")
  if (h.posts("api/ownership").length) throw new Error("用户取消了却还是发了重建请求")
})

/* ------------- ⑤ 权限管理页：owners / admins / ignored 都要列出来（VM） ------------- */

console.log("\n权限管理页（editor.html 原脚本 + 状态断言）")

/** 页面上的白名单行 */
const adminRows = h => rowsOf(h.el("aList"))

await check("权限管理页：owner 名单里的主人也要列出来（不能只画 /api/admins 的 admins）", async () => {
  const h = bootPage({
    /** 这个主人**不在** admins 里：只画 admins 的页面会把他漏掉（只画 owner 的漏掉另一个） */
    dataFor: () => makeData({ role: "admin", readonly: false, owner: true, showAdmins: true, versions: true, manage: true }),
    adminsReply: () => ({
      status: 200,
      body: { ok: true, admins: ["424242", "30099"], owners: ["111111", "424242"], env: [], file: [], ignored: [], suggestions: {} },
    }),
  })
  await h.ready()
  h.nav("admins")
  await h.ready()
  const rows = adminRows(h)
  const qqs = rows.map(r => r.cells[0])
  if (!qqs.includes("111111")) throw new Error(`主人（只在 owners 里）没画出来：${JSON.stringify(qqs)}`)
  if (!qqs.includes("30099")) throw new Error(`白名单管理员没画出来：${JSON.stringify(qqs)}`)
  const owner = rows.find(r => r.cells[0] === "111111")
  if (!owner.cells.includes("主人")) throw new Error(`主人没被标成主人：${JSON.stringify(owner.cells)}`)
  const admin = rows.find(r => r.cells[0] === "30099")
  if (admin.cells.includes("主人")) throw new Error(`白名单管理员被标成了主人：${JSON.stringify(admin.cells)}`)
})

/**
 * 输入框与页面提示**都只说 QQ**（维护者报告：placeholder 原来写着「QQ 号或群昵称」，
 * 等于教人填昵称——真填了只会得到一句报错）。这条钉住文案，别再退回去。
 */
await check("权限管理页：只教人填 QQ 号，不再提群昵称", async () => {
  const html = fs.readFileSync(new URL("../editor.html", import.meta.url), "utf8")
  const input = /<input id="adminAdd"[^>]*>/.exec(html)?.[0] ?? ""
  if (!input) throw new Error("页面里没有 #adminAdd")
  const placeholder = /placeholder="([^"]*)"/.exec(input)?.[1] ?? ""
  if (/群昵称/.test(placeholder)) throw new Error(`输入框还在教人填群昵称：${JSON.stringify(placeholder)}`)
  if (!/QQ/.test(placeholder)) throw new Error(`输入框没写明是 QQ 号：${JSON.stringify(placeholder)}`)

  const h = bootPage({
    dataFor: () => makeData({ role: "admin", readonly: false, owner: true, showAdmins: true, versions: true, manage: true }),
    adminsReply: () => ({ status: 200, body: { ok: true, admins: ["30099"], owners: ["111111"], env: [], file: [], ignored: [], suggestions: {} } }),
  })
  await h.ready()
  h.nav("admins")
  await h.ready()
  const tip = String(h.el("aFoot").textContent ?? "")
  if (!/只加 QQ 号/.test(tip)) throw new Error(`页面提示没写"只加 QQ 号"：${JSON.stringify(tip)}`)
})

await check("权限管理页：解析不出 QQ 的条目也要显示，并标明「不是权限」", async () => {
  const h = bootPage({
    dataFor: () => makeData({ role: "admin", readonly: false, owner: true, showAdmins: true, versions: true, manage: true }),
    adminsReply: () => ({
      status: 200,
      body: {
        ok: true,
        admins: ["30099"],
        owners: ["111111"],
        env: [],
        file: [],
        ignored: ["老管理昵称"],
        suggestions: { 老管理昵称: "30088" },
      },
    }),
  })
  await h.ready()
  h.nav("admins")
  await h.ready()
  const bad = adminRows(h).find(r => (r.cells[0] || "").includes("老管理昵称"))
  if (!bad) throw new Error(`被拒绝的昵称条目没显示出来：${JSON.stringify(adminRows(h).map(r => r.cells))}`)
  if (!bad.cells.includes("不是权限")) throw new Error(`无效条目没写「不是权限」：${JSON.stringify(bad.cells)}`)
  if (!bad.cells.some(c => c.includes("30088"))) throw new Error(`无效条目没给"该改成哪个 QQ"的建议：${JSON.stringify(bad.cells)}`)
  const tip = String(h.el("aFoot").textContent ?? "")
  if (!tip.includes("不生效")) throw new Error(`页面提示没说清无效条目不生效：${JSON.stringify(tip)}`)
})

await check("无效条目的「×」：删的是白名单文件里的那一条原始条目", async () => {
  const h = bootPage({
    dataFor: () => makeData({ role: "admin", readonly: false, owner: true, showAdmins: true, versions: true, manage: true }),
    adminsReply: () => ({
      status: 200,
      body: { ok: true, admins: [], owners: ["111111"], env: [], file: [], ignored: ["老管理昵称"], suggestions: {} },
    }),
  })
  await h.ready()
  h.nav("admins")
  await h.ready()
  const bad = adminRows(h).find(r => (r.cells[0] || "").includes("老管理昵称"))
  if (!bad) throw new Error("无效条目没显示出来")
  const x = bad.el.querySelector("[data-remove-name]")
  if (!x) throw new Error("无效条目上没有摘除按钮")
  if (typeof x.onclick !== "function") throw new Error("无效条目上的「×」没挂处理器")
  await x.onclick()
  const posts = h.posts("api/admins")
  if (posts.length !== 1) throw new Error(`期望 1 次 POST /api/admins，实际 ${posts.length} 次`)
  if (JSON.stringify(posts[0].body?.remove) !== JSON.stringify(["老管理昵称"]))
    throw new Error(`摘的不是原始条目：${JSON.stringify(posts[0].body)}`)
})

/** 重建前后都要能看出草稿还在（`probe.dirty` 是行号数组） */
function mustDraft(h) {
  if (!h.probe.dirty.includes(10)) throw new Error(`草稿没记上：${JSON.stringify(h.probe.dirty)}`)
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
