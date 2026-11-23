/**
 * 保存版本冲突：页面怎么说、服务端怎么判
 *
 * 九页重写后的口径（旧的"常驻冲突提示条 + 读取最新并对比"整套都不在了）：
 *   - 保存失败按原因分档：409 = 别人先改了（这次没保存、草稿还在、点「重新读取」看最新）；
 *     403 / 口令失效 = 去群里重取链接；其余（400 / 500 / 网络）= 只报原因；
 *   - 任何失败都**不自动重试、不自动重读**，草稿一直留在 `st.dirty` 里等人处理；
 *   - 保存请求始终带 `version`（服务端才有得比）与逐行 `base` 指纹。
 *
 * 用法：node editor/test/save-conflict.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"

import { bootPage, makeData, makeFakeTimers } from "./page-vm.mjs"

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const state = h => String(h.el("saveState").textContent ?? "")

/** 统一挂假时钟：自动保存的防抖要靠 `h.advance()` 推 */
const boot = opts => bootPage({ timers: makeFakeTimers(), ...opts })

/** 改一格并把防抖跑完 */
const edit = async (h, key, value, row = 10) => {
  h.type(h.rowNo(row), key, value)
  h.advance(1300)
  await h.ready()
  await h.ready()
}

console.log("保存版本冲突（editor.html 现脚本 + 请求捕获）")

/* ------------------- ① 409 ------------------- */

await check("撞上 409：提示写明「被别人改过 / 这次没保存 / 草稿还在」", async () => {
  const h = boot({
    saveReply: () => ({ status: 409, body: { ok: false, error: "这一版已经被别人改过" } }),
  })
  await h.ready()
  await edit(h, "note", "我的备注")
  const said = state(h) + " " + h.toasts().join(" ")
  must(/被别人改过/.test(said), `没说是别人改过：${JSON.stringify(said)}`)
  must(/没保存/.test(said), `没说这次没保存：${JSON.stringify(said)}`)
  must(/草稿还在/.test(said), `没说草稿还在：${JSON.stringify(said)}`)
  must(/重新读取/.test(said), `没给下一步（重新读取看最新）：${JSON.stringify(said)}`)
})

await check("409 之后草稿还在，也不自动重试、不自动重读", async () => {
  const h = boot({
    saveReply: () => ({ status: 409, body: { ok: false, error: "这一版已经被别人改过" } }),
  })
  await h.ready()
  await edit(h, "note", "我的备注")
  must(h.probe.dirty.length === 1, `草稿被清掉了：${JSON.stringify(h.probe.dirty)}`)
  must(h.posts("api/save").length === 1, `409 之后自动重试了：${h.posts("api/save").length} 发`)
  const reads = h.reads("api/data").length
  h.advance(5000)
  await h.ready()
  must(h.posts("api/save").length === 1, "过一会儿又自动重试了")
  must(h.reads("api/data").length === reads, "409 之后自动重读了表（会把草稿冲掉）")
})

await check("再点保存：原改动照样带着（不是从头再来）", async () => {
  let n = 0
  const h = boot({
    saveReply: () => (++n === 1 ? { status: 409, body: { ok: false, error: "这一版已经被别人改过" } } : { status: 200, body: { ok: true } }),
  })
  await h.ready()
  await edit(h, "note", "我的备注")
  must(h.posts("api/save").length === 1, "第一次没发出去")
  const tr = h.rowNo(10)
  h.type(tr, "gameName", "改个游戏名")
  h.advance(1300)
  await h.ready()
  const saves = h.posts("api/save")
  must(saves.length === 2, `第二次没发出去：${saves.length} 发`)
  must(JSON.stringify(saves[1].body.rows[0].values.note) === JSON.stringify("我的备注"),
    `第二次丢了第一次的改动：${JSON.stringify(saves[1].body.rows[0].values)}`)
})

/* ------------------- ② 保存请求的形状 ------------------- */

await check("保存请求带上面里读到的那一版表（服务端才有得比）", async () => {
  const h = boot({ dataFor: () => makeData(undefined, "v7") })
  await h.ready()
  await edit(h, "note", "我的备注")
  const saves = h.posts("api/save")
  must(saves.length === 1, `没发保存请求：${saves.length}`)
  must(saves[0].body.version === "v7", `没带版本号：${JSON.stringify(saves[0].body.version)}`)
  must(saves[0].body.base && typeof saves[0].body.base["10"] === "string",
    `没带逐行指纹：${JSON.stringify(saves[0].body.base)}`)
})

/* ------------------- ③ 其它失败 ------------------- */

await check("400（普通失败）：只报「保存失败：原因」，不摆冲突文案", async () => {
  const h = boot({ saveReply: () => ({ status: 400, body: { ok: false, error: "有必填没补全" } }) })
  await h.ready()
  await edit(h, "note", "我的备注")
  const said = state(h) + " " + h.toasts().join(" ")
  must(/保存失败/.test(said), `没说保存失败：${JSON.stringify(said)}`)
  must(/有必填没补全/.test(said), `没带原因：${JSON.stringify(said)}`)
  must(!/被别人改过/.test(said), `400 却摆了冲突文案：${JSON.stringify(said)}`)
  must(h.probe.dirty.length === 1, "400 之后草稿该留着")
})

await check("403（口令失效）：提示去群里重取链接", async () => {
  const h = boot({ saveReply: () => ({ status: 403, body: { ok: false, error: "这条链接已经失效" } }) })
  await h.ready()
  await edit(h, "note", "我的备注")
  const said = state(h) + " " + h.toasts().join(" ")
  must(/没权限保存/.test(said), `没说没权限：${JSON.stringify(said)}`)
  must(/#排队|重.*链接/.test(said), `没教人怎么重取链接：${JSON.stringify(said)}`)
})

await check("网络失败（fetch 抛异常）：照旧报「保存失败」", async () => {
  const h = boot({ saveReply: () => { throw new Error("网络断了") } })
  await h.ready()
  await edit(h, "note", "我的备注")
  const said = state(h) + " " + h.toasts().join(" ")
  must(/保存失败/.test(said), `没说保存失败：${JSON.stringify(said)}`)
  must(/网络断了/.test(said), `没带原因：${JSON.stringify(said)}`)
  must(h.probe.dirty.length === 1, "网络失败之后草稿该留着")
})

/* ---------- ⑥ 端到端：页面手里的那一版，服务端真的认（起真编辑器；缺模板就跳过） ---------- */

/**
 * 上面那一截的 fetch 是桩，"服务端照单全收"，所以证明不了"页面带回去的版本服务端真的认"。
 * 这一截起一个真编辑器，按页面的口径走一遍：`/api/data` 拿 version → 原样带回去保存。
 * 必须 200 —— 要是版本对不上，加上 version 之后**每一次保存都会变成 409**，
 * 那就成了比不带 version 更糟的回归。顺带钉住"别人先提交 → 我手里这版被 409 拒掉、且一个字不落表"。
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
