# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)

## 3.0.0

- **移除 · 插件自更新整体下线**：删掉 `apps/update.js`（`#更新排队` / `#更新强制`）、`components/update.js` 与 `test/update.test.mjs`。更新一律交给框架自带的那条（`#更新 abyss-queue` / `#强制更新 abyss-queue`）——它的规则是 `^#(安?静)?(强制)?更新` 且 `priority: -Infinity`，插件再实现一遍只会与它抢消息，还要自己维护 git 命令、提交号判定与重启编排。`data/restart.flag` 保留（启动器据此判断这次是重启还是停服，与自更新无关）。
- **重构 · 单体拆分（第一轮）**：`editor/editor.mjs` 从 4416 行的「一条龙」按职责拆开——新增 `ctx.js`（装配根写、其余模块只读的运行时句柄袋）、`defs.js`（列定义与常量）、`status.js`（完成情况串解析/生成）、`rows.js`（行校验与差异）、`cycle-ledger.js`（清榜账本与 intent）、`anchors.js`（主播区可选值）、`queue-view.js`（读投影 `buildPayload`）、`roster-sync.js`（名单对账）、`table-ops.js`（表操作），写动作收在 `actions.js`；`model/` 的五个薄壳（`tidy` / `move-row` / `leave-row` / `check-write` / `cycle-write`）合并成 `model/editor-commands.js`；`readJson`/`writeJson`、`aclQq`、`messageIdOf` 三组复制实现各收敛成一份（`components/json-file.js` / `qq.js` / `message-id.js`），`modules/group-link.js` 与 `modules/manager-link.js` 改成共用；顺手删掉 13 个零引用导出。对外契约（`handler` / `startEditor` / `syncAttackStatuses` 导出、CLI 参数、全部 HTTP 端点路径与字段、`queue.json` 格式）一律不变；`editor/editor.mjs` 4416 → 3470 行。
- **重构 · 路由分发搬出装配根**：`handler`（948 行、约 30 个端点）整段搬进 `editor/http/server.js` 的 `createHandler(deps)`——装配根按名注入 113 个依赖，本文件不 import 装配根（避免成环）。`editor/editor.mjs` 3476 → 1437 行，现在只剩三件事：读配置、建服务单例并 `installCtx` 三处、把 `handler` / `startEditor` / `syncAttackStatuses` 三个契约导出。路由路径、字段、鉴权与响应一律未变；全量 82 通过 / 1 跳过。
- **重构 · 清掉两条废弃兼容分支**：管理员会话 cookie 只认 `QQ.过期.MAC` 三段式（旧版 `过期.MAC` 没有 QQ、只能在已知 QQ 时校验，等于把签名退化成“谁带这个 MAC 都行”，删）；主播行与公共队列不再下发 `queuePill`（旧前端才读的单颗胶囊字段，现在页面只读 `queuePills`）。两条都先加“旧写法必须被拒”的断言、红过之后再删实现。
- **工程**：`package.json` 版本 2.0.2 → 3.0.0（删掉一条对外命令属破坏性变更）。

## 2.0.2

- **安全 · 域名按标签边界认**：`components/live-entry.js` 原来用 `host.endsWith("douyin.com")` / `"huya.com"` 判平台，`evil-douyin.com`、`notdouyin.com` 都会被当成抖音/虎牙（CodeQL `js/incomplete-url-substring-sanitization`）。新增 `components/text.js` 的 `isHostOf(host, domain)`（`=== domain` 或 `.domain` 结尾），`components/text.js` 与 `components/live-entry.js` 共用。
- **安全 · 页脚净化不再靠一遍正则**：`editor/config.js` 的 `sanitizeFooter()` 改成「先按不动点剪掉危险标签，再把每个标签拆成属性重建」——`on*=` 与 `javascript:`/`vbscript:`/`data:` 的 `href|src|xlink:href` 逐条丢，属性值按浏览器口径先还原（实体 `&#x61;`、`&colon;`、大小写、空白）再判协议；`<scr<script>ipt>` 这类套娃也能剪干净（CodeQL `js/incomplete-multi-character-sanitization`）。
- **测试辅助**：假 DOM 与静态扫描剥 `<script>` / 注释改成「剪到不动点」，闭合标签容忍 `</script >`；`test/anchor-live.test.mjs` 查文本里有没有某条链接改用正则（`includes` 会被 CodeQL 当成 URL 子串净化报假警）。
- **工程**：`package.json` 版本 2.0.1 → 2.0.2。

## 2.0.1

- **安全 · 页脚净化补回实现**：文档从 2026-10 起就写着「页脚自由 HTML 先过 `sanitizeFooter()`」，但九页重写时实现丢了——页脚一直原样插进同源页面。现在 `editor/config.js` 的 `sanitizeFooter()` 真的存在：`<script>` / `<iframe>` / `<object>` / `<embed>` / `<link>` / `<meta>` / `<base>` / `<form>` 整段、所有 `on*=` 事件属性、`javascript:` / `vbscript:` / `data:` 的 `href|src`（含 `xlink:href`）一律剥掉，`<style>` 与普通标签保留。
- **安全 · 转义补单引号**：页面里那个 `esc()` 只转 `& < > "`，现在连 `'` 一起转成 `&#39;`——当前拼的都是双引号属性，但页面里只要有一处把转义值放进单引号属性或内联脚本，少这一个字符就能跳出上下文（CodeQL `incomplete-escaping`）。
- **安全 · 业务日志压行**：新增 `editor/audit.js` 的 `oneLine()`（折叠所有空白），编辑器 9 处会拼用户可控文本（群昵称 / 表名 / 手填名字）的日志都对动态段套上——群名片里一个 `\n` 原来就能在日志里伪造一行。审计行本来就是这个口径，现在两边一致。
- **安全 · 强制更新的重置目标加白名单**：`components/update.js` 的 `remote` 会被拼进 `` git reset --hard ${remote} ``。现在只接受 `^[A-Za-z0-9._/-]+$`、且不许 `-` 开头与含 `..`，不合法时回一句「强制更新的重置目标不合法（…）：只接受 origin/main 这种写法」并**一条命令都不跑**（当前调用方本来也不传这个参数，属于把接口收紧）。
- **工程**：`package.json` 版本 2.0.0 → 2.0.1。

## 2.0.0

- **编辑器 · 填写页**：手机端只保留「排队表 · 填写」一个入口（原来的「排队表」与它合并，所有身份都看得到填写页；管理端的手机导航里不出现填写页）；页头在窄屏改成竖排，榜名不再被右上角「上次保存」挤断成两行。
- **编辑器 · 群昵称候选与头像**：群昵称格 / 填写页昵称框聚焦就弹候选浮层（空输入摆 8 个名片、打字实时筛、`↑↓` / `Enter` / `Esc` 键盘可操作、只读身份不弹），名单判定为不在本群的人拿不到整群名片；左下角头像由机器人取协议端头像（`getAvatarUrl()`，取不到按 QQ 拼）经**同源代理** `GET /api/avatar?qq=` 下发（CSP 不变），失败回落金色圆章 + 昵称首字。
- **群内短码**：同一条 6 位口令在 5 分钟有效期内**不限制兑换次数**——链接发给整个群，谁先点、点几次都换回同一条完整链接；去掉「兑换成功即作废」与一切点击次数限制，防枚举只剩「按来源 IP 限流 + 连续失败冷却 + 统一 410」。
- **群内排队输出**：同一成员连发 `#排队` 时上一条（图片）能撤回——兼容 Satori 回执的 `id` 与 `bot.recallMsg(channel_id, id)` 兜底。
- **文案**：插件简介改成「排队表工具：查队列 / 主播 / 我的记录（表格随机器人一起维护，自带网页编辑器）」，锅巴面板同步。
- **工程**：`package.json` 版本 1.0.0 → 2.0.0，`AGENTS.md` 定下「中等及以上改动必须同步升版本号」。

## 1.0.0

- 从项目初始化开始，到 2026-11 的第一个成型版本：**两个入口**（机器人侧读表出图、编辑器写表）、**四张榜**（幻想真境剧诗 / 幽境危战 / 深境螺旋 / 绝境攻炼），群友自己在浏览器填表，机器人在群里出图与播报。
- **加载**：单入口 `index.js` 动态发现 `apps/*.js` 并按 `Promise.allSettled` 容错载入；单入口插件没有热重载，改完要重启。
- **命令**：`#排队` / `#排队 <榜>` / `#<榜>排队`、`#主播 [名字]`、`#插队` / `#退队`、`#排队开播提醒` / `#排队直播状态`、`#排队帮助`；主人另有 `#排队初始化`、`#更新排队`（框架 `#更新` 的简写）、`#排队同步名单`。
- **数据**：状态文档是 `data/queue.json`（可 diff、原子替换），xlsx 只作导出镜像 / 导入来源 / 历史版本；读 xlsx 只有 `model/xlsx.js` 的 `openWorkbook()` 一条路，带解压预算（≤256 MB、条目 ≤2048）。
- **配置**：三层（`defSet` 模板 → `config.yaml` 运行时 → `config.yaml.example` 参考），锅巴面板覆盖全部插件键，八条读写硬约束（读文件不读快照、读写同源、写前逐键验证、原子替换、读不出来时一个字节都不写、热重载走轮询）。
- **编辑器**：随框架启停，挂在 bot 自己的 HTTP server 上（前缀 `/queue`），是唯一写表入口；口令 + 身份签名 + 5 分钟时间窗。**身份只来自链接、权限只问群名单**（点进去的 QQ 在群成员名单里才可写），没有设备认领、也没有「链接最新一条」这一层；作废转发出去的链接靠重发 `#排队`（群里那份 `#code=` 口令 5 分钟过期，管理员私聊那条另带 5 分钟窗口）。
- **权限**：主人 / 白名单管理员 / 本人 / 只读访客四档；群友只能把自己那格填成「排队中」或「本人已完成」，主播锁随"写成完成人"建立、改回排队中即放开；改别人的行受额度与两条硬红线约束，越界私聊告警主人。
- **主播选项**：「选择主播」里的公共队列选项从「都可以」改名「公共队列」（下拉以新名写出、代码不认旧名；老表用 `tools/migrate-anchor-name.mjs` 一次性迁移，仓库空模板已迁好）。
- **填写体验**：页面上没有「保存」按钮，改动停手 1.2 秒自动写表（防抖、单飞、409 暂停不重试）；草稿、行级冲突、历史版本、改动记录都在页面上。
- **安全**：每个响应带三个安全头 + 两份 CSP；凭证进请求头不进 URL，口令恒时比较；所有非 GET 请求留一行审计且**绝不带 `?k=`**；用户可控文本进 `innerHTML` 前一律 `esc()`，页脚自由 HTML 先净化。群里那份 `#code=` 口令的兑换接口另有两道防枚举（按来源 IP 限流、失败冷却，见 `editor/http/link-guard.js`）。
- **出图与播报**：三张图（总览 / 单榜 / 主播列表）都带规范署名行 `Created By {框架名} {宿主版本} & 三路深渊排队 {插件版本}`，框架名按 bot 根包名判定（含 `trss` 是 `TRSS-Yunzai`，其余 `Yunzai-Bot`），纯文本兜底末尾同样带；完成播报是"一块三行"（下一位 / 主播 @），「已完成 → 排队中」另有补充播报，开榜播报 @ 该榜主播。
- **直播**：只认 B 站，只显示「直播中 / 未开播」（不显示长链接）；开播提醒只 @ 订阅过、还在排队、且选的正是这位主播的人。
- **工程**：84 套回归套件（`test/` 43 + `editor/test/` 41），`pnpm test` 任意 cwd 可跑，缺前置打印「跳过」并 `exit 0`，每套 120 秒上限、端口一律现要；字体与模板随源码入库，不联网下载。CI 跑两种口径：内存合成样本，以及把样本落盘后 `XLSX_PATH` 指过去的真实工作簿链路。
- **部署**：正式形态只有 bot 一个进程——`#排队初始化` 生成口令与签名密钥并探活，nginx 把 `/queue` 转给 bot 端口；代码只走 `#更新排队`（或框架的 `#更新 abyss-queue`），不接受手工拷贝进运行实例。