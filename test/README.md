# 回归套件

不依赖 Yunzai，也不启动机器人进程。`node test/run.mjs` 顺序跑 `test/*.test.mjs` 与
`editor/test/*.test.mjs`（插件侧 29 个 + 编辑器侧 34 个 = 63 个；**权威计数见 [`../docs/测试.md`](../docs/测试.md)**），汇总后按失败数给退出码。
被测表格只操作**副本**，结束时校验原表哈希未变。

## 运行

```bash
pnpm test                            # = node test/run.mjs
node test/run.mjs --list             # 列出全部套件（打印相对插件根的路径）
node test/run.mjs workbook cache     # 只跑相对路径含这些关键词的套件
node test/workbook.test.mjs          # 单跑某个套件（任意 cwd 均可）
node test/run.mjs editor             # 只跑编辑器那一半（关键词按相对路径匹配）
XLSX_PATH="D:/别的表.xlsx" pnpm test  # 指定被测表格
ABYSS_TEST_SYNTHETIC=1 pnpm test     # 强制用合成样本（验"没有真实表也全绿、零跳过"）
ABYSS_TEST_TIMEOUT_MS=300000 pnpm test # 调单个套件的超时（默认 120000 = 120 秒）
```

关键词是**位置参数**（`--list` 之外，`--` 开头的参数一律被忽略）；给了关键词却一个都没匹配上时退 1，
打错名字不会静默变成"跑全量"。

**每套都有超时**：超时按**失败**计（"没跑完"不等于"通过"），并杀掉**整棵进程树**——套件会起真实
子进程（编辑器、宿主的 HTTP 服务），吊住一个就让 `pnpm test` 永远不返回，而 Windows 上
`child.kill()` 只杀直接子进程，留下的孤儿会继续占着那张表、把后面的套件一起带红。

**干净克隆先装依赖**：在机器人根目录 `pnpm install --filter=abyss-queue`（本仓库所在的工作区由机器人根
统一管理，锁文件也在那儿）；只想装这一个插件、或在插件目录里单独跑，则用 `npm i`。
`jszip` / `yaml` 是运行时依赖，`express` 只有
`test/editor-host.test.mjs` 用（要真摆出框架那四个 body parser，才验得了"请求体不被读空"），
所以列在 `devDependencies`。借宿主上层的 `node_modules` 也能跑到，但那是巧合，不是依赖声明。

## 插件侧套件（`test/`）

| 套件 | 覆盖 |
| --- | --- |
| `workbook.test.mjs`、`template.test.mjs` | 表格层：结构解析（表头行 / 列映射 / 下拉选项 / 主播区 / 数据区末日行）、报名写入、人工维护要素保全、特殊字符往返、改备注与退队、原表未被触碰；空模板"结构在、数据不在、样式规范" |
| `doc-export.test.mjs` | 导出器的行数口径：`prefill: 0` 只写到数据末行（不许白铺 100 行空行）、缺省仍是 100、小于数据行数时以数据行数为准、负数 / 非整数回退 100 |
| `json-table.test.mjs` | `JsonTable` 读路径：常规读不加锁不写盘（别的写者占锁也照常返回）；需要导回镜像（自举 / 镜像更新）时并进写串行链、锁没放出来之前不写盘；指纹口径与落盘内容同源 |
| `xlsx-row-tag.test.mjs` | 自闭合 `<row r="9"/>` 的写入：必须就地换成成对标签，不跟"这一行不存在"共用 `insertRow` 分支 |
| `clearrow-style.test.mjs`、`compact-style.test.mjs`、`save-row-style.test.mjs` | 逐行样式保全的三条路：清空同一行再填回来 / 删行后整体上移 / 普通保存写已存在的行——都不许抹平行自己的底色 |
| `workflow.test.mjs` | 工作流：经 `index.js` 的 `apps` 导出装载入口类，复刻 loader 的规则匹配与上下文分发，覆盖全部命令（含 **`#排队同步名单`**：主人真推一次并回执人数 / 非主人不推只回拒绝 / 没配群号只回原因）、引导流程、错误路径、**唯一一条定时任务**与进度通知（一块三行：谁已完成 / 下一位 `@` / 主播 `@`——主播读下一位那一行选的、「公共队列」不写；以及「已完成 → 排队中」的补充播报：请那一行选的主播 @ 注意、「公共队列」只写不 @；`@` 人绑定优先 / 名单兜底 / 都拿不到就不 @）；**开榜播报末尾 @ 这一榜的主播**（名字相同的直接查名单、表里与群里不同的走 `data/anchor-names.json` 映射、两边都没有只写名字、`notify.open_anchor` 关掉就不加那一行）；`#排队帮助` 与 `#排队开播提醒` 的注册、分发与回执 |
| `commands.test.mjs` | 命令一致性：注册规则 / 处理器解析 / 分页提示同源（全名、简称、别名、序号、后缀式、全量查看） |
| `aliases.test.mjs`、`progress.test.mjs`、`locate-self.test.mjs` | 主播别名归一；完成判定与「下一位」；**结构闸**（每榜按行序的 `行号:群昵称` 指纹：插行/整理/插队/换表这类**行位移不算"刚完成"**——主播区插行只挪行号、昵称序列不变也算位移；老状态文件首跑只记基线）；按 QQ 定位（同名不得认领别人已绑定的行） |
| `notify.test.mjs`、`notice.test.mjs` | 定时通知：一条 tick 里的五件事、开榜时刻口径、月末催办与名单同步/每日整理的去重（时间由 `tick(now)` 注入，不 mock 全局 `Date`）；关掉通知时名单同步与每日整理仍照做；**主播区插一行**（真表 + `insertRows` + 真 `tick`）不误报完成；主人首启提示 |
| `anchor-live.test.mjs` | 主播直播：B 站入口解析（房间/UID）、状态缓存与首次基线、接口失败保留旧状态、**只 @ 自己订阅过且还在排队的人**（没人订阅整条不发）、`#主播`/详情/菜单文本都带具体主播名与「直播中/未开播」；**只展示 B 站入口**（同格的抖音/虎牙内容被过滤，多选主播也只带 B 站项）；**有状态时只显示开播状态、不显示长链接**；多选主播时状态带名字、单选不带；`#排队直播状态` 自检按主播名合并跨榜重复；**个人空间 UID-only、短房号归一、自检 pending 事件、force 刷新、多选逐位链接/文本回退都有回归** |
| `attack.test.mjs` | 绝境攻炼：5 模式（7.0 / 7.1）、3 目标（满原石 / 满星 / 顶分）；模式全部选中才按版本简写（`7.0模式` / `7.1模式` / `7.0/7.1模式`），否则逐个列名字；组合值解析、目标配色、11-04 10:00 起每 42 天的版更日历与「同一期只播一次」 |
| `help.test.mjs` | 帮助页内容门禁（命令以 `#` 开头、说明长度、不出现配置键/路径）与同源文本回退 |
| `manager-link.test.mjs` | 管理员的私聊链接：主人 / 白名单管理员发 `#排队` 走私聊（群里一个都不发）、普通群友照旧群内发；私聊那份是带当期 `w/ws` 的长地址，**只在本人发 `#排队` 时给一次**（带那一刻的当期窗口、在那一刻验得过）；**tick 不主动发链**——窗口变没变都一条不发、也不动状态文件；状态文件记「发给了谁 / 哪个窗口 / 消息 id」；私聊发不出去只在群里报一句原因 |
| `roster.test.mjs` | 机器人推群成员名单：签名身份、成员映射、空名单不推；**成员来源逐个试、空就换下一个**（`getMemberMap` 给空对象 / 返回 Promise / 成员挂在 `group.group` 上 / 只有 `Bot.getGroupMemberList` / `Bot.gl.get` 都要能取到），全空时错误里带群号与每个来源的形状数量，扫成功的来源能报出来 |
| `outbound-window.test.mjs` | **进程内直调对账**（跨层契约）：名单同步真调到 `registerEditorService` 注册的假 service（身份是机器人、只推一次），**失败不重试也不吞错**（HTTP 超时/重试层已随出站请求消失）；填报入口两条长链接仍带身份 + 当期窗口，否则编辑器侧照样 410 |
| `layout.test.mjs` | 版式契约：三张渲染模板与编辑器主表的列对齐规则（**菜单那一列的名字是「排队中人数」**；只查规则有没有被改回去，出图人工看走 `render-check.mjs`） |
| `render-fallback.test.mjs` | 出图发送链的失败口径：只有确认发出去了才算成功，重试仍失败要落到纯文本兜底；**规范署名行（小尾巴）**在单榜 / 主播列表的图上与文本兜底末尾都在 |
| `bootstrap.test.mjs` | 启动补齐：`editor.token` / `editor.sign_key` 为空才生成、**只改那两行**（注释与别的键一字不动）、手填值不覆盖、整行缺失按缩进插回；白名单首次写入（过滤非 QQ、去重、已有 owner 不覆盖、坏 JSON 不覆盖）；第二次启动逐字节不变；坏配置只记 warn 且一个字节不写 |
| `editor-host.test.mjs` | 编辑器宿主：挂到 bot 自己的 HTTP server 后前缀认 `/queue`、`/queueX` 不吞、框架路径照旧、**带 body 的请求不挂死**、凭证只有 `config.editor` 一份来源、重复调用不重复挂载、互锁探针语义（**不带口令**，200 / 403 都算「有编辑器」） |
| `guoba.test.mjs` | 锅巴三段式配置：模板的 `${变量}` 与 `CONFIG_FIELDS` 一一对应、三份配置结构一致、真往返、注释按模板保留、schema 漂移守卫 |

## 编辑器侧套件（`editor/test/`）

| 套件 | 覆盖 |
| --- | --- |
| `editor.test.mjs` | 端到端：字段与下拉选项、口令与身份签名、白名单权限、完成情况锁定（**主播写成主播名才锁、改回「排队中」即放开**）、**本人只能填「排队中」/「本人已完成」两档**（越权值忽略该格 + 回报）、写入校验、健康检查 |
| `mount.test.mjs`、`owner-only.test.mjs` | 子路径挂载（nginx `proxy_pass` 不带尾斜杠）；主人专用模式（除主人外一律打不开，只剩 `/healthz` 凭口令放行） |
| `acl-roles.test.mjs`、`identity.test.mjs`、`sign-key.test.mjs` | 权限只按稳定 QQ 判（群昵称不算）；身份签名（换口令、改内容、过期都过不了）；签名密钥与访问口令分开后，拿口令伪造的身份必须被拒 |
| `fail-closed.test.mjs`、`data-confinement.test.mjs` | 漏配就"起不来"而不是"敞着门"；数据落点生产模式不许出插件，`ABYSS_EDITOR_TEST_PATHS=1` 才放行 |
| `row-ownership.test.mjs`、`ownership.test.mjs` | 行归属：同名的两个 QQ 走真接口互不认领；归属状态审计与按当前表重建；**面板上给人看的编号是「序号」不是表格行号**（绑定 / 退群候选都按 `seq` 写，真行号只进悬浮提示） |
| `status-rename.test.mjs` | 群昵称变更 → 「帮帮完成情况」跟着改：三条路径（本人保存 / 管理员改行 / 群名单同步）都钉「旧名变成新名」（含别人那一行）与「不误伤」（前缀相同的别人的名字、主播名、状态词）；两行同名或没有可依据的绑定时**宁可不动**并给出说明 |
| `save-conflict.test.mjs`、`anchor-version.test.mjs`、`write-queue.test.mjs` | 保存时的版本冲突（前端接住 409、主播列表也带版本）；所有写入口共用同一条提交队列 |
| `anchor-add.test.mjs` | 主播列表**新增主播**：入口只对主人 / 白名单管理员渲染（本人 / 访客页面上根本没有这个控件）；保存走 `/api/anchors` 的 `added`（带 `version`、409 保留草稿）；真接口下这一行真的插进表里，且数据行逐字下移、行号引用与归属绑定一起跟着走 |
| `table-swap.test.mjs` | 整表替换：表、绑定、完成情况锁作为同一次状态转换，替换前做结构校验 |
| `lock-compact.test.mjs`、`member-row-area.test.mjs`、`delete-compact.test.mjs` | 压紧行时完成情况锁的迁移；成员保存的**业务行范围**（表头与主播区不能被当成新增成员行写）；**删掉整行之后立刻压紧**（页面上的序号不留空档：行号连续、上移后的行显示它现在那一行的序号、绑定与锁跟搬、删前留底；清空最后一行 / 本来就空的行不压紧不白写；**表里已有"漏压紧"的空档时，下一次删行把它一起合上**——只扫夹在活人中间的空行，末尾那片空闲格不碰） |
| `client-state.test.mjs`、`reload-drafts.test.mjs` | 前端草稿状态（新增行的提交口径、草稿的「榜 × 行」两维归属）；**群昵称候选是下拉浮层**（默认收起、点开给名单、打字给相近、选完收起，不再铺在单元格下面）；**移动端同步**（键盘弹出/页面滚动只重摆、不关掉浮层，量的是 `visualViewport`）；「重新读取」与「回到上一次修改状态」的语义；**重读时本地新增行与表里撞号 ⇒ 挪到下一个空行**（同一行不许画两次、字不丢） |
| `roster.test.mjs`、`versions.test.mjs` | 群成员名单的候选 / 改名同步 / 退群删行并压紧（**每天那一趟**的口径：有绑定的按 QQ 判、退群就删；**同一趟里改名 + 退群要都写成**——两笔写分两趟走，不然改名会被压紧盖掉、整趟自检放弃）；历史版本、回退与上传覆盖（`--cloud` 独立调试模式下两个编辑器进程一起跑）；**自动保存的存底节流**（5 分钟内连改只多一份版本，结构性动作照旧每次都留） |
| `tidy.test.mjs` | **整理**：每天那一趟（进程内 `tidy` service；HTTP 端点仍保留给编辑器网页）的段内分区 / 挡位不动 / 空行不动 / 行号与序号不动 / 归属跟搬 / 幂等不写 / 权限；**改了完成情况就立刻生效**那一条（普通保存的回执带 `tidied` 与 `rowMap`、当场已完成的在前、名单不可信时只跳过昵称检测、名单可信时改名同步 + 退群只报不删、机器人推名单时才删） |
| `changes.test.mjs` | **改动记录（留痕）**：模块层钉滚动保留与可见范围（自己发的 + 改到我自己那些行的，含 `reject` 的 `rows` 形状）；端到端钉"只记真正改动的字段"（提交整行 ≠ 改了这一行）、`[原值, 新值]`、没改动的提交不产生记录、**越权保存被拒也留一条 `reject`**、管理员看全部 / 本人只看与自己相关的（**别人改了我的行我看得见**）、改名连带标 `via`、**退群删行留 `remove`** 且本人看得到 |
| `live-refresh.test.mjs` | **实时刷新 + 行级冲突**：服务端（真进程）钉"每行带指纹""同一行两次读到的指纹一样""别人改了**别的行**我照旧存得进去（不连坐）""同一行被改过 ⇒ 409 且只报那一行、一个字不落表""不带 `base` 照旧整表 409""我以为空的行刚被填上 ⇒ 409""`/api/version?fast=1` 与全量一致、写表后跟上"；页面（node:vm）钉探测节奏（5 秒、版本没变不拉数据、`document.hidden` 不探、切回前台补探、失败退避 5→10 秒）、合并时**有草稿的行一个字都不动**、"两边都改过"的两个动作（含"没决定前保存带的仍是旧基线"）、保存请求带 `base`、行级 409 **只挂起那几行**且其余行照旧自动保存 |
| `quota-guard.test.mjs` | **本群守卫 + 越界额度与红线 + 告警**：模块层钉额度的单次上限 / 窗口累计 / 窗口外归零 / 被拒不占额度、名单守卫的"空 / 过期 / 正常"三态、告警的限频合并与强制、宿主侧 `sendOwnerAlert`（去重、没好友只记 failed）；真编辑器钉"名单还没推过 ⇒ 老口径（不放权也不拒人）""本群成员 roam + 拿到整表 + 能改别人的行""群外人只读、看不到别人的行、一个字都不许写""清空别人的行 / 改别人那一行的群昵称 ⇒ 拒且内容没被改""一次改 4 位 ⇒ 拒且一个字没写""窗口累计 12 > 10 ⇒ 拒""主播锁照旧只忽略那一格""名单过期 ⇒ 退回只能改自己那一行 + 私聊提醒进日志" |
| `link-code.test.mjs` | **群内短码 `#code=`**：模块层钉登记簿（两次签发口令不同且都 6 位、`recordLinkTarget` 后 `readLinkTarget` 换回同一 URL、超 5 分钟换不到、并发保护）、填报入口（长链接带 `w/ws` 且**不带** `#v=`；管理员那份形状相同；名片回落 QQ 时用候选群昵称）；真编辑器钉留言页 6 位口令表单与 `addEventListener` 提交（无内联 `onsubmit`）、`/api/link-code` 换回完整链接、**同一条口令可反复兑换（不作废）**、过期 / 未登记口令 410、主页面 boot 与 `hashchange` 两条兑换路 |
| `empty-nick.test.mjs` | 身份里的群名片为空（群名单里没这个人）时：建行保存的昵称**再读一次仍在**（空串不许回写昵称格）、非空名片改名照旧同步、空名单/名单里没这个人不删行不清昵称 |
| `body-limit.test.mjs` | 请求体契约：边界、超限后继续追加、连接中断 |
| `link-identity.test.mjs` | **身份只来自链接、权限只问群名单**（2026-11-25 重写）：访客 / 在名单**可写** / 不在名单**只读**（`perm.outOfGroup`，写表拒「不在本群成员名单」）/ 名单不可信（空名单）走老口径「只能改自己那一行」；时间窗当期与上一期 200、两窗之前 / 被改签名 / 别人的签名 / 未来窗口全 410；**没带 `w/ws` 的身份链照旧放行**且权限照旧按名单；管理员 24 小时 cookie（`Max-Age=86400` + `HttpOnly` + `SameSite=Lax`，本机 http 不加 `Secure`、`x-forwarded-proto: https` 加）与群友只带 cookie ⇒ `guest` 只读；**认领层已整体删除**（不生成 `abyss-editor-claims.json`、响应头无 `x-abyss-device`、页面无 `__DEVICE__`、`perm` 无 `staleLink`）；旁路文件原子替换 |
| `link-guard.test.mjs` | **群内短码防枚举**（2026-11-26）：`clientIpOf()` 取 `x-forwarded-for` **最后一段**（无头则退回 socket）；失败计数按 IP 分开、窗口内 10 次触发 5 分钟冷却、冷却期连正确口令也 429（`retry-after` 秒数在区间内）、成功清计数、**守卫里没有"已兑换"状态**（`taken` / `consume` 不许回来）；真编辑器钉 `/api/link-code` 的 200 / **同一条口令 5 分钟内被不同 IP 与同一 IP 反复兑换都是 200 且链接相同** / 猜错不消耗真口令 / 过期与未登记同一句 410 |

## 不参与 `run.mjs` 收集的脚本

- 公共设施与夹具：`_helper.mjs`（路径推导 / 断言计数 / 框架全局桩）、`env.mjs`（隔离配置 + 路径）、
  `fixtures/sample-table.mjs`（匿名合成样本生成器）、`fixtures/_snapshot-xlsx.mjs`（合成快照夹具）、
  `editor/test/harness.mjs`、`editor/test/page-vm.mjs`、`editor/test/source.mjs`、`editor/test/plugin.mjs`。
- `render-check.mjs`：把模板渲染成 PNG，人工看图（需在**机器人根目录**执行，要浏览器）。
- `verify-xlsx.ps1`：用 .NET 的 ZIP/XML 解析器（与插件实现完全不同的一套）独立复核生成的文件。
- `check-deploy.mjs`：源码仓库与部署目录的一致性自查（脏改动会挡住 `#更新`）。
- `editor/test/compare-editors.mjs`：本机编辑器与线上编辑器对同一份数据的行为对比。

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
node test/check-deploy.mjs "<部署目录>"      # 默认查本机部署目录
node test/render-check.mjs [输出目录]        # 产物默认写系统临时目录
```

`verify-xlsx.ps1` 的 `-Sheet` 是写入的工作表序号（1 起，对应 `xl/worksheets/sheetN.xml`，如 sheet2 = 幽境危战），
`-Row` 是写入行号；脚本会回读该行 B–H 的文本、比对结构标签数量、校验未改动工作表逐字节一致。

## 前置与跳过

被测表格的来源是**三层**（缺表不整套跳过）：

1. `XLSX_PATH` 指了就用它（指向不存在的路径时也照跑，不会悄悄回落到真实表）；
2. 否则用维护者机器上那份真实表（与插件同级的 `2026年10月三路深渊排队.xlsx`）；
3. 都没有就由 `fixtures/sample-table.mjs` **现生成匿名合成样本**到 `test/.test-tmp/`（已忽略），
   输出里会打印「本次用合成样本（真实表不存在）」。

所以**没有"缺表就整套跳过"这回事**，唯一会因此整套跳过的是 `test/editor-host.test.mjs`：
它要 `<插件根>/data/queue.xlsx` 真在（宿主挂载编辑器必须有那张表），干净仓库上按设计打印 `⏭ 套件跳过`。

**"真实表"的判据不是路径，是内容**（`_helper.mjs` 的 `isRealTable()`）：把合成样本复制到别处再用
`XLSX_PATH` 指过去，仍然算样本——`test/template.test.mjs` 那条"数据区样式与下方空行一致"的比对会跳过。
样本是照空模板生成的，没有"填过人又被清空"的历史痕迹，拿它自己跟自己比只会假红。
CI 的第二个 job（`test-xlsx`）正是这么做的：先生成样本、复制到 `$RUNNER_TEMP`，再用 `XLSX_PATH`
指过去跑全量，覆盖"从磁盘读工作簿 → 按行号写回"这条链路（第一个 job 走 `ABYSS_TEST_SYNTHETIC=1`
的内存样本，那条链路一步都不走）。

`requireSource()` 因此是**异步**的：一律写 `await requireSource()`（它对字符串 / thenable 都安全）。
`ABYSS_TEST_SYNTHETIC=1` 强制走第 3 层，用来在本机复验"没有真实表也零跳过、全绿"
（唯一按设计整套跳过的仍是需要 `data/queue.xlsx` 的 `test/editor-host.test.mjs`）。

真正缺前置的套件（浏览器、编辑器进程起不来等）打印 `⏭ 套件跳过：原因` 并 `exit 0`，
**不算失败**（但也不算通过：`run.mjs` 把它们单独计数并列出套件名）。
条件只在部分用例上成立的（例如没有 `.git` 元数据时没法验"运行时文件真被 git 忽略"），
用 `check(name, fn, 跳过原因)` 记一条 `⏭`，那一项不进 passed，同套件其余断言照跑。

## 约定

1. **任意 cwd 可跑**：路径一律经 `_helper.mjs` 的 `Paths` 推导，禁止裸相对字面量与盘符绝对路径；
   被测表格位置用 `XLSX_PATH` 覆盖。
2. **不改动源数据**：被测表格复制成副本后再改，结束时校验原表哈希未变；
   合成样本与夹具产物写 `test/.test-tmp/`（`.gitignore` 已忽略），
   编辑器 / 工作流 / 初始化套件的表副本与隔离配置写在系统临时目录（`env.mjs` 的 `fs.mkdtempSync`）。
3. **必须有断言与退出码**：断言器只有两个来源，都在 `test/_helper.mjs`——`createChecker()`（回调抛错即
   中断，新套件优先）与 `createSoftChecker()`（失败记一条 ❌ 继续跑，尾部 `finish()` 汇总并按失败数设退出码，
   老套件统一到这里）；只打印不判定的脚本不是回归。**两个断言器都"真的跑回调"**：
   `typeof ok === "function"` 就调用它、同步 / 异步都等结果——写成 `if (ok)` 的话回调永远是"真值"，
   那批用例只会印 ✅ 而一条断言都没执行（2026-10 自查：8 个 `editor/test/` 套件踩过，共计 18 条；
   判据是**变异**——把被测实现改坏，那一条必须变红）。
4. **框架全局桩集中在 `_helper.mjs`**：`installFrameworkStubs()` 提供 `plugin` / `logger` / `segment` / `Bot`，
   必须在 import 插件代码**之前**调用。上下文按「规则集 + 会话」隔离，一个插件目录下的多个 app 类不会互相串上下文。
5. **入口类必须经 `index.js` 装载**：`workflow.test.mjs` 用 `const { apps } = await import("../index.js")`，
   与框架 loader 的取法一致（插件根有 `index.js` 时 loader 只加载它）。这样"apps 导出漏了某个类"这类回归才测得到。
6. **数据来自本地表副本**：编辑器写的是 `<插件根>/data/queue.json`（`queue.xlsx` 只是导出镜像），套件里换成 `ABYSS_QUEUE_XLSX_PATH`
   指向的临时副本（状态文档由它派生）；`env.mjs` 只做隔离（临时目录 + `ABYSS_QUEUE_CONFIG`），**不再起任何桩 HTTP 服务**。
   套件要模拟编辑器时，直接 `registerEditorService({...})` 注册假 service（`resetEditorService()` 收尾），
   不再有桩 HTTP 服务、也没有 TTL 之类的配置。
7. **数据目录口径只有一个**：数据固定在插件内 `<插件根>/data`（`data/` 已被 git 忽略），
   **生产口径不许离开插件目录**。套件的数据在临时目录里，所以：
   - 会起编辑器进程的套件必须显式设 `ABYSS_EDITOR_TEST_PATHS=1`（否则编辑器按生产口径直接拒绝启动）；
   - 插件侧套件由 `env.mjs` 统一设 `ABYSS_QUEUE_TEST_PATHS=1`，并用环境变量把落点指到临时目录
     —— 插件侧的落点已经**不是配置项**（配置里没有路径键），只能这样重定向。覆盖到的落点：
     绑定（`ABYSS_QUEUE_STORE_FILE`）、进度快照（`_STATE_FILE`）、快照备份（`_BACKUP_DIR`，当前无写入者）、
     白名单（`_ADMINS_FILE`）、私聊链接状态（`_MANAGER_LINK_FILE`）、
     重启标记（`_RESTART_FLAG`）；表格（`_XLSX_PATH`）指向本套件的临时副本（所有插件侧套件通用）。
     白名单那一处**不是方便而是隔离**：它决定 `#排队` 往群里发还是私聊发，不指的话维护者本机
     真实白名单会漏进套件——某条断言的绿红就取决于"本机恰好这个号是不是管理员"。
     备份目录与重启标记也一并重定向：前者现在**没有写入者**（快照拉取已随出站请求删除），
     保留变量只是为了隔离自检不落进仓库；后者由 `components/boot.js` 的**退出钩子**在子进程退出时写
     （默认 `data/restart.flag`，`boot()` 只由 `index.js` 装配，所以 import 了入口的套件都会碰到）。
     重启标记的兜底值由 `_helper.mjs` 在模块求值时设好——`bootstrap.test.mjs` 这类只经 `_helper.mjs`、
     不 import `env.mjs` 的套件同样跑在临时目录里，不会写进仓库 `data/`。
     **不要**为了"套件别写文件"去掉写标记的行为：那是启动器判断「重启还是停服」的机制。
   这条由 `editor/test/data-confinement.test.mjs` 钉住（生产拒绝 / 测试放行 / 出圈回落）；
   **生产部署绝不要设这两个开关**。
8. **端口一律现要，不写死**：会起编辑器进程的套件用 `freePort()`（`test/_helper.mjs`；编辑器侧从
   `editor/test/harness.mjs` 或 `../../test/_helper.mjs` 取）——绑 `0` 让系统挑一个空闲端口再放开，
   拿到的值**原样传给 `--port`**。固定端口只要撞上（两套并发跑、本机留着个没退干净的编辑器、别的
   程序占了那个号）就会以 `fetch failed` / "编辑器没起来"变红，排查成本全落在下一个人身上。
   放开到子进程重新绑上有极小窗口，所以 `harness.startEditor()` 那种"起不来就换一个端口重试"
   的机制照旧保留。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `XLSX_PATH` | 指定被测表格（优先级最高） |
| `ABYSS_TEST_SYNTHETIC=1` | 强制使用合成样本，跳过真实表 |
| `ABYSS_TEST_TIMEOUT_MS` | 单个套件的超时（毫秒），默认 `120000`；不是正数直接退 2 |
| `ABYSS_QUEUE_TEST_PATHS=1` | 插件侧落点放行开关（`env.mjs` 自动设，仅在测试进程内） |
| `ABYSS_QUEUE_CONFIG` | 隔离配置的路径（`env.mjs` 自动设，避免读写仓库里的 `config/config.yaml`） |
| `ABYSS_QUEUE_STORE_FILE`、`_STATE_FILE`、`_BACKUP_DIR`、`_ADMINS_FILE`、`_MANAGER_LINK_FILE`、`_RESTART_FLAG`、`_XLSX_PATH` | 把绑定 / 进度 / 备份目录 / 白名单 / 私聊链接状态 / 重启标记 / 表格指到临时目录（只在 `ABYSS_QUEUE_TEST_PATHS=1` 下生效；表格指向本套件副本） |
| `ABYSS_EDITOR_TEST_PATHS=1` | 编辑器落点放行开关（起编辑器进程的套件必设） |
| `ABYSS_TEST_EDITOR_MJS` | **只给 `editor/test/empty-nick.test.mjs`**：换成别处的一份 `editor.mjs` 来跑（默认是工作树里那份）。用途是把"修复前的旧逻辑"复制出去跑一遍，看这套断言会不会变红——它是套件内置的对照入口，产品代码不读它 |
| `ABYSS_PLUGIN_DIR` | 编辑器套件定位插件根（默认按 `editor/test/` 上两级推） |
| `ABYSS_TEST_BROWSER`、`RENDER_CHECK_WIDTH` | `render-check.mjs` 指定浏览器 / 截图宽度 |
| `ABYSS_DEPLOY_DIR` | `check-deploy.mjs` 的默认部署目录 |
