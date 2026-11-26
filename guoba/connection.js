/** 锅巴接入：连接与通知 */
export function getSchema() {
  return [
    { label: "连接与通知", component: "SOFT_GROUP_BEGIN" },
    { label: "编辑器", component: "Divider" },
    {
      field: "editor.public_url",
      label: "编辑器地址",
      bottomHelpMessage:
        "群友能打开的地址，只用来拼填表链接。例：https://example.com/queue ；本机联调填 http://127.0.0.1:7788。留空时 #排队 只会回「插件还没配置好」，填好保存即可",
      component: "Input",
      componentProps: { placeholder: "https://example.com/queue" },
    },
    {
      field: "editor.token",
      label: "访问口令",
      bottomHelpMessage:
        "编辑器用的就是这一份（宿主在插件加载时把它注入编辑器），它会出现在每个人的填表链接里。留空也行：启动时会自动生成一次，之后只管显示与手改。改完要重启机器人才对编辑器生效——不重启就是「插件用新口令、编辑器还认旧口令」，链接会直接报 403",
      component: "InputPassword",
    },
    {
      field: "editor.sign_key",
      label: "身份签名密钥",
      bottomHelpMessage:
        "编辑器用的就是这一份，必须与访问口令不同（留空或相同 → 编辑器拒绝启动，宿主因此不挂载，bot 照常跑；只有本机联调的回环地址 + ABYSS_EDITOR_TEST_PATHS=1 才允许退回用口令签）。留空就行：启动时会自动生成一次。改完要重启机器人",
      component: "InputPassword",
    },
    {
      field: "editor.admin_token",
      label: "管理口令",
      bottomHelpMessage:
        "编辑器页面上用 ?a=<这段> 打开就是「主人」身份，用来维护白名单（主人的备用入口）。留空 = 不开这个入口；非空时必须与访问口令、签名密钥都不同。改完要重启机器人",
      component: "InputPassword",
    },
    { label: "群名单", component: "Divider" },
    {
      field: "roster.group",
      label: "群成员名单来源群",
      bottomHelpMessage: "从这个群拉成员名单，给编辑器当「群昵称候选」，并按 QQ 对账（改名同步 / 退群删行）。留空 = 关闭",
      component: "GSelectGroup",
      componentProps: { multiple: false, placeholder: "选择一个群" },
    },
    {
      field: "roster.at",
      label: "名单推送时刻",
      bottomHelpMessage: "每天到这个时刻推一次（本地时间，HH:MM）。到点之后一整天都算数，机器人夜里关着、早上起来也会补做",
      component: "Input",
      componentProps: { placeholder: "05:00" },
    },
    { label: "通知（三条 @ 提醒）", component: "Divider" },
    {
      field: "notify.enable",
      label: "开启通知",
      bottomHelpMessage: "总开关：关掉后「上一位完成 @ 下一位」「榜开启提醒」「月末催办」都不发（群名单同步不受影响）",
      component: "Switch",
    },
    {
      field: "notify.groups",
      label: "通知发到哪些群",
      bottomHelpMessage: "可以选多个。留空 = 上述三条通知都不发（启动日志会提示）",
      component: "GSelectGroup",
      componentProps: { multiple: true },
    },
    {
      field: "notify.cron",
      label: "定时任务周期",
      bottomHelpMessage:
        "只有这一条定时任务（默认每 3 分钟）：完成轮询 / 开榜提醒 / 月末催办都在它里面按时间判断。**改完要重启机器人才生效**（其余配置项都是热重载）",
      component: "EasyCron",
      componentProps: { placeholder: "*/3 * * * *" },
    },
    {
      field: "notify.monthly_enable",
      label: "月末催办",
      bottomHelpMessage: "每月最后一天 @ 一遍还在排队的人。关掉它不影响开榜提醒与完成轮询",
      component: "Switch",
    },
    {
      field: "notify.monthly_at",
      label: "月末催办时刻",
      bottomHelpMessage: "每月最后一天到这个时刻之后当天发一次（本地时间，HH:MM）",
      component: "Input",
      componentProps: { placeholder: "12:00" },
    },
    {
      field: "notify.open_anchor",
      label: "开榜播报 @ 本榜主播",
      bottomHelpMessage:
        "某个榜开榜时，在播报末尾再加一行 @ 这一榜的主播（表头上方「主播列表」里那几位）。群里名字与表里不一样的先登记在 <插件根>\\data\\anchor-names.json（键=表里的名字，值=群里的名字或 QQ），没登记的只写名字、不 @",
      component: "Switch",
    },
    { label: "主播直播（B 站）", component: "Divider" },
    {
      field: "anchor_live.enable",
      label: "查询主播直播状态",
      bottomHelpMessage:
        "定时任务查询主播区 B 站入口的「直播中 / 未开播」。#主播 与 #排队直播状态 会强制刷新全部入口，#排队 读取缓存。关闭检测时直播接口请求为零",
      component: "Switch",
    },
    {
      field: "anchor_live.push",
      label: "开播提醒",
      bottomHelpMessage:
        "主播开播时只 @ 自己发过 #排队开播提醒 订阅、且还在排队、且选的是这位主播的人；没人订阅就不发整条提醒（不 @ 全体）",
      component: "Switch",
    },
    { label: "高级（一般不用改）", component: "Divider" },
    {
      label: "快照缓存有效期（毫秒）",
      bottomHelpMessage: "这期间连续命令不再重复拉云端。默认 30000（30 秒）",
      component: "InputNumber",
      componentProps: { min: 0, step: 1000, placeholder: "30000" },
    },
    {
      label: "拉取超时（毫秒）",
      bottomHelpMessage: "单次拉云端快照的超时。默认 15000（15 秒）",
      component: "InputNumber",
      componentProps: { min: 1000, step: 1000, placeholder: "15000" },
    },
  ]
}
