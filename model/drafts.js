/**
 * 引导式报名的草稿
 *
 * 跨命令共享（#深渊报名 建档，#深渊报名 上下文步骤读写），
 * 因此放在数据层而不是某个 app 内；按 self_id:user_id 隔离。
 */
export const drafts = new Map()
