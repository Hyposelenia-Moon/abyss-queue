/**
 * 各入口 app 的公共基类
 *
 * 这里只放与具体指令无关的胶水：异常出口、取表模型、上下文装配。
 * 每个 app 文件自己定义 rule 与 handler，不再往这里加业务方法。
 */
import { ValidationError } from "../lib/router.js"
import { getRemote, getStore } from "../model/index.js"
import { log } from "../lib/logger.js"
import { checkPatches, patchNotice } from "../lib/patches.js"
import { noticeFile, notifyOnce } from "./notify.js"

/** 自检只跑一次：几个 app 会各实例化一次 */
let patchesChecked = false
let patchesCheckRuns = 0

/** 自检实际执行次数（回归用：确认多个 app 只触发一次） */
export const patchesCheckCount = () => patchesCheckRuns

/** 部署补丁自检：缺失时写日志并私聊主人（换机部署最容易漏这一环） */
function checkDeployPatches() {
  if (patchesChecked) return
  patchesChecked = true
  patchesCheckRuns++
  try {
    const { missing } = checkPatches()
    if (!missing.length) return
    const notice = patchNotice(missing)
    log("warn", notice)
    notifyOnce(noticeFile("patches"), notice)
  } catch (err) {
    log("warn", `[abyss-queue] 部署补丁自检失败：${err?.message ?? err}`)
  }
}

export class AppBase extends plugin {
  /**
   * 自检放构造函数：模块加载期框架的 Bot 还没就绪，那时私聊主人会失败。
   * 走构造函数而不是 init()，因为子类会覆盖 init 注册定时任务。
   */
  constructor(...args) {
    super(...args)
    checkDeployPatches()
  }

  /** 取当前数据：来自云端快照（只读，见 model/remote.js） */
  async models() {
    return getRemote().read(({ models }) => models)
  }

  async store() {
    return getStore()
  }

  nickname() {
    return String(this.e.sender?.card || this.e.sender?.nickname || this.e.user_id)
  }

  isGroup() {
    return Boolean(this.e.isGroup)
  }

  draftKey() {
    return `${this.e.self_id}:${this.e.user_id}`
  }

  /** 统一异常出口：出错不让机器人静默；用户输入问题只回原因 */
  async safe(fn) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ValidationError) {
        log("mark", `[abyss-queue] ${err.message}`)
        return this.reply(err.message)
      }
      log("error", `[abyss-queue] ${err?.stack || err}`)
      return this.reply(`出错了：${err.message}`)
    }
  }
}
