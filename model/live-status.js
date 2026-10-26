/**
 * B 站直播状态的缓存与刷新
 *
 * 数据源全部是**公开接口、不需要 Cookie**：
 *   - `GET  /room/v1/Room/get_info?room_id=`                 房间 → UP 主 / 状态
 *   - `POST /room/v1/Room/get_status_info_by_uids`          一批 UP 主 → 各自直播间状态
 *   - `GET  /live_user/v1/Master/info?uid=`                 UP 主 → 直播间号（这里只在必要时用）
 *
 * 为什么做成"缓存 + 定时刷新"而不是命令里现查：`#主播` / `#排队` 是高频查询，不能让群友
 * 等一个外网请求；缓存由唯一的 tick 每轮刷一次（见 apps/queue.js），命令只读内存/文件。
 *
 * 失败口径：接口失败**保留上一次状态**，超过 `stale` 时间就不展示（宁可不显示，也不把
 * "查不到"说成"未开播"）；同一个房间连续失败按 `backoff` 退避，不每轮重试。
 *
 * 落点：`<插件根>/data/anchor-live.json`（常量，没有配置项；套件用
 * `ABYSS_QUEUE_ANCHOR_LIVE_FILE` 重定向）。写盘复用 queue-state 的原子 `writeJson`。
 */
import { config } from "../components/config.js"
import { collectBiliRefs } from "../components/live-entry.js"
import { log } from "../components/logger.js"
import { readJson, writeJson } from "./queue-state.js"

const API = "https://api.live.bilibili.com"
const VERSION = 1
/** 状态有效期：与默认 tick 周期一致 */
const TTL = 3 * 60 * 1000
/** 超过这个时间没刷新成功：不展示状态（但不改动已存的值） */
const STALE = 10 * 60 * 1000
/** 单个房间解析失败后的退避 */
const BACKOFF = 30 * 60 * 1000
/** 每轮最多解析几个新房间（避免一次 tick 打出一串请求）；6 位主播要一轮解析完 */
const MAX_RESOLVE = 10
const TIMEOUT = 5000

const emptyState = () => ({
  version: VERSION,
  initialized: false,
  rooms: {},
  uidRoom: {},
  /** 短房号 → 接口返回的完整 room_id；查询/通知都用这一份身份 */
  roomAlias: {},
  /** 自检/定时刷新发现但还没发出去的开播事件（下一轮 tick 消费） */
  pending: {},
})

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 从各榜主播区收集需要查的 B 站引用（按房间/UID 去重） */
export function refsOf(models) {
  const seen = new Set()
  const out = []
  for (const model of models ?? []) {
    for (const anchor of model?.anchors ?? []) {
      for (const ref of collectBiliRefs(anchor?.entry)) {
        const key = ref.roomId ? `room:${ref.roomId}` : ref.uid ? `uid:${ref.uid}` : ""
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push({ key, roomId: ref.roomId, uid: ref.uid })
      }
    }
  }
  return out
}

export class LiveStatus {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 缓存文件
   * @param {Function} [opts.fetchImpl] 注入 fetch（套件用）
   * @param {Function} [opts.now] 注入时钟（套件用）
   * @param {number} [opts.ttl] 状态有效期
   * @param {number} [opts.stale] 超过多久不展示
   * @param {number} [opts.backoff] 失败退避
   * @param {number} [opts.maxResolve] 每轮最多解析几个新房间
   */
  constructor({ file = config.anchorLivePath, fetchImpl = globalThis.fetch, now = () => Date.now(), ttl = TTL, stale = STALE, backoff = BACKOFF, maxResolve = MAX_RESOLVE } = {}) {
    this.file = file
    this.fetchImpl = fetchImpl
    this.now = now
    this.ttl = ttl
    this.stale = stale
    this.backoff = backoff
    this.maxResolve = maxResolve
    this.state = null
  }

  /** 懒加载：读不出来（首次 / 损坏 / 写了一半）一律当空状态，最坏结果只是这一轮没状态可显示 */
  load() {
    if (this.state) return this.state
    const raw = readJson(this.file)
    const state = emptyState()
    if (raw && typeof raw === "object") {
      state.initialized = Boolean(raw.initialized)
      if (raw.rooms && typeof raw.rooms === "object") state.rooms = raw.rooms
      if (raw.uidRoom && typeof raw.uidRoom === "object") state.uidRoom = raw.uidRoom
      if (raw.roomAlias && typeof raw.roomAlias === "object") state.roomAlias = raw.roomAlias
      if (raw.pending && typeof raw.pending === "object") state.pending = raw.pending
    }
    this.state = state
    return state
  }

  #save() {
    try {
      writeJson(this.file, this.state)
    } catch (err) {
      log("error", `[abyss-queue] 写直播状态失败：${err?.message ?? err}`)
    }
  }

  /** 短房号/完整房号统一成接口返回的那个 room_id */
  #canonical(raw) {
    const id = String(raw ?? "")
    if (!id) return ""
    const state = this.load()
    return state.roomAlias?.[id] || id
  }

  /** 入口（字符串或解析结果）→ 当前状态；没有可用缓存时返回 null */
  lookup(entry) {
    const e = typeof entry === "string" ? { text: entry } : entry
    const state = this.load()
    const raw = e?.roomId || state.uidRoom?.[e?.uid] || ""
    const roomId = this.#canonical(raw)
    if (!roomId) return null
    const room = state.rooms?.[roomId]
    if (!room) return null
    if (this.now() - num(room.checkedAt) > this.stale) return null
    const live = num(room.live) === 1 ? "live" : "off"
    return {
      state: live,
      label: live === "live" ? "直播中" : "未开播",
      roomId,
      uid: String(room.uid ?? ""),
      link: `https://live.bilibili.com/${roomId}`,
      checkedAt: num(room.checkedAt),
    }
  }

  /** 某条入口对应的房间号（推送时把房间映射回主播用；短号会归一为完整号） */
  roomOf(entry) {
    const e = typeof entry === "string" ? { text: entry } : entry
    const state = this.load()
    return this.#canonical(e?.roomId || state.uidRoom?.[e?.uid] || "")
  }

  /**
   * 取走待发送的开播事件（自检命令与定时任务共用同一份基线）。
   *
   * 自检命令也会推进基线；如果它发现的开播只写状态、不留下事件，下一轮 tick 就再也
   * 看不到这次「非直播 → 直播中」，订阅提醒会漏。`refresh()` 把事件写进 `pending`，
   * tick 在真正准备发送时再取走；首轮基线/没配群时留在文件里，下一轮还能发。
   */
  takePending() {
    const state = this.load()
    const events = Object.values(state.pending ?? {})
    if (!events.length) return []
    state.pending = {}
    this.#save()
    return events
  }

  /** 一次网络请求；失败统一返回 null，不把异常抛给 tick */
  async #request(url, options = {}) {
    try {
      const res = await this.fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          ...(options.headers ?? {}),
        },
      })
      if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "?"}`)
      const json = await res.json()
      if (num(json?.code) !== 0) throw new Error(`code ${json?.code} ${json?.message ?? json?.msg ?? ""}`.trim())
      return json.data
    } catch (err) {
      return { __error: err?.message ?? String(err) }
    }
  }

  async #getRoom(roomId) {
    const data = await this.#request(`${API}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`)
    return data && !data.__error ? data : null
  }

  async #batch(uids) {
    if (!uids.length) return {}
    const data = await this.#request(`${API}/room/v1/Room/get_status_info_by_uids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uids: uids.map(u => Number(u)).filter(Boolean) }),
    })
    return data && !data.__error && typeof data === "object" ? data : null
  }

  /**
   * 刷新一轮
   * @param {Array} models 各榜模型
   * @param {number} [at] 当前时刻
   * @returns {Promise<Array<{roomId:string, uid:string, live:number}>>} 这一轮**刚开播**的房间
   */
  async refresh(models, at = this.now(), { force = false } = {}) {
    const state = this.load()
    if (!state.roomAlias || typeof state.roomAlias !== "object") state.roomAlias = {}
    if (!state.pending || typeof state.pending !== "object") state.pending = {}
    let dirty = false
    const started = []
    try {
      const refs = refsOf(models)
      if (!refs.length) {
        if (!state.initialized) {
          state.initialized = true
          dirty = true
        }
        if (dirty) this.#save()
        return started
      }

      /** 1) 房间 → uid：只解析没见过的房间，每轮限流；短号归一为接口返回的完整 room_id */
      let resolved = 0
      for (const ref of refs) {
        const rawRoom = String(ref.roomId ?? "")
        if (!rawRoom) continue
        const canonical = state.roomAlias[rawRoom] || rawRoom
        const room = state.rooms[canonical] ?? state.rooms[rawRoom]
        if (room?.uid) {
          /** 老缓存可能只把状态记在短号下：搬到完整号并留下映射 */
          state.uidRoom[String(room.uid)] = canonical
          if (canonical !== rawRoom) {
            state.roomAlias[rawRoom] = canonical
            /** 只有完整号还没有记录时才拿短号旧记录补；否则保留完整号那份，删掉短号重复项 */
            if (!state.rooms[canonical] && state.rooms[rawRoom]) state.rooms[canonical] = state.rooms[rawRoom]
            if (state.rooms[rawRoom]) delete state.rooms[rawRoom]
            dirty = true
          }
          continue
        }
        if (!force && room && num(room.failedAt) && at - num(room.failedAt) < this.backoff) continue
        if (resolved >= this.maxResolve) continue
        resolved++
        const info = await this.#getRoom(rawRoom)
        if (!info) {
          state.rooms[canonical] = { ...(room ?? {}), failedAt: at }
          dirty = true
          log("warn", `[abyss-queue] 直播间 ${rawRoom} 查询失败（保留旧状态，30 分钟后重试）`)
          continue
        }
        const uid = String(info.uid ?? "")
        const full = String(info.room_id || rawRoom)
        if (full !== rawRoom) {
          state.roomAlias[rawRoom] = full
          if (state.rooms[rawRoom]) delete state.rooms[rawRoom]
        }
        state.rooms[full] = { uid, live: num(info.live_status), checkedAt: at, failedAt: 0 }
        if (uid) state.uidRoom[uid] = full
        dirty = true
        /** 新建房间没有旧状态可比：不推送（避免刚开这一轮就把所有在播的都报一遍） */
      }

      /** 2) 批量查状态：按 uid 覆盖已解析/已缓存的房间；UID-only 也直接进批量 */
      const due = new Map()
      for (const ref of refs) {
        const rawRoom = String(ref.roomId ?? "")
        const mapped = rawRoom ? state.roomAlias[rawRoom] || rawRoom : ref.uid ? state.uidRoom[ref.uid] : ""
        const room = mapped ? state.rooms[mapped] : undefined
        const uid = String(room?.uid ?? ref.uid ?? "")
        if (!uid) continue
        if (!force && room && at - num(room.checkedAt) < this.ttl) continue
        due.set(uid, rawRoom || mapped)
      }
      const uids = [...due.keys()]
      const data = await this.#batch(uids)
      if (data) {
        for (const [uid, info] of Object.entries(data)) {
          const dueRoom = String(due.get(uid) ?? "")
          const full = String(
            info?.room_id ?? (dueRoom ? state.roomAlias[dueRoom] || dueRoom : state.uidRoom[uid] ?? ""),
          )
          if (!full) continue
          const prev = state.rooms[full] ?? (dueRoom ? state.rooms[dueRoom] : undefined)
          const live = num(info?.live_status)
          if (dueRoom && dueRoom !== full) {
            state.roomAlias[dueRoom] = full
            if (state.rooms[dueRoom]) delete state.rooms[dueRoom]
          }
          state.rooms[full] = { uid, live, checkedAt: at, failedAt: 0 }
          state.uidRoom[uid] = full
          dirty = true
          /** 第一次运行只记基线；之后"非直播中 → 直播中"才算一次开播 */
          if (state.initialized && prev && num(prev.live) !== 1 && live === 1) {
            const event = { roomId: full, uid: String(uid), live }
            started.push(event)
            state.pending[full] = event
          }
        }
      } else if (uids.length) {
        log("warn", `[abyss-queue] 批量查询直播状态失败（${uids.length} 个 UID，保留旧状态）`)
      }

      if (!state.initialized) {
        state.initialized = true
        dirty = true
      }
      if (dirty) this.#save()
    } catch (err) {
      log("warn", `[abyss-queue] 直播状态刷新失败（保留上一次状态）：${err?.message ?? err}`)
    }
    return started
  }
}

/** 生产单例；套件用 `new LiveStatus({...})` 注入假 fetch / 临时文件 */
export const liveStatus = new LiveStatus()
