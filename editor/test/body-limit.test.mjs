/**
 * 请求体契约（`editor/http/respond.js`）：边界、超限后继续追加、连接中断
 *
 * 声明的是**接收量**的上限（JSON 4MB / 上传 32MB），所以"到了上限就停"这件事必须能被测出来：
 *   - 边界：正好等于上限要收下，多一个字节才算超限（不是"到了上限就拒"）；
 *   - 超限后追加：客户端还在往里灌的时候，服务端只能回一句"过大"，**不能继续留着**后面的分块
 *     ——后者是本套件的重点，"留着但已经 reject 了"在功能上看不出来，只能在内存上量；
 *   - 连接中断：客户端半路断开不能把服务端带崩，后面的请求照常处理。
 *
 * 用法：node editor/test/body-limit.test.mjs
 */
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { shared } from "./plugin.mjs"

const { createChecker } = await shared("test/_helper.mjs")
const { check, finish } = createChecker("请求体契约")

const MODULE = path.join(import.meta.dirname, "..", "http", "respond.js")
const MODULE_URL = pathToFileURL(MODULE).href
const { readRawBody, JSON_BODY_LIMIT, BodyTooLarge } = await import(MODULE_URL)

const wait = ms => new Promise(r => setTimeout(r, ms))
const pad = n => Buffer.alloc(n, 0x61)

/**
 * 手写请求：要精确控制"声明多少字节 / 实际发多少 / 什么时候断开"
 *
 * `fetch` 做不到这件事——它要么把整个 body 发完再等回应，要么自己决定什么时候复用连接，
 * 而这里要测的正是"服务端在中途就回了、客户端还在发"。
 *
 * @param {number} port
 * @param {{contentLength:number, chunks:Buffer[], abortAt?:number}} opts
 *   `abortAt`：发满这么多字节就**直接断开**（模拟连接中断），不写 end()
 * @returns {Promise<{status:number, text:string, sent:number, error:string|null}>}
 */
const rawRequest = (port, { contentLength, chunks, abortAt = null }) =>
  new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1")
    let text = ""
    let sent = 0
    let error = null
    sock.on("data", d => (text += d))
    sock.on("error", err => {
      error = error ?? err.code ?? err.message
    })
    sock.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0), text, sent, error }))
    sock.once("connect", async () => {
      sock.write(
        `POST /api/save HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
          `content-length: ${contentLength}\r\nconnection: close\r\n\r\n`,
      )
      for (const chunk of chunks) {
        if (abortAt !== null && sent >= abortAt) {
          sock.destroy()
          return
        }
        if (!sock.write(chunk)) await new Promise(r => sock.once("drain", r))
        sent += chunk.length
      }
      sock.end()
    })
  })

/** 小上限：字节级边界不用搬 4MB 才测得出来（4MB 那条只核对常量本身） */
const LIMIT = 8 * 1024

/** 与 `editor.mjs` 的收尾同一口径：超限声明 close，然后只写这一句（不重复写） */
const server = http.createServer(async (req, res) => {
  try {
    const buf = await readRawBody(req, LIMIT)
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`LEN ${buf.length}`)
  } catch (err) {
    if (err instanceof BodyTooLarge) res.setHeader("connection", "close")
    /** 中断之后对端已经没了：写不出去是正常的，别让它在这里再抛一次把套件弄崩 */
    if (res.destroyed || req.destroyed) return
    res.writeHead(400, { "content-type": "text/plain" })
    res.end(err instanceof BodyTooLarge ? "TOO_LARGE" : `ERR ${err.code ?? err.name}`)
  }
})
await new Promise(r => server.listen(0, "127.0.0.1", r))
const port = server.address().port

try {
  await check("上限就是声明的 4MB（上传的 32MB 是另一条契约）", async () => {
    if (JSON_BODY_LIMIT !== 4 * 1024 * 1024) throw new Error(`JSON_BODY_LIMIT=${JSON_BODY_LIMIT}`)
  })

  await check("边界：正好等于上限 → 收下（比较是「超过」而不是「达到」）", async () => {
    const res = await rawRequest(port, { contentLength: LIMIT, chunks: [pad(LIMIT)] })
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${JSON.stringify(res.text.slice(-200))}`)
    if (!res.text.includes(`LEN ${LIMIT}`)) throw new Error(`服务端收到的字节数不对：${res.text.slice(-200)}`)
  })

  await check("边界：多一个字节 → 拒，且说明是「过大」而不是「不是合法 JSON」", async () => {
    const res = await rawRequest(port, { contentLength: LIMIT + 1, chunks: [pad(LIMIT + 1)] })
    if (res.status !== 400) throw new Error(`HTTP ${res.status}`)
    if (!res.text.includes("TOO_LARGE")) throw new Error(`拒绝原因不对：${res.text.slice(-200)}`)
  })

  await check("超限后继续追加：只回一句「过大」，客户端继续灌也不影响这次结算", async () => {
    /** 先灌过上限一个字节，再继续追加 1MB：超限之后还收不收后面这些块，看下面的断言 */
    const res = await rawRequest(port, {
      contentLength: LIMIT + 1024 * 1024,
      chunks: [pad(LIMIT + 1), ...Array.from({ length: 16 }, () => pad(64 * 1024))],
    })
    if (res.status !== 400) throw new Error(`HTTP ${res.status}`)
    if (!res.text.includes("TOO_LARGE")) throw new Error(`拒绝原因不对：${res.text.slice(-200)}`)
    if (res.error) throw new Error(`服务端把连接弄断了（客户端看到 ${res.error}），应当把响应写出去再收尾`)
    /** 响应只能有一份：出现两个状态行说明结算了不止一次 */
    if ((res.text.match(/HTTP\/1\.1 /g) ?? []).length !== 1) throw new Error(`响应不止一份：${res.text.slice(-300)}`)
  })

  await check("超限后继续追加：后续分块不再被保留（内存不跟着输入涨）", async () => {
    const kept = await retainedBytes(64 * 1024)
    /** 把实测值打出来：这条断言不能只在失败时才说话，否则"量了个 0"也会被当成通过 */
    console.log(`     （上限 64KB、超限后再灌 16MB：结算并回收之后仍被留着 ${(kept / 1048576).toFixed(1)}MB）`)
    /**
     * 超限即停的实现只留到上限附近；把后面每一块都留下的实现会把 16MB 一直挂在 `arrayBuffers` 上。
     * 阈值取 8MB——两边各有 2 倍以上余量（实测：本实现 0.0MB、把分块全留下的写法 16MB）。
     */
    if (kept > 8 * 1024 * 1024)
      throw new Error(`超限后仍在保留分块：仍有 ${(kept / 1048576).toFixed(1)}MB 挂着（上限 64KB、又灌了 16MB）`)
  })

  await check("连接中断（还没到上限就断开）：服务端不崩，后面的请求照常", async () => {
    /** 声明 32KB、只发 4KB 就断开：对端拿不到响应是必然的，要紧的是服务端别跟着出事 */
    await rawRequest(port, { contentLength: LIMIT * 4, chunks: [pad(2048), pad(2048)], abortAt: 4096 })
    await wait(200)
    const after = await rawRequest(port, { contentLength: 512, chunks: [pad(512)] })
    if (after.status !== 200) throw new Error(`中断之后服务端不再应答：HTTP ${after.status}`)
    if (!after.text.includes("LEN 512")) throw new Error(`中断之后收到的内容不对：${after.text.slice(-200)}`)
  })
} finally {
  await new Promise(r => server.close(r))
}

/**
 * 量"超限之后还留着多少分块"，三条关键设计：
 *
 *   1. **不给真连接**：真 socket 在服务端写完错误响应之后就被关掉了，"后面还来的分块"根本没机会到，
 *      那样量出来的是"连接关得早不早"，不是"还留不留"。用一个假的请求对象（EventEmitter）才能
 *      一直喂到 `end`，把"超限之后还在追加"这件事真正喂进去。
 *   2. **先跑一次对照**：同一段代码再喂一次"没人监听"的 16MB，量的是分配器自己没还回去的那部分；
 *      两次相减才是实现真正攥着的分块。少了这个对照，读数会在 0.1MB–4.5MB 之间飘（实测）。
 *   3. **换进程 + `--expose-gc`**：量的是整个进程的外部内存，前面用例的垃圾会串进来；先 `global.gc()`
 *      把"已经没人引用"的分块收掉，留下的就只能是实现自己还攥着的。
 *
 * @param {number} limit 上限
 * @returns {Promise<number>} 结算并回收之后仍被实现留着的字节
 */
async function retainedBytes(limit) {
  const code = `
    const { EventEmitter } = await import("node:events")
    const { readRawBody } = await import(${JSON.stringify(MODULE_URL)})
    const LIMIT = ${limit}
    const feed = async attach => {
      const req = new EventEmitter()
      let settled = "none"
      if (attach) readRawBody(req, LIMIT).then(v => (settled = "resolved"), e => (settled = e.name))
      /** 先越过上限；再一路灌到 16MB——实现如果把分块留着，这些就都会挂在 arrayBuffers 上 */
      req.emit("data", Buffer.allocUnsafe(LIMIT + 1))
      await new Promise(r => setImmediate(r))
      for (let i = 0; i < 256; i++) req.emit("data", Buffer.allocUnsafe(64 * 1024))
      req.emit("end")
      await new Promise(r => setImmediate(r))
      global.gc()
      await new Promise(r => setImmediate(r))
      global.gc()
      return { bytes: process.memoryUsage().arrayBuffers, settled }
    }
    await feed(false)
    const control = process.memoryUsage().arrayBuffers
    const kept = await feed(true)
    console.log("CONTROL " + control)
    console.log("MEM " + kept.bytes)
    console.log("SETTLED " + kept.settled)
  `
  const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", d => (out += d))
  child.stderr.on("data", d => (out += d))
  try {
    const read = key => Number(new RegExp(`${key} (\\d+)`).exec(out)?.[1] ?? NaN)
    for (let i = 0; i < 100 && Number.isNaN(read("MEM")); i++) {
      await wait(50)
      if (child.exitCode !== null) break
    }
    const mem = read("MEM")
    if (Number.isNaN(mem)) throw new Error(`子进程没有回报内存：\n${out.slice(-400)}`)
    /** 顺带钉住"只结算一次"：超限之后的 `end` 不该让这次请求变成成功 */
    const settled = /SETTLED (\S+)/.exec(out)?.[1]
    if (settled !== "BodyTooLarge") throw new Error(`结算结果不对（应当只结算成 BodyTooLarge）：${out.slice(-200)}`)
    return Math.max(0, mem - read("CONTROL"))
  } finally {
    child.kill()
  }
}

await finish()
/* 收尾后不强制退出：Windows + Node 24 上 process.exit 可能在异步句柄收尾途中触发 libuv 断言崩溃 */
