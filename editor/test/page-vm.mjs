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
      /** 真 DOM 认字符串（追加文本节点）；这里也认——`el.append(name)` 这种写法页面在用 */
      if (typeof child === "string" || typeof child === "number") {
        el.textContent += String(child)
        return child
      }
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
 * 假计时器：页面里的**防抖**（自动保存那 1.5 秒）与 `note()` 的自动消失都靠它
 *
 * 为什么要能控制时间：自动保存的判据就是"改完等 1.5 秒才发请求、连着改只发一次"，
 * 用真计时器测就得让套件真的睡 1.5 秒（还测不准"没到点不会发"）；这里把时钟交出来，
 * `advance(1499)` 与 `advance(1)` 的差别才是可断言的。默认（不传）仍是"计时器不跑"，
 * 既有两个套件的口径一字未变。
 *
 * 语义与浏览器一致：到点的回调按**到期时间**顺序跑；回调里再排的计时器照常参与本轮推进。
 */
export function makeFakeTimers() {
  let seq = 0
  let now = 0
  const jobs = new Map()
  return {
    setTimeout(fn, ms = 0) {
      const id = ++seq
      const at = now + Math.max(0, Number(ms) || 0)
      jobs.set(id, { fn, at })
      return id
    },
    clearTimeout(id) {
      jobs.delete(id)
    },
    /** 把时钟往前推 ms（按到期顺序把该跑的回调跑完） */
    advance(ms = 0) {
      const until = now + Math.max(0, Number(ms) || 0)
      for (;;) {
        const due = [...jobs.entries()].filter(([, j]) => j.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        if (!due.length) break
        const [id, job] = due[0]
        jobs.delete(id)
        now = job.at
        job.fn()
      }
      now = until
    },
    /** 还没到点的计时器有几个（断言"防抖被重排了/清掉了"用） */
    get pending() {
      return jobs.size
    },
    get now() {
      return now
    },
  }
}

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
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.adminsReply] 第 n 次 /api/admins 该怎么回（默认一份"只有 QQ"的白名单）
 * @param {() => {status:number, body:object}} [opts.versionReply] GET /api/version 该怎么回（**实时刷新的探测**要读它）；
 *        不给就照旧回整份数据（老口径：既有两个套件不探版本，行为一字未变）
 * @param {() => boolean} [opts.confirm] 二次确认对话框的答案（默认一律"确定"）
 * @param {object} [opts.timers] 假计时器（`makeFakeTimers()`）；不给就"计时器不跑"，与既有套件口径一致
 */
export function bootPage({
  dataFor = () => makeData(),
  saveReply = null,
  anchorReply = null,
  ownershipReply = null,
  versionsReply = null,
  restoreReply = null,
  adminsReply = null,
  versionReply = null,
  confirm = () => true,
  timers = null,
} = {}) {
  const byId = new Map()
  /** `document` 上注册的监听（页面挂 `visibilitychange` 用）：套件要能显式触发它们 */
  const docListeners = {}
  const document = {
    head: makeEl("head"),
    body: makeEl("body"),
    /** 页面不在前台时不该去探测（省电省流量）——套件把它设成 true 就能验这条 */
    hidden: false,
    createElement: tag => makeEl(tag),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl("div"))
      return byId.get(id)
    },
    addEventListener(type, fn) {
      ;(docListeners[type] ??= []).push(fn)
    },
  }

  const calls = []
  let saves = 0
  let anchors = 0
  let rebuilds = 0
  let restores = 0
  let admins = 0
  /**
   * 假响应**与真 fetch 同形**：`json()` 之外也给 `text()` 与 `headers.get()`
   *
   * 页面读响应体走 `jsonOf(res)`（先 `text()` 再自己 `JSON.parse`，这样才认得出"拿到的是 HTML"），
   * 并从 `x-abyss-device` 响应头取设备令牌；桩少这两样等于在考自己假 DOM 的形状。
   */
  /** 任意状态码的假响应（与 `jsonRes` 同形）：套件用 `saveReply` 一类回非 200 时走它 */
  const resOf = (status, payload) => ({
    status,
    ok: status === 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  })
  const jsonRes = payload => resOf(200, payload)
  const fetchStub = (url, opts) => {
    const u = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: opts?.method ?? "GET", body })
    if (u.includes("api/save")) {
      saves++
      const reply = saveReply?.(saves, body)
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true, written: body?.rows?.length ?? 0, cleared: 0, ignored: [], notices: [] })
    }
    if (u.includes("api/anchors")) {
      anchors++
      const reply = anchorReply?.(anchors, body)
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true, written: body?.rows?.length ?? 0, options: 0 })
    }
    if (u.includes("api/ownership")) {
      if (opts?.method === "POST") {
        rebuilds++
        const reply = ownershipReply?.(rebuilds, body)
        if (reply) return resOf(reply.status, reply.body)
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
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true, versions: [], archives: [], keep: 20, archiveDays: 7, dir: "（桩）", archivesDir: "（桩）" })
    }
    if (u.includes("api/restore")) {
      restores++
      const reply = restoreReply?.(restores, body)
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true })
    }
    /**
     * 表版本（实时刷新的探测）
     *
     * **不给 `versionReply` 就照旧回整份数据**：既有两个套件里没有任何一条走这条路
     * （页面那时还不探版本），但保持"默认行为与从前一致"这条纪律比"顺手改成新形状"重要。
     */
    if (u.includes("api/version")) {
      const reply = versionReply?.()
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes(structuredClone(dataFor()))
    }
    if (u.includes("api/admins")) {
      admins++
      const reply = adminsReply?.(admins, body)
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true, admins: [], owners: [], env: [], file: [], ignored: [], suggestions: {} })
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
    /**
     * 页面里的计时器：不给假计时器就一律"不跑"——`note()` 的自动消失计时器跑了提示就看不见了，
     * 也没法断言（既有两个套件就靠这个口径）。要测防抖的套件传 `timers: makeFakeTimers()`。
     */
    setTimeout: timers ? timers.setTimeout : () => 0,
    clearTimeout: timers ? timers.clearTimeout : () => {},
    confirm,
    console,
    URLSearchParams,
    /** 页面用 `AbortController` 给 fetch 加 15 秒超时（审核 B-04）：真实浏览器与 Node 18+ 都有，vm 里得显式给 */
    AbortController,
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
  /** 实时刷新：探测到但还没合并的远端版本 / 两边都改过的行 / 被行级冲突挂起的行 */
  get pollFail() { return pollFail },
  get clashes() { return [...rowClashes.keys()] },
  get blocked() { return [...blockedRows] },
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
  /** 面板里一个个胶囊（含主人 / 白名单 / 无效条目），给断言用 */
  const adminTags = () => {
    const out = []
    const walk = node => {
      for (const n of node.childNodes ?? []) {
        if (n.className?.includes?.('tag')) out.push(n)
        walk(n)
      }
    }
    walk(el("adminList"))
    return out
  }
  /** 一个胶囊上看得见的文字（名称 + 「主人」/「不是权限」这类标记） */
  const tagText = tag => (tag.textContent || '') + (tag.childNodes ?? []).map(n => n.textContent || '').join('')

  const h = {
    ctx,
    document,
    calls,
    /** 按 id 取假 DOM 元素（编辑器按 id 取过的都在） */
    el,
    /** 「权限管理」面板里的胶囊（主人 / 白名单 / 无效条目各一个） */
    adminTags,
    tagText,
    /** 触发 `document` 上的监听（页面把 `visibilitychange` 挂在这里） */
    fire(type) {
      for (const fn of docListeners[type] ?? []) fn()
    },
    /** 实时刷新那一行的轻提示现在写着什么（`#liveHint` 的可见文字） */
    liveText() {
      return (el("liveHint").textContent || "") + (el("liveHint").childNodes ?? []).map(n => n.textContent || "").join("")
    },
    /** `#liveHint` 里那一行里的按钮（「用表里的 / 保留我的」） */
    liveButtons() {
      const box = el("liveHint")
      const out = []
      const walk = node => {
        for (const n of node.childNodes ?? []) {
          if (n.tagName === "BUTTON") out.push(n)
          walk(n)
        }
      }
      walk(box)
      return out
    },
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
      /** 候选在浮层里的 `.opts` 那一层（底部「＋ 收录新名字」在它外面，见 editor.html 的 .picker .opts） */
      const opt = td.childNodes[1].childNodes[0].childNodes.find(n => (n.childNodes[0]?.textContent ?? n.textContent) === option)
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
