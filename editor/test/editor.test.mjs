/**
 * 在线编辑器端到端：读写都打在表格副本上
 *
 * 覆盖：字段与下拉选项、口令与身份签名、白名单权限、完成情况锁定、写入校验、健康检查。
 * 用法：node test/editor.test.mjs [xlsx路径]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { exampleConfig, freePort } from "../../test/_helper.mjs"
import { PLUGIN_DIR, shared } from "./plugin.mjs"
import { SOURCE as SRC } from "./source.mjs"
import { cookieJar } from "./harness.mjs"

/** 身份签名只有一份实现（插件 model/identity.js），编辑器也用它 */
const { signIdentity } = await shared("model/identity.js")

/** 别名归一与表格逻辑都在插件目录里（只有一份实现） */
const aliases = await shared("components/aliases.js")

/**
 * 被测表格由 `source.mjs` 统一给（显式参数 / XLSX_PATH / 维护者真实表 / 合成样本），
 * 拿不到真实表也不跳过——干净克隆上这套必须真跑（外部审核「改进意见 #3」）。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abyss-editor-"))
const fixture = path.join(tmp, "queue.xlsx")
fs.copyFileSync(SRC, fixture)

/**
 * 主播别名：真实表用仓库示例配置里那套（`config.yaml.example`），合成样本再叠上样本自己登记的旧名
 *
 * 为什么不写死「璃月第一深情 → 摸头妹」：
 * 合成样本表里根本没有那对名字，硬写会让断言空转；样本自己声明"我用这个旧名"，
 * 套件照它写配置与断言即可（见 `test/fixtures/sample-table.mjs` 的 `SAMPLE_ALIAS`）。
 * 示例配置那套照旧保留，所以拿真实表跑时语义不变。
 */
const SAMPLE_ALIAS = (await import(pathToFileURL(path.join(PLUGIN_DIR, "test", "fixtures", "sample-table.mjs")).href)).SAMPLE_ALIAS
const aliasMap = Object.fromEntries(
  Object.entries(exampleConfig.anchor_aliases ?? {}).map(([name, list]) => [name, [...[].concat(list)]]),
)
aliasMap[SAMPLE_ALIAS.canonical] = [...new Set([...(aliasMap[SAMPLE_ALIAS.canonical] ?? []), SAMPLE_ALIAS.value])]

/**
 * 「主播区里有、原下拉验证里没有」的目标：挑得到才有那条断言可测
 * （真实表里是深境螺旋的「摸头妹」；合成样本沿用同一份主播区，目标一致）
 */
const anchorMissingFromList = await (async () => {
  const wb = await (await shared("model/xlsx.js")).openWorkbook(fs.readFileSync(SRC))
  const { buildModel } = await shared("model/schema.js")
  for (const sheet of wb.sheets) {
    const model = buildModel({ name: sheet.name, xml: await wb.sheetXml(sheet.name), shared: wb.shared })
    const raw = model.options.anchor ?? []
    const hit = model.anchors.map(a => a.name).find(n => n && !raw.includes(n))
    if (hit) return { sheet: sheet.name, name: hit }
  }
  return null
})()

/**
 * 别名断言按"每张榜各查各的"：表里在用的旧名归到**该榜**主播区里的那一位
 * （配置里登记了正名才算数；没登记的名字不算别名，表里也就不该出现）
 */
const aliasMapOf = (sheetName, anchors, used) => {
  const known = aliases.compileAliases(aliasMap)
  return [...used]
    .map(alias => ({ alias, canonical: aliases.canonicalAnchor(alias, known) }))
    .filter(({ alias, canonical }) => canonical !== alias && anchors.includes(canonical))
}

const cfg = path.join(tmp, "config.yaml")
/** 数据落点：测试模式下派生自表格所在目录（表格就在这个临时目录里），配置里没有路径键 */
fs.writeFileSync(
  cfg,
  [
    /** 别名：表里写的旧名其实就是主播区里的那一位（正名由被测表推出，见上） */
    "anchor_aliases:",
    ...Object.entries(aliasMap).flatMap(([name, list]) => [`  ${name}: [${list.map(a => `"${a}"`).join(", ")}]`]),
    /**
     * 页脚：故意用**字面 `\n`**（老注释教维护者在面板里这么写）——
     * 编辑器必须把它当换行渲染，而不是把这两个字符画到页面上（见 editor/config.js 的 withFooterLine）。
     */
    "footer:",
    "  html: '<div>footer-line-1</div>\\n<div>footer-line-2</div>'",
    "",
  ].join("\n"),
  "utf8",
)

const editor = path.resolve(import.meta.dirname, "..", "editor.mjs")
const port = await freePort()
const TOKEN = "test-token-42"
const ADMIN_TOKEN = "admin-token-99"
const ADMINS_FILE = path.join(tmp, "admins.json")
/** 环境变量白名单：**只有 QQ 号算权限**（AQ-01）；昵称条目会被拒绝并提示 */
const ENV_ADMIN_QQ = "888888"
const ENV_ADMIN = "环境白名单"
/** 主人：只有他能维护白名单（不给管理口令也行）。一个来自启动参数，一个来自白名单文件 */
const OWNER = "424242"
const FILE_OWNER = "999999"
fs.writeFileSync(ADMINS_FILE, JSON.stringify({ owner: [FILE_OWNER], admins: [] }, null, 2), "utf8")
const child = spawn(
  process.execPath,
  [editor, "--port", String(port), "--token", TOKEN, "--admin-token", ADMIN_TOKEN, "--admins", ADMINS_FILE, "--owner", OWNER],
  {
    env: {
      ...process.env,
      ABYSS_QUEUE_CONFIG: cfg,
      ABYSS_EDITOR_FILE: fixture,
      ABYSS_EDITOR_ADMINS: `${ENV_ADMIN_QQ},${ENV_ADMIN}`,
      /** 套件在系统临时目录里起编辑器：生产口径只认插件内的 data（见 data-confinement.test.mjs） */
      ABYSS_EDITOR_TEST_PATHS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let out = ""
child.stdout.on("data", d => (out += d))
child.stderr.on("data", d => (out += d))

const wait = ms => new Promise(r => setTimeout(r, ms))

/** 把参数拼成查询串：k=口令、u/s=身份、a=管理口令 */
const query = ({ k = TOKEN, who = null, a = "" } = {}) => {
  const params = []
  if (k) params.push(`k=${encodeURIComponent(k)}`)
  if (who) {
    const id = signIdentity(who, TOKEN)
    params.push(`u=${encodeURIComponent(id.u)}`, `s=${encodeURIComponent(id.s)}`)
  }
  if (a) params.push(`a=${encodeURIComponent(a)}`)
  return params.join("&")
}

/**
 * 一台"设备"一个 cookie 罐（按 QQ 分）
 *
 * 认领那一层靠 cookie 认设备（`editor/claims.js`）：同一个人认领之后，后续请求要把那个 cookie
 * 带上——不带就会被当成"第二个来的人"降级成只读（写接口 403）。所以这里按身份分罐，
 * 与浏览器里"同一个人还是一个浏览器"同义。
 */
const jars = new Map()
const jarOf = who => {
  /** 同一个人换昵称（测"改了群名片"）还是同一台设备，所以按 QQ 分 */
  const key = who ? `qq:${who.qq ?? ""}` : "(无身份)"
  if (!jars.has(key)) jars.set(key, cookieJar())
  return jars.get(key)
}

const api = async (p, body, opts = {}) => {
  const qs = query(opts)
  const url = `http://127.0.0.1:${port}${p}${qs ? (p.includes("?") ? "&" : "?") + qs : ""}`
  const jar = jarOf(opts.who)
  const init = { headers: { ...jar.headers }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) }
  if (body) init.headers["content-type"] = "application/json"
  const res = await fetch(url, init)
  jar.take(res)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { __raw: text.slice(0, 4000) }
  }
  return { status: res.status, json }
}

/**
 * 原样发一段字节（`content-length` 与请求体都由调用方给）
 *
 * 与 `api()` 同一套 cookie 罐：超限那两条请求也要是"这个身份那台设备"的，
 * 否则认领那一层会先把人降级成只读、拿到的是 403 而不是要测的 400。
 */
const apiRaw = async (p, text, opts = {}) => {
  const qs = query(opts)
  const url = `http://127.0.0.1:${port}${p}${qs ? (p.includes("?") ? "&" : "?") + qs : ""}`
  const jar = jarOf(opts.who)
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...jar.headers }, body: text })
  jar.take(res)
  return { status: res.status, text: await res.text() }
}

let failed = 0
/** 支持同步与 async 回调 */
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}

try {
  // 等服务就绪（用带口令的请求）
  let ready = false
  for (let i = 0; i < 60; i++) {
    await wait(500)
    try {
      const r = await api("/healthz")
      if (r.status === 200) {
        ready = true
        break
      }
    } catch {}
  }
  if (!ready) throw new Error(`编辑器没起来：\n${out}`)

  await check("口令：无口令访问接口被拒绝", async () => {
    const r = await api("/api/data", null, { k: "" })
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("口令：错误口令被拒绝", async () => {
    const r = await api("/api/data", null, { k: "wrong" })
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  /**
   * 口令比较走恒时算法（`timingSafeEqual`），两条分支都要**拒绝而不是抛错**：
   * 等长不同内容走比较本身，不同长度在比较之前就被挡下（`timingSafeEqual` 要求等长 buffer）。
   * 顺带钉住"正确口令仍然放行"——恒时比较最容易犯的错是把两个空值判成相等或者永远不等。
   */
  await check("口令：等长错口令与短一截的口令都 403，正确口令仍放行", async () => {
    const flip = (TOKEN[0] === "0" ? "1" : "0") + TOKEN.slice(1)
    const sameLen = await api("/api/data", null, { k: flip })
    if (sameLen.status !== 403) throw new Error(`等长错口令竟然放行（HTTP ${sameLen.status}）`)
    const shorter = await api("/api/data", null, { k: TOKEN.slice(0, -1) })
    if (shorter.status !== 403) throw new Error(`短一截的口令竟然放行（HTTP ${shorter.status}）`)
    const ok = await api("/api/data")
    if (ok.status !== 200) throw new Error(`正确口令被拒（HTTP ${ok.status}）`)
  })
  await check("口令：无口令打开首页给出口令输入页（而不是 403）", async () => {
    const r = await api("/", null, { k: "" })
    if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
    if (!String(r.json.__raw).includes("访问口令")) throw new Error("首页不是口令输入页")
  })
  await check("健康检查：带口令返回配置摘要（但不回吐服务器路径）", async () => {
    const r = await api("/healthz")
    if (r.status !== 200 || !r.json.ok) throw new Error(`healthz 异常：${JSON.stringify(r.json)}`)
    if (r.json.auth !== true) throw new Error("healthz 未表明已启用口令")
    /** 只凭口令就能看健康检查，所以不能回吐服务器路径与云端地址 */
    if ("file" in r.json) throw new Error(`healthz 不该暴露表路径：${r.json.file}`)
    if ("cloud" in r.json) throw new Error(`healthz 不该暴露云端地址：${r.json.cloud}`)
    if (r.json.admin_api !== true) throw new Error("healthz 未表明管理接口已启用")
    /** 权限只数"能当权限的 QQ"；解析不出 QQ 的历史昵称条目单独报（AQ-01） */
    if (r.json.admins !== 1) throw new Error(`环境变量白名单里的 QQ 应计入：${r.json.admins}`)
    if (r.json.acl_invalid !== 1) throw new Error(`应报出 1 条解析不出 QQ 的条目：${r.json.acl_invalid}`)
    /** 升级后忘了重启本地编辑器时，靠这两项就能看出来跑的是哪一版 */
    if (!r.json.version) throw new Error("healthz 没有版本号")
    if (r.json.owners !== 2) throw new Error(`主人名单应计 2 人（启动参数 + 文件）：${r.json.owners}`)
    if (!Array.isArray(r.json.fields) || !r.json.fields.includes("status")) throw new Error(`healthz 字段表缺 status：${JSON.stringify(r.json.fields)}`)
  })

  /* ------------------------- 网页标签页图标（favicon） ------------------------- */
  /**
   * 放在前段（进程还活着的时候）：后段有一处会把编辑器弄停，
   * 那时再请求只会拿到 ECONNREFUSED，测不出真实状态码。
   */
  {
    /**
     * 图标路径必须是**挂载前缀下**的那条，不能是站根绝对路径：编辑器挂在 bot 的 `/queue` 上时，
     * `/favicon.ico` 不归编辑器接管（框架会回 404），图标就不显示。
     * `editor.html` 里写的是 `__MOUNT__/favicon.ico`，由服务端按**这次请求实际带的前缀**替换。
     */
    const homeRes = await api("/")
    await check("首页（无前缀形态）引用了 /favicon.ico", () => {
      if (homeRes.status !== 200) throw new Error(`首页状态 ${homeRes.status}`)
      if (!String(homeRes.json.__raw).includes('rel="icon" href="/favicon.ico"'))
        throw new Error("首页里没有 favicon 的 link 标签")
    })

    const mountedRes = await api("/queue/")
    await check("首页（挂载形态）把图标指到 /queue/favicon.ico，而不是站根", () => {
      if (mountedRes.status !== 200) throw new Error(`首页状态 ${mountedRes.status}`)
      const html = String(mountedRes.json.__raw)
      if (!html.includes('rel="icon" href="/queue/favicon.ico"'))
        throw new Error("挂载形态下图标没有指向挂载前缀")
      if (html.includes('href="/favicon.ico"')) throw new Error("首页里还留着站根图标路径")
    })

    /**
     * 无尾斜杠 → 301 到带斜杠：首页里的请求都是相对路径（`api/*`、`font/*`），
     * 地址栏 `…/queue` 会让它们解析到站根、全部 404。规范形式必须固定。
     */
    const noSlash = await fetch(`http://127.0.0.1:${port}/queue`, { redirect: "manual" })
    await check("无尾斜杠访问 /queue → 301 到 /queue/（相对路径才不会跑偏）", () => {
      if (noSlash.status !== 301) throw new Error(`状态 ${noSlash.status}`)
      const loc = noSlash.headers.get("location") ?? ""
      if (!loc.endsWith("/queue/")) throw new Error(`location=${loc}`)
    })

    /**
     * 页脚与其它请求**共用同一个取口令的方式**。
     *
     * 反面教材：自己 `new URLSearchParams(location.search)` 取 `k` —— 主脚本开局就把 `?k=` 收进
     * localStorage 并把地址栏清干净了，于是那次请求带的是空口令、`/api/meta` 回 403，页脚静默消失。
     * 这条只能查**整份**首页（`api()` 的 `__raw` 会截到前 4000 字符，页脚在文件末尾）。
     */
    const homeText = await (await fetch(`http://127.0.0.1:${port}/?${query()}`)).text()
    await check("首页的页脚走 withToken（不许自己读 location.search）", () => {
      if (!homeText.includes("withToken('api/meta')")) throw new Error("页脚没有走 withToken('api/meta')")
      /** 只数**真读地址栏**的那种写法（注释里提到 location.search 不算） */
      const reads = (homeText.match(/URLSearchParams\(location\.search\)/g) ?? []).length
      if (reads !== 1) throw new Error(`URLSearchParams(location.search) 出现 ${reads} 次（应当只有主脚本那一次）`)
    })

    /**
     * 安全响应头（审查报告 #3 / #7）：**所有路径**都要带，不只是首页。
     *
     * 三件事都是在堵"公网页面 + 口令在 URL 里"带来的实害：点击劫持（无 XFO）、
     * 口令顺着外链 Referer 漏出去（无 Referrer-Policy）、响应被猜类型（无 nosniff）。
     * 这里挨个路径抽查一遍——只测首页的话，"接口忘了带"照样会漏。
     */
    const SEC_HEADERS = { "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }
    await check("安全头：首页 / 接口 / 探活 / 无口令 403 / 图标 都带 XFO + Referrer-Policy + nosniff", async () => {
      const samples = [
        ["首页", `/?${query()}`],
        ["接口 /api/meta", `/api/meta?${query()}`],
        ["接口 /api/data", `/api/data?${query()}`],
        ["探活 /healthz", `/healthz?${query()}`],
        ["无口令 403", "/api/data"],
        ["图标", "/favicon.ico"],
      ]
      const bad = []
      for (const [label, p] of samples) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`)
        for (const [name, want] of Object.entries(SEC_HEADERS)) {
          const got = res.headers.get(name)
          if (got !== want) bad.push(`${label} 的 ${name}=${JSON.stringify(got)}（期望 ${want}）`)
        }
      }
      if (bad.length) throw new Error(bad.join("；"))
    })

    await check("接口响应不许被缓存：/api/meta 与 /api/data 都是 cache-control: no-store", async () => {
      for (const p of [`/api/meta?${query()}`, `/api/data?${query()}`]) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`)
        const got = res.headers.get("cache-control")
        if (got !== "no-store") throw new Error(`${p} 的 cache-control=${JSON.stringify(got)}（应当 no-store）`)
      }
    })

    /**
     * 页脚内容里的**字面 `\n`** 要当换行渲染。
     *
     * 老注释教人「多行由 `\n` 转义」，但那一路在面板里根本走不通（`yamlValue()` 会把反斜杠再转义一层，
     * YAML 解析回来仍是"反斜杠 + n"），页面于是把 `\n` 照字面画了出来——实机就是这么一个现场。
     */
    const metaRes = await api("/api/meta")
    await check("页脚：配置里手打的字面 \\n 当换行渲染（不是把 \\n 画出来）", () => {
      if (metaRes.status !== 200) throw new Error(`/api/meta 状态 ${metaRes.status}`)
      const footer = String(metaRes.json.footer ?? "")
      if (!footer.includes("footer-line-1") || !footer.includes("footer-line-2"))
        throw new Error(`页脚内容丢了：${JSON.stringify(footer)}`)
      if (footer.includes("\\n")) throw new Error(`页脚里还留着字面 \\n：${JSON.stringify(footer)}`)
      if (!/footer-line-1<\/div>\s*<div>footer-line-2/.test(footer))
        throw new Error(`两行没有折开：${JSON.stringify(footer)}`)
    })

    /**
     * 页脚是**署名**：字号要跟正文接近、字体跟页面一致、链接不要浏览器默认的下划线。
     * 三条都是"看页面才知道"的口径，所以这里就照着样式块钉住（改 CSS 时会被绊一下）。
     */
    await check("页脚样式：字号跟正文接近、字体继承页面、链接不带下划线", () => {
      const css = homeText.slice(homeText.indexOf(".site-footer {"))
      const size = /\.site-footer\s*\{[^}]*font-size:\s*(\d+)px/.exec(css)
      if (!size) throw new Error("没读到页脚字号")
      if (Number(size[1]) < 14) throw new Error(`页脚字号只有 ${size[1]}px（正文 17px、次要文字 13~14px）`)
      if (!/\.site-footer\s*\{[^}]*font-family:\s*inherit/.test(css)) throw new Error("页脚没有显式继承页面字体")
      if (!/\.site-footer\s+a\s*\{[^}]*text-decoration:\s*none/.test(css)) throw new Error("页脚链接没有显式去掉下划线")
    })

    /**
     * 页脚要贴着最后一个组件：它必须在 `</main>` **里面**（`main` 的 40px 底衬是页尾留白，
     * 落在页脚下方），上边距也只能是小几十像素——放在 main 外面时那 40px 会被夹在中间，
     * 页脚看着离组件老远。
     */
    await check("页脚位置：在 </main> 里面、上边距 ≤ 12px（别把页尾留白夹在中间）", () => {
      const at = homeText.indexOf('id="siteFooter"')
      const mainEnd = homeText.indexOf("</main>")
      if (at < 0 || mainEnd < 0) throw new Error("首页里没找到页脚或 </main>")
      if (at > mainEnd) throw new Error("页脚在 </main> 外面（40px 底衬会夹在它与最后一个组件之间）")
      const gap = /\.site-footer\s*\{[^}]*margin:\s*(\d+)px\s+auto\s+0/.exec(homeText.slice(homeText.indexOf(".site-footer {")))
      if (!gap) throw new Error("没读到页脚的上边距")
      if (Number(gap[1]) > 12) throw new Error(`页脚上边距 ${gap[1]}px 偏大`)
    })

    /**
     * **故意不带口令**：浏览器请求 favicon 时不会有 `?k=`（页面口令在 localStorage 里、不是 cookie），
     * 所以这条必须能在口令校验之前放行。上面那几条"无口令访问 /api/data 被拒"已经钉住数据接口，
     * 这里只验"图标是那个例外、且吐的就是仓库里那份文件"。
     */
    const iconRes = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
    const buf = Buffer.from(await iconRes.arrayBuffer())
    await check("不带口令也能取到（favicon 先于口令校验）", () => {
      if (iconRes.status !== 200) throw new Error(`状态 ${iconRes.status}（浏览器不会带 ?k=，403 就等于没图标）`)
    })
    await check("返回的是 ico（内容类型 + 文件头 type=1）", () => {
      const type = iconRes.headers.get("content-type") ?? ""
      if (!/icon/i.test(type)) throw new Error(`content-type=${type}`)
      if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("不是 ICO 文件头")
      if (buf.readUInt16LE(4) < 1) throw new Error("ICO 里一张图都没有")
    })
    await check("吐出来的是 256 那版（高分屏/任务栏要够大，64 会发虚）", () => {
      const onDisk = fs.readFileSync(path.join(PLUGIN_DIR, "resources", "image", "HuTao_LeLouvre_256.ico"))
      if (!buf.equals(onDisk)) throw new Error(`长度 ${buf.length} vs ${onDisk.length}`)
      /** ICO 里那张图的尺寸要真是 256（免得文件改名了内容没换） */
      const w = buf[6] || 256
      const h = buf[7] || 256
      if (w !== 256 || h !== 256) throw new Error(`图标尺寸 ${w}x${h}`)
    })
    /** 挂载形态下也得取得到（浏览器就是按 href 里那条 `/queue/favicon.ico` 去要的） */
    const mountedIcon = await fetch(`http://127.0.0.1:${port}/queue/favicon.ico`)
    await check("挂载形态下 /queue/favicon.ico 不带口令也 200", () => {
      if (mountedIcon.status !== 200) throw new Error(`状态 ${mountedIcon.status}（挂载下浏览器要的就是这条）`)
    })

    await check("面板用的 64 那版仍在（锅巴 iconPath 指着它）", () => {
      const small = path.join(PLUGIN_DIR, "resources", "image", "HuTao_LeLouvre.ico")
      if (!fs.existsSync(small)) throw new Error(`缺 ${small}`)
    })
  }

  /** 只有口令、没有签名身份：看得到全部，但一格也改不了 */
  const guest = await api("/api/data")
  check("访客（只有口令）：能看到全部行", () => {
    if (guest.json.sheets.length !== 3) throw new Error(`得到 ${guest.json.sheets.length} 个表`)
    if (!guest.json.sheets.every(s => s.rows.length > 0)) throw new Error("有表没有返回行")
  })
  check("访客：角色为 guest 且标记只读", () => {
    if (guest.json.perm.role !== "guest") throw new Error(`role=${guest.json.perm.role}`)
    if (guest.json.perm.readonly !== true) throw new Error("没有标记只读")
  })

  check("字段：与原表同序列出（完成情况在备注右边），不含序号", () => {
    const keys = guest.json.fields.map(f => f.key)
    const want = ["nickname", "gameName", "anchor", "goal", "strength", "note", "status"]
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`字段为 ${keys.join(",")}，期望 ${want.join(",")}`)
    if (keys.includes("seq")) throw new Error("不该显示 seq")
    const required = guest.json.fields.filter(f => f.required).map(f => f.key)
    if (JSON.stringify(required) !== JSON.stringify(["nickname", "gameName", "anchor", "goal"]))
      throw new Error(`必填项为 ${required.join(",")}`)
  })
  check("字段：完成情况有下拉选项", () => {
    const s = guest.json.sheets.find(x => x.name === "幽境危战")
    if (!s.options.status?.includes("排队中")) throw new Error("完成情况没有下拉选项")
    if (!s.options.goal?.length || !s.options.anchor?.length) throw new Error("难度/主播没有下拉选项")
  })

  /**
   * 完成情况的候选只该有：状态词（等待开启 / 排队中 / 本人已完成）∪ 本榜主播 ∪ 表里**在用**的值
   *
   * 归档（`archiveOptions`）只增不减：表里当年用过的名字会被写进 xlsx 的下拉验证列表，再没人用时
   * 永远留着——现场就是「幽境危战的完成情况里有神秘的『小伙01』残留」（该榜没有任何一行的 status 是他）。
   * 注意：表里存字面「本人已完成」时，页面会把它显示成该行昵称（`statusWithSelfDone`），
   * 所以"在用值"要按**原始值**算（显示值等于昵称且候选里有「本人已完成」⇒ 原始值就是它）。
   */
  check("字段：完成情况的候选没有「归档残留」，在用的值一个也不少", () => {
    const WORDS = ["等待开启", "排队中", "本人已完成"]
    for (const s of guest.json.sheets) {
      const cands = s.options?.status ?? []
      const anchors = new Set(s.options?.anchor ?? [])
      const inUse = new Set()
      for (const r of s.rows) {
        const shown = String(r.status ?? "").trim()
        if (!shown) continue
        /** 显示值 == 该行昵称且候选里有「本人已完成」⇒ 表里存的是那四个字 */
        const raw = shown === String(r.nickname ?? "").trim() && cands.includes("本人已完成") ? "本人已完成" : shown
        for (const part of raw
          .split(/[,，]/)
          .map(x => x.trim())
          .filter(Boolean))
          inUse.add(part)
      }
      const stale = cands.filter(v => !WORDS.includes(v) && !anchors.has(v) && !inUse.has(v))
      if (stale.length)
        throw new Error(`${s.name} 的完成情况候选里有没人用的残留：${stale.join("、")}（候选=${JSON.stringify(cands)}）`)
      for (const v of inUse)
        if (!cands.includes(v))
          throw new Error(`${s.name} 在用的「${v}」没进候选；候选=${JSON.stringify(cands)}；在用的=${JSON.stringify([...inUse])}`)
    }
  })

  /** 各榜开榜时间：剧诗每月 1 号（不用「等待开启」）；深渊每月 16 号 4 点；危战没有固定日子 */
  const expectedDefaultStatus = name => {
    const now = new Date()
    if (/剧诗/.test(name)) return "排队中"
    if (!/螺旋/.test(name)) return "等待开启"
    const openAt = new Date(now.getFullYear(), now.getMonth(), 16, 4, 0, 0, 0)
    return now.getTime() >= openAt.getTime() ? "排队中" : "等待开启"
  }

  check("默认值：完成情况按各榜开榜时间下发（剧诗排队中 / 深渊看 16 号 4 点 / 危战等待开启）", () => {
    for (const s of guest.json.sheets) {
      const want = expectedDefaultStatus(s.name)
      if (s.defaults?.status !== want) throw new Error(`${s.name}：下发的是 ${JSON.stringify(s.defaults?.status)}，期望 ${want}`)
    }
  })

  const sheet = "幽境危战"
  const all = guest.json.sheets.find(x => x.name === sheet).rows
  /** 找一个有昵称的行当"本人"，再找一个昵称不同的当"别人" */
  const mineRow = all.find(r => String(r.nickname).trim())
  const MY_NICK = String(mineRow.nickname).trim()
  const otherRow = all.find(r => String(r.nickname).trim() && String(r.nickname).trim() !== MY_NICK)
  const who = { qq: "1000000001", nick: MY_NICK }

  const self = await api("/api/data", null, { who })
  check("本人（带签名）：只拿得到自己那一行", () => {
    if (self.json.perm.role !== "self") throw new Error(`role=${self.json.perm.role}`)
    const rows = self.json.sheets.find(x => x.name === sheet).rows
    if (!rows.length) throw new Error("没有返回自己那一行")
    for (const r of rows) if (String(r.nickname).trim() !== MY_NICK) throw new Error(`返回了别人的行：${r.nickname}`)
  })

  const selfSheet = self.json.sheets.find(x => x.name === sheet)
  check("本人：下发「已占用行号」，新增一行不会挑到别人的行", () => {
    if (!Array.isArray(selfSheet.taken)) throw new Error("没有下发 taken")
    if (selfSheet.taken.length !== all.length) throw new Error(`taken 有 ${selfSheet.taken.length} 个，应为 ${all.length}`)
    const taken = new Set(selfSheet.taken)
    let row = 0
    for (let r = selfSheet.dataStart; r <= selfSheet.dataEnd; r++) if (!taken.has(r)) { row = r; break }
    if (!row) throw new Error("数据区里没有空行可加")
    if (taken.has(row)) throw new Error(`挑到了别人占着的第 ${row} 行`)
  })

  /** 按前端的挑行口径真写一行，再原样清掉：确认"首次报名"这条路是通的、且不碰别人的行 */
  await check("本人（本榜还没有自己的行）：能新增一行，保存后能再清掉", async () => {
    const here = new Set(guest.json.sheets.find(x => x.name === sheet).rows.map(r => String(r.nickname).trim()))
    const elsewhere = guest.json.sheets.filter(x => x.name !== sheet)
    const newcomer = elsewhere.flatMap(x => x.rows.map(r => String(r.nickname).trim())).find(n => n && !here.has(n))
    if (!newcomer) throw new Error("测试表里找不到「别的榜有行、本榜没行」的人")
    const who2 = { qq: "10010", nick: newcomer }

    const payload = await api("/api/data", null, { who: who2 })
    const s2 = payload.json.sheets.find(x => x.name === sheet)
    if (s2.rows.length) throw new Error(`本榜不该有他的行：${s2.rows.map(r => r.nickname).join(",")}`)
    const taken = new Set(s2.taken ?? [])
    let row = 0
    for (let r = s2.dataStart; r <= s2.dataEnd; r++) if (!taken.has(r)) { row = r; break }
    if (!row) throw new Error("数据区里没有空行可加")

    const added = await api(
      "/api/save",
      {
        sheet,
        rows: [
          {
            row,
            values: {
              nickname: newcomer,
              gameName: "新增测试",
              /** 选择主播 / 难度及目标现在是必填 */
              anchor: (s2.options.anchor ?? [])[0],
              goal: (s2.options.goal ?? [])[0],
            },
          },
        ],
      },
      { who: who2 },
    )
    if (!added.json.ok) throw new Error(added.json.error || "新增失败")
    const seen = await api("/api/data")
    const got = seen.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === row)
    if (String(got?.nickname).trim() !== newcomer) throw new Error(`第 ${row} 行没写进去：${JSON.stringify(got)}`)
    /** 没填的字段按默认值落表：账号强度「中配」、完成情况按该榜开榜时间（幽境危战=等待开启） */
    if (got.strength !== "中配") throw new Error(`账号强度默认值不对：${JSON.stringify(got.strength)}`)
    const wantStatus = expectedDefaultStatus(sheet)
    if (got.status !== wantStatus) throw new Error(`完成情况默认值不对：${JSON.stringify(got.status)}，期望 ${wantStatus}`)

    /** 清空要显式给空串：漏传的字段会被当成"不动" */
    const blanks = Object.fromEntries(payload.json.fields.map(f => [f.key, ""]))
    const cleared = await api("/api/save", { sheet, rows: [{ row, values: blanks }] }, { a: ADMIN_TOKEN })
    if (!cleared.json.ok) throw new Error(cleared.json.error || "清理失败")
    const back = await api("/api/data")
    if (back.json.sheets.find(x => x.name === sheet).rows.some(r => r.row === row)) throw new Error("新增的行没清掉")
  })

  await check("篡改签名：换掉昵称后降级为只读访客", async () => {
    const id = signIdentity(who, TOKEN)
    const forged = Buffer.from(JSON.stringify({ q: "1", n: "别人", t: Date.now() }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const r = await api(`/api/data?k=${TOKEN}&u=${encodeURIComponent(forged)}&s=${encodeURIComponent(id.s)}`)
    if (r.json.perm.role !== "guest") throw new Error(`role=${r.json.perm.role}`)
  })

  const marker = "编辑器测试备注"
  const original = mineRow.note
  const saveMine = await api("/api/save", { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, note: marker } }] }, { who })
  check("本人：能改自己那一行", () => {
    if (!saveMine.json.ok) throw new Error(saveMine.json.error || "保存失败")
    if (saveMine.json.written !== 1) throw new Error(`written=${saveMine.json.written}`)
  })

  const otherSave = await api(
    "/api/save",
    { sheet, rows: [{ row: otherRow.row, values: { ...otherRow, note: "越权" } }] },
    { who },
  )
  check("本人：改别人的行被拒绝", () => {
    if (otherSave.json.ok) throw new Error("竟然保存成功了")
    if (!String(otherSave.json.error).includes("只能改自己那一行")) throw new Error(otherSave.json.error)
  })

  const guestSave = await api("/api/save", { sheet, rows: [{ row: mineRow.row, values: { ...mineRow } }] })
  check("访客：不能保存", () => {
    if (guestSave.json.ok) throw new Error("竟然保存成功了")
    if (!String(guestSave.json.error).includes("只能查看")) throw new Error(guestSave.json.error)
  })

  /* ---------------------- 完成情况：本人可填，主播改过就锁 ---------------------- */

  const statusOpt = guest.json.sheets.find(x => x.name === sheet).options.status
  const doneValue = statusOpt.find(v => v === "本人已完成") ?? statusOpt[0]
  const selfStatus = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, status: doneValue, note: original } }] },
    { who },
  )
  check("本人：能填自己的完成情况", () => {
    if (!selfStatus.json.ok) throw new Error(selfStatus.json.error || "保存失败")
  })

  const admin = await api("/api/data", null, { a: ADMIN_TOKEN })
  check("管理员（管理口令）：角色为 admin", () => {
    if (admin.json.perm.role !== "admin") throw new Error(`role=${admin.json.perm.role}`)
    if (admin.json.perm.showAdmins !== true) throw new Error("没有开放白名单维护")
  })

  /** 管理口令同样走恒时比较：错口令不得当上管理员（也不得因为比较失败而 500） */
  const badAdmin = await api("/api/data", null, { a: (ADMIN_TOKEN[0] === "0" ? "1" : "0") + ADMIN_TOKEN.slice(1) })
  check("管理员：错的（等长）管理口令不授予 admin", () => {
    if (badAdmin.status !== 200) throw new Error(`期望 200（只是没身份），实际 ${badAdmin.status}`)
    if (badAdmin.json.perm.role === "admin") throw new Error("错管理口令竟然拿到 admin")
  })

  const adminStatus = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, status: "排队中", note: original } }] },
    { a: ADMIN_TOKEN },
  )
  check("管理员：能改别人的完成情况", () => {
    if (!adminStatus.json.ok) throw new Error(adminStatus.json.error || "保存失败")
  })

  const locked = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, status: doneValue, note: marker } }] },
    { who },
  )
  check("本人：主播改过完成情况后，改不动这一格（其余字段照常保存）", () => {
    if (!locked.json.ok) throw new Error(locked.json.error || "保存失败")
    if (!(locked.json.ignored ?? []).some(i => i.label === "帮帮完成情况")) throw new Error("没有回报被忽略的字段")
  })
  const afterLock = await api("/api/data", null, { who })
  const lockedRow = afterLock.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === mineRow.row)
  check("锁定生效：完成情况仍是主播填的值，备注已改", () => {
    if (lockedRow.status !== "排队中") throw new Error(`status=${lockedRow.status}`)
    if (lockedRow.note !== marker) throw new Error(`note=${lockedRow.note}`)
    if (lockedRow.statusLocked !== true) throw new Error("没有回报 statusLocked")
  })

  /* ---------------------- 按 QQ 定位（改了群名片也认人） ---------------------- */

  const RENAMED = "改了名片的同一个人"
  const renamed = await api("/api/data", null, { who: { qq: who.qq, nick: RENAMED } })
  check("按 QQ 定位：换了群名片，靠绑定仍能拿到自己那一行", () => {
    if (renamed.json.perm.role !== "self") throw new Error(`role=${renamed.json.perm.role}`)
    const rows = renamed.json.sheets.find(x => x.name === sheet).rows
    if (!rows.some(r => r.row === mineRow.row)) throw new Error(`只拿到 ${rows.length} 行，没有绑定那一行`)
  })
  const renamedRow = renamed.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === mineRow.row)
  check("按 QQ 定位：表里的群昵称被同步成新名片", () => {
    if (String(renamedRow.nickname).trim() !== RENAMED) throw new Error(`昵称=${renamedRow.nickname}`)
    if ((renamed.json.sync?.renamed ?? 0) < 1) throw new Error("没有回报同步动作")
  })
  const saveRenamed = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...renamedRow, note: marker } }] },
    { who: { qq: who.qq, nick: RENAMED } },
  )
  check("按 QQ 定位：绑定过的行照常可保存", () => {
    if (!saveRenamed.json.ok) throw new Error(saveRenamed.json.error || "保存失败")
  })

  /* ---------------- 「选择主播」下拉：以主播列表为准 ---------------- */

  check("选择主播：下拉以主播列表为准（每一位都在，顺序也按表内顺序）", () => {
    const s = admin.json.sheets.find(x => x.name === sheet)
    const names = s.anchorRows.map(a => a.name)
    if (JSON.stringify(s.options.anchor.slice(0, names.length)) !== JSON.stringify(names))
      throw new Error(`下拉前 ${names.length} 项应为主播列表：${JSON.stringify(s.options.anchor)}`)
  })
  check("选择主播：表里在用的值仍在（别名除外）", () => {
    const { compileAliases, canonicalAnchor } = aliases
    /** 别名映射就是本进程真正写给编辑器的配置：出现"配置归不出正名"的差异才算问题 */
    const known = compileAliases(aliasMap)
    for (const s of guest.json.sheets) {
      /** 用 payload 里的 anchors（各角色都会下发），主播区的明细行只有管理员才有 */
      const names = s.anchors ?? []
      const used = [...new Set(s.rows.flatMap(r => String(r.anchor ?? "").split(/[,，]/).map(x => x.trim()).filter(Boolean)))]
      for (const v of used) {
        /** 别名归到正名：只要正名在表里且有下拉项，就算这个值"选得到" */
        const c = canonicalAnchor(v, known)
        if (c !== v && names.includes(c)) {
          if (!s.options.anchor.includes(c)) throw new Error(`${s.name}：「${v}」是「${c}」的别名，但下拉里没有正名`)
          continue
        }
        if (!s.options.anchor.includes(v)) throw new Error(`${s.name}：表里在用的「${v}」不在下拉里`)
      }
    }
  })
  await check("选择主播：主播列表里有、原下拉验证里没有的名字也能存回去", async () => {
    /**
     * 点名一位"只在主播区、不在「选择主播」下拉验证里"的主播（真实表里是深境螺旋的摸头妹）：
     * 这类名字不当成"不在选项里"处理。目标在文件头从被测表里推出来，挑不到就说明这份表没有这个场景。
     */
    if (!anchorMissingFromList) {
      console.log("     ⏭ 这份表里没有「只主播区有、下拉验证没有」的名字，跳过")
      return
    }
    const { name: anchorName } = anchorMissingFromList
    const s = admin.json.sheets.find(x => x.name === anchorMissingFromList.sheet)
    if (!s?.anchorRows.some(a => a.name === anchorName)) {
      console.log(`     ⏭ 榜「${anchorMissingFromList.sheet}」的主播列表里没有「${anchorName}」，跳过`)
      return
    }
    const row = guest.json.sheets
      .find(x => x.name === anchorMissingFromList.sheet)
      .rows.find(r => String(r.nickname).trim())
    const saved = await api(
      "/api/save",
      { sheet: anchorMissingFromList.sheet, rows: [{ row: row.row, values: { ...row, anchor: anchorName } }] },
      { a: ADMIN_TOKEN },
    )
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
    const back = await api("/api/data", null, { a: ADMIN_TOKEN })
    const now = back.json.sheets
      .find(x => x.name === anchorMissingFromList.sheet)
      .rows.find(x => x.row === row.row)
    if (now.anchor !== anchorName) throw new Error(`表里是 ${now.anchor}`)
    await api(
      "/api/save",
      { sheet: anchorMissingFromList.sheet, rows: [{ row: row.row, values: { ...row } }] },
      { a: ADMIN_TOKEN },
    )
  })

  check("选择主播：别名归到正名，不在下拉里多出一个名字", () => {
    /** 表里有人按旧名（别名）写，正名在主播区：下拉只该出现正名 */
    const s = guest.json.sheets.find(x => x.name === sheet)
    const used = [...new Set(s.rows.flatMap(r => String(r.anchor ?? "").split(/[,，]/).map(x => x.trim()).filter(Boolean)))]
    const here = aliasMapOf(sheet, s.anchors ?? [], used)
    if (!here.length) {
      console.log("     ⏭ 这个榜没有用别名写的行，跳过")
      return
    }
    for (const { alias, canonical } of here) {
      if (s.options.anchor.includes(alias)) throw new Error(`下拉里不该出现别名：${JSON.stringify(s.options.anchor)}`)
      if (!s.options.anchor.includes(canonical)) throw new Error(`下拉里少了正名「${canonical}」`)
    }
  })
  await check("选择主播：写着别名的老行，不改动也能照常保存", async () => {
    const s = guest.json.sheets.find(x => x.name === sheet)
    const used = [...new Set(s.rows.flatMap(r => String(r.anchor ?? "").split(/[,，]/).map(x => x.trim()).filter(Boolean)))]
    const aliasesHere = aliasMapOf(sheet, s.anchors ?? [], used).map(x => x.alias)
    const row = s.rows.find(r => aliasesHere.some(a => String(r.anchor ?? "").includes(a)))
    if (!row) {
      console.log("     ⏭ 没有这样的行，跳过")
      return
    }
    const saved = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
  })

  /* --------------------- 多选字段与部分字段提交 --------------------- */

  check("选择主播：下拉不重复、不含别名", () => {
    const s = admin.json.sheets.find(x => x.name === sheet)
    const list = s.options.anchor
    if (list.length !== new Set(list).size) throw new Error(`下拉有重复：${JSON.stringify(list)}`)
    for (const [canonical, patterns] of Object.entries(aliasMap))
      for (const alias of patterns)
        if (list.includes(alias) && !list.includes(canonical))
          throw new Error(`下拉里只剩别名「${alias}」、没有正名「${canonical}」：${JSON.stringify(list)}`)
  })
  await check("多选：选择主播可以同时选多位（逗号分隔落表）", async () => {
    const multi = guest.json.sheets.find(x => x.name === sheet).options.anchor.filter(v => !/^都可以$/.test(v))
    if (multi.length < 2) {
      console.log("     ⏭ 可选主播不足两位，跳过")
      return
    }
    const row = guest.json.sheets.find(x => x.name === sheet).rows.find(r => String(r.nickname).trim())
    const want = `${multi[0]},${multi[1]}`
    const saved = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, anchor: want } }] }, { a: ADMIN_TOKEN })
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
    const back = await api("/api/data", null, { a: ADMIN_TOKEN })
    const now = back.json.sheets.find(x => x.name === sheet).rows.find(x => x.row === row.row)
    if (now.anchor !== want) throw new Error(`表里是 ${now.anchor}`)
    await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
  })
  await check("多选：完成情况也可以同时写多位主播", async () => {
    const opts = guest.json.sheets.find(x => x.name === sheet).options.status
    const two = opts.filter(v => !["等待开启", "排队中", "本人已完成"].includes(v)).slice(0, 2)
    if (two.length < 2) {
      console.log("     ⏭ 完成情况里没有两位主播可选，跳过")
      return
    }
    const row = guest.json.sheets.find(x => x.name === sheet).rows.find(r => String(r.nickname).trim())
    const want = two.join(",")
    const saved = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, status: want } }] }, { a: ADMIN_TOKEN })
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
    await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
  })
  await check("多选：「都可以」是独占的，不能和别的并选", async () => {
    const s = guest.json.sheets.find(x => x.name === sheet)
    if (!s.options.anchor.includes("都可以")) {
      console.log("     ⏭ 这个榜没有「都可以」选项，跳过")
      return
    }
    const other = s.options.anchor.find(v => !["都可以"].includes(v))
    const row = s.rows.find(r => String(r.nickname).trim())
    const bad = await api(
      "/api/save",
      { sheet, rows: [{ row: row.row, values: { ...row, anchor: `都可以,${other}` } }] },
      { a: ADMIN_TOKEN },
    )
    if (bad.json.ok) throw new Error("竟然保存成功了")
    if (!String(bad.json.error).includes("不能和别的")) throw new Error(bad.json.error)
    /** 单独选「都可以」是允许的 */
    const alone = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, anchor: "都可以" } }] }, { a: ADMIN_TOKEN })
    if (!alone.json.ok) throw new Error(`单独选「都可以」应允许：${alone.json.error}`)
    await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
  })
  await check("只提交改动的字段：不会把其它字段清掉、也不该报「游戏名不能为空」", async () => {
    const row = guest.json.sheets.find(x => x.name === sheet).rows.find(r => String(r.nickname).trim())
    const saved = await api("/api/save", { sheet, rows: [{ row: row.row, values: { note: "只改了备注" } }] }, { a: ADMIN_TOKEN })
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
    const back = await api("/api/data", null, { a: ADMIN_TOKEN })
    const now = back.json.sheets.find(x => x.name === sheet).rows.find(x => x.row === row.row)
    if (now.nickname !== row.nickname || now.gameName !== row.gameName) throw new Error("其它字段被清掉了")
    if (now.note !== "只改了备注") throw new Error(`备注没写进去：${now.note}`)
    await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
  })

  await check("手填的主播自动归档成下拉选项（表格里手写的也算）", async () => {
    /** 模拟有人在 Excel 里手填了一个下拉里没有的主播名 */
    const { Table } = await shared("model/table.js")
    await shared("model/store.js")
    const table = new Table({ file: fixture, backup: false })
    const row = mineRow.row
    const NICK = "新来的主播"
    await table.mutate(ctx => ctx.setCell(sheet, row, "anchor", NICK))

    /** 管理员打开一次编辑器 → 归档 */
    const before = await api("/api/data", null, { a: ADMIN_TOKEN })
    const listBefore = before.json.sheets.find(x => x.name === sheet).options.anchor
    if (!listBefore.includes(NICK)) throw new Error(`打开时没归档：${JSON.stringify(listBefore)}`)

    /** 表格自己的下拉里也要有它 */
    const { openWorkbook } = await shared("model/xlsx.js")
    const { buildModel } = await shared("model/schema.js")
    const wb = await openWorkbook(fs.readFileSync(fixture))
    const model = buildModel({ name: sheet, xml: await wb.sheetXml(sheet), shared: wb.shared })
    const col = model.col.anchor
    const xml = await wb.sheetXml(sheet)
    const body = new RegExp(`sqref="${col}[^"]*"[^>]*>[\\s\\S]*?<formula1>([\\s\\S]*?)</formula1>`).exec(xml)?.[1] ?? ""
    if (!body.includes(NICK)) throw new Error(`表格下拉里没归档：${body.slice(0, 120)}`)
    if (!/errorStyle="warning"/.test(xml)) throw new Error("校验强度没有放宽成 warning")

    /** 收尾：把这一格改回去 */
    await table.mutate(ctx => ctx.setCell(sheet, row, "anchor", mineRow.anchor ?? ""))
  })

  await check("完成情况：「等待开启 / 排队中」与完成人互斥", async () => {
    const s = guest.json.sheets.find(x => x.name === sheet)
    const row = s.rows.find(r => String(r.nickname).trim())
    const done = (s.options.status ?? []).find(v => !["等待开启", "排队中", "本人已完成"].includes(v))
    if (!done) {
      console.log("     ⏭ 没有可用的完成人选项，跳过")
      return
    }
    for (const [status, why] of [
      [`排队中,${done}`, "排队中 + 完成人"],
      [`等待开启,${done}`, "等待开启 + 完成人"],
      ["等待开启,排队中", "两个未开始状态"],
    ]) {
      const bad = await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row, status } }] }, { a: ADMIN_TOKEN })
      if (bad.json.ok) throw new Error(`${why} 竟然保存成功了`)
      if (!/互斥|只能选一个/.test(String(bad.json.error))) throw new Error(`${why}：${bad.json.error}`)
    }
  })
  await check("必填：选择主播 / 难度及目标不能为空", async () => {
    /**
     * 行号要挑一个**合法且空着**的：`row: 0` 会被当成"不存在的新行"走到必填校验，
     * 而它连成员数据区都不在（表头上方是主播区），会被行范围检查直接拒掉，测的就不是必填了。
     * 这里取数据区末尾 +100（追加余量之内、没人占），缺的必填项也就不会被"行里原有的值"补齐。
     */
    const live = await api("/api/data", null, { a: ADMIN_TOKEN })
    const emptyRow = live.json.sheets.find(x => x.name === sheet).dataEnd + 100
    const r = await api(
      "/api/save",
      { sheet, rows: [{ row: emptyRow, values: { nickname: "必填检查专用", gameName: "游戏名", note: "只填了备注" } }] },
      { a: ADMIN_TOKEN },
    )
    if (r.json.ok) throw new Error("缺必填也保存成功了")
    const msg = String(r.json.error ?? "")
    if (!msg.includes("选择主播") || !msg.includes("难度及目标")) throw new Error(`报错没提这两个必填项：${msg}`)
  })

  await check("完成情况：「本人已完成」落成该行群昵称", async () => {
    const s = guest.json.sheets.find(x => x.name === sheet)
    const row = s.rows.find(r => String(r.nickname).trim())
    const saved = await api(
      "/api/save",
      { sheet, rows: [{ row: row.row, values: { ...row, status: "本人已完成" } }] },
      { a: ADMIN_TOKEN },
    )
    if (!saved.json.ok) throw new Error(saved.json.error || "保存失败")
    const back = await api("/api/data", null, { a: ADMIN_TOKEN })
    const now = back.json.sheets.find(x => x.name === sheet).rows.find(x => x.row === row.row)
    if (now.status !== String(row.nickname).trim()) throw new Error(`实际写成了：${now.status}`)
    if (!(saved.json.notices ?? []).some(n => String(n.text).includes("群昵称"))) throw new Error("没有回报这次转换")
    /** 还原 */
    await api("/api/save", { sheet, rows: [{ row: row.row, values: { ...row } }] }, { a: ADMIN_TOKEN })
  })

  /* ------------------------------ 开榜时间 ------------------------------ */

  await check("开榜时间：到点的榜自动翻成「排队中」，没有固定开榜日子的榜不动", async () => {
    const pick = name => guest.json.sheets.find(x => x.name === name).rows.find(r => String(r.nickname).trim())
    /** 危战没有固定开榜日子：造一行「等待开启」，它必须原样保留 */
    const weiZhan = { name: "幽境危战", row: pick("幽境危战") }
    const made = await api(
      "/api/save",
      { sheet: weiZhan.name, rows: [{ row: weiZhan.row.row, values: { ...weiZhan.row, status: "等待开启" } }] },
      { a: ADMIN_TOKEN },
    )
    if (!made.json.ok) throw new Error(`造数据失败：${made.json.error}`)

    const waitingCount = sheet => guest.json.sheets.find(x => x.name === sheet).rows.filter(r => r.status === "等待开启").length
    /** 管理员打开这一步会顺手把到点的行翻掉 */
    const after = await api("/api/data", null, { a: ADMIN_TOKEN })
    const shenNow = after.json.sheets.find(x => x.name === "深境螺旋").rows.filter(r => r.status === "等待开启").length
    const weiNow = after.json.sheets.find(x => x.name === weiZhan.name).rows.find(r => r.row === weiZhan.row.row)
    if (weiNow.status !== "等待开启") throw new Error(`危战不该被翻：${weiNow.status}`)

    if (expectedDefaultStatus("深境螺旋") === "排队中") {
      /** 到点了：深渊残留的「等待开启」应该被翻成「排队中」 */
      if (shenNow) throw new Error(`深渊到点了还留着 ${shenNow} 行「等待开启」`)
      if (!(after.json.sync?.opened >= 1)) throw new Error(`没有翻任何行：opened=${after.json.sync?.opened}`)
    } else {
      /** 没到点：一行都不能动 */
      if (shenNow !== waitingCount("深境螺旋")) throw new Error("深渊没到点却被翻了")
      if (after.json.sync?.opened !== 0) throw new Error(`不该有改动：opened=${after.json.sync?.opened}`)
    }

    /** 还原那一行 */
    await api("/api/save", { sheet: weiZhan.name, rows: [{ row: weiZhan.row.row, values: { ...weiZhan.row } }] }, { a: ADMIN_TOKEN })
  })

  /* --------------------- 表头上方的「主播列表」 --------------------- */

  const sheetAnchors = admin.json.sheets.find(x => x.name === sheet).anchorRows
  check("主播列表：管理员拿得到主播区的行（字段与渲染列一致）", () => {
    if (!Array.isArray(sheetAnchors) || !sheetAnchors.length) throw new Error("没有返回主播行")
    for (const a of sheetAnchors)
      for (const key of ["row", "name", "recommend", "duty", "skills", "platform", "link"])
        if (!(key in a)) throw new Error(`主播行缺少 ${key}：${JSON.stringify(a)}`)
  })
  check("主播列表：非管理员拿不到（普通人与访客都没有）", () => {
    if (guest.json.sheets.find(x => x.name === sheet).anchorRows !== undefined) throw new Error("访客也拿到了主播行")
    if (self.json.sheets.find(x => x.name === sheet).anchorRows !== undefined) throw new Error("本人也拿到了主播行")
  })

  const anchorRow = sheetAnchors[0]
  const anchorMarker = "自动化测试强项"
  const savedAnchor = await api(
    "/api/anchors",
    {
      sheet,
      rows: [
        {
          row: anchorRow.row,
          values: {
            name: anchorRow.name,
            recommend: anchorRow.recommend || "强烈推荐",
            duty: anchorRow.duty || "幽境危战",
            skills: anchorMarker,
            platform: anchorRow.platform || "B站",
            link: anchorRow.link,
          },
        },
      ],
    },
    { a: ADMIN_TOKEN },
  )
  check("主播列表：管理员能改", () => {
    if (!savedAnchor.json.ok) throw new Error(savedAnchor.json.error || "保存失败")
    if (savedAnchor.json.written !== 1) throw new Error(`written=${savedAnchor.json.written}`)
  })

  const anchorBack = await api("/api/data", null, { a: ADMIN_TOKEN })
  const anchorNow = anchorBack.json.sheets.find(x => x.name === sheet).anchorRows.find(a => a.row === anchorRow.row)
  check("主播列表：改动落表（强项 / 专职 / 推荐度都在）", () => {
    if (anchorNow.skills !== anchorMarker) throw new Error(`强项=${anchorNow.skills}`)
    if (anchorNow.duty !== (anchorRow.duty || "幽境危战")) throw new Error(`专职=${anchorNow.duty}`)
    if (anchorNow.recommend !== (anchorRow.recommend || "强烈推荐")) throw new Error(`推荐度=${anchorNow.recommend}`)
  })
  await check("主播列表：改完表结构没被动（合并 / 校验 / 条件格式数量不变）", async () => {
    const { openWorkbook } = await shared("model/xlsx.js")
    const countOf = (text, tag) => text.split(tag).length - 1
    const before = await (await openWorkbook(fs.readFileSync(SRC))).sheetXml(sheet)
    const after = await (await openWorkbook(fs.readFileSync(fixture))).sheetXml(sheet)
    for (const tag of ["<mergeCell ", "<dataValidation ", "<conditionalFormatting ", "<hyperlink "])
      if (countOf(after, tag) !== countOf(before, tag))
        throw new Error(`${tag} 数量变化：${countOf(before, tag)} → ${countOf(after, tag)}`)
  })

  await check("主播列表：保存后表格自己的「选择主播」下拉也同步（以主播为准）", async () => {
    const { openWorkbook } = await shared("model/xlsx.js")
    const { buildModel } = await shared("model/schema.js")
    const readSheet = async file => {
      const wb = await openWorkbook(fs.readFileSync(file))
      const xml = await wb.sheetXml(sheet)
      return { xml, model: buildModel({ name: sheet, xml, shared: wb.shared }) }
    }
    const now = await readSheet(fixture)
    const col = now.model.col.anchor
    const listOf = (xml, letter) => {
      const re = new RegExp(`<dataValidation[^>]*sqref="${letter}[^"]*"[^>]*>[\\s\\S]*?<formula1>([\\s\\S]*?)</formula1>`)
      const body = re.exec(xml)?.[1] ?? ""
      return body
        .replace(/&quot;/g, '"')
        .replace(/^"|"$/g, "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    }
    const names = now.model.anchors.map(a => a.name)
    const list = listOf(now.xml, col)
    for (const n of names) if (!list.includes(n)) throw new Error(`下拉里没有主播「${n}」：${JSON.stringify(list)}`)
    /** 原文里那个"主播区有、下拉没有"的名字（如摸头妹）现在必须在 */
    const before = await readSheet(SRC)
    const wasMissing = before.model.anchors.map(a => a.name).filter(n => !listOf(before.xml, before.model.col.anchor).includes(n))
    for (const n of wasMissing) if (!list.includes(n)) throw new Error(`原本缺的「${n}」还是没补上下拉`)
    /**
     * 主播列表新增的人也要同步进「帮帮完成情况」的下拉（现场问过：上方加主播后，下方两个下拉是否都跟着加）
     * 这一列同样是多值、同样按主播区走（`mergeStatusOptions`），写回表时一并更新。
     */
    const statusList = listOf(now.xml, now.model.col.status)
    for (const n of names) if (!statusList.includes(n)) throw new Error(`完成情况下拉里没有主播「${n}」：${JSON.stringify(statusList)}`)
    /** 别的列的下拉原样不动 */
    const strengthCol = now.model.col.strength
    if (JSON.stringify(listOf(now.xml, strengthCol)) !== JSON.stringify(listOf(before.xml, strengthCol)))
      throw new Error("账号强度的下拉被误改")
  })

  await check("主播列表：本人与访客都不能改", async () => {
    const body = { sheet, rows: [{ row: anchorRow.row, values: { ...anchorNow, skills: "越权" } }] }
    for (const opts of [{ who }, {}]) {
      const r = await api("/api/anchors", body, opts)
      if (r.json.ok) throw new Error("竟然保存成功了")
      if (!String(r.json.error).includes("只有白名单管理员")) throw new Error(r.json.error)
    }
  })

  /**
   * 「帮帮完成情况」的手动收录（临时成员：不在主播区、也不是本人）
   *
   * 关键点：收录进来的名字必须**一直留在候选里**——它不能被"候选净化"清掉
   * （净化只清表里那份下拉验证的残留），所以要单独存一份名单。
   */
  await check("收录临时成员：主人/管理员可用，本人与访客 403，收录后候选里一直有他", async () => {
    const name = "临时帮忙的阿花"
    /** 权限：本人与访客都不行 */
    for (const opts of [{ who }, {}]) {
      const r = await api("/api/status-names", { sheet, name }, opts)
      if (r.status !== 403) throw new Error(`本人/访客竟然能收录（HTTP ${r.status}）`)
    }
    /** 管理员（管理口令）可以 */
    const ok = await api("/api/status-names", { sheet, name }, { a: ADMIN_TOKEN })
    if (!ok.json.ok) throw new Error(`管理员收录失败：${ok.json.error}`)
    if (!(ok.json.names ?? []).includes(name)) throw new Error(`返回的名单里没有他：${JSON.stringify(ok.json.names)}`)

    /** 再拉一次数据：这一列的下拉里必须有他（而且是持久化的，不是一次性的） */
    const again = await api("/api/data", null, { a: ADMIN_TOKEN })
    const s = again.json.sheets.find(x => x.name === sheet)
    if (!(s.options?.status ?? []).includes(name))
      throw new Error(`收录之后候选里没有「${name}」：${JSON.stringify(s.options?.status)}`)

    /** 幂等：重复收录不产生重复项 */
    await api("/api/status-names", { sheet, name }, { a: ADMIN_TOKEN })
    const twice = await api("/api/data", null, { a: ADMIN_TOKEN })
    const list = twice.json.sheets.find(x => x.name === sheet).options.status
    if (list.filter(v => v === name).length !== 1) throw new Error(`重复收录产生了重复项：${JSON.stringify(list)}`)

    /** 逗号是这一列的分隔符，不能收进名字里 */
    const bad = await api("/api/status-names", { sheet, name: "甲,乙" }, { a: ADMIN_TOKEN })
    if (bad.json.ok) throw new Error("带逗号的名字竟然收录成功了")
  })
  await check("主播列表：不能写到非主播行、也不能把主播名清空", async () => {
    const notAnchor = await api("/api/anchors", { sheet, rows: [{ row: mineRow.row, values: { name: "x" } }] }, { a: ADMIN_TOKEN })
    if (notAnchor.json.ok || !String(notAnchor.json.error).includes("不是主播列表")) throw new Error(notAnchor.json.error)
    const noName = await api("/api/anchors", { sheet, rows: [{ row: anchorRow.row, values: { name: "" } }] }, { a: ADMIN_TOKEN })
    if (noName.json.ok || !String(noName.json.error).includes("不能为空")) throw new Error(noName.json.error)
  })

  /* ------------------------- 本机模式（桌面快捷方式） ------------------------- */

  /** 本地编辑器不带口令启动（`--allow-no-token`）：等同管理员，所以主播列表与所有行都能改 */
  const localPort = await freePort()
  const local = spawn(process.execPath, [editor, "--port", String(localPort), "--file", fixture, "--allow-no-token"], {
    /** 临时目录里的表：同上是测试模式（见 data-confinement.test.mjs） */
    env: { ...process.env, ABYSS_QUEUE_CONFIG: cfg, ABYSS_EDITOR_TEST_PATHS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let localOut = ""
  local.stdout.on("data", d => (localOut += d))
  local.stderr.on("data", d => (localOut += d))
  try {
    let up = false
    for (let i = 0; i < 40; i++) {
      await wait(400)
      try {
        const r = await fetch(`http://127.0.0.1:${localPort}/healthz`)
        if (r.ok) {
          up = true
          break
        }
      } catch {}
    }
    if (!up) throw new Error(`本地模式编辑器没起来：\n${localOut}`)
    const res = await fetch(`http://127.0.0.1:${localPort}/api/data`)
    const out = await res.json()
    check("本地编辑器（不带口令）：等同管理员，主播列表可改", () => {
      if (out.perm?.role !== "admin") throw new Error(`role=${out.perm?.role}`)
      const rows = out.sheets.find(x => x.name === sheet)?.anchorRows
      if (!Array.isArray(rows) || !rows.length) throw new Error("没有下发主播列表")
      if (!out.sheets.every(s => (s.rows?.length ?? 0) > 0)) throw new Error("没有下发数据行")
    })
  } finally {
    local.kill()
  }

  /* ------------------------------ 白名单 ------------------------------ */

  await check("白名单：没有管理口令时读不到", async () => {
    const r = await api("/api/admins")
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
  })
  await check("白名单：读出环境变量里写死的那些 QQ", async () => {
    const r = await api("/api/admins", null, { a: ADMIN_TOKEN })
    if (!r.json.ok) throw new Error(r.json.error)
    if (!r.json.admins.includes(ENV_ADMIN_QQ)) throw new Error(`admins=${JSON.stringify(r.json.admins)}`)
    if (!r.json.env.includes(ENV_ADMIN_QQ)) throw new Error("没有回报环境变量来源")
    /** 环境变量里那条昵称解析不出 QQ：既不能当权限，也要在接口里说得明明白白 */
    if (r.json.admins.includes(ENV_ADMIN)) throw new Error(`昵称条目不该出现在权限名单里：${JSON.stringify(r.json.admins)}`)
    if (!r.json.ignored?.includes(ENV_ADMIN)) throw new Error(`没有报出被拒绝的昵称条目：${JSON.stringify(r.json.ignored)}`)
  })
  await check("白名单：想加昵称会被拒绝（群昵称随时能改，不能当权限）", async () => {
    const r = await api("/api/admins", { add: ["某个群昵称"] }, { a: ADMIN_TOKEN })
    if (r.json.ok) throw new Error("竟然允许把昵称加进白名单")
    if (!String(r.json.error).includes("QQ")) throw new Error(r.json.error)
  })

  /* ------------------------------ 主人 ------------------------------ */

  const ownerWho = { qq: OWNER, nick: "主人甲" }
  const plainAdminWho = { qq: ENV_ADMIN_QQ, nick: "环境白名单本人" }

  const ownerData = await api("/api/data", null, { who: ownerWho })
  check("主人：自己就是管理员（看得到全部行与主播列表）", () => {
    if (ownerData.json.perm.role !== "admin") throw new Error(`role=${ownerData.json.perm.role}`)
    if (ownerData.json.perm.owner !== true) throw new Error("没有标记 owner")
    if (!ownerData.json.perm.showAdmins) throw new Error("没给「权限管理」入口")
    if (ownerData.json.sheets.find(x => x.name === sheet).rows.length !== all.length) throw new Error("看不到全部行")
    if (!ownerData.json.sheets.find(x => x.name === sheet).anchorRows?.length) throw new Error("看不到主播列表")
  })

  check("主人：没有管理口令也能读白名单", async () => {
    const r = await api("/api/admins", null, { who: ownerWho })
    if (r.status !== 200 || !r.json.ok) throw new Error(`status=${r.status} ${r.json.error ?? ""}`)
    if (!r.json.owners.includes(OWNER)) throw new Error(`owners=${JSON.stringify(r.json.owners)}`)
  })

  check("主人：写在白名单文件 owner 里的人同样算主人", async () => {
    const fileOwner = { qq: FILE_OWNER, nick: "文件主人" }
    const data = await api("/api/data", null, { who: fileOwner })
    if (data.json.perm.owner !== true) throw new Error(`perm.owner=${data.json.perm.owner}`)
    const r = await api("/api/admins", null, { who: fileOwner })
    if (r.status !== 200 || !r.json.ok) throw new Error(`status=${r.status} ${r.json.error ?? ""}`)
  })

  check("普通管理员：没有管理口令仍然读不到白名单", async () => {
    const r = await api("/api/admins", null, { who: plainAdminWho })
    if (r.status !== 403) throw new Error(`期望 403，实际 ${r.status}`)
    const data = await api("/api/data", null, { who: plainAdminWho })
    if (data.json.perm.owner) throw new Error("普通管理员不该被当成主人")
    if (data.json.perm.showAdmins) throw new Error("普通管理员不该看到「权限管理」")
  })

  /** 加白名单只收 QQ：昵称本人随时能改，收进来等于把权限交给"改个名片"（AQ-01） */
  const tempAdminQq = "555555"
  const ownerAdd = await api("/api/admins", { add: [tempAdminQq] }, { who: ownerWho })
  check("主人：能加白名单（立即生效）", async () => {
    if (!ownerAdd.json.ok) throw new Error(ownerAdd.json.error || "添加失败")
    const promoted = await api("/api/data", null, { who: { qq: tempAdminQq, nick: "临时管理员" } })
    if (promoted.json.perm.role !== "admin") throw new Error(`新加的人 role=${promoted.json.perm.role}`)
  })

  await check("主人：写回白名单不会把文件里的 owner 名单抹掉", () => {
    const raw = JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8"))
    if (!Array.isArray(raw.owner) || !raw.owner.includes(FILE_OWNER)) throw new Error(`文件里的 owner 被改坏了：${JSON.stringify(raw)}`)
  })

  const ownerRemove = await api("/api/admins", { remove: [tempAdminQq] }, { who: ownerWho })
  check("主人：能移出白名单（立即生效）", async () => {
    if (!ownerRemove.json.ok) throw new Error(ownerRemove.json.error || "移除失败")
    const demoted = await api("/api/data", null, { who: { qq: tempAdminQq, nick: "临时管理员" } })
    if (demoted.json.perm.role !== "self") throw new Error(`移出后 role=${demoted.json.perm.role}`)
  })

  const addQq = "10086"
  const addWho = { qq: addQq, nick: otherRow.nickname }
  await api("/api/admins", { add: [addQq] }, { a: ADMIN_TOKEN })
  const promoted = await api("/api/data", null, { who: addWho })
  check("白名单：加进去的人变成管理员，能看到全部行", () => {
    if (promoted.json.perm.role !== "admin") throw new Error(`role=${promoted.json.perm.role}`)
    const rows = promoted.json.sheets.find(x => x.name === sheet).rows
    if (rows.length !== all.length) throw new Error(`只看到 ${rows.length} 行，应为 ${all.length}`)
  })
  const promotedSave = await api(
    "/api/save",
    { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, note: "白名单改的" } }] },
    { who: addWho },
  )
  check("白名单：能改别人的行", () => {
    if (!promotedSave.json.ok) throw new Error(promotedSave.json.error || "保存失败")
  })

  await api("/api/admins", { remove: [addQq] }, { a: ADMIN_TOKEN })
  const demoted = await api("/api/data", null, { who: addWho })
  check("白名单：移出后立刻回到只能改自己", () => {
    if (demoted.json.perm.role !== "self") throw new Error(`role=${demoted.json.perm.role}`)
  })

  /* ------------------------- 请求体上限（S04） ------------------------- */

  /**
   * 4MB 上限是**接收量**的上限，验两件只有"整条路由"才看得出来、单测 `http/respond.js` 看不出来的事：
   *   1. **能先判角色的接口先判角色**：访客根本不该让对方把 4MB 灌完才拿到 403；
   *   2. 有身份的人真发超限的体，拿到的是 400 + "请求体过大"（不是 500、也不是连接被弄断），
   *      而且服务端在结算之后照常活着。
   * 字节级的边界与"超限后不再保留分块"在 `body-limit.test.mjs` 里量（那边能精确控制收发）。
   */
  const oversized = `{"sheet":${JSON.stringify(sheet)},"rows":[],"pad":"${"a".repeat(4 * 1024 * 1024)}"}`
  await check("访客发超限请求体：先判角色，直接 403（不必先把 4MB 收下来）", async () => {
    const res = await apiRaw("/api/save", oversized)
    const text = res.text
    /** 先读请求体的话，这里会变成 400「请求体过大」——那就说明角色判定被排在读体之后了 */
    if (res.status !== 403) throw new Error(`期望 403（先判角色），实际 HTTP ${res.status} ${text.slice(-200)}`)
  })

  await check("有身份的人发超限请求体：400 且说明是「请求体过大」", async () => {
    let res
    try {
      res = await apiRaw("/api/save", oversized, { who: ownerWho })
    } catch (err) {
      throw new Error(`超限时连接被弄断了（客户端只看到 ${err.message}），应当先把错误响应写出去`)
    }
    const text = res.text
    if (res.status !== 400) throw new Error(`期望 400，实际 HTTP ${res.status} ${text.slice(-200)}`)
    if (!text.includes("请求体过大")) throw new Error(`没有说清是请求体过大：${text.slice(-200)}`)
    const after = await api("/healthz")
    if (after.status !== 200) throw new Error(`超限之后服务端不再应答：HTTP ${after.status}`)
  })

  /* ------------------------------ 收尾 ------------------------------ */

  await api("/api/save", { sheet, rows: [{ row: mineRow.row, values: { ...mineRow, note: original } }] }, { a: ADMIN_TOKEN })
  const restored = await api("/api/data")
  const r2 = restored.json.sheets.find(x => x.name === sheet).rows.find(r => r.row === mineRow.row)
  check("还原：备注回到原值", () => {
    if (r2.note !== original) throw new Error(`期望 ${JSON.stringify(original)}，实际 ${JSON.stringify(r2.note)}`)
  })
  check("整表行数未变", () => {
    if (restored.json.sheets.find(x => x.name === sheet).rows.length !== all.length) throw new Error("行数变化")
  })
  check("源表格未被触碰（编辑器只写副本）", () => {
    const a = fs.statSync(SRC)
    if (Date.now() - a.mtimeMs < 60_000) console.log(`     （注意：源表最近被改过 ${a.mtime.toLocaleString()}，请人工确认）`)
  })

  /* ------------------------- 写操作审计（审查报告 #4） ------------------------- */

  await check("审计：写操作各记一行 [abyss-editor]（qq / action / status），且输出里没有口令", () => {
    const lines = out.split("\n").filter(line => line.includes("[abyss-editor]"))
    if (!lines.length) throw new Error("一条审计行都没有")
    for (const want of ["action=/api/save", "action=/api/anchors", "action=/api/admins"]) {
      if (!lines.some(line => line.includes(want)))
        throw new Error(`缺 ${want} 的审计行，最近几行：\n${lines.slice(-6).join("\n")}`)
    }
    if (!lines.some(line => / qq=\d+ /.test(line))) throw new Error("审计行里没有 qq=数字")
    if (!lines.some(line => / status=\d+/.test(line))) throw new Error("审计行里没有 status=")
    /** 审计行**绝不带口令**——这是报告特别点名的（"写日志时不得把 ?k= 带进去"） */
    if (out.includes(TOKEN)) throw new Error("编辑器输出里出现了访问口令")
  })

} catch (err) {
  failed++
  console.log(`  ❌ 异常：${err.message}`)
} finally {
  child.kill()
  await wait(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n❌ 编辑器端到端验证失败 ${failed} 项` : "\n✅ 编辑器端到端验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：子进程已 kill、临时目录已清，让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
