/**
 * 保存时的版本冲突（AQ-06 前端这一截）：页面接住 409
 *
 * 服务端已经做到"读到的表版本与提交时不一致 → HTTP 409、一个字都不写"（model/table.js 的
 * VersionConflict → editor.mjs 的 /api/save 翻成 409 + `{ ok:false, conflict:true }`）。
 * 前端缺的是收尾，一共三件事：
 *   1) 保存时把**读到的那一版表**带回去（`/api/data` 下发 `version`）：不带的话服务端永远
 *      不会报冲突，"不覆盖别人改动"这层保护形同虚设；
 *   2) 撞上 409 时说清楚"表被别人改过 / 你这次的改动没保存 / 草稿还在 / 不要直接覆盖"，
 *      并给一个可执行的下一步（「读取最新并对比」）；
 *   3) **不许**丢草稿（edited / added / anchorEdited 三类都算），**不许**自动重试保存
 *      （自动重试等于拿基于旧表算出来的整行值去覆盖别人刚提交的改动），也**不许**顺手自动
 *      重读（`load()` 会把草稿一并清掉）。
 *
 * 口径与 client-state.test.mjs 完全一致：把 `editor.html` 的内联脚本原样抽出来，在 node:vm 里
 * 跑，桩掉 fetch 与最小 DOM，断言"真实处理器发出去的请求 + 用户看得见的提示"，不碰真实表格。
 * 最后另起一截端到端（真编辑器 + 空模板副本）：钉住"页面带回去的那一版，服务端真的认"——
 * 桩里的服务端永远照单全收，这一条只有真服务端能证明。
 *
 * 用法：node editor/test/save-conflict.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

const HTML = path.join(import.meta.dirname, "..", "editor.html")
const html = fs.readFileSync(HTML, "utf8")

/** 页面里的内联脚本（按顺序、同一个上下文跑，与浏览器一致）；不带 src 的才算 */
const SCRIPTS = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])
if (!SCRIPTS.length) throw new Error(`${HTML} 里抽不出内联脚本——套件的前提没了`)

/* ------------------------------ 最小 DOM ------------------------------ */

/**
 * 与 client-state.test.mjs 相同的口径：只实现 editor.html 真正用到的那点 API
 * （classList 与 className 共用一份集合，因为页面两种写法都用）
 */
function makeEl(tag = "div") {
  const classes = new Set()
  const el = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    attrs: {},
    dataset: {},
    style: {},
    value: "",
    title: "",
    textContent: "",
    placeholder: "",
    type: "",
    disabled: false,
    parentNode: null,
    _html: "",
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : Boolean(on)
        if (want) classes.add(c)
        else classes.delete(c)
        return want
      },
    },
    get className() {
      return [...classes].join(" ")
    },
    set className(v) {
      classes.clear()
      String(v ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach(c => classes.add(c))
    },
    get innerHTML() {
      return el._html
    },
    set innerHTML(v) {
      el._html = String(v ?? "")
      el.childNodes = []
    },
    appendChild(child) {
      child.parentNode = el
      el.childNodes.push(child)
      return child
    },
    append(...kids) {
      kids.forEach(k => el.appendChild(k))
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v)
    },
    getAttribute(k) {
      return el.attrs[k] ?? null
    },
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    remove() {
      const at = el.parentNode?.childNodes.indexOf(el) ?? -1
      if (at >= 0) el.parentNode.childNodes.splice(at, 1)
    },
  }
  return el
}

const makeStorage = () => {
  const box = new Map()
  return {
    getItem: k => (box.has(k) ? box.get(k) : null),
    setItem: (k, v) => box.set(k, String(v)),
    removeItem: k => box.delete(k),
  }
}

/* ------------------------------ 桩数据 ------------------------------ */

/** 与 editor.mjs 的 FIELDS 同口径（字段顺序就是列顺序，假 DOM 靠它找格子） */
const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]
const OPTIONS = {
  anchor: ["阿修Axiu", "听雨"],
  goal: ["困难满花", "险恶(N4)"],
  strength: ["高配", "中配", "低配"],
  status: ["等待开启", "排队中", "本人已完成"],
}

/**
 * 两个榜（行号都从第 10 行起，与 client-state.test.mjs 同一份桩数据），
 * 外加 `version`：服务端下发的"这一版表的编号"，保存时要原样带回去。
 */
const makeData = (perm = { role: "admin", readonly: false }, version = "v1") => ({
  version,
  fields: FIELDS,
  roster: { candidates: [] },
  savedAt: "",
  perm,
  sheets: [
    {
      name: "剧诗",
      dataStart: 8,
      dataEnd: 20,
      taken: [10],
      defaults: { status: "排队中" },
      options: OPTIONS,
      anchors: OPTIONS.anchor,
      anchorRows: [{ row: 10, name: "阿修Axiu", recommend: "强烈推荐", duty: "剧诗", skills: "", platform: "B站", link: "" }],
      rows: [
        { row: 10, seq: 1, nickname: "甲", gameName: "甲的游戏", anchor: "阿修Axiu", goal: "困难满花", strength: "中配", note: "", status: "排队中" },
      ],
    },
    {
      name: "危战",
      dataStart: 8,
      dataEnd: 20,
      taken: [10],
      defaults: {},
      options: OPTIONS,
      anchors: OPTIONS.anchor,
      anchorRows: [{ row: 10, name: "听雨", recommend: "推荐", duty: "危战", skills: "", platform: "抖音", link: "" }],
      rows: [
        { row: 10, seq: 1, nickname: "乙", gameName: "乙的游戏", anchor: "听雨", goal: "险恶(N4)", strength: "高配", note: "", status: "" },
      ],
    },
  ],
})

/* ------------------------------ 开机 ------------------------------ */

const flush = () => new Promise(r => setImmediate(r))

/**
 * 跑一遍页面脚本，返回操作与观察用的把手
 *
 * @param {object} [opts]
 * @param {() => object} [opts.dataFor] 每次 GET /api/data 返回的桩数据（返回前会深克隆）
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.saveReply]
 *   第 n 次 POST /api/save 该怎么回（不给就回 200 成功）
 */
function boot({ dataFor = () => makeData(), saveReply = null } = {}) {
  const byId = new Map()
  const document = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: tag => makeEl(tag),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl("div"))
      return byId.get(id)
    },
    addEventListener() {},
  }

  const calls = []
  let saves = 0
  const jsonRes = payload => ({ status: 200, ok: true, json: async () => payload })
  const fetchStub = (url, opts) => {
    const u = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: opts?.method ?? "GET", body })
    if (u.includes("api/save")) {
      saves++
      const reply = saveReply?.(saves, body)
      if (reply) return { status: reply.status, ok: reply.status === 200, json: async () => reply.body }
      return jsonRes({ ok: true, written: body?.rows?.length ?? 0, cleared: 0, ignored: [], notices: [] })
    }
    if (u.includes("api/anchors")) return jsonRes({ ok: true, written: body?.rows?.length ?? 0, options: 0 })
    return jsonRes(structuredClone(dataFor()))
  }

  const ctx = {
    document,
    window: { addEventListener() {} },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { search: "", pathname: "/editor" },
    history: { replaceState() {} },
    fetch: fetchStub,
    /** note() 里的自动消失计时器：不跑真的（跑了提示就看不见了，也没法断言） */
    setTimeout: () => 0,
    confirm: () => true,
    console,
    URLSearchParams,
  }
  vm.createContext(ctx)
  vm.runInContext(
    SCRIPTS.join("\n;\n") +
      `
;globalThis.__client = {
  get data() { return data },
  get current() { return current },
  get perm() { return perm },
  get version() { return tableVersion },
  get conflict() { return conflict },
  get edited() { return edited },
  get added() { return added },
  get anchorEdited() { return anchorEdited },
}`,
    ctx,
    { filename: "editor.html" },
  )

  const el = id => document.getElementById(id)
  const grid = el("grid")
  /** grid → table → tbody → tr（页面就是这么拼的） */
  const gridRows = () => grid.childNodes[0]?.childNodes[1]?.childNodes ?? []
  /** tr 的第 i+1 个格子是第 i 个字段（第 0 个是序号列） */
  const cellOf = (tr, key) => tr.childNodes[FIELDS.findIndex(f => f.key === key) + 1]
  const controlOf = (tr, key) => cellOf(tr, key).childNodes[0]

  const h = {
    ctx,
    document,
    calls,
    get probe() {
      return ctx.__client
    },
    /** 页面上挂着的提示（toast）：`note()` 每句一个 div */
    toasts: () => el("toast").childNodes.map(n => n.textContent),
    /** 常驻的冲突提示条：页面用 style.display='' 表示显示（初始内联是 none） */
    conflictShown: () => el("conflict").style.display === "",
    /** 冲突提示条上的文字（标题 + 说明），用户真正看得见的那两行 */
    conflictText: () => el("conflictTitle").textContent + " " + el("conflictTip").textContent,
    async ready() {
      await flush()
      await flush()
    },
    /** 按表格行号找一行（序号列 title 里写着真实行号） */
    rowNo(row) {
      const tr = gridRows().find(x => x.childNodes[0].title === "表格第 " + row + " 行")
      if (!tr) throw new Error(`界面上没有第 ${row} 行`)
      return tr
    },
    newRow() {
      const tr = gridRows().find(x => x.className.includes("isnew"))
      if (!tr) throw new Error("界面上没有新增行")
      return tr
    },
    /** 文本框：页面把改动记在 onchange 上（离开这一格时触发） */
    type(tr, key, value) {
      const input = controlOf(tr, key)
      input.value = value
      if (typeof input.onchange !== "function") throw new Error(`${key} 这一格不是文本框`)
      input.onchange()
    },
    /** 界面上这一格现在显示的值（看草稿有没有被保住） */
    cellValue(row, key) {
      return controlOf(h.rowNo(row), key).value
    },
    /** 胶囊格（难度及目标 / 完成情况）：点「＋」开浮层，再点选项——走的是真实下拉路径 */
    pick(tr, key, option) {
      const td = cellOf(tr, key)
      const add = td.childNodes[0].childNodes.find(n => n.className.includes("addbtn"))
      if (!add) throw new Error(`${key} 这一格没有「＋」按钮`)
      add.onclick({ stopPropagation() {} })
      const opt = td.childNodes[1].childNodes.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === option)
      if (!opt) throw new Error(`${key} 的浮层里没有「${option}」`)
      opt.onclick({ stopPropagation() {} })
    },
    /** 主播列表：输入记在 oninput 上 */
    typeAnchor(sheetIndex, key, value) {
      h.tab(sheetIndex)
      const table = el("anchorGrid").childNodes[0]
      const tr = table.childNodes[1].childNodes[0]
      const col = ["name", "recommend", "skills", "platform"].indexOf(key)
      const input = tr.childNodes[col + 1].childNodes[0]
      input.value = value
      input.oninput()
    },
    tab(index) {
      const t = el("tabs").childNodes[index]
      if (!t) throw new Error(`没有第 ${index} 个标签`)
      t.onclick()
    },
    async click(id) {
      const fn = el(id).onclick
      if (typeof fn !== "function") throw new Error(`页面上没有 #${id} 的点击处理器`)
      await fn()
      await flush()
    },
    posts(part) {
      return calls.filter(c => c.method === "POST" && c.url.includes(part))
    },
    reads() {
      return calls.filter(c => c.method === "GET" && c.url.includes("api/data"))
    },
  }
  return h
}

/* ------------------------------ 断言 ------------------------------ */

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
/** 真被拒过的那次保存请求（没有就直接报"压根没发保存请求"） */
const firstSave = h => {
  const posts = h.posts("api/save")
  if (!posts.length) throw new Error(`没发保存请求（${h.calls.map(c => c.method + " " + c.url.split("?")[0]).join("、")}）`)
  return posts[0].body
}

/** 服务端 409：表在保存期间被别人改过，一个字都没写进去 */
const CONFLICT_409 = {
  status: 409,
  body: { ok: false, conflict: true, error: "表格在你保存期间被改过（别人先提交、或表被外部改动），请刷新页面确认后再改" },
}
const SAVE_OK = n => ({ status: 200, body: { ok: true, written: n, cleared: 0, ignored: [], notices: [] } })

/** 一次典型冲突场景：改一下第 10 行的备注，第一次保存回 409 */
const bootConflict = (opts = {}) => {
  const h = boot({ ...opts, saveReply: opts.saveReply ?? (n => (n === 1 ? CONFLICT_409 : SAVE_OK(1))) })
  return h
}

console.log("保存版本冲突（editor.html 原脚本 + 请求捕获）")

/* ------------------------- ① 提示说得清 ------------------------- */

await check("撞上 409：提示写明「被别人改过 / 这次没保存 / 草稿还在」，并给出下一步", async () => {
  const h = bootConflict()
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("save")

  const said = h.toasts().join("\n")
  must(/被别人改过|冲突/.test(said), `提示里看不出"冲突 / 被别人改过"：${JSON.stringify(said)}`)
  must(/没有保存|没保存|未保存/.test(said), `提示里没说清"这次的改动没保存"：${JSON.stringify(said)}`)
  must(/草稿还在/.test(said), `提示里没说草稿还在（用户不敢继续改）：${JSON.stringify(said)}`)
  must(/不要直接覆盖|不要直接再点保存/.test(said), `提示里没讲"不要直接覆盖"：${JSON.stringify(said)}`)
  must(/读取最新并对比/.test(said), `提示里没给出可执行的下一步：${JSON.stringify(said)}`)
  /** 服务端那句"请刷新页面确认后再改"照抄过来会把人坑了：草稿只在内存里，刷新一次全丢 */
  must(!/请刷新|刷新页面确认/.test(said), `提示在叫用户去刷新页面（刷新会把草稿全丢）：${JSON.stringify(said)}`)
})

await check("409 之后：常驻的冲突提示条 + 可点的「读取最新并对比」入口", async () => {
  const h = bootConflict()
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("save")
  /** toast 几秒就没了，冲突这种必须用户处理的得常驻 */
  must(h.conflictShown(), "冲突提示条没有显示（只弹了个会自己消失的 toast）")
  must(/被别人改过|冲突/.test(h.conflictText()), `提示条上没写清冲突：${JSON.stringify(h.conflictText())}`)
  must(/草稿还在/.test(h.conflictText()), `提示条上没说草稿还在：${JSON.stringify(h.conflictText())}`)
  const btn = h.document.getElementById("conflictReload")
  must(typeof btn.onclick === "function", "提示条上没有「读取最新并对比」这个入口")
})

/* ------------------------- ② 草稿一个字都不许丢 ------------------------- */

await check("409 之后：edited / added / anchorEdited 三类草稿都还在", async () => {
  const h = bootConflict()
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注") // edited
  h.typeAnchor(0, "skills", "我改的强项") // anchorEdited
  await h.click("addRow")
  const tr = h.newRow() // added
  h.type(tr, "nickname", "新人丙")
  h.type(tr, "gameName", "丙的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")

  await h.click("save")
  const sent = firstSave(h)
  must(sent.rows.length === 2, `第一次保存应带上 2 行（改过的第 10 行 + 新增行），实际 ${sent.rows.length} 行`)

  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "冲突把 edited 里的草稿弄丢了")
  must(h.probe.added.length === 1, "冲突把新增行弄丢了")
  must(h.probe.anchorEdited.size === 1, "冲突把主播列表的草稿弄丢了")
  /** 界面上也还是用户填的内容（别看着像被清空了） */
  must(h.cellValue(10, "note") === "我的备注", `界面上第 10 行的备注变成了 ${JSON.stringify(h.cellValue(10, "note"))}`)
})

await check("409 之后不自动重试、也不自动重读；用户再点保存，原改动照样带着", async () => {
  const h = bootConflict({ saveReply: n => (n === 1 ? CONFLICT_409 : SAVE_OK(2)) })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("addRow")
  const tr = h.newRow()
  h.type(tr, "nickname", "新人丙")
  h.type(tr, "gameName", "丙的游戏")
  h.pick(tr, "anchor", "阿修Axiu")
  h.pick(tr, "goal", "困难满花")

  await h.click("save")
  must(h.posts("api/save").length === 1, `被 409 拒了之后自动重试了保存：一共发了 ${h.posts("api/save").length} 个 /api/save（重试会拿旧表算出来的整行值覆盖别人）`)
  must(h.reads().length === 1, `被 409 拒了之后自动重读了表：一共读了 ${h.reads().length} 次（load() 会把草稿清掉）`)

  /** 用户自己再点一次：这次服务端接受了 */
  await h.click("save")
  const posts = h.posts("api/save")
  must(posts.length === 2, `用户手动再保存时应当只有这一发，实际 ${posts.length} 发`)
  const again = posts[1].body
  must(again.rows.length === 2, `再保存应当还是那两行，实际 ${again.rows.length} 行`)
  must(again.rows[0].values.note === "我的备注", `再保存时第 10 行的备注丢了：${JSON.stringify(again.rows[0].values.note)}`)
  must(again.rows[1].values.nickname === "新人丙", `再保存时新增行丢了：${JSON.stringify(again.rows[1]?.values)}`)
  must(!h.conflictShown(), "保存成功了，冲突提示条还挂着")
})

/* ------------------- ③ 带上读到的版本（不然 409 永远不会发生） ------------------- */

await check("保存请求带上面里读到的那一版表（服务端才有得比）", async () => {
  const h = boot()
  await h.ready()
  must(h.probe.version === "v1", `页面没记住读到的版本：tableVersion=${JSON.stringify(h.probe.version)}`)
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("save")
  const sent = firstSave(h)
  must(sent.version === "v1", `保存请求里的 version 是 ${JSON.stringify(sent.version)}，应当带上页面读到的那一版 v1`)
})

/* ------------------- ④ 下一步真的能用：读取最新并对比 ------------------- */

await check("「读取最新并对比」：拉到最新表、草稿还在、把别人改了哪一格列出来", async () => {
  const server = makeData()
  const h = boot({
    dataFor: () => server,
    saveReply: n => (n === 1 ? CONFLICT_409 : SAVE_OK(1)),
  })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  /** 另一个窗口在这中间改了同一行的备注（表因此换了版本） */
  server.version = "v2"
  server.sheets[0].rows[0].note = "别人改的备注"
  await h.click("save") // → 409

  await h.click("conflictReload")
  must(h.posts("api/save").length === 1, "「读取最新并对比」不该顺手再发一次保存（那是自动覆盖）")
  must(h.reads().length === 2, `应当重新读一次表，实际读了 ${h.reads().length} 次`)
  must(h.probe.version === "v2", `重读后没更新手里的版本：${JSON.stringify(h.probe.version)}`)

  /** 别人改了什么，得看得见 */
  const diff = h.document.getElementById("conflictDiff").textContent
  must(/备注/.test(diff), `对比里没写出别人改的是哪一格：${JSON.stringify(diff)}`)
  must(/别人改的备注/.test(diff), `对比里没写出别人改成了什么：${JSON.stringify(diff)}`)

  /** 草稿还在：界面上仍是我输入的，重新保存时也带着 */
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "对比时把草稿弄丢了")
  must(h.cellValue(10, "note") === "我的备注", `对比后界面上我的备注不见了：${JSON.stringify(h.cellValue(10, "note"))}`)

  await h.click("save")
  const again = h.posts("api/save")[1].body
  must(again.version === "v2", `重读后再保存，带的还是旧版本 ${JSON.stringify(again.version)}`)
  must(again.rows[0].values.note === "我的备注", `重读后再保存，我的改动没了：${JSON.stringify(again.rows[0].values.note)}`)
  must(!h.conflictShown(), "保存成功后冲突提示条应当收起来")
})

/* ------------------- ⑤ 别的错误码照旧（别顺手改） ------------------- */

await check("400（普通失败）照旧：只报「保存失败：原因」，不摆冲突提示条", async () => {
  const h = boot({ saveReply: () => ({ status: 400, body: { ok: false, error: "校验未通过：第 10 行：选择主播不能为空" } }) })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("save")

  const said = h.toasts().join("\n")
  must(/保存失败/.test(said), `400 的提示文案变了：${JSON.stringify(said)}`)
  must(/选择主播不能为空/.test(said), `服务端给的原因没透出来：${JSON.stringify(said)}`)
  must(!h.conflictShown(), "普通失败也当成了版本冲突（提示条不该出现）")
  must(h.posts("api/save").length === 1, "400 之后不该再发保存请求")
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "普通失败把草稿弄丢了")
})

await check("403（口令失效）照旧：提示去群里重取链接", async () => {
  const h = boot({ saveReply: () => ({ status: 403, body: { ok: false, error: "口令无效" } }) })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("save")
  const said = h.toasts().join("\n")
  must(/#排队/.test(said), `403 的提示文案变了：${JSON.stringify(said)}`)
  must(!h.conflictShown(), "403 不该显示版本冲突提示条")
})

await check("网络失败（fetch 抛异常）照旧：报「保存失败」", async () => {
  const h = boot({
    saveReply: () => {
      throw new Error("Failed to fetch")
    },
  })
  await h.ready()
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("save")
  const said = h.toasts().join("\n")
  must(/保存失败/.test(said) && /Failed to fetch/.test(said), `网络失败的提示变了：${JSON.stringify(said)}`)
  must(!h.conflictShown(), "网络失败不该显示版本冲突提示条")
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "网络失败把草稿弄丢了")
})

/* ---------- ⑥ 端到端：页面手里的那一版，服务端真的认（起真编辑器；缺模板就跳过） ---------- */

/**
 * 上面那一截的 fetch 是桩，"服务端照单全收"，所以证明不了"页面带回去的版本服务端真的认"。
 * 这一截起一个真编辑器，按页面的口径走一遍：`/api/data` 拿 version → 原样带回去保存。
 * 必须 200 —— 要是版本对不上，加上 version 之后**每一次保存都会变成 409**，
 * 那就成了比改动前更糟的回归。顺带钉住"别人先提交 → 我手里这版被 409 拒掉、且一个字不落表"。
 *
 * 动态 import：上半截（纯 vm）不依赖插件目录与模板，缺前置时这一截自己跳过。
 */
{
  const harness = await import("./harness.mjs").catch(() => null)
  if (!harness || !fs.existsSync(harness.TEMPLATE)) {
    console.log("  ⏭ 缺空模板（或插件目录），跳过端到端那一截：页面口径的版本往返没验")
  } else {
    const OWNER = { qq: "424242", nick: "主人" }
    const TOKEN = "save-conflict-token"
    const SIGN_KEY = "save-conflict-sign-key"
    const SHEET = "幽境危战"
    const ws = harness.makeWorkspace("save-conflict")
    const adminsFile = ws.file("admins.json")
    fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
    let editor = null
    try {
      editor = await harness.startEditor({
        label: "版本往返",
        ports: [7826, 7827, 7828],
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

      const load = async () => (await editor.request("/api/data", { who: OWNER })).json
      const rowOf = async (row) => {
        const d = await load()
        return d.sheets.find(s => s.name === SHEET)?.rows.find(r => r.row === row)
      }
      const payload = await load()
      const sheet = payload.sheets.find(s => s.name === SHEET)
      if (!sheet) {
        console.log(`  ⏭ 空模板里没有「${SHEET}」这个榜，跳过端到端那一截`)
      } else {
        const row = sheet.dataStart
        const anchor = (sheet.options?.anchor ?? [])[0] ?? "都可以"
        const goal = (sheet.options?.goal ?? [])[0] ?? "N5"
        const values = { nickname: "版本甲", gameName: "游戏", anchor, goal, note: "页面带版本存的" }

        await check("端到端：页面读到的那一版带回去保存，服务端认（不是 409）", async () => {
          const v = payload.version
          must(typeof v === "string" && v.length > 0, `/api/data 没下发 version：${JSON.stringify(v)}`)
          const saved = await editor.request("/api/save", { who: OWNER, body: { sheet: SHEET, rows: [{ row, values }], version: v } })
          must(saved.json.ok, `带着自己刚读到的版本保存被拒了（HTTP ${saved.status}）：${JSON.stringify(saved.json)}`)
          must((await rowOf(row))?.note === "页面带版本存的", "保存成功了，表里却没写进去")
        })

        await check("端到端：写成功之后版本会变（下一次带旧版本就冲突）", async () => {
          const v1 = payload.version
          const now = await load()
          must(now.version !== v1, `写表前后版本一样（${v1}），冲突检测会失效`)
        })

        await check("端到端：别人先提交，我手里这版被 409 拒掉，一个字都不落表", async () => {
          const mine = (await load()).version
          /** 另一个窗口：请求里不带版本号（或已重读过的窗口）先写进去 */
          const other = await editor.request("/api/save", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row, values: { ...values, note: "别人先改的" } }] },
          })
          must(other.json.ok, `先提交的那个不该被拒：${JSON.stringify(other.json)}`)
          const rejected = await editor.request("/api/save", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row, values: { ...values, note: "不该落地" } }], version: mine },
          })
          must(rejected.status === 409 && rejected.json.conflict === true, `期望 409 冲突，实际 HTTP ${rejected.status} ${JSON.stringify(rejected.json)}`)
          must(rejected.json.error, "409 里没给原因")
          must((await rowOf(row))?.note === "别人先改的", `被拒的保存落表了：${JSON.stringify((await rowOf(row))?.note)}`)
        })
      }
    } catch (err) {
      await check("端到端那一截", async () => {
        throw err
      })
    } finally {
      if (editor) await editor.stop()
      ws.cleanup()
    }
  }
}

console.log(failed ? `\n❌ 保存版本冲突验证失败 ${failed} 项` : "\n✅ 保存版本冲突验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
