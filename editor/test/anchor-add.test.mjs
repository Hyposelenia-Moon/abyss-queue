/**
 * 主播列表「新增主播」：谁能看到入口、点下去发出什么、服务端真的插了一行
 *
 * 主播区没有空行可占，所以"加一位主播"在表里就是**插一行**：公告行 / 表头行 / 数据行
 * 连同它们的合并格、下拉验证范围、条件格式范围、超链接与冻结窗格一起下移一格。
 * 这个动作以前只有"人去 Excel 里插行"一条路（`editor.mjs` 的 applyAnchors 原本明确
 * 拒绝非既有行号），现在由编辑器自己做，因此必须钉住三件事：
 *
 *   1) 入口的可见性**只认稳定身份**（QQ 白名单口径）：主人与白名单管理员看得到、能用；
 *      本人与访客页面上**根本没有这个控件**（不是 disabled、也不只是"点了没反应"）。
 *   2) 新增的主播走 `POST /api/anchors`，与既有主播和成员行**同一套语义**：
 *      带 `version` 判冲突（409 一个字都不写）、失败保留草稿、成功后重新读表拿到行号。
 *   3) 服务端真的把行插进表里，而且**只多出这一行**：数据行逐字下移、结构要素数量不变、
 *      行号引用（合并 / 校验 / 条件格式 / 维度 / 冻结 / 序号公式）全部跟着走，
 *      归属绑定也跟着搬 —— 否则本人会被认到别人的行上。
 *   4) **插入点必须在表头之上**：表头在第 3 行及更靠上的表（主播区为空时 `ANCHOR_FIRST_ROW`
 *      这个回退值会落到表头及以下）一律拒绝，表 / 绑定 / 锁 / 版本一个字都不动（合成表复现）。
 *   5) **两个区的序号各自独立**：插一行之后排队区序号仍是 1..N（`=ROW()-k` 的常量同步 +1，
 *      值不变、不是整体 +1），主播区编号仍从 1 起；排队区加减行也不得动主播区编号。
 *
 * 口径：上半截把 `editor.html` 的内联脚本原样抽出来在 node:vm 里跑（桩 fetch + 最小 DOM）；
 * 下半截起真编辑器 + 真文件：空模板副本证明"表里真的多了一行"，真实表副本（`source.mjs` 的三层来源，
 * 在 %TEMP% 里复制、跑完即删）复核序号，另用两张合成的"表头在第 2 / 3 行"的表验守卫。
 *
 * 用法：node editor/test/anchor-add.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bootPage, makeData, ANCHOR_COLS } from "./page-vm.mjs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker, isRealTable } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("主播列表新增主播")
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

console.log("主播列表「新增主播」（editor.html 原脚本 + 真接口 + 真文件）")

/* ========================= ① 页面：入口对谁可见 ========================= */

/** 页面上真正挂在主播面板里的「＋ 新增主播」（按 DOM 找，不看 getElementById 能不能取到 id） */
const addButtons = h => h.document.getElementById("anchorAddHost").childNodes.filter(n => n.id === "anchorAdd")
const anchorTable = h => h.document.getElementById("anchorGrid").childNodes[0]
const anchorBodyRows = h => anchorTable(h)?.childNodes[1]?.childNodes ?? []
const panelOpen = h => h.document.getElementById("anchors").classList.contains("open")

/** 往主播表最后一行（新增行）的某一格填字：走页面真实的 oninput */
const fillRow = (h, values) => {
  const tr = anchorBodyRows(h).at(-1)
  if (!tr) throw new Error("主播列表里没有可以填的行")
  for (const [key, value] of Object.entries(values)) {
    const input = tr.childNodes[ANCHOR_COLS.indexOf(key) + 1].childNodes[0]
    input.value = value
    input.oninput()
  }
}

/** 与服务端真会给的那几种 perm 一致（见 editor.mjs 的 buildPayload）：主人 / 白名单管理员 / 本人 / 访客 */
const permOfOwner = { role: "admin", readonly: false, owner: true, showAdmins: true }
const permOfAdmin = { role: "admin", readonly: false, owner: false, showAdmins: false }
const permOfSelf = { role: "self", readonly: false, nick: "甲" }
const permOfGuest = { role: "guest", readonly: true }

const bootAs = perm => bootPage({ dataFor: () => makeData(perm) })

for (const [label, perm] of [["主人", permOfOwner], ["白名单管理员", permOfAdmin]]) {
  await check(`${label}：看得到「＋ 新增主播」，点一下界面上就多一行`, async () => {
    const h = bootAs(perm)
    await h.ready()
    must(panelOpen(h), `${label}的主播面板没有打开（#anchors 上没有 open）`)
    const buttons = addButtons(h)
    must(buttons.length === 1, `${label}页面上没有「＋ 新增主播」这个控件（找到 ${buttons.length} 个）`)
    const before = anchorBodyRows(h).length
    buttons[0].onclick()
    must(h.probe.anchorAdded.length === 1, `点了「＋ 新增主播」没有记下一条新增（anchorAdded=${h.probe.anchorAdded.length}）`)
    must(anchorBodyRows(h).length === before + 1, `点完之后界面上没有多出一行：${before} → ${anchorBodyRows(h).length}`)
  })
}

for (const [label, perm] of [["本人", permOfSelf], ["访客", permOfGuest]]) {
  await check(`${label}：页面上没有「＋ 新增主播」（面板不显示、控件不存在、也没有处理器）`, async () => {
    const h = bootAs(perm)
    await h.ready()
    must(!panelOpen(h), `${label}的主播面板竟然是打开的`)
    must(addButtons(h).length === 0, `${label}页面上有「＋ 新增主播」控件（应当根本不存在）`)
    must(h.document.getElementById("anchorGrid").innerHTML === "", `${label}的主播行表不是空的`)
    must(typeof h.document.getElementById("anchorAdd").onclick !== "function", `${label}页面上竟然留着「＋ 新增主播」的点击处理器`)
  })
}

await check("本人：就算界面被人为拼出保存按钮，也发不出 /api/anchors（这条对所有人都是同一个判据）", async () => {
  const h = bootAs(permOfSelf)
  await h.ready()
  await h.click("anchorSave")
  must(h.posts("api/anchors").length === 0, `本人竟然发出了 ${h.posts("api/anchors").length} 个 /api/anchors`)
})

/* ============ ①b 两个区的序号各自独立（页面：主播区 1..M、排队区 1..N，互不串号） ============ */

/** 主播行：在表里的行号故意跳开（7 / 8 / 12），序号必须是 1、2、3 —— 拿表里行号当序号就会露馅 */
const anchorRowsAt = rows =>
  rows.map((row, i) => ({ row, name: `主播${i + 1}`, recommend: "", duty: "", skills: "", platform: "", link: "" }))

/** 桩数据换一份主播行（其余照 makeData：排队区数据行号仍是 10） */
const dataWithAnchors = (rows, perm = permOfAdmin) => {
  const data = makeData(perm)
  data.sheets[0].anchorRows = anchorRowsAt(rows)
  data.sheets[0].anchors = data.sheets[0].anchorRows.map(a => a.name)
  return data
}

/** 主播列表自己那一列序号现在显示什么（页面对新行写的是「＋」，已有行写的是数字，统一成字符串比） */
const anchorNos = h => anchorBodyRows(h).map(tr => String(tr.childNodes[0].textContent))

await check("主播区的序号是 1..M 且从 1 起（跟主播在表里的行号无关）", async () => {
  const h = bootPage({ dataFor: () => dataWithAnchors([7, 8, 12]) })
  await h.ready()
  must(JSON.stringify(anchorNos(h)) === JSON.stringify(["1", "2", "3"]), `主播序号不是 1..3：${JSON.stringify(anchorNos(h))}`)
  /** 真实行号不进正文，只进悬浮提示：第三位主播在表里第 12 行，页面上仍是第 3 位 */
  const third = anchorBodyRows(h)[2].childNodes[0]
  must(third.title === "表格第 12 行", `第 3 位主播的悬浮提示里没有真实行号：${JSON.stringify(third.title)}`)
  /** 新增的主播保存时才有行号，序号列先显示「＋」——不占 1..M 里的号，也不能算成第 M+1 个 */
  addButtons(h)[0].onclick()
  must(JSON.stringify(anchorNos(h)) === JSON.stringify(["1", "2", "3", "＋"]), `点「＋ 新增主播」之后主播序号串了：${JSON.stringify(anchorNos(h))}`)
})

await check("排队区加减行不影响主播区编号（两个区的序号各自从 1 起、不互相串号）", async () => {
  const h = bootPage({ dataFor: () => dataWithAnchors([7, 8, 12]) })
  await h.ready()
  must(JSON.stringify(anchorNos(h)) === JSON.stringify(["1", "2", "3"]), `前置：主播序号不是 1..3：${JSON.stringify(anchorNos(h))}`)
  /** 排队区新增一行（页面上真实的「＋ 新增一行」） */
  await h.click("addRow")
  must(JSON.stringify(anchorNos(h)) === JSON.stringify(["1", "2", "3"]), `排队区新增一行把主播区序号带跑了：${JSON.stringify(anchorNos(h))}`)
  /** 切一遍标签会整套重画（renderAnchors 也在里面），重画之后仍是 1..M */
  h.tab(0)
  await h.ready()
  must(JSON.stringify(anchorNos(h)) === JSON.stringify(["1", "2", "3"]), `重画之后主播序号变了：${JSON.stringify(anchorNos(h))}`)
  /** 排队区那一行有自己的序号轴（新 · N），不该被主播区的号影响、也不影响主播区 */
  const fresh = h.newRow().childNodes[0].textContent
  must(/^新 · \d+$/.test(fresh), `排队区新增行的序号不是「新 · N」：${JSON.stringify(fresh)}`)
})

/* ================= ② 页面：点「＋」之后保存走哪条路、怎么失败 ================= */

const ANCHORS_OK = n => ({ status: 200, body: { ok: true, written: n, inserted: n, options: 1 } })
const CONFLICT_409 = {
  status: 409,
  body: { ok: false, conflict: true, error: "表格在你保存期间被改过（别人先提交、或表被外部改动），请刷新页面确认后再改" },
}

await check("保存新增的主播：走 /api/anchors，带 version，并把它放在 added 里（不自己编行号）", async () => {
  const h = bootAs(permOfAdmin)
  await h.ready()
  addButtons(h)[0].onclick()
  fillRow(h, { name: "新主播甲", recommend: "可选", skills: "测试强项", platform: "B站" })
  await h.click("anchorSave")

  const posts = h.posts("api/anchors")
  must(posts.length === 1, `期望 1 个 /api/anchors 请求，实际 ${posts.length} 个`)
  const body = posts[0].body
  must(body.version === "v1", `新增主播的请求没带"我读到的那一版表"：${JSON.stringify(body.version)}`)
  must(body.sheet === "剧诗", `目标榜是 ${body.sheet}`)
  must(Array.isArray(body.added) && body.added.length === 1, `请求里没有把新增的主播放进 added：${JSON.stringify(body.added)}`)
  must(body.added[0].values.name === "新主播甲", `新增主播的名字丢了：${JSON.stringify(body.added[0])}`)
  must(body.added[0].values.skills === "测试强项", `新增主播的强项丢了：${JSON.stringify(body.added[0])}`)
  must(body.added[0].row === undefined, `新增主播种不该自己编行号（行号由服务端插入时定）：${JSON.stringify(body.added[0])}`)
  must(body.rows.length === 0, `没有改既有主播，rows 应当是空的：${JSON.stringify(body.rows)}`)
})

await check("新增主播撞上 409：一个字都不落地，界面上那一行与草稿都还在", async () => {
  const h = bootPage({ dataFor: () => makeData(permOfAdmin), anchorReply: n => (n === 1 ? CONFLICT_409 : ANCHORS_OK(1)) })
  await h.ready()
  addButtons(h)[0].onclick()
  fillRow(h, { name: "新主播甲", skills: "测试强项" })
  await h.click("anchorSave")

  must(h.probe.anchorAdded.length === 1, `冲突把新增主播的草稿弄丢了（anchorAdded=${h.probe.anchorAdded.length}）`)
  const tr = anchorBodyRows(h).at(-1)
  must(tr?.className.includes("isnew"), "冲突之后界面上那一行不见了")
  must(tr.childNodes[1].childNodes[0].value === "新主播甲", `界面上那一行的名字被清掉了：${JSON.stringify(tr.childNodes[1].childNodes[0].value)}`)
  must(h.conflictShown(), "冲突提示条没显示")
  must(h.posts("api/anchors").length === 1, `被 409 拒了之后自动重试了：${h.posts("api/anchors").length} 发`)
})

await check("点了「＋ 新增主播」却一个字没填：不算一条记录，不发请求", async () => {
  const h = bootAs(permOfOwner)
  await h.ready()
  addButtons(h)[0].onclick()
  await h.click("anchorSave")
  must(h.posts("api/anchors").length === 0, `空的新增行也发请求了：${JSON.stringify(h.posts("api/anchors")[0]?.body)}`)
  must(h.toasts().some(t => /没有改动/.test(t)), `没有提示"没有改动"：${JSON.stringify(h.toasts())}`)
})

await check("新增的主播没填名字（填了别的）：当场拦下，不发请求", async () => {
  const h = bootAs(permOfOwner)
  await h.ready()
  addButtons(h)[0].onclick()
  fillRow(h, { skills: "只有强项，没有名字" })
  await h.click("anchorSave")
  must(h.posts("api/anchors").length === 0, "没填名字也把请求发出去了")
  must(h.toasts().some(t => /主播名不能为空/.test(t)), `提示里没说清原因：${JSON.stringify(h.toasts())}`)
})

/* ================= ③ 真接口 + 真文件：表里真的多了一行 ================= */

if (!fs.existsSync(TEMPLATE)) {
  console.log(`  ⏭ 缺少空模板（${TEMPLATE}），跳过"新增主播真的落表"那一截`)
} else {
  const { openWorkbook, parseSheet } = await shared("model/xlsx.js")
  const { buildModel } = await shared("model/schema.js")

  const OWNER = { qq: "424242", nick: "主人甲" }
  const ADMIN = { qq: "777777", nick: "白名单管理员乙" }
  const SELF = { qq: "300001", nick: "某个群友" }
  const TOKEN = "anchor-add-token"
  const SIGN_KEY = "anchor-add-sign-key"
  const SHEET = "幽境危战"

  const ws = makeWorkspace("anchor-add")
  const adminsFile = ws.file("admins.json")
  fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [ADMIN.qq] }), "utf8")
  let editor = null
  try {
    editor = await startEditor({
      label: "新增主播",
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

    const load = async who => (await editor.request("/api/data", { who })).json
    const sheetOf = payload => payload.sheets.find(s => s.name === SHEET)
    const anchorNames = payload => (sheetOf(payload).anchorRows ?? []).map(a => a.name)
    /** 这份表当前的原始工作表 XML 与它的共享字符串表（直接读文件，不经过接口） */
    const readSheet = async () => {
      const wb = await openWorkbook(fs.readFileSync(ws.fixture))
      return { xml: await wb.sheetXml(SHEET), shared: wb.shared }
    }
    const structOf = xml => ({
      merges: (xml.match(/<mergeCell /g) ?? []).length,
      cf: (xml.match(/<conditionalFormatting /g) ?? []).length,
      dv: (xml.match(/<dataValidation /g) ?? []).length,
      links: (xml.match(/<hyperlink /g) ?? []).length,
    })
    /** 一行数据的内容指纹（**不含行号**：行号整体下移正是这次改动的预期结果） */
    const rowContent = r => JSON.stringify([r.seq, r.nickname, r.gameName, r.anchor, r.goal, r.strength, r.note, r.status])

    const first = await load(OWNER)
    const rowsBefore = sheetOf(first).rows
    /**
     * 空模板里没有成员（`model.rows` 只收真有内容的行），但"数据行整体下移"正是要证的那件事，
     * 所以先由主人铺三行进去 —— 之后每一行都必须原样出现在 +1 的位置上。
     */
    const options = sheetOf(first).options ?? {}
    if (!rowsBefore.length) {
      const seed = await editor.request("/api/save", {
        who: OWNER,
        body: {
          sheet: SHEET,
          rows: [0, 1, 2].map(i => ({
            row: sheetOf(first).dataStart + i,
            values: { nickname: `铺底的人${i + 1}`, gameName: `游戏${i + 1}`, anchor: (options.anchor ?? [])[0], goal: (options.goal ?? [])[0] },
          })),
        },
      })
      must(seed.json.ok, `前置：铺三行数据失败：${JSON.stringify(seed.json)}`)
    }
    const base = await load(OWNER)
    const anchorsBefore = sheetOf(base).anchorRows
    const dataBefore = sheetOf(base).rows
    const rawBefore = (await readSheet()).xml
    const lastAnchorRow = Math.max(...anchorsBefore.map(a => a.row))
    must(anchorsBefore.length > 0 && dataBefore.length > 0, "模板里没有主播行或数据行，套件前提不成立")

    await check("主人：新增一位主播 → 200，表里多出那一行（就在最后一位主播下面）", async () => {
      const saved = await editor.request("/api/anchors", {
        who: OWNER,
        body: {
          sheet: SHEET,
          rows: [],
          added: [{ values: { name: "新主播甲", recommend: "可选", skills: "测试强项", platform: "B站", link: "https://example.com/x" } }],
          version: base.version,
        },
      })
      must(saved.json.ok, `新增主播被拒了（HTTP ${saved.status}）：${JSON.stringify(saved.json)}`)
      must(saved.json.inserted === 1 && saved.json.written === 1, `回执里没如实报新增：${JSON.stringify(saved.json)}`)

      const after = await load(OWNER)
      const mine = (sheetOf(after).anchorRows ?? []).find(a => a.name === "新主播甲")
      must(mine, `表里没有这位新主播：${JSON.stringify(anchorNames(after))}`)
      must(mine.row === lastAnchorRow + 1, `新主播落在第 ${mine.row} 行，期望第 ${lastAnchorRow + 1} 行`)
      must(mine.recommend === "可选", `推荐度没写进去：${JSON.stringify(mine)}`)
      must(mine.skills === "测试强项", `核心强项没写进去：${JSON.stringify(mine)}`)
      must(mine.platform === "B站" && mine.link === "https://example.com/x", `直播入口没写进去：${JSON.stringify(mine)}`)
      /** 既有主播的行号一位都不该动（新行插在它们下面） */
      const kept = (sheetOf(after).anchorRows ?? []).filter(a => a.name !== "新主播甲").map(a => [a.row, a.name])
      must(JSON.stringify(kept) === JSON.stringify(anchorsBefore.map(a => [a.row, a.name])), `既有主播行被动过了：${JSON.stringify(kept)}`)
      /** 「选择主播」的下拉以主播列表为准：新人也得在 */
      must((sheetOf(after).options?.anchor ?? []).includes("新主播甲"), `下拉里没有新主播：${JSON.stringify(sheetOf(after).options?.anchor)}`)
    })

    await check("插一行只多一行：数据行逐字下移一格，行号引用（合并 / 校验 / 条件格式 / 维度 / 冻结 / 序号公式）全跟着走", async () => {
      const after = await load(OWNER)
      const rowsAfter = sheetOf(after).rows
      must(rowsAfter.length === dataBefore.length, `数据行数量变了：${dataBefore.length} → ${rowsAfter.length}`)
      const broken = dataBefore.filter(r => {
        const moved = rowsAfter.find(x => x.row === r.row + 1)
        return !moved || rowContent(moved) !== rowContent(r)
      })
      must(broken.length === 0, `有 ${broken.length} 行下移之后对不上（例如第 ${broken[0]} 行）`)
      must(sheetOf(after).dataStart === sheetOf(base).dataStart + 1, `表头没有跟着下移：dataStart=${sheetOf(after).dataStart}`)

      const { xml: xmlAfter, shared: sharedStrings } = await readSheet()
      const s0 = structOf(rawBefore)
      const s1 = structOf(xmlAfter)
      /** 新主播行照抄第一位主播的三段合并（A:B / C:F / G:H）：合并格 +3，其余结构要素一个不动 */
      must(s1.merges === s0.merges + 3, `合并格数量不是 +3：${s0.merges} → ${s1.merges}`)
      for (const key of ["cf", "dv", "links"]) must(s1[key] === s0[key], `${key} 的数量被改了：${s0[key]} → ${s1[key]}`)
      const newRow = lastAnchorRow + 1
      for (const ref of [`A${newRow}:B${newRow}`, `C${newRow}:F${newRow}`, `G${newRow}:H${newRow}`])
        must(xmlAfter.includes(`<mergeCell ref="${ref}"/>`), `新行缺少合并格 ${ref}`)
      /** 公告行整体下移：它那条整行合并（A:H）也要跟着走，不能留在原行 */
      must(xmlAfter.includes(`<mergeCell ref="A${newRow + 1}:H${newRow + 1}"/>`), "公告行的整行合并没有跟着下移")
      must(/<dimension ref="H111"\/>/.test(xmlAfter), `维度没跟着走：${/<dimension[^>]*>/.exec(xmlAfter)?.[0]}`)
      const pane = /<pane[^>]*>/.exec(xmlAfter)?.[0] ?? ""
      must(/ySplit="11"/.test(pane) && /topLeftCell="A12"/.test(pane), `冻结窗格没跟着走：${pane}`)
      must(xmlAfter.includes('sqref="D11:D1048576"'), "「选择主播」那一列的下拉范围没跟着下移")
      /** 序号是 =ROW()-偏移 的公式：常量不跟着 +1，Excel 一重算序号就从 2 开始 */
      const seq = new RegExp(`<c r="A${sheetOf(after).dataStart}"[^>]*>\\s*<f[^>]*>([^<]*)</f>`).exec(xmlAfter)?.[1]
      must(seq === "=ROW()-11", `序号公式的偏移没跟着走：${JSON.stringify(seq)}`)
      /** 自检之外再核一遍：新行的值在**原始 XML** 里真的存在（不是只在接口回执里"成功"） */
      const nameCell = parseSheet(xmlAfter, sharedStrings).rows.get(newRow)?.cells.get("A")?.value ?? ""
      must(nameCell.includes("新主播甲"), `表里第 ${newRow} 行的 A 列是 ${JSON.stringify(nameCell)}`)
      buildModel({ name: SHEET, xml: xmlAfter, shared: sharedStrings })
    })

    await check("白名单管理员（不是主人）：同样能新增主播", async () => {
      const perms = await load(ADMIN)
      must(perms.perm.role === "admin", `白名单管理员的 role=${perms.perm.role}`)
      must(!perms.perm.owner, "这条的前提是「非主人」的管理员（perm.owner 必须为假）")
      const before = anchorNames(perms).length
      const saved = await editor.request("/api/anchors", {
        who: ADMIN,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "管理员加的主播" } }], version: perms.version },
      })
      must(saved.json.ok, `白名单管理员新增主播被拒了：${JSON.stringify(saved.json)}`)
      const after = await load(OWNER)
      must(anchorNames(after).length === before + 1, `主播数量没变：${before} → ${anchorNames(after).length}`)
      must(anchorNames(after).includes("管理员加的主播"), `表里没有这位新主播：${JSON.stringify(anchorNames(after))}`)
    })

    await check("本人 / 访客：新增主播一律 403，表里一行都不多", async () => {
      for (const [label, who] of [["本人", SELF], ["访客", null]]) {
        const before = anchorNames(await load(OWNER))
        const r = await editor.request("/api/anchors", {
          who,
          body: { sheet: SHEET, rows: [], added: [{ values: { name: label + "想加的主播" } }], version: (await load(OWNER)).version },
        })
        must(r.status === 403, `${label}新增主播没有被拒：HTTP ${r.status} ${JSON.stringify(r.json)}`)
        must(String(r.json.error).includes("只有白名单管理员"), `${label}的 403 没说清原因：${r.json.error}`)
        const after = anchorNames(await load(OWNER))
        must(JSON.stringify(after) === JSON.stringify(before), `${label}的请求落表了：${JSON.stringify(after)}`)
      }
    })

    await check("新增主播也带版本判冲突：别人先加过，我手里这一版 409 且一行都不插", async () => {
      const mine = (await load(OWNER)).version
      const other = await editor.request("/api/anchors", {
        who: ADMIN,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "别人先加的主播" } }] },
      })
      must(other.json.ok, `先提交的那个不该被拒：${JSON.stringify(other.json)}`)
      const rejected = await editor.request("/api/anchors", {
        who: OWNER,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "不该落地的主播" } }], version: mine },
      })
      must(rejected.status === 409 && rejected.json.conflict === true, `期望 409，实际 HTTP ${rejected.status} ${JSON.stringify(rejected.json)}`)
      const after = await load(OWNER)
      must(anchorNames(after).includes("别人先加的主播"), "先提交的那位没写进去")
      must(!anchorNames(after).includes("不该落地的主播"), `被 409 拒掉的新主播竟然插进去了：${JSON.stringify(anchorNames(after))}`)
    })

    await check("一次加两位：连着插两行，表里两条都在且相邻", async () => {
      const before = await load(OWNER)
      const rowCount = sheetOf(before).rows.length
      const saved = await editor.request("/api/anchors", {
        who: OWNER,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "批量甲" } }, { values: { name: "批量乙" } }], version: before.version },
      })
      must(saved.json.ok && saved.json.inserted === 2, `一次加两位失败：${JSON.stringify(saved.json)}`)
      const after = await load(OWNER)
      const got = (sheetOf(after).anchorRows ?? []).filter(a => ["批量甲", "批量乙"].includes(a.name))
      must(got.length === 2, `表里没有这两位：${JSON.stringify(anchorNames(after))}`)
      must(got[1].row === got[0].row + 1, `两位新主播不在相邻两行：${JSON.stringify(got.map(a => a.row))}`)
      must(sheetOf(after).rows.length === rowCount, `插两行把数据行数改了：${rowCount} → ${sheetOf(after).rows.length}`)
    })

    await check("新增主播的名字不能为空（服务端也拦，不只是前端）", async () => {
      const before = anchorNames(await load(OWNER))
      const r = await editor.request("/api/anchors", {
        who: OWNER,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "   " } }], version: (await load(OWNER)).version },
      })
      must(!r.json.ok && /不能为空/.test(String(r.json.error)), `没拦住空名字：${JSON.stringify(r.json)}`)
      must(JSON.stringify(anchorNames(await load(OWNER))) === JSON.stringify(before), "被拒的请求竟然插了行")
    })

    await check("归属不因插行而错位：本人打开页面时仍在自己那一行上", async () => {
      /** 先让某位成员占一行（本人身份报名），再插一位主播把数据行整体推下去，然后看他还在不在自己那一行 */
      const ownerData = await load(OWNER)
      const occupied = sheetOf(ownerData).rows.map(r => r.row)
      /** 空模板里没写过的行不进 `rows`，所以"空行"取"已用行号下面那一行" */
      const freeRow = Math.max(...occupied) + 1
      must(freeRow <= sheetOf(ownerData).dataEnd, `模板行数不够（dataEnd=${sheetOf(ownerData).dataEnd}），套件需要调整`)
      const options = sheetOf(ownerData).options ?? {}
      const me = { qq: "300009", nick: "插行前报名的人" }
      const signup = await editor.request("/api/save", {
        who: me,
        body: {
          sheet: SHEET,
          rows: [{ row: freeRow, values: { nickname: me.nick, gameName: "x", anchor: (options.anchor ?? [])[0], goal: (options.goal ?? [])[0] } }],
        },
      })
      must(signup.json.ok, `前置：本人报名失败：${JSON.stringify(signup.json)}`)
      const before = (await load(me)).sheets.find(s => s.name === SHEET).rows
      must(before.length === 1 && before[0].row === freeRow, `前置：本人拿到的行不对：${JSON.stringify(before.map(r => r.row))}`)

      const saved = await editor.request("/api/anchors", {
        who: OWNER,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "插行之后的新主播" } }], version: (await load(OWNER)).version },
      })
      must(saved.json.ok, `插行失败：${JSON.stringify(saved.json)}`)

      const after = (await load(me)).sheets.find(s => s.name === SHEET).rows
      must(after.length === 1, `插行之后本人拿到的行数变了：${JSON.stringify(after.map(r => r.row))}`)
      must(after[0].row === freeRow + 1, `插行之后本人被认到了第 ${after[0].row} 行（应当跟着下移到第 ${freeRow + 1} 行）`)
      must(after[0].nickname === me.nick, `本人那一行的昵称不对：${JSON.stringify(after[0])}`)
    })
  } catch (err) {
    await check("真接口那一截", async () => {
      throw err
    })
  } finally {
    if (editor) await editor.stop()
    ws.cleanup()
  }
}

/* ====== ④ 插入位置守卫：表头在第 3 行及更靠上 → 拒绝，表 / 绑定 / 锁 / 版本一个字都不动 ====== */

/**
 * 合成一张"表头在第 n 行、主播区为空"的表
 *
 * 真实表与空模板的表头都在第 7 / 10 行，造不出这条边界；守卫针对的正是"主播区还空着"时
 * `ANCHOR_FIRST_ROW`（= 3）那个回退值落到表头及以下的一档：表头在第 2 行时插入点（第 3 行）
 * 是排队区的第一行，在第 3 行时插入点正好等于表头行（新行会被插到表头前面去）。
 * @param {number} headerRow 表头在第几行（A 列 =「序号」）
 * @returns {Promise<{file: string, dir: string}>} 表文件落在系统临时目录，调用方负责删
 */
async function syntheticHeaderRowTable(headerRow) {
  const { zipSnapshot } = await shared("test/fixtures/_snapshot-xlsx.mjs")
  /** 共享字符串：0 标题 / 1 主播列表 / 2 序号 / 3 群昵称 / 4 原神游戏名 / 5 帮帮完成情况 / 6 铺底的人 */
  const items = ["标题", "主播列表", "序号", "群昵称", "原神游戏名", "帮帮完成情况", "铺底的人"]
  const data = headerRow + 1
  const header =
    `<row r="${headerRow}"><c r="A${headerRow}" t="s"><v>2</v></c><c r="B${headerRow}" t="s"><v>3</v></c>` +
    `<c r="C${headerRow}" t="s"><v>4</v></c><c r="H${headerRow}" t="s"><v>5</v></c></row>`
  const sheetBody =
    `<sheetData>\n<row r="1"><c r="A1" t="s"><v>0</v></c></row>\n` +
    (headerRow >= 3 ? `<row r="2"><c r="A2" t="s"><v>1</v></c></row>\n` : "") +
    `${header}\n<row r="${data}"><c r="A${data}"><f>=ROW()-${headerRow}</f><v>1</v></c><c r="B${data}" t="s"><v>6</v></c></row>\n</sheetData>`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-anchor-guard-"))
  const file = path.join(dir, "queue.xlsx")
  fs.writeFileSync(file, await zipSnapshot({ items, sheetBody }))
  return { file, dir }
}

/** 绑定 / 锁文件现在的样子（不存在记 "(缺)"）：守卫说好"不动"，就得逐字节对得上 */
const stateFilesOf = ws => [ws.bindingsFile, ws.locksFile].map(f => (fs.existsSync(f) ? fs.readFileSync(f).toString("hex") : "(缺)"))

for (const headerRow of [2, 3]) {
  await check(`表头在第 ${headerRow} 行、主播区为空：新增主播被拒，表里一个字都没写`, async () => {
    const { openWorkbook } = await shared("model/xlsx.js")
    const { buildModel } = await shared("model/schema.js")
    const OWNER = { qq: "424242", nick: "主人甲" }
    const SHEET = "幽境危战"
    const syn = await syntheticHeaderRowTable(headerRow)
    const ws = makeWorkspace(`anchor-guard-${headerRow}`, { source: syn.file })
    let editor = null
    try {
      const adminsFile = ws.file("admins.json")
      fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
      editor = await startEditor({
        label: `守卫-表头${headerRow}`,
        token: "anchor-guard-token",
        signKey: "anchor-guard-sign-key",
        adminsFile,
        args: ["--file", ws.fixture],
        env: {
          ABYSS_QUEUE_CONFIG: ws.cfg,
          ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
          ABYSS_EDITOR_TEST_PATHS: "1",
        },
      })

      const base = await editor.request("/api/data", { who: OWNER })
      must(base.status === 200 && Array.isArray(base.json.sheets), `合成表（表头第 ${headerRow} 行）读不出来：HTTP ${base.status} ${JSON.stringify(base.json)}`)
      const sheetBase = base.json.sheets.find(s => s.name === SHEET)
      must(sheetBase?.anchorRows?.length === 0, `这条用例的前提是主播区为空：${JSON.stringify(sheetBase?.anchorRows)}`)

      const bytesBefore = fs.readFileSync(ws.fixture)
      const filesBefore = stateFilesOf(ws)
      const rejected = await editor.request("/api/anchors", {
        who: OWNER,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "不该落地的主播" } }], version: base.json.version },
      })
      must(rejected.json.ok === false, `表头第 ${headerRow} 行的表：新增主播竟然没被拒（HTTP ${rejected.status} ${JSON.stringify(rejected.json)}）`)
      const reason = String(rejected.json.error ?? "")
      must(
        reason.includes("主播区") && reason.includes("排队区") && reason.includes("不能混"),
        `拒绝的理由没说清"主播区与排队区不能混"：${reason}`,
      )
      must(Buffer.compare(bytesBefore, fs.readFileSync(ws.fixture)) === 0, "被拒的请求把表写动了（应当一个字都不写）")
      must(JSON.stringify(stateFilesOf(ws)) === JSON.stringify(filesBefore), "被拒的请求动了绑定 / 锁文件")

      const after = await editor.request("/api/data", { who: OWNER })
      must(after.json.version === base.json.version, `被拒的请求换了版本：${base.json.version} → ${after.json.version}`)
      must(
        (after.json.sheets.find(s => s.name === SHEET)?.anchorRows ?? []).length === 0,
        `被拒的请求还是把主播行插进去了：${JSON.stringify(after.json.sheets.find(s => s.name === SHEET)?.anchorRows)}`,
      )
      /** 再按重读的那份表核一遍表头位置：插入若真发生，表头会整体挪走 */
      const wb = await openWorkbook(fs.readFileSync(ws.fixture))
      const model = buildModel({ name: SHEET, xml: await wb.sheetXml(SHEET), shared: wb.shared })
      must(model.headerRow === headerRow && model.dataStart === headerRow + 1, `表头被挪了：headerRow=${model.headerRow} dataStart=${model.dataStart}`)
    } finally {
      if (editor) await editor.stop()
      ws.cleanup()
      fs.rmSync(syn.dir, { recursive: true, force: true })
    }
  })
}

/* ====== ⑤ 一根行号轴、两套序号：插一行之后排队区序号仍是 1..N（真表副本） ====== */

{
  const { SOURCE } = await import("./source.mjs")
  const { openWorkbook } = await shared("model/xlsx.js")
  const { buildModel } = await shared("model/schema.js")

  /** 真实表副本还是合成样本，写进用例名：复核时一眼看得出这次验的是哪份数据 */
  const sourceLabel = isRealTable(SOURCE) ? "维护者真实表副本" : "合成样本"
  const OWNER = { qq: "424242", nick: "主人甲" }
  const SHEET = "幽境危战"
  const ws = makeWorkspace("anchor-seq", { source: SOURCE })
  let editor = null
  try {
    const adminsFile = ws.file("admins.json")
    fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")

    /**
     * 往副本里注入一条"用公式确定格式"的条件格式（Excel 的真实写法：引用 + 引号里的字面量）
     *
     * 真实表与空模板本来那条是字面量 `<formula>排队中</formula>`（没有行号可搬），光靠它
     * "搬 cfRule 公式里的行号"这条逻辑等于没被验到；注入之后两件事都能钉住：
     *   - `$H<dataStart>` 必须跟着下移一格（不搬就指着上一行）；
     *   - 引号里的 `"绝境(N6)"` 一个字符都不能动（`N6` 不是行号）。
     */
    const boot = await openWorkbook(fs.readFileSync(ws.fixture))
    const xmlBefore = await boot.sheetXml(SHEET)
    const base = buildModel({ name: SHEET, xml: xmlBefore, shared: boot.shared })
    const kBefore = Number(/<c r="A\d+"[^>]*>\s*<f[^>]*>=?ROW\(\)-(\d+)<\/f>/.exec(xmlBefore)?.[1])
    const xmlInjected = xmlBefore.replace(
      "<formula>排队中</formula></cfRule>",
      `<formula>排队中</formula></cfRule><cfRule type="expression" priority="2"><formula>$H${base.dataStart}="绝境(N6)"</formula></cfRule>`,
    )
    must(xmlInjected !== xmlBefore, "注入条件格式公式失败：表里没有那条字面量 cfRule")
    boot.setSheetXml(SHEET, xmlInjected)
    fs.writeFileSync(ws.fixture, await boot.toBuffer())

    editor = await startEditor({
      label: "序号独立",
      token: "anchor-seq-token",
      signKey: "anchor-seq-sign-key",
      adminsFile,
      args: ["--file", ws.fixture],
      env: {
        ABYSS_QUEUE_CONFIG: ws.cfg,
        ABYSS_EDITOR_VERSIONS_DIR: ws.file("versions"),
        ABYSS_EDITOR_TEST_PATHS: "1",
      },
    })

    const load = async () => (await editor.request("/api/data", { who: OWNER })).json
    const sheetOf = payload => payload.sheets.find(s => s.name === SHEET)

    await check(`插一行之后排队区序号仍是 1..N（${sourceLabel}；常量 +1、值不变而不是整体 +1）`, async () => {
      const before = await load()
      must(Number.isFinite(kBefore) && kBefore > 0, `前置：表里的序号公式不是 =ROW()-k：${JSON.stringify(kBefore)}`)
      const anchorsBefore = sheetOf(before).anchorRows ?? []
      const dataBefore = sheetOf(before).rows
      const seqBefore = dataBefore.map(r => String(r.seq))
      const dataRowsBefore = sheetOf(before).dataEnd - sheetOf(before).dataStart + 1
      must(anchorsBefore.length > 0 && dataBefore.length > 0 && dataRowsBefore > 0, "这份表里没有主播行 / 排队行，套件前提不成立")
      must(seqBefore[0] === "1", `前置：排队区第一个序号不是 1：${JSON.stringify(seqBefore.slice(0, 3))}`)

      const saved = await editor.request("/api/anchors", {
        who: OWNER,
        body: { sheet: SHEET, rows: [], added: [{ values: { name: "序号独立性甲" } }], version: before.version },
      })
      must(saved.json.ok && saved.json.inserted === 1, `新增主播失败：HTTP ${saved.status} ${JSON.stringify(saved.json)}`)

      const after = await load()
      const seqAfter = sheetOf(after).rows.map(r => String(r.seq))
      /**
       * ① 页面 / 模型看到的排队区序号：跟插行前**逐个相同**（不是整体 +1），且仍从 1 起
       *    —— 序号列显示的就是这个缓存值（`editor.html` 的 `values.seq`）
       */
      must(
        JSON.stringify(seqAfter) === JSON.stringify(seqBefore),
        `排队区序号跟着插行变了：${JSON.stringify(seqBefore.slice(0, 5))} → ${JSON.stringify(seqAfter.slice(0, 5))}`,
      )
      must(seqAfter.every((s, i) => s === String(i + 1)), `排队区序号不是从 1 起的 1..N：${JSON.stringify(seqAfter.slice(0, 5))}…`)

      /**
       * ② 原始 XML：`=ROW()-k` 的常量 +1（不 +1 时 Excel 一重算序号就从 2 开始），
       *    而缓存值仍等于"行号 − 常量"、逐行连起来正是 1..N（缓存不动 = 重算后还是同一个号）
       */
      const wb = await openWorkbook(fs.readFileSync(ws.fixture))
      const xmlAfter = await wb.sheetXml(SHEET)
      const kAfter = Number(/<c r="A\d+"[^>]*>\s*<f[^>]*>=?ROW\(\)-(\d+)<\/f>/.exec(xmlAfter)?.[1])
      must(kAfter === kBefore + 1, `序号公式的常量没跟着插行 +1：${kBefore} → ${kAfter}`)
      const cells = [...xmlAfter.matchAll(/<c r="A(\d+)"[^>]*>\s*<f[^>]*>=?ROW\(\)-(\d+)<\/f>\s*(?:<v>([^<]*)<\/v>)?/g)].map(m => ({
        row: Number(m[1]),
        k: Number(m[2]),
        v: m[3],
      }))
      const queue = cells.filter(c => c.row >= sheetOf(after).dataStart)
      must(queue.length === dataRowsBefore, `排队区（数据区）的序号格数量变了：${dataRowsBefore} → ${queue.length}`)
      const bad = queue.filter(c => Number(c.v) !== c.row - c.k)
      must(
        bad.length === 0,
        `有 ${bad.length} 行的序号缓存与"行号 − 常量"对不上（例如第 ${bad[0]?.row} 行：缓存 ${bad[0]?.v}、算式 ${bad[0] ? bad[0].row - bad[0].k : "-"}）`,
      )
      must(queue.every((c, i) => Number(c.v) === i + 1), `排队区序号不是 1..N：${JSON.stringify(queue.slice(0, 5).map(c => c.v))}…`)

      /** ③ 主播区自己那套：新主播接在最后一位下面，既有主播一位没动（两套序号各走各的轴） */
      const anchorsAfter = sheetOf(after).anchorRows ?? []
      must(anchorsAfter.length === anchorsBefore.length + 1, `主播数量没 +1：${anchorsBefore.length} → ${anchorsAfter.length}`)
      must(
        JSON.stringify(anchorsAfter.filter(a => a.name !== "序号独立性甲").map(a => [a.row, a.name])) ===
          JSON.stringify(anchorsBefore.map(a => [a.row, a.name])),
        `既有主播行被动了：${JSON.stringify(anchorsAfter.filter(a => a.name !== "序号独立性甲").map(a => [a.row, a.name]))}`,
      )

      /** ④ cfRule 公式：引用跟着下移一行，引号里的字面量一个字符都不能动 */
      const cf = /<conditionalFormatting[\s\S]*?<\/conditionalFormatting>/g.exec(xmlAfter)?.[0] ?? ""
      must(cf.includes(`<formula>$H${base.dataStart + 1}="绝境(N6)"</formula>`), `cfRule 公式里的行号没跟着下移：${cf}`)
      must(cf.includes("<formula>排队中</formula>"), `cfRule 里的字面量「排队中」被改坏了：${cf}`)
      must(!cf.includes(`$H${base.dataStart}="`), `cfRule 里还留着旧行号引用：${cf}`)
    })
  } catch (err) {
    await check("真表副本那一截", async () => {
      throw err
    })
  } finally {
    if (editor) await editor.stop()
    ws.cleanup()
  }
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
