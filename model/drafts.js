/**
 * 引导式报名的草稿
 *
 * 跨命令共享（#报名 建档，#报名 上下文步骤读写），
 * 因此放在数据层而不是某个 app 内；按 self_id:user_id 隔离。
 */
export const drafts = new Map()
