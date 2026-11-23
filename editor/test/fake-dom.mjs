/**
 * `page-vm.mjs` 用的最小 DOM（**只实现 editor.html 真用到的那点 API**）
 *
 * 为什么要有它：老版本对 `innerHTML` 只存字符串、`querySelector` 一律返回 null，
 * 而现在的页面把整张表、六个面板、选择器都靠 `innerHTML` 渲染，桩里一个节点都取不到。
 * 这里补上「把 HTML 解析成节点树」+「按选择器查节点」两件事，其余 API 仍然不实现——
 * 多了就是在测自己的假 DOM，不是在测页面。
 *
 * 与真 DOM 的**已知差异**（故意保留，避免影响既有断言）：
 * - `childNodes` 只放元素节点，纯文本并入父节点的 `textContent`；
 * - `textContent` 只返回本节点自己的文字（真 DOM 会连子节点一起返回），
 *   因为既有断言（findOption / tagText / textOf）自己会往下递归，两边都算会翻倍。
 */

// 这些 HTML 属性在真 DOM 里同时是同名的布尔属性
const BOOL_PROPS = new Set(["disabled", "checked", "hidden", "readonly", "selected"])

const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"])

/** 从 `<` 之后找到这个标签真正结束的 `>`（跳过引号里的 `>`） */
function findTagEnd(text, start) {
  let quote = ""
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ""
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ">") {
      return i
    }
  }
  return -1
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: "\u00a0", "#160": "\u00a0" }
const decode = s =>
  String(s).replace(/&(#?\w+);/g, (_, k) => (k in ENTITIES ? ENTITIES[k] : `&${k};`))

/* ------------------------------ 选择器 ------------------------------ */

/** 复合选择器里的"标识符到此为止"判定：`#` `.` `[` `>` 与所有空白 */
const isStop = ch => ch === "#" || ch === "." || ch === "[" || ch === ">" || /\s/.test(ch)

/** 只认 `*` / `tag` / `.cls` / `#id` / `[attr]` / `[attr="v"]` 的复合形态 */
function parseCompound(text) {
  const out = { tag: "", id: "", classes: [], attrs: [] }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "#" || c === ".") {
      let j = i + 1
      while (j < text.length && !isStop(text[j])) j++
      const name = text.slice(i + 1, j)
      if (c === "#") out.id = name
      else out.classes.push(name)
      i = j
    } else if (c === "[") {
      const close = text.indexOf("]", i)
      if (close < 0) break
      const inner = text.slice(i + 1, close)
      const eq = inner.indexOf("=")
      if (eq < 0) out.attrs.push({ name: inner.trim(), value: null })
      else {
        const name = inner.slice(0, eq).trim()
        let value = inner.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        out.attrs.push({ name, value: decode(value) })
      }
      i = close + 1
    } else if (c === "*") {
      i++
    } else {
      let j = i
      while (j < text.length && !isStop(text[j])) j++
      out.tag = text.slice(i, j).toUpperCase()
      i = j
    }
  }
  return out
}

/** `a b > c, d` → [[{compound, combinator}…]…]（combinator 指「与左边那个的关系」） */
function parseSelector(selector) {
  return String(selector)
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const steps = []
      let rest = part
      let combinator = " "
      while (rest) {
        rest = rest.trim()
        if (rest.startsWith(">")) {
          combinator = ">"
          rest = rest.slice(1)
          continue
        }
        const stop = rest.search(/[\s>]/)
        const text = stop < 0 ? rest : rest.slice(0, stop)
        const tail = stop < 0 ? "" : rest.slice(stop)
        steps.push({ compound: parseCompound(text), combinator })
        combinator = " "
        rest = tail
      }
      return steps
    })
    .filter(steps => steps.length > 0)
}

function matchCompound(el, c) {
  if (!el || !el.tagName) return false
  if (c.tag && c.tag !== "*" && el.tagName !== c.tag) return false
  if (c.id && el.attrs.id !== c.id) return false
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false
  for (const a of c.attrs) {
    if (!(a.name in el.attrs)) return false
    if (a.value !== null && el.attrs[a.name] !== a.value) return false
  }
  return true
}

function matchesSteps(el, steps) {
  const last = steps.length - 1
  if (!matchCompound(el, steps[last].compound)) return false
  let node = el
  for (let i = last; i > 0; i--) {
    const step = steps[i]
    const prev = steps[i - 1].compound
    if (step.combinator === ">") {
      node = node?.parentNode
      if (!matchCompound(node, prev)) return false
    } else {
      node = node?.parentNode
      while (node && !matchCompound(node, prev)) node = node.parentNode
      if (!node) return false
    }
  }
  return true
}

export function matches(el, selector) {
  return parseSelector(selector).some(steps => matchesSteps(el, steps))
}

/* ------------------------------ 元素 ------------------------------ */

export function makeEl(tag = "div") {
  const classes = new Set()
  const el = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    hidden: false,
    attrs: {},
    dataset: {},
    style: {},
    _text: "",
    /** textarea 的 value 在真浏览器里就是它的文本内容；没显式赋过值就退回 _text */
    get value() {
      return el._value !== undefined ? el._value : el.tagName === "TEXTAREA" ? el._text : ""
    },
    set value(v) {
      el._value = String(v ?? "")
    },
    title: "",
    placeholder: "",
    type: "",
    disabled: false,
    checked: false,
    rows: 0,
    parentNode: null,
    _html: "",
    offsetWidth: 0,
    offsetHeight: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    get children() {
      return el.childNodes
    },
    get firstChild() {
      return el.childNodes[0] ?? null
    },
    /** 页面用它们遍历侧栏分组（`#nav .g` 后面跟一串 `.ni`） */
    get nextElementSibling() {
      const sibs = el.parentNode?.childNodes ?? []
      const at = sibs.indexOf(el)
      return at < 0 ? null : sibs[at + 1] ?? null
    },
    get previousElementSibling() {
      const sibs = el.parentNode?.childNodes ?? []
      const at = sibs.indexOf(el)
      return at <= 0 ? null : sibs[at - 1] ?? null
    },
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
    get textContent() {
      return el._text
    },
    set textContent(v) {
      el._text = String(v ?? "")
      el.childNodes = []
    },
    get innerHTML() {
      return el._html
    },
    set innerHTML(v) {
      el._html = String(v ?? "")
      el.childNodes = []
      el._text = ""
      for (const node of parseHTML(el._html)) {
        node.parentNode = el
        el.childNodes.push(node)
      }
    },
    appendChild(child) {
      /** 真 DOM 认字符串（追加文本节点）；`el.append(name)` 这种写法页面在用 */
      if (typeof child === "string" || typeof child === "number") {
        el._text += String(child)
        return child
      }
      child.parentNode = el
      el.childNodes.push(child)
      return child
    },
    append(...kids) {
      kids.forEach(k => el.appendChild(k))
    },
    removeChild(child) {
      const at = el.childNodes.indexOf(child)
      if (at >= 0) el.childNodes.splice(at, 1)
      child.parentNode = null
      return child
    },
    remove() {
      const at = el.parentNode?.childNodes.indexOf(el) ?? -1
      if (at >= 0) el.parentNode.childNodes.splice(at, 1)
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v)
      if (k.startsWith("data-")) el.dataset[camel(k.slice(5))] = String(v)
      if (k === "class") el.className = String(v)
      // 布尔属性在真 DOM 里也是同名属性（disabled 写进 HTML 后 el.disabled === true）
      if (BOOL_PROPS.has(k)) el[k] = true
    },
    getAttribute(k) {
      return el.attrs[k] ?? null
    },
    removeAttribute(k) {
      delete el.attrs[k]
      if (k.startsWith("data-")) delete el.dataset[camel(k.slice(5))]
      if (BOOL_PROPS.has(k)) el[k] = false
    },
    hasAttribute(k) {
      return k in el.attrs
    },
    matches(selector) {
      return matches(el, selector)
    },
    closest(selector) {
      let node = el
      while (node) {
        if (node.tagName && matches(node, selector)) return node
        node = node.parentNode
      }
      return null
    },
    querySelectorAll(selector) {
      const out = []
      const walk = node => {
        for (const child of node.childNodes) {
          if (matches(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(el)
      return out
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null
    },
    /** 页面只用它做 FLIP 动画与浮层定位；桩里没有真实布局，给零矩形即可 */
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    focus() {},
    blur() {},
    addEventListener() {},
    removeEventListener() {},
    click() {
      if (typeof el.onclick === "function") el.onclick({ stopPropagation() {}, preventDefault() {}, target: el })
    },
  }
  return el
}

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

/* ------------------------------ HTML 解析 ------------------------------ */

/**
 * 把一段 HTML 解析成元素数组
 *
 * 支持：开闭标签、自闭合、`<input ... />`、属性（双/单/无引号）、注释、实体解码。
 * 不支持：`<template>`、SVG 命名空间、表格式隐式补全——页面都不写这些。
 */
export function parseHTML(source) {
  const text = String(source ?? "")
  const root = makeEl("div")
  const stack = [root]
  let i = 0
  const pushText = chunk => {
    const decoded = decode(chunk)
    if (decoded.trim()) stack[stack.length - 1]._text += decoded
  }
  while (i < text.length) {
    const lt = text.indexOf("<", i)
    if (lt < 0) {
      pushText(text.slice(i))
      break
    }
    if (lt > i) pushText(text.slice(i, lt))
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4)
      i = end < 0 ? text.length : end + 3
      continue
    }
    const gt = findTagEnd(text, lt)
    if (gt < 0) {
      pushText(text.slice(lt))
      break
    }
    const raw = text.slice(lt + 1, gt)
    i = gt + 1
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toUpperCase()
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].tagName === name) {
          stack.length = d
          break
        }
      }
      continue
    }
    const selfClosing = raw.endsWith("/")
    const body = selfClosing ? raw.slice(0, -1) : raw
    const spaceAt = body.search(/\s/)
    const name = (spaceAt < 0 ? body : body.slice(0, spaceAt)).trim()
    if (!name) continue
    const el = makeEl(name.toLowerCase())
    const attrText = spaceAt < 0 ? "" : body.slice(spaceAt)
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let m
    while ((m = attrRe.exec(attrText))) {
      const key = m[1]
      const val = m[2] ?? m[3] ?? m[4] ?? ""
      el.setAttribute(key, decode(val))
    }
    const parent = stack[stack.length - 1]
    el.parentNode = parent
    parent.childNodes.push(el)
    if (!selfClosing && !VOID_TAGS.has(el.tagName.toLowerCase())) stack.push(el)
  }
  return root.childNodes
}

/* ------------------------------ document ------------------------------ */

export function makeDocument(bodyHtml = "") {
  const auto = new Map()
  const docListeners = {}
  const findById = (node, id) => {
    for (const child of node.childNodes) {
      if (child.attrs.id === id) return child
      const hit = findById(child, id)
      if (hit) return hit
    }
    return null
  }
  const document = {
    head: makeEl("head"),
    body: makeEl("body"),
    documentElement: makeEl("html"),
    hidden: false,
    fonts: { ready: Promise.resolve(), load: () => Promise.resolve() },
    createElement: tag => makeEl(tag),
    createTextNode: text => {
      const n = makeEl("#text")
      n._text = String(text)
      return n
    },
    getElementById(id) {
      const found = findById(document.body, id)
      if (found) return found
      if (!auto.has(id)) auto.set(id, makeEl("div"))
      return auto.get(id)
    },
    querySelectorAll(selector) {
      return document.body.querySelectorAll(selector)
    },
    querySelector(selector) {
      return document.body.querySelector(selector)
    },
    addEventListener(type, fn) {
      ;(docListeners[type] ??= []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = docListeners[type] ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    /** 套件要显式触发 `visibilitychange` 一类监听时用它 */
    _fire(type, evt = {}) {
      for (const fn of docListeners[type] ?? []) fn(evt)
    },
  }
  document.body.parentNode = document.documentElement
  document.documentElement.childNodes.push(document.body)
  for (const node of parseHTML(bodyHtml)) {
    node.parentNode = document.body
    document.body.childNodes.push(node)
  }
  return document
}
