/**
 * 编辑器前端的 node:vm 脚手架（**新增套件共用**，不下场跑真浏览器）
 *
 * 口径与 `client-state.test.mjs` / `save-conflict.test.mjs` 完全一致：把 `editor.html` 里的
 * 内联脚本原样抽出来，在 node:vm 里跑，桩掉 fetch 与最小 DOM，断言"真实处理器发出去的请求 +
 * 用户看得见的提示"，不碰任何真实表格。
 *
 * 为什么要单独抽一份：冲突提示、草稿保留、重新读取这几件事服务端测不到（它们全在页面状态里），
 * 而每加一条这样的回归就复制一遍两百行假 DOM，等于把"页面到底用了哪些 DOM API"散在多处，
 * 改页面时总有一份忘了跟。新增套件统一 import 这里；既有两个套件保持原样（它们各自那套已经稳定）。
 *
 * 只实现 editor.html 真正用到的那点 API：多了就是在测自己的假 DOM，不是在测页面。
 */
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

export const HTML = path.join(import.meta.dirname, "..", "editor.html")
const html = fs.readFileSync(HTML, "utf8")

/** 页面里的内联脚本（按顺序、同一个上下文跑，与浏览器一致）；不带 src 的才算 */
export const SCRIPTS = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])
if (!SCRIPTS.length) throw new Error(`${HTML} 里抽不出内联脚本——套件的前提没了`)

/** 与 editor.mjs 的 FIELDS 同口径（字段顺序就是列顺序，假 DOM 靠它找格子） */
export const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "strength", label: "账号强度", option: "strength" },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]
export const OPTIONS = {
  anchor: ["阿修Axiu", "听雨"],
  goal: ["困难满花", "险恶(N4)"],
  strength: ["高配", "中配", "低配"],
  status: ["等待开启", "排队中", "本人已完成"],
}

/** 主播列表的四列（与 editor.html 的 ANCHOR_COLS 一致，假 DOM 按它找格子） */
export const ANCHOR_COLS = ["name", "recommend", "skills", "platform"]

/**
 * 两个榜（行号都从第 10 行起，与 client-state / save-conflict 同一份桩数据），
 * `version` 是服务端下发的"这一版表的编号"，保存时要原样带回去。
 */
export const makeData = (perm = { role: "admin", readonly: false }, version = "v1") => ({
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

/* ------------------------------ 最小 DOM ------------------------------ */

/** classList 与 className 共用一份集合，因为页面两种写法都用 */
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

const flush = () => new Promise(r => setImmediate(r))

/**
 * 跑一遍页面脚本，返回操作与观察用的把手
 *
 * @param {object} [opts]
 * @param {() => object} [opts.dataFor] 每次 GET /api/data 返回的桩数据（返回前会深克隆）
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.saveReply] 第 n 次 POST /api/save 该怎么回
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.anchorReply] 第 n 次 POST /api/anchors 该怎么回
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.ownershipReply] 第 n 次 POST /api/ownership 该怎么回
 * @param {() => {status:number, body:object}} [opts.versionsReply] GET /api/versions 该怎么回（回退按钮要读它）
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.restoreReply] 第 n 次 POST /api/restore 该怎么回
 * @param {() => boolean} [opts.confirm] 二次确认对话框的答案（默认一律"确定"）
 */
export function bootPage({
  dataFor = () => makeData(),
  saveReply = null,
  anchorReply = null,
  ownershipReply = null,
  versionsReply = null,
  restoreReply = null,
  confirm = () => true,
} = {}) {
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
  let anchors = 0
  let rebuilds = 0
  let restores = 0
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
    if (u.includes("api/anchors")) {
      anchors++
      const reply = anchorReply?.(anchors, body)
      if (reply) return { status: reply.status, ok: reply.status === 200, json: async () => reply.body }
      return jsonRes({ ok: true, written: body?.rows?.length ?? 0, options: 0 })
    }
    if (u.includes("api/ownership")) {
      if (opts?.method === "POST") {
        rebuilds++
        const reply = ownershipReply?.(rebuilds, body)
        if (reply) return { status: reply.status, ok: reply.status === 200, json: async () => reply.body }
        return jsonRes({ ok: true, kept: 0, moved: 0, dropped: 0, unconfirmed: 0, missing: 0, locks: { kept: 0, dropped: 0 } })
      }
      return jsonRes({
        ok: true,
        version: "v1",
        bindings: { table: "v1", stale: false, count: 0 },
        locks: { table: "v1", stale: false, count: 0, rows: [] },
        roster: { group: "测试群", updatedAt: 0, count: 0 },
        sheets: [],
      })
    }
    if (u.includes("api/versions")) {
      const reply = versionsReply?.()
      if (reply) return { status: reply.status, ok: reply.status === 200, json: async () => reply.body }
      return jsonRes({ ok: true, versions: [], archives: [], keep: 20, archiveDays: 7, dir: "（桩）", archivesDir: "（桩）" })
    }
    if (u.includes("api/restore")) {
      restores++
      const reply = restoreReply?.(restores, body)
      if (reply) return { status: reply.status, ok: reply.status === 200, json: async () => reply.body }
      return jsonRes({ ok: true })
    }
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
    confirm,
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
  get anchorAdded() { return anchorAdded },
}`,
    ctx,
    { filename: "editor.html" },
  )

  const el = id => document.getElementById(id)
  const grid = el("grid")
  /** grid → table → tbody → tr（页面就是这么拼的） */
  const gridRows = () => grid.childNodes[0]?.childNodes[1]?.childNodes ?? []
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
    /** 常驻提示条：页面用 style.display='' 表示显示（初始内联是 none） */
    conflictShown: () => el("conflict").style.display === "",
    /** 提示条上的文字（标题 + 说明），用户真正看得见的那两行 */
    conflictText: () => el("conflictTitle").textContent + " " + el("conflictTip").textContent,
    conflictDiff: () => el("conflictDiff").textContent,
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
    /** 胶囊格：点「＋」开浮层，再点选项——走的是真实下拉路径 */
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
      const input = tr.childNodes[ANCHOR_COLS.indexOf(key) + 1].childNodes[0]
      input.value = value
      input.oninput()
    },
    /** 界面上主播列表这一格现在显示的值 */
    anchorValue(sheetIndex, key) {
      h.tab(sheetIndex)
      const tr = el("anchorGrid").childNodes[0].childNodes[1].childNodes[0]
      return tr.childNodes[ANCHOR_COLS.indexOf(key) + 1].childNodes[0].value
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
