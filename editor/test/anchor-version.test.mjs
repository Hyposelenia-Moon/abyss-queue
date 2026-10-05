/**
 * 主播列表保存的版本冲突（AQ-06 的这一截收尾）
 *
 * 背景：成员行保存早就带 `version`、撞上就 409；主播列表（表头上方那份名单）当时**没有**接这一层，
 * 前端也没带版本——于是"别人刚改过表，我这一份基于旧表算出来的主播名单照样覆盖上去"。
 * 本套件钉住三件事：
 *   1) 页面保存主播列表时，把读到的那一版表带回去（不然服务端永远没得比）；
 *   2) 服务端认这一版：对不上就 409，且**一个字都不写进表**；
 *   3) 撞上 409 时前端与成员保存**同一套处理**：只提示、草稿（主播列表的编辑）保留、
 *      不自动重试、不自动重读。
 *
 * 口径：上半截把 `editor.html` 的内联脚本原样抽出来在 node:vm 里跑（桩 fetch + 最小 DOM）；
 * 下半截起一个真编辑器（空模板副本），因为"服务端真的认这一版"只有真服务端能证明。
 *
 * 用法：node editor/test/anchor-version.test.mjs（任意 cwd）
 */
import fs from "node:fs"
import { bootPage } from "./page-vm.mjs"

/* ------------------------------ 断言脚手架 ------------------------------ */

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

/** 服务端 409：表在保存期间被别人改过，一个字都没写进去 */
const CONFLICT_409 = {
  status: 409,
  body: { ok: false, conflict: true, error: "表格在你保存期间被改过（别人先提交、或表被外部改动），请刷新页面确认后再改" },
}
const ANCHORS_OK = n =>({ status: 200, body: { ok: true, written: n, options: 1 } })

console.log("主播列表保存的版本冲突（editor.html 原脚本 + 真接口）")

/* ------------------- ① 页面把读到的那一版带回去 ------------------- */

await check("保存主播列表时带上页面读到的那一版表（服务端才有得比）", async () => {
  const h = bootPage()
  await h.ready()
  must(h.probe.version === "v1", `页面没记住读到的版本：${JSON.stringify(h.probe.version)}`)
  h.typeAnchor(0, "skills", "我改的强项")
  await h.click("anchorSave")

  const posts = h.posts("api/anchors")
  must(posts.length === 1, `期望 1 个 /api/anchors 请求，实际 ${posts.length} 个`)
  must(
    posts[0].body.version === "v1",
    `主播列表保存请求里的 version 是 ${JSON.stringify(posts[0].body.version)}，应当带上页面读到的那一版 v1（不带就永远不会报冲突）`,
  )
})

/* ---------------- ② 撞上 409：同一套提示 + 不丢草稿 ---------------- */

await check("主播列表撞上 409：提示说清「没保存 / 草稿还在」，并给出下一步", async () => {
  const h = bootPage({ anchorReply: n => (n === 1 ? CONFLICT_409 : ANCHORS_OK(1)) })
  await h.ready()
  h.typeAnchor(0, "skills", "我改的强项")
  await h.click("anchorSave")

  const said = h.toasts().join("\n")
  must(/主播列表/.test(said), `提示里看不出是"主播列表"这一次没保存：${JSON.stringify(said)}`)
  must(/被别人改过|冲突/.test(said), `提示里看不出"冲突 / 被别人改过"：${JSON.stringify(said)}`)
  must(/没有保存|没保存|未保存/.test(said), `提示里没说清"这次的改动没保存"：${JSON.stringify(said)}`)
  must(/草稿还在/.test(said), `提示里没说草稿还在：${JSON.stringify(said)}`)
  must(/读取最新并对比/.test(said), `提示里没给出可执行的下一步：${JSON.stringify(said)}`)
  must(h.conflictShown(), "冲突提示条没有常驻显示（只弹了个会自己消失的 toast）")
})

await check("主播列表撞上 409：主播草稿一个字都不丢，界面上也还是我填的", async () => {
  const h = bootPage({ anchorReply: n => (n === 1 ? CONFLICT_409 : ANCHORS_OK(1)) })
  await h.ready()
  h.typeAnchor(0, "skills", "我改的强项")
  h.type(h.rowNo(10), "note", "我的备注")
  await h.click("anchorSave")

  must(h.probe.anchorEdited.size === 1, "冲突把主播列表的草稿弄丢了")
  const draft = h.probe.anchorEdited.get("剧诗\u0000" + 10)
  must(draft?.skills === "我改的强项", `主播草稿内容变了：${JSON.stringify(draft)}`)
  must(h.anchorValue(0, "skills") === "我改的强项", `界面上主播强项被清成了 ${JSON.stringify(h.anchorValue(0, "skills"))}`)
  must(h.probe.edited.get("剧诗\u0000" + 10)?.note === "我的备注", "成员行的草稿被主播列表的冲突连累了")
})

await check("主播列表撞上 409：不自动重试、不自动重读；用户再点一次才发请求", async () => {
  const h = bootPage({ anchorReply: n => (n === 1 ? CONFLICT_409 : ANCHORS_OK(1)) })
  await h.ready()
  h.typeAnchor(0, "skills", "我改的强项")
  await h.click("anchorSave")

  must(h.posts("api/anchors").length === 1, `被 409 拒了之后自动重试了：一共发了 ${h.posts("api/anchors").length} 个 /api/anchors`)
  must(h.reads().length === 1, `被 409 拒了之后自动重读了表：一共读了 ${h.reads().length} 次（load() 会把草稿清掉）`)

  await h.click("anchorSave")
  must(h.posts("api/anchors").length === 2, `用户手动再保存时应当只有这一发，实际 ${h.posts("api/anchors").length} 发`)
  must(!h.conflictShown(), "保存成功了，冲突提示条还挂着")
  must(h.probe.anchorEdited.size === 0, "保存成功后这一榜的主播草稿没清掉")
})

/* ------- ③ 端到端：服务端真的按版本判（起真编辑器；缺模板就跳过） ------- */

/**
 * 上面那一截的 fetch 是桩，"服务端照单全收"，证明不了"主播列表带上版本之后服务端真的认"。
 * 这一截起一个真编辑器，按页面的口径走一遍：`/api/data` 拿 version → 原样带回去保存（必须 200）；
 * 别人先提交之后，我手里这一版再提交必须 409，且**表里的值一个字节都没变**。
 */
{
  const harness = await import("./harness.mjs").catch(() => null)
  if (!harness || !fs.existsSync(harness.TEMPLATE)) {
    console.log("  ⏭ 缺空模板（或插件目录），跳过端到端那一截：主播列表的版本往返没验")
  } else {
    const OWNER = { qq: "424242", nick: "主人" }
    const TOKEN = "anchor-version-token"
    const SIGN_KEY = "anchor-version-sign-key"
    const SHEET = "幽境危战"
    const ws = harness.makeWorkspace("anchor-version")
    const adminsFile = ws.file("admins.json")
    fs.writeFileSync(adminsFile, JSON.stringify({ owner: [OWNER.qq], admins: [] }), "utf8")
    let editor = null
    try {
      editor = await harness.startEditor({
        label: "主播版本往返",
        ports: [7832, 7833, 7834],
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
      const anchorOf = async () => (await load()).sheets.find(s => s.name === SHEET)?.anchorRows?.[0]
      const payload = await load()
      const first = payload.sheets.find(s => s.name === SHEET)?.anchorRows?.[0]
      if (!first) {
        console.log(`  ⏭ 空模板里「${SHEET}」没有识别到主播行，跳过端到端那一截`)
      } else {
        const values = { ...first, skills: "页面带版本存的主播强项" }
        delete values.row
        delete values.entry

        await check("端到端：主播列表带着读到的那一版保存，服务端认（不是 409）", async () => {
          const v = (await load()).version
          must(typeof v === "string" && v.length > 0, `/api/data 没下发 version：${JSON.stringify(v)}`)
          const saved = await editor.request("/api/anchors", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row: first.row, values }], version: v },
          })
          must(saved.json.ok, `带着自己刚读到的版本保存主播列表被拒了（HTTP ${saved.status}）：${JSON.stringify(saved.json)}`)
          must((await anchorOf())?.skills === values.skills, "保存成功了，表里却没写进去")
        })

        await check("端到端：别人先提交主播列表，我手里这版被 409 拒掉，一个字都不落表", async () => {
          const mine = (await load()).version
          /** 另一个窗口：请求里不带版本号先写进去（页面还没跟着升级的那种） */
          const other = await editor.request("/api/anchors", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row: first.row, values: { ...values, skills: "别人先改的强项" } }] },
          })
          must(other.json.ok, `先提交的那个不该被拒：${JSON.stringify(other.json)}`)
          const rejected = await editor.request("/api/anchors", {
            who: OWNER,
            body: { sheet: SHEET, rows: [{ row: first.row, values: { ...values, skills: "不该落地" } }], version: mine },
          })
          must(
            rejected.status === 409 && rejected.json.conflict === true,
            `期望 409 冲突，实际 HTTP ${rejected.status} ${JSON.stringify(rejected.json)}`,
          )
          must(rejected.json.error, "409 里没给原因")
          must((await anchorOf())?.skills === "别人先改的强项", `被拒的主播列表保存落表了：${JSON.stringify((await anchorOf())?.skills)}`)
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

console.log(failed ? `\n❌ 主播列表版本冲突验证失败 ${failed} 项` : "\n✅ 主播列表版本冲突验证通过")
/** 退出码照旧（失败 = 1），但不强制退出：让事件循环自然收尾 */
process.exitCode = failed ? 1 : 0
