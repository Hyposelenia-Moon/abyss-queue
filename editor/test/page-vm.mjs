/**
 * 编辑器前端的 node:vm 脚手架（**套件共用**，不下场跑真浏览器）
 *
 * 把 `editor.html` 里的内联脚本原样抽出来，在 node:vm 里跑，桩掉 fetch 与最小 DOM，
 * 断言"真实处理器发出去的请求 + 用户看得见的文字"，不碰任何真实表格。
 *
 * 2026-11-23：页面从 `<table>` 重写成 `<div class="tr">` + 九页结构后，这里的假 DOM 也跟着换成
 * `fake-dom.mjs`（真解析 `innerHTML`、真支持 `querySelector(All)`/`closest`）。
 * 旧版对 `innerHTML` 只存字符串，而新页面把整张表、六个面板、选择器全走 `innerHTML`，
 * 桩里一个节点都取不到，套件就只会报 `document.querySelectorAll is not a function`。
 *
 * 只实现 editor.html 真正用到的那点 API：多了就是在测自己的假 DOM，不是在测页面。
 */
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { makeDocument, makeEl } from "./fake-dom.mjs"

export const HTML = path.join(import.meta.dirname, "..", "editor.html")
const html = fs.readFileSync(HTML, "utf8")

/** 页面里的内联脚本（按顺序、同一个上下文跑，与浏览器一致）；不带 src 的才算 */
export const SCRIPTS = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])
if (!SCRIPTS.length) throw new Error(`${HTML} 里抽不出内联脚本——套件的前提没了`)

/**
 * 静态 body（去掉内联脚本）：假 DOM 拿它搭出真正的节点树
 *
 * 页面用 `document.getElementById` 取容器、用 `querySelectorAll('.page')` 切页、
 * 用 `#nav .g` 收空分组——这些都必须有节点才跑得通。
 */
export const BODY_HTML = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, ""])[1]
  .replace(/<script[\s\S]*?<\/script>/gi, "")

/** 与 editor.mjs 的 FIELDS 同口径（字段顺序就是列顺序，假 DOM 靠它找格子） */
export const FIELDS = [
  { key: "nickname", label: "群昵称", required: true },
  { key: "gameName", label: "原神游戏名", required: true },
  { key: "anchor", label: "选择主播", option: "anchor", multi: true, required: true },
  { key: "goal", label: "难度及目标", option: "goal", required: true },
  { key: "note", label: "备注" },
  { key: "status", label: "帮帮完成情况", option: "status", multi: true },
]
export const OPTIONS = {
  anchor: ["阿修Axiu", "听雨"],
  goal: ["困难模式满星章", "险恶(N4)"],
  status: ["等待开启", "排队中", "本人已完成"],
}

/** 新页面每行是 8 个 span，顺序与表头一致（见 editor.html 的 HEADERS） */
export const COLUMNS = ["seq", "nickname", "gameName", "anchor", "goal", "note", "status", "call"]

const makeStorage = () => {
  const box = new Map()
  return {
    getItem: k => (box.has(k) ? box.get(k) : null),
    setItem: (k, v) => box.set(k, String(v)),
    removeItem: k => box.delete(k),
    get size() {
      return box.size
    },
  }
}

const flush = () => new Promise(r => setImmediate(r))

/**
 * 两个榜（行号都从第 10 行起），`version` 是服务端下发的"这一版表的编号"，保存时要原样带回去。
 *
 * 字段形状与 `editor.mjs` 的 `buildPayload` 同构：每行有 `row/seq/…/fp`，
 * 每榜有 `name/title/dataStart/dataEnd/options/anchorRows/rows`。
 */
export const makeData = (perm = { role: "admin", readonly: false, changes: true, versions: true, manage: true }, version = "v1") => ({
  version,
  fields: FIELDS,
  roster: { candidates: [] },
  savedAt: "",
  perm,
  sheets: [
    {
      name: "幻想真境剧诗",
      title: "幻想真境剧诗",
      dataStart: 8,
      dataEnd: 20,
      taken: [10],
      defaults: { status: "排队中" },
      options: OPTIONS,
      anchors: OPTIONS.anchor,
      anchorRows: [{ row: 10, name: "阿修Axiu", recommend: "强烈推荐", duty: "剧诗", skills: "", platform: "B站", link: "", queued: 1, done: 0 }],
      rows: [
        { row: 10, seq: 1, nickname: "甲", gameName: "甲的游戏", anchor: "阿修Axiu", goal: "困难模式满星章", note: "", status: "排队中", fp: "fp10" },
      ],
    },
    {
      name: "幽境危战",
      title: "幽境危战",
      dataStart: 8,
      dataEnd: 20,
      taken: [10],
      defaults: {},
      options: OPTIONS,
      anchors: OPTIONS.anchor,
      anchorRows: [{ row: 10, name: "听雨", recommend: "推荐", duty: "危战", skills: "", platform: "抖音", link: "", queued: 1, done: 0 }],
      rows: [
        { row: 10, seq: 1, nickname: "乙", gameName: "乙的游戏", anchor: "听雨", goal: "险恶(N4)", note: "", status: "", fp: "fp10" },
      ],
    },
  ],
})

/**
 * 假计时器：页面里的**防抖**（自动保存那 1.2 秒）与 `note()` 的自动消失都靠它
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
      jobs.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout(id) {
      jobs.delete(id)
    },
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
 * @param {() => {status:number, body:object}} [opts.versionsReply] GET /api/versions 该怎么回
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.restoreReply] 第 n 次 POST /api/restore 该怎么回
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.adminsReply] 第 n 次 /api/admins 该怎么回
 * @param {(n:number, body:object) => {status:number, body:object}} [opts.ownershipReply] 第 n 次 POST /api/ownership 该怎么回
 * @param {() => {status?:number, body?:object}} [opts.ownershipGetReply] GET `/api/ownership` 该怎么回
 * @param {() => {status?:number, body?:object}} [opts.metaReply] GET `/api/meta` 该怎么回（页脚）
 * @param {() => boolean} [opts.confirm] 二次确认对话框的答案（默认一律"确定"）
 * @param {object} [opts.timers] 假计时器（`makeFakeTimers()`）；不给就"计时器不跑"
 * @param {string} [opts.device] 服务端注入的设备令牌（`__DEVICE__`）
 * @param {string} [opts.who] 服务端注入的链接身份（`__WHO__`）
 */
export function bootPage({
  dataFor = () => makeData(),
  saveReply = null,
  versionsReply = null,
  restoreReply = null,
  adminsReply = null,
  ownershipReply = null,
  ownershipGetReply = null,
  /** 主播呼叫 / 呼叫本人这两种通知型接口的回执（默认成功） */
  anchorReply = null,
  callReply = null,
  metaReply = null,
  confirm = () => true,
  timers = null,
  device = "",
  who = "",
} = {}) {
  const document = makeDocument(BODY_HTML)

  const calls = []
  let saves = 0
  let restores = 0
  let admins = 0
  let audits = 0
  /**
   * 假响应**与真 fetch 同形**：`json()` 之外也给 `text()` 与 `headers.get()`
   *
   * 页面读响应体走 `api()`（先 `text()` 再自己 `JSON.parse`，这样才认得出"拿到的是 HTML"），
   * 桩少这两样等于在考自己假 DOM 的形状。
   */
  const resOf = (status, payload) => ({
    status,
    ok: status === 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  })
  const jsonRes = payload => resOf(200, payload)
  const emptyOwnership = () =>
    ({ ok: true, version: "v1", bindings: { table: "v1", stale: false, count: 0 },
      locks: { table: "v1", stale: false, count: 0, rows: [] },
      roster: { group: "测试群", updatedAt: 0, count: 0 }, sheets: [],
      missing: { supported: true, reason: "", rows: [] } })

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
    if (u.includes("api/ownership")) {
      if ((opts?.method ?? "GET") === "POST") {
        audits++
        const reply = ownershipReply?.(audits, body)
        if (reply) return resOf(reply.status, reply.body)
        return jsonRes({ ok: true, kept: 0, moved: 0, dropped: 0, unconfirmed: 0, missing: 0, pruned: 0 })
      }
      const got = ownershipGetReply?.()
      if (got) return resOf(got.status ?? 200, got.body ?? got)
      return jsonRes(emptyOwnership())
    }
    if (u.includes("api/admins")) {
      admins++
      const reply = adminsReply?.(admins, body)
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true, admins: [], owners: [], env: [], file: [], ignored: [], suggestions: {} })
    }
    if (u.includes("api/meta")) {
      const reply = metaReply?.()
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true, version: "v1", footer: "", versionsKeep: 20 })
    }
    if (u.includes("api/version")) return jsonRes({ ok: true, version: "v1" })
    if (u.includes("api/changes")) return jsonRes({ ok: true, all: false, keep: 2000, entries: [] })
    if (u.includes("api/call") || u.includes("api/anchor-call")) {
      const isAnchor = u.includes("api/anchor-call")
      const reply = (isAnchor ? anchorReply : callReply)?.(body)
      if (reply) return resOf(reply.status, reply.body)
      return jsonRes({ ok: true })
    }
    if (u.includes("api/tidy")) return jsonRes({ ok: true })
    return jsonRes(structuredClone(dataFor()))
  }

  /**
   * `window` 上注册的监听（滚动 / 改窗口大小 / 视觉视口变化）
   *
   * 页面在 `resize` / `scroll` 时**重摆**开着的浮层。套件要能显式触发它们，所以这里记下来。
   */
  const winListeners = {}
  const windowStub = {
    addEventListener(type, fn) {
      ;(winListeners[type] ??= []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = winListeners[type] ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    innerWidth: 1024,
    innerHeight: 768,
    visualViewport: undefined,
  }

  const ctx = {
    document,
    window: windowStub,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { search: "", hash: "", pathname: "/editor" },
    history: {
      replaceState(_state, _title, url) {
        if (typeof url === "string") {
          const [p, h] = url.split("#")
          ctx.location.pathname = p || ctx.location.pathname
          ctx.location.hash = h ? "#" + h : ""
        }
      },
    },
    fetch: fetchStub,
    setTimeout: timers ? timers.setTimeout : () => 0,
    clearTimeout: timers ? timers.clearTimeout : () => {},
    confirm,
    console,
    URLSearchParams,
    AbortController,
    /** 页面读 `getComputedStyle(document.documentElement).zoom` 换算浮层坐标；桩里恒为 1 */
    getComputedStyle: () => ({ zoom: 1 }),
  }
  vm.createContext(ctx)
  /**
   * `__client` 必须**塞进页面那个 IIFE 里面**再跑：`st`、`selectedRow`、`curPage` 都是 IIFE 的局部变量，
   * 挂在脚本末尾（IIFE 之外）的 getter 一取就 `ReferenceError: st is not defined`，
   * 而 getter 是懒执行的，所以表现成"某条断言突然报 st is not defined"，不是启动就崩。
   */
  const source = SCRIPTS.join("\n;\n").replaceAll("__DEVICE__", device).replaceAll("__WHO__", who)
  const tail = "\n})()"
  const at = source.lastIndexOf(tail)
  if (at < 0) throw new Error("editor.html 的内联脚本不是以 `})()` 收尾——`__client` 注入点没了")
  /** 塞在 IIFE 收尾之前：这样 getter 才取得到 st / selectedRow / curPage */
  const probe = [
    "",
    "  globalThis.__client = {",
    "    get sheets() { return st.sheets },",
    "    get cur() { return st.cur },",
    "    get meta() { return st.meta },",
    "    get dirty() { return [...st.dirty.keys()] },",
    "    get selected() { return selectedRow },",
    "    get readonly() { return st.readonly },",
    "    get page() { return curPage },",
    "  }",
  ].join("\n")
  vm.runInContext(source.slice(0, at) + probe + source.slice(at), ctx, { filename: "editor.html" })

  const el = id => document.getElementById(id)
  /** 表格里所有数据行（`#grid` 与 `#fillGrid` 各挂一份） */
  const gridRows = host => [...(host ?? el("grid")).querySelectorAll(".tr[data-row]")]
  const textOf = n => (n?.textContent || "") + (n?.childNodes ?? []).flatMap(textOf).join("")

  /** 一格里那个可点的东西：文本框 / `.pick` 容器 */
  const controlOf = (tr, key) => {
    if (key === "anchor" || key === "goal" || key === "status") {
      return tr.querySelector(`[data-pick="${key}"]`)
    }
    return tr.querySelector(`[data-edit="${key}"]`)
  }
  const findOption = (node, option) => {
    if (!node) return null
    const cls = String(node.className || "")
    if (typeof node.onclick === "function" && cls.split(" ").includes("opt") && !cls.includes("addbtn") && textOf(node).trim() === option) return node
    for (const child of node.childNodes ?? []) {
      const hit = findOption(child, option)
      if (hit) return hit
    }
    return null
  }

  const h = {
    ctx,
    document,
    calls,
    el,
    gridRows,
    /** 页面上某张卡里的文字（概览 KPI、面板列表都用它断言） */
    textOf,
    get probe() {
      return ctx.__client
    },
    /** 触发 `document` 上的监听（页面把"点别处就收起"挂在 click 上） */
    fire(type, evt = {}) {
      document._fire(type, evt)
    },
    fireDocument(type, evt = {}) {
      document._fire(type, evt)
    },
    /** 触发 `window` 上注册的监听（`resize` / `scroll`） */
    fireWindow(type, evt = { target: {} }) {
      for (const fn of winListeners[type] ?? []) fn(evt)
    },
    fireScroll(target) {
      h.fireWindow("scroll", { target })
    },
    setVisualViewport(vp) {
      windowStub.visualViewport = vp
    },
    /** 页面上挂着的提示（toast）：`toast()` 每句一个 div */
    toasts: () => [...el("toast").querySelectorAll("div")].map(textOf),
    async ready() {
      await flush()
      await flush()
      await flush()
    },
    /** 按表格行号找一行 */
    rowNo(row, host) {
      const tr = gridRows(host).find(x => Number(x.dataset.row) === Number(row))
      if (!tr) throw new Error(`界面上没有第 ${row} 行`)
      return tr
    },
    /** 新增行（`__new` 的行序号写的是「新」） */
    newRow(host) {
      const tr = gridRows(host).find(x => x.querySelector(".seqcell")?.textContent.trim() === "新")
      if (!tr) throw new Error("界面上没有新增行")
      return tr
    },
    /** 切榜（页签按钮） */
    tab(index) {
      const t = el("tabs").querySelector(`[data-tab="${index}"]`)
      if (!t) throw new Error(`没有第 ${index} 个页签`)
      t.onclick()
    },
    /** 切页（侧栏 `.ni`） */
    nav(id) {
      const a = document.querySelectorAll(".ni").find(x => x.dataset.nav === id)
      if (!a) throw new Error(`侧栏没有「${id}」`)
      a.onclick({ preventDefault() {} })
      return a
    },
    /** 侧栏那颗按钮（只取不点） */
    navEl(id) {
      const a = document.querySelectorAll(".ni").find(x => x.dataset.nav === id)
      if (!a) throw new Error(`侧栏没有「${id}」`)
      return a
    },
    /** 文本框：新页面把改动记在 `oninput` 上 */
    type(tr, key, value) {
      const input = controlOf(tr, key)
      if (!input || input.tagName !== "TEXTAREA") throw new Error(`${key} 这一格不是文本框`)
      input.value = value
      if (typeof input.oninput !== "function") throw new Error(`${key} 这一格没挂 oninput`)
      input.oninput()
    },
    /** 界面上这一格现在显示的值 */
    cellValue(row, key) {
      return controlOf(h.rowNo(row), key).value
    },
    /** 胶囊格/选择格现在显示的纯文字（去掉插入符 ▾） */
    cellText(tr, key) {
      const box = controlOf(tr, key)
      if (!box) return ""
      return textOf(box).replace(/▾/g, "").trim()
    },
    /** 胶囊格所有胶囊的 class（攻炼复合状态会拆成多颗） */
    cellPillClass(tr, key) {
      const box = controlOf(tr, key)
      if (!box) return ""
      return [...box.querySelectorAll(".chip")].map(p => p.className).join(" ")
    },
    /**
     * 点开某一格的下拉浮层
     *
     * 新页面的浮层是**全局单例** `#picker`（不是每格一个），所以打开后要断言的是 `#picker.open`。
     */
    openPicker(tr, key) {
      const sp = controlOf(tr, key)
      if (!sp) throw new Error(`${key} 这一格找不到可点的选择器`)
      sp.onclick({ stopPropagation() {} })
    },
    pickerOpen(tr, key) {
      void tr
      void key
      return el("picker").classList.contains("open")
    },
    pickerOf() {
      return el("picker")
    },
    closePicker() {
      el("picker").classList.remove("open")
    },
    /** 点浮层里的某个选项 */
    pickOption(tr, key, option) {
      void tr
      void key
      const picker = el("picker")
      if (!picker.classList.contains("open")) throw new Error("浮层没打开")
      const opt = findOption(picker, option)
      if (!opt) throw new Error(`浮层里没有「${option}」`)
      opt.onclick({ stopPropagation() {} })
    },
    /** 走完整路径选一个值：开浮层 → 点选项 */
    pick(tr, key, option) {
      h.openPicker(tr, key)
      const picker = el("picker")
      const click = text => {
        const opt = findOption(picker, text)
        if (!opt) throw new Error(`${key} 的浮层里没有「${text}」`)
        opt.onclick({ stopPropagation() {} })
      }
      /** 剧诗旧写法 `困难模式满星章` 拆成「难度 + 目标」两栏单选：先选难度，再由目标收尾 */
      const split = key === "goal" ? /^(.*模式)(满原石|满星章)$/.exec(option) : null
      if (split) {
        click(split[1])
        click(split[2])
        return
      }
      click(option)
    },
    /** 主播卡上的「呼叫」（`data-acall="<行号>"`） */
    anchorCall(index = 0) {
      const btns = [...el("acards").querySelectorAll("[data-acall]")]
      const b = btns[index]
      if (!b) throw new Error(`没有第 ${index} 张主播卡的呼叫按钮`)
      b.onclick({ stopPropagation() {} })
    },
    /** 表格行上的「呼叫」（`data-call="<行号>"`） */
    callRow(row) {
      const b = h.rowNo(row).querySelector("[data-call]")
      if (!b) throw new Error(`第 ${row} 行没有呼叫按钮`)
      b.onclick({ stopPropagation() {} })
    },
    /** 点整行（选中） */
    selectRow(row) {
      h.rowNo(row).onclick({ target: { closest: () => null } })
    },
    /** 已完成列表里的一行（`data-done="<行号>"`） */
    doneRow(row) {
      const el2 = el("doneList").querySelector(`[data-done="${row}"]`)
      if (!el2) throw new Error(`已完成列表里没有第 ${row} 行`)
      return el2
    },
    /** 手机抽屉里那一格的输入框 */
    typeMobile(key, value) {
      const inp = el("msBody").querySelector(`[data-ms="${key}"]`)
      if (!inp) throw new Error(`抽屉里没有 ${key}`)
      inp.value = value
      inp.oninput()
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
    reads(part = "api/data") {
      return calls.filter(c => c.method === "GET" && c.url.includes(part))
    },
    /** 自动保存：把假时钟往前推过防抖那 1.2 秒 */
    async autoSave() {
      timers?.advance(1300)
      await h.ready()
    },
    advance(ms) {
      timers?.advance(ms)
    },
  }
  return h
}
