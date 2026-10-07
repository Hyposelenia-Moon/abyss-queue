/**
 * 成员保存的**业务行范围**：表头与主播区不能被当"新增成员行"写
 *
 * 表头上方是主播区、再往上是标题/公告，它们都不在 `model.rows` 里。"行号不在成员列表里"因此
 * 同时是两件事：**新增成员行**，或者**改主播格 / 改表头**——只按行号放行的话，
 * 任何有签名身份的人都能借成员保存改到受保护区域：
 *   - 指到主播行 → 改掉主播格（那本来只有管理员走 /api/anchors 才能改）；
 *   - 指到表头行 → 把"群昵称"等表头清掉，下次建模直接失败；
 *   - 行号是 0 / 负数 / 非整数 → 被 `Number(x) || 0` 静默吞掉，变成一次什么都不做的"成功"。
 * 这里同时钉住**合法追加**照旧可用（页面就是在数据区末尾顺延找空行的，不能把追加一起拒掉）。
 *
 * 断言口径：越界必须"什么都没发生"——HTTP 400、表版本不变、工作簿里的锚点格原样。
 *
 * 用法：node editor/test/member-row-area.test.mjs
 */
import fs from "node:fs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("成员行范围")

if (!fs.existsSync(TEMPLATE)) {
  console.log(`⏭ 缺少空模板（${TEMPLATE}），跳过成员行范围套件`)
  process.exit(0)
}

const { openWorkbook, parseSheet } = await shared("model/xlsx.js")
const { buildModel } = await shared("model/schema.js")

const SHEET = "幽境危战"
const TOKEN = "member-area-token"
const SIGN_KEY = "member-area-sign-key"
const ADMIN = { qq: "424242", nick: "主人" }
const SELF = { qq: "515151", nick: "报名的人" }

const ws = makeWorkspace("member-area")
const adminsFile = ws.file("admins.json")
fs.writeFileSync(adminsFile, JSON.stringify({ owner: [ADMIN.qq], admins: [] }), "utf8")

/**
 * 直接读工作簿里的一个格子（断言"工作簿没被动过"要比对文件内容，不能只看接口回什么）
 * @param {string} ref 单元格地址，如 `A3`
 */
const cellOf = async ref => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)
  const wb = await openWorkbook(fs.readFileSync(ws.fixture))
  const parsed = parseSheet(await wb.sheetXml(SHEET), wb.shared)
  return parsed.rows.get(Number(m[2]))?.cells.get(m[1])?.value ?? ""
}

let editor = null
try {
  editor = await startEditor({
    label: "成员行范围",
    token: TOKEN,
    signKey: SIGN_KEY,
    adminsFile,
    args: ["--file", ws.fixture],
    env: {
      ABYSS_QUEUE_CONFIG: ws.cfg,
      ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
      /** 临时目录里的表 + 独立的签名密钥：这个套件不碰"本地兼容模式"那条路 */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
  })

  const versionNow = async () => (await editor.request("/api/version")).json.version
  const sheetOf = async who => (await editor.request("/api/data", { who })).json.sheets.find(s => s.name === SHEET)
  const rowInTable = async row => (await sheetOf(ADMIN)).rows.find(r => r.row === row)

  const sheet = await sheetOf(ADMIN)
  const anchor = (sheet.options?.anchor ?? [])[0] ?? "都可以"
  const goal = (sheet.options?.goal ?? [])[0] ?? "N5"
  /**
   * 表头行 / 主播区行都从表里读出来，不写死行号（模板改版后套件不该跟着改）
   *
   * 数据接口里表头行没有单独下发，但 `model/schema.js` 的契约是 `dataStart = 表头行 + 1`
   * （成员数据从表头下一行开始），所以按它反推；主播行取管理员的 `anchorRows`（带行号与名字）。
   */
  const headerRow = sheet.dataStart - 1
  const firstAnchor = (sheet.anchorRows ?? [])[0]
  const anchorRow = firstAnchor?.row ?? 0
  const anchorName = firstAnchor?.name ?? ""
  const appendRow = sheet.dataEnd + 1

  console.log(
    `  （幽境危战：表头第 ${headerRow} 行、数据区 ${sheet.dataStart}–${sheet.dataEnd}、` +
      `首个主播在第 ${anchorRow} 行「${anchorName}」）`,
  )

  /** 一行"看起来完全正常"的成员数据：要能通过必填与下拉校验，否则测不出"是被行号拒的" */
  const values = (nickname, note = "") => ({ nickname, gameName: "游戏名", anchor, goal, note })

  /** 越界的统一断言：400 + 版本不变 + 该格原样 */
  const expectRejected = async (name, body, ref, expected) => {
    const before = await versionNow()
    const res = await editor.request("/api/save", { who: ADMIN, body })
    if (res.json.ok) throw new Error(`越界保存竟然成功了：${JSON.stringify(res.json)}`)
    if (res.status !== 400) throw new Error(`期望 400 参数错误，实际 HTTP ${res.status} ${JSON.stringify(res.json)}`)
    if (!/行/.test(String(res.json.error)) || !String(res.json.error).includes(String(body.rows[0].row)))
      throw new Error(`拒绝原因没点明行号：${JSON.stringify(res.json.error)}`)
    if ((await versionNow()) !== before) throw new Error("被拒的保存改了表（版本变了）")
    if ((await cellOf(ref)) !== expected) throw new Error(`${ref} 被写坏了：${JSON.stringify(await cellOf(ref))}`)
    /**
     * 版本、工作簿都没动，再顺手确认表里那一行还在。
     *
     * 只对**成员数据区**里的行号断言这条：表头行与主播行本来就不在成员列表（`model.rows`）里，
     * 拿"成员列表里找不到它"当"被清掉了"，是套件自己认错了对象。
     */
    const row = Number(body.rows[0].row)
    if (expected && row >= sheet.dataStart && !(await rowInTable(row))) throw new Error(`第 ${row} 行在表里消失了`)
  }

  await check("表头行：拒绝，且表头一个字都没被清掉", async () => {
    const header = await cellOf(`A${headerRow}`)
    if (!header) throw new Error(`表头行第 ${headerRow} 行 A 列本来就没内容，套件前提不成立`)
    /**
     * 这一条故意用**整行空值**：它在范围检查放宽时能走得最远——必填校验对空行放行，
     * 于是 `ctx.clearRow(表头行)` 会把"群昵称"等表头格一并清掉，下一次建模就再也找不到表头了。
     */
    await expectRejected("表头行", { sheet: SHEET, rows: [{ row: headerRow, values: {} }] }, `A${headerRow}`, header)
  })

  await check("主播区行：拒绝，锚点格保持原样", async () => {
    /** A 列原文是「主播名【推荐度】」，模型里的 name 已经把【推荐度】摘掉了，所以比对要用原文 */
    const current = await cellOf(`A${anchorRow}`)
    if (!anchorName || !current.includes(anchorName))
      throw new Error(`第 ${anchorRow} 行不是主播行（A 列是 ${JSON.stringify(current)}），套件前提不成立`)
    await expectRejected(
      "主播区行",
      { sheet: SHEET, rows: [{ row: anchorRow, values: { ...values("坏人"), note: "越界写的备注" } }] },
      `A${anchorRow}`,
      current,
    )
  })

  await check("非法行号：非整数（2.5 / 字符串 / 对象）在收行号那一步就被点名，不静默变 0", async () => {
    for (const row of [2.5, "abc", {}]) {
      const res = await editor.request("/api/save", { who: ADMIN, body: { sheet: SHEET, rows: [{ row, values: values("坏人") }] } })
      if (res.json.ok) throw new Error(`行号 ${JSON.stringify(row)} 竟然被接受了`)
      if (res.status !== 400) throw new Error(`行号 ${JSON.stringify(row)} 期望 400，实际 HTTP ${res.status}`)
      /** 只要求"被拒"是不够的：坏行号被归一成第 0 行以后同样会被范围检查拒掉，那时这条断言就白测了 */
      if (!String(res.json.error).includes("行号不是整数"))
        throw new Error(`行号 ${JSON.stringify(row)} 的拒绝原因没点明不是整数：${res.json.error}`)
    }
  })

  await check("非法行号：0 / 负数 / 缺行号 → 越界拒绝（表头上方永远不是成员行）", async () => {
    /** `缺失`在这里会归一成 0（空串转数字），所以它和 0 / 负数走同一条越界拒绝 */
    for (const row of [0, -1, null, undefined]) {
      const res = await editor.request("/api/save", { who: ADMIN, body: { sheet: SHEET, rows: [{ row, values: values("坏人") }] } })
      if (res.json.ok) throw new Error(`行号 ${JSON.stringify(row)} 竟然被接受了`)
      if (res.status !== 400) throw new Error(`行号 ${JSON.stringify(row)} 期望 400，实际 HTTP ${res.status}`)
      if (!String(res.json.error).includes("不是成员数据行"))
        throw new Error(`行号 ${JSON.stringify(row)} 的拒绝原因没说清是越界：${res.json.error}`)
    }
  })

  await check("合法追加：数据区末尾 +1 行照旧能写（页面的新增行就是这么算的）", async () => {
    const before = await versionNow()
    const nickname = `追加的人${appendRow}`
    const res = await editor.request("/api/save", { who: ADMIN, body: { sheet: SHEET, rows: [{ row: appendRow, values: values(nickname, "追加的备注") }] } })
    if (!res.json.ok) throw new Error(`合法追加被拒了（第 ${appendRow} 行）：${JSON.stringify(res.json)}`)
    if (res.status !== 200) throw new Error(`期望 200，实际 HTTP ${res.status}`)
    const after = await versionNow()
    if (after === before) throw new Error("写成功了版本却没变")
    const row = await rowInTable(appendRow)
    if (!row) throw new Error(`追加的第 ${appendRow} 行在表里读不到`)
    if (row.nickname !== nickname) throw new Error(`昵称不对：${JSON.stringify(row.nickname)}`)
    if (row.note !== "追加的备注") throw new Error(`备注不对：${JSON.stringify(row.note)}`)
  })

  await check("追加余量之外：拒绝（不能想写哪行就写哪行）", async () => {
    /**
     * 上界是**相对"当前"数据区末尾**算的（末尾之后留一段追加余量），所以必须在上一条合法追加
     * **之后**重新取一次 dataEnd：拿加载时那份快照算出来的行号，在追加之后正好落进新余量里，
     * 那样测的就不是"越界被拒"，而是"余量跟着表一起长"。
     *
     * 余量口径与服务端一致：`APPEND_ROWS_MAX` = 一次提交最多 500 行（applySave 的行数上限），
     * 页面的新增行就是从数据区末尾一行一行顺延的，单次请求不可能超出这个数。
     */
    const now = await sheetOf(ADMIN)
    const tooFarRow = now.dataEnd + 500 + 1
    const res = await editor.request("/api/save", {
      who: ADMIN,
      body: { sheet: SHEET, rows: [{ row: tooFarRow, values: values("太远了") }] },
    })
    if (res.json.ok) throw new Error(`第 ${tooFarRow} 行竟然写进去了`)
    if (res.status !== 400 || !String(res.json.error).includes(String(tooFarRow)))
      throw new Error(`期望 400 且说明行号，实际 HTTP ${res.status} ${JSON.stringify(res.json)}`)
  })

  await check("本人（self）也过同一条范围检查：主播区照样拒", async () => {
    const current = await cellOf(`A${anchorRow}`)
    if (!anchorName || !current.includes(anchorName))
      throw new Error(`第 ${anchorRow} 行不是主播行（A 列是 ${JSON.stringify(current)}），套件前提不成立`)
    const res = await editor.request("/api/save", {
      who: SELF,
      body: { sheet: SHEET, rows: [{ row: anchorRow, values: { ...values(SELF.nick), note: "self 越界" } }] },
    })
    if (res.json.ok) throw new Error("self 身份竟然改到了主播区")
    if (res.status !== 400 || !String(res.json.error).includes(String(anchorRow)))
      throw new Error(`期望 400 且说明行号，实际 HTTP ${res.status} ${JSON.stringify(res.json)}`)
    if ((await cellOf(`A${anchorRow}`)) !== current) throw new Error("主播格被 self 改坏了")
  })

  await check("本人（self）的合法追加仍然可用（并且绑到本人名下）", async () => {
    const rowNum = sheet.dataEnd + 2
    const res = await editor.request("/api/save", {
      who: SELF,
      body: { sheet: SHEET, rows: [{ row: rowNum, values: values(SELF.nick, "本人追加的") }] },
    })
    if (!res.json.ok) throw new Error(`本人的合法追加被拒了：${JSON.stringify(res.json)}`)
    const after = await rowInTable(rowNum)
    if (after?.nickname !== SELF.nick) throw new Error(`本人追加的行不对：${JSON.stringify(after)}`)
    /** 追加完还要认得出是本人：绑定表里得记上这一行，否则下次再来改就"不是你的记录"了 */
    const binds = JSON.parse(fs.readFileSync(ws.bindingsFile, "utf8")).binds?.[SHEET] ?? {}
    if (Number(binds[SELF.qq]?.row) !== rowNum) throw new Error(`本人追加的行没绑给本人：${JSON.stringify(binds[SELF.qq])}`)
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
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
