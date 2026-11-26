/** B 站直播状态的缓存与刷新 */
import { config } from "../components/config.js"
import { collectBiliRefs } from "../components/live-entry.js"
import { log } from "../components/logger.js"
import { readJson, writeJson } from "./queue-state.js"

const API = "https://api.live.bilibili.com"
const VERSION = 1

const TTL = 3 * 60 * 1000

const STALE = 10 * 60 * 1000

const BACKOFF = 30 * 60 * 1000

const MAX_RESOLVE = 10
const TIMEOUT = 5000

const emptyState = () => ({
  version: VERSION,
  initialized: false,
  rooms: {},
  uidRoom: {},
  roomAlias: {},
  pending: {},
})

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const storedTime = value => (Number.isFinite(Number(value)) ? Number(value) : num(Date.parse(value)))

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
    for (const room of Object.values(state.rooms)) {
      if (!room || typeof room !== "object") continue
      room.checkedAt = storedTime(room.checkedAt)
      room.failedAt = storedTime(room.failedAt)
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
  #canonical(raw) {
    const id = String(raw ?? "")
    if (!id) return ""
    const state = this.load()
    return state.roomAlias?.[id] || id
  }
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
  roomOf(entry) {
    const e = typeof entry === "string" ? { text: entry } : entry
    const state = this.load()
    return this.#canonical(e?.roomId || state.uidRoom?.[e?.uid] || "")
  }
  takePending() {
    const state = this.load()
    const events = Object.values(state.pending ?? {})
    if (!events.length) return []
    state.pending = {}
    this.#save()
    return events
  }
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
      log("warn", `[abyss-queue] 直播接口 ${new URL(url).pathname} 请求失败：${err?.message ?? err}`)
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
  #recordRoom(info, rawRoom, at, started, baseline = false) {
    const uid = String(info?.uid ?? "")
    const roomId = String(info?.room_id || this.#canonical(rawRoom) || "")
    const live = Number(info?.live_status)
    if (!uid || !roomId || info?.live_status == null || !Number.isFinite(live)) return ""
    const state = this.load()
    const prev = state.rooms[roomId] ?? state.rooms[rawRoom]
    if (rawRoom && rawRoom !== roomId) {
      state.roomAlias[rawRoom] = roomId
      if (state.rooms[rawRoom]) delete state.rooms[rawRoom]
    }
    state.rooms[roomId] = { uid, live, checkedAt: at, failedAt: 0 }
    state.uidRoom[uid] = roomId
    if (!baseline && state.initialized && prev?.uid && num(prev.live) !== 1 && live === 1) {
      const event = { roomId, uid, live }
      started.push(event)
      state.pending[roomId] = event
    }
    return roomId
  }
  async refresh(models, at = this.now(), opts = {}) {
    const result = await this.refreshDetailed(models, at, opts)
    return result.started
  }
  async refreshDetailed(models, at = this.now(), { force = false, maxResolve = this.maxResolve } = {}) {
    at = Number(at)
    const state = this.load()
    if (!state.roomAlias || typeof state.roomAlias !== "object") state.roomAlias = {}
    if (!state.pending || typeof state.pending !== "object") state.pending = {}
    const refs = refsOf(models)
    const updatedRooms = new Set()
    const skippedRefs = new Set()
    let dirty = false
    const started = []
    try {
      let resolved = 0
      for (const ref of refs) {
        const rawRoom = String(ref.roomId ?? "")
        if (!rawRoom) continue
        const canonical = state.roomAlias[rawRoom] || rawRoom
        const room = state.rooms[canonical] ?? state.rooms[rawRoom]
        if (room?.uid) {
          state.uidRoom[String(room.uid)] = canonical
          if (canonical !== rawRoom) {
            state.roomAlias[rawRoom] = canonical
            if (!state.rooms[canonical] && state.rooms[rawRoom]) state.rooms[canonical] = state.rooms[rawRoom]
            if (state.rooms[rawRoom]) delete state.rooms[rawRoom]
            dirty = true
          }
          continue
        }
        if (!force && room && num(room.failedAt) && at - num(room.failedAt) < this.backoff) {
          skippedRefs.add(ref.key)
          continue
        }
        if (resolved >= maxResolve) {
          skippedRefs.add(ref.key)
          continue
        }
        resolved++
        const info = await this.#getRoom(rawRoom)
        const full = this.#recordRoom(info, rawRoom, at, started, true)
        if (!full) {
          state.rooms[canonical] = { ...(room ?? {}), failedAt: at }
          dirty = true
          continue
        }
        updatedRooms.add(full)
        dirty = true
      }
      const due = new Map()
      for (const ref of refs) {
        const rawRoom = String(ref.roomId ?? "")
        const mapped = rawRoom ? state.roomAlias[rawRoom] || rawRoom : ref.uid ? state.uidRoom[ref.uid] : ""
        const room = mapped ? state.rooms[mapped] : undefined
        const uid = String(room?.uid ?? ref.uid ?? "")
        if (!uid) continue
        if (skippedRefs.has(ref.key)) continue
        if (!force && room && at - num(room.checkedAt) < this.ttl) {
          skippedRefs.add(ref.key)
          continue
        }
        due.set(uid, rawRoom || mapped)
      }
      const uids = [...due.keys()]
      const data = await this.#batch(uids)
      for (const [uid, dueRoom] of due) {
        const info = data?.[uid]
        const full = this.#recordRoom(info ? { ...info, uid } : null, dueRoom, at, started)
        if (full) {
          updatedRooms.add(full)
          dirty = true
          continue
        }
        const canonical = this.#canonical(dueRoom)
        if (!dueRoom || updatedRooms.has(canonical)) continue
        const fallback = await this.#getRoom(dueRoom)
        const recovered = this.#recordRoom(fallback, dueRoom, at, started)
        if (recovered) updatedRooms.add(recovered)
        else state.rooms[canonical] = { ...(state.rooms[canonical] ?? {}), failedAt: at }
        dirty = true
      }
    } catch (err) {
      log("warn", `[abyss-queue] 直播状态刷新失败（保留上一次状态）：${err?.message ?? err}`)
    }
    if (!state.initialized) {
      state.initialized = true
      dirty = true
    }
    if (dirty) this.#save()
    const result = { started, total: refs.length, refreshed: 0, failed: 0, skipped: 0 }
    const failed = []
    for (const ref of refs) {
      if (updatedRooms.has(this.roomOf(ref))) result.refreshed++
      else if (skippedRefs.has(ref.key)) result.skipped++
      else {
        result.failed++
        failed.push(ref.key)
      }
    }
    if (failed.length) log("warn", `[abyss-queue] 直播状态本轮未刷新（${failed.length}/${refs.length} 个引用，保留旧状态）：${failed.join("、")}`)
    return result
  }
}

export const liveStatus = new LiveStatus()
