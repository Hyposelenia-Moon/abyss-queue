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
 *
 * 口径：上半截把 `editor.html` 的内联脚本原样抽出来在 node:vm 里跑（桩 fetch + 最小 DOM）；
 * 下半截起一个真编辑器（空模板副本），因为"表里真的多了一行"只有真服务端 + 真文件能证明。
 *
 * 用法：node editor/test/anchor-add.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import { bootPage, makeData, ANCHOR_COLS } from "./page-vm.mjs"
import { shared } from "./plugin.mjs"
import { makeWorkspace, startEditor, TEMPLATE } from "./harness.mjs"

const { createChecker } = await shared("test/_helper.mjs")
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

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
