# abyss-queue（三路深渊排队）

在 QQ 群里排队报名，数据直接读写**人工维护的本地 xlsx 排表**——不改表结构、不丢条件格式/下拉/公式/超链接。

适用于「主播帮帮」类深渊排表：群友自助报名、退队、改备注，主播照旧用 Excel 维护这张表。

## 命令

| 命令 | 说明 |
| --- | --- |
| `#三路深渊` / `#深渊菜单` | 查看人数总览与命令帮助（末尾带 `Created By Yz-Bot & 三路深渊排队 <版本>` 页脚） |
| `#幽境危战` / `#幻想真境剧诗` / `#深境螺旋` | 查看某个榜的队列（`#幽境危战 全部` 显示全部） |
| `#深渊主播 [榜]` | 列出该榜的主播、强项、直播入口 |
| `#深渊报名` | 引导式报名：榜 → 游戏名 → 主播 → 难度 → 强度 → 备注 → 确认 |
| `#深渊报名 <榜> <游戏名> <主播> <难度> <强度> [备注]` | 一行式报名 |
| `#深渊我的` | 查看自己的报名记录与所在行 |
| `#深渊退队 [榜]` | 退出排队（清空自己那一行，保留序号公式） |
| `#深渊改备注 <内容>` | 修改自己的备注 |
| `#深渊清空 [榜]` | 清空整榜（需二次确认「确认清空 <榜>」，默认仅主人可用） |

报名时**不用手打完整选项**：`无畏` 会自动归一成 `无畏(N5)`，`3` 会按序号取第 3 个选项；只有唯一命中才写入，多个候选（如 `绝境` → `绝境(N6)` / `绝境(N6)180s`）会要求回复序号。

引导式报名中随时回复「取消」可退出。

## 配置

配置文件 `config/config.yaml`（首次加载时若不存在，会自动从 `config/config.yaml.example` 复制一份）：

```yaml
# 表格文件路径：绝对路径，或相对插件目录
xlsx_path: "D:/文件/游戏/原神/2026年10月三路深渊排队.xlsx"

# 默认榜：引导首项、退队时的优先项
default_sheet: 幽境危战

# 各表报名时写入的「帮帮完成情况」
sheets:
  幻想真境剧诗: { default_status: 排队中 }
  幽境危战: { default_status: 排队中 }
  深境螺旋: { default_status: 等待开启 }

list_limit: 20            # 列表显示条数，0 = 全部
join_existing_nickname: update  # 表里已有同昵称行：update=更新该行 / reject=拒绝
backup: true              # 写表前备份为 <原文件名>.bak
context_timeout: 180      # 引导报名等待超时（秒）
permission:               # 命令权限：all / master
  join: all
  leave: all
  note: all
  clear: master
push:                     # 定时推送，默认关闭
  enable: false
  cron: "0 12 * * *"
  groups: []
  sheets: []
  limit: 10
store_file: data/bindings.json  # QQ→行号 绑定（相对插件目录）
```

回归测试可用环境变量 `ABYSS_QUEUE_CONFIG` 指定另一份配置，避免动到真实配置。

## 部署

1. 把整个 `abyss-queue` 目录放进 Yunzai 的 `plugins/` 下（**不要**放 `node_modules`，`pnpm i` 会自己装）。
2. 在 Yunzai 根目录执行 `pnpm i`（或 `pnpm i --filter abyss-queue`）安装 `jszip`、`yaml`。
3. 编辑 `plugins/abyss-queue/config/config.yaml` 填写 `xlsx_path` 指向你的表格。
4. 重启 Yunzai。加载成功时日志里会看到插件数 +1。

要求 Node ≥ 20（用到 `import.meta.dirname` 需 Node 20.11+）。

## 表格要求

- 三个工作表（榜）名称可自定义，插件按表内内容识别，不写死行号/表名。
- 每个工作表需有一行表头，**A 列写着「序号」**；表头行之上是主播区（A 列主播名、C 列强项、G/H 列直播入口）。
- 数据列按表头关键字识别：群昵称 / 原神游戏名 / 选择主播 / 难度 / 账号强度 / 帮帮完成情况 / 备注。
- 主播、难度、强度列的下拉验证（数据验证）会被当作合法选项读出来，报名时据此归一与校验。
- 序号列（A 列）的公式不会被改动；退队只删 B–H 的单元格，不删整行。

## 实现要点

分层遵循 Yunzai 插件仓库惯例（`index.js` 薄加载器 + `apps/` 入口 + `model/` 数据 + `components/` 组件 + `lib/` 公共库）：

```
abyss-queue/
├── index.js              薄加载器：首启生成配置 + 聚合 apps/ 下的入口类（框架只认这个文件）
├── apps/                 入口层 — 每个文件导出 class，rule 定义正则 → 方法
│   ├── _base.js          AppBase：日志、异常出口、取表/取绑定、上下文装配
│   ├── queue.js          #三路深渊 / #<榜> / #深渊主播 / #深渊我的 + 定时推送
│   ├── join.js           #深渊报名（引导式 + 一行式）
│   └── leave.js          #深渊退队 / #深渊改备注 / #深渊清空
├── model/                数据层
│   ├── index.js          Table / BindStore 单例（保证写操作共用一把锁）
│   ├── table.js          xlsx 读-改-校验-原子替换 + 进程内串行
│   ├── store.js          QQ → 表格行号 绑定
│   └── drafts.js         引导式报名的草稿（按 self_id:user_id 隔离）
├── components/           可复用组件
│   ├── config.js         配置读取、默认值合并、路径解析、configHint、ensureConfig
│   ├── constants.js      榜名、上下文名、插件名与用法文案
│   └── pluginVersion.js  版本号（回复页脚用）
├── lib/                  底层公共库（纯函数，不依赖 Yunzai）
│   ├── xlsx.js           极简 xlsx 容器读写
│   ├── schema.js         工作表结构解析
│   ├── queue.js          排队业务逻辑
│   ├── render.js         文本渲染
│   └── router.js         输入解析（选榜 / 选项归一 / 候选提示 / 参数切分）
├── config/               config.yaml（运行时，入库忽略）+ config.yaml.example（参考）
├── test/                 回归套件
└── data/                 运行时数据（绑定文件，入库忽略）
```

- `lib/xlsx.js`：极简 xlsx 容器。不整表解析重排，而是**外科手术式替换目标 `<c>` 节点**，写入用 `inlineStr` 从而完全不动 `sharedStrings.xml`；未改动的工作表逐字节保持原样。
- `model/table.js`：每次操作都重新读盘（人工可能刚用 Excel 改过表），写入走「读-改-校验-原子替换」；替换前会用新缓冲重新解析并核对写入结果，核对不过就放弃写入；所有写操作进程内串行，多群同时报名不会互相覆盖。
- `components/config.js`：首次启动自动从 `config.yaml.example` 生成运行时配置；缺 `xlsx_path` 时回复明确提示而不是静默失败。
- `lib/` 下全部是纯函数（不 import Yunzai、不碰文件系统），因此可以脱离机器人做回归测试。
- `apps/` 下的类由 `index.js` 聚合导出为 `module.apps`——这是框架 loader 的取法：插件根一旦存在 `index.js`，loader 就只导入它、不再扫 `apps/`（`lib/plugins/loader.js:58-62`、`:130`）。

## 已知限制

- **宿主的命令冷却会吞消息**：TRSS-Yunzai 的 `config/config/group.yaml` 里有 `singleCD`（默认 2000ms，同群同一人）与 `groupCD`（默认 500ms，同群）。用户连续快发独立指令时，冷却期内的消息在规则匹配前就被丢弃，插件收不到。实测发消息间隔 >2s 时 16/16 全部得到回复。
  引导式报名走的是 loader 的上下文分发（在冷却判定之前），**不受冷却影响**。
- 表格里没有 QQ 号列，「你是谁」靠群昵称判定：登记绑定后每次操作都会回表核对昵称，昵称被人工改动会提示「绑定已失效，请重新报名」。同群多人同昵称时以表内先出现的那行为准。
- 表格正被 Excel/WPS 打开时可能写入失败（`EPERM/EBUSY`），插件会明确提示「请关闭后重试」，不会写坏原文件。
- 只支持 `.xlsx`；`.xls` 与在线文档（腾讯文档等）不支持——需要在线协同时，请把在线表格定时导出成本地 xlsx。

## 测试

不依赖 Yunzai，直接跑：

```bash
pnpm test                              # = node test/run.mjs，顺序跑全部套件并汇总
node test/run.mjs --list               # 列出套件
node test/run.mjs workbook             # 只跑文件名含 workbook 的
node test/workbook.test.mjs            # 单跑某个套件
XLSX_PATH="D:/别的表.xlsx" pnpm test    # 指定表格
```

| 套件 | 覆盖 |
| --- | --- |
| `test/workbook.test.mjs` | 34 项：表格结构解析 / 报名写入 / 格式保全 / 特殊字符 / 原表未被触碰 |
| `test/workflow.test.mjs` | 59 项：经 `index.js` 的 `apps` 装载入口类、复刻 loader 分发，覆盖全部命令、上下文流程与错误路径 |

两个套件都只操作表格**副本**，结束时校验源表格哈希未变；被测表格不存在时按约定「跳过、不算失败」。约定细节见 `test/README.md`。

`test/verify-xlsx.ps1` 用 .NET 的 ZIP/XML 解析器独立复核生成的文件（与插件实现完全不同的一套实现）：

```powershell
powershell -File test/verify-xlsx.ps1 -Modified <生成的文件> -Original <原表格> -Sheet 2 -Row 27
```

`-Sheet` 是写入的工作表序号（1 起，对应 `xl/worksheets/sheetN.xml`，如 sheet2 = 幽境危战），`-Row` 是写入行号；脚本会回读该行 B–H 的文本、比对结构标签数量、校验未改动工作表逐字节一致。
