/**
 * 锅巴接入：连接与通知
 *
 * 三块内容对应插件运行必需的三件事：
 *   - `remote.*`：往哪儿拉云端表（地址 / 口令 / 签名密钥 / 短链与 markdown 开关）
 *   - `roster.*`：群名单从哪个群取、每天几点推
 *   - `notify.*`：三条 @ 通知的开关、群号、周期与月末催办时刻
 *
 * 值怎么读见根目录 `components/config.js` 的 `CONFIG_FIELDS`；这里只描述"面板长什么样"。
 */
export function getSchema() {
  return [
    { label: "连接与通知", component: "SOFT_GROUP_BEGIN" },

    { label: "云端编辑器", component: "Divider" },
    {
      field: "remote.url",
      label: "云端编辑器地址",
      bottomHelpMessage:
        "例：https://yunzai.axiu.uno/queue 。插件只读它，不写表；本机联调填 http://127.0.0.1:7788。留空时 #排队 只会回「插件还没配置好」，填好保存即可",
      component: "Input",
      componentProps: { placeholder: "https://yunzai.axiu.uno/queue" },
    },
    {
      field: "remote.token",
      label: "访问口令",
      bottomHelpMessage:
        "必须与编辑器进程的 ABYSS_EDITOR_TOKEN 一致；它会出现在每个人的填表链接里。这里只管显示与手改，生成交给 #排队初始化（它同时会把口令交给编辑器、并同步启动器产物）",
      component: "InputPassword",
    },
    {
      field: "remote.sign_key",
      label: "身份签名密钥",
      bottomHelpMessage:
        "必须与编辑器的 ABYSS_EDITOR_SIGN_KEY 一致。留空就退回用口令签——那样拿到链接的人能伪造别人的身份（包括主人），正式部署务必单独配；推荐由 #排队初始化 生成（生成：openssl rand -hex 24）",
      component: "InputPassword",
    },
    {
      field: "remote.admin_token",
      label: "管理口令",
      bottomHelpMessage:
        "编辑器页面上用 ?a=<这段> 打开就是「主人」身份，用来维护白名单（主人的备用入口）。留空 = 不开这个入口；它与访问口令、签名密钥必须互不相同",
      component: "InputPassword",
    },
    {
      field: "remote.short_link",
      label: "发短链",
      bottomHelpMessage: "群里发 <地址>/s/<码> 而不是带身份的长链接。云端编辑器还没更新（没有 /s/ 路由）时关掉它",
      component: "Switch",
    },
    {
      field: "remote.link_markdown",
      label: "填报入口用可点文字",
      bottomHelpMessage:
        "把入口做成「点此填表」四个字本身可点（QQ 的 markdown 段）。默认关：多数群/账号不认机器人发的 markdown，每次都要先失败一次再退回纯文本",
      component: "Switch",
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

    { label: "高级（一般不用改）", component: "Divider" },
    {
      field: "remote.ttl_ms",
      label: "快照缓存有效期（毫秒）",
      bottomHelpMessage: "这期间连续命令不再重复拉云端。默认 30000（30 秒）",
      component: "InputNumber",
      componentProps: { min: 0, step: 1000, placeholder: "30000" },
    },
    {
      field: "remote.timeout_ms",
      label: "拉取超时（毫秒）",
      bottomHelpMessage: "单次拉云端快照的超时。默认 15000（15 秒）",
      component: "InputNumber",
      componentProps: { min: 1000, step: 1000, placeholder: "15000" },
    },
  ]
}
