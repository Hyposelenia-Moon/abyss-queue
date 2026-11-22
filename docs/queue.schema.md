# 排队数据格式（queue.json）

> 2026-11 起：`data/queue.json` 是**唯一事实源**，`data/queue.xlsx` 降级为**导出镜像**（导入 / 导出 / 下载 / 历史版本）。
> 之前 xlsx 兼作数据库与人工文档，是因为腾讯文档时期要手工改表；那份需求消失后，主存换成可 diff、可校验、原子替换的 JSON。

## 1. 文件布局

| 路径 | 角色 |
| --- | --- |
| `data/queue.json` | **事实源**。唯一写入口是编辑器；原子替换（tmp + rename），写前留 `.bak` |
| `data/queue.lock` | 写锁：`O_EXCL` 抢占，内容 `{pid, host, at}`；跨进程挡住“读—改—写”交错（见 §7） |
| `data/queue.xlsx` | **导出镜像**。每次提交后由编辑器重写；给 Excel / 下载 / 旧工具看 |
| `data/queue.xlsx.bak` | 写镜像前的上一版（排查用） |
| `data/versions/queue-*.xlsx` | 历史版本：镜像的快照（默认留 20 份；连续自动保存 5 分钟最多一份） |
| `data/archives/queue-YYYY-MM-DD.xlsx` | 每日归档（当天首份，保留 7 天） |
| `data/archives/queue-YYYY-MM.xlsx` | 每月归档（保留 12 个月） |
| `data/abyss-editor-roster.json` | 群成员名单（外挂，不进 queue.json） |
| `data/abyss-editor-status-names.json` | 当月临时状态名（外挂；导出只写基础词表） |
| `data/abyss-editor-bindings.json`、`locks.json` | 归属与锁：行号只在同一版表内有效，靠 `table`（json 的 sha256）门禁 |
| `data/claims`、`links`、`admins` | 链接认领、短链、白名单（各自独立） |

`data/` 已在 `.gitignore` 里，真实昵称与链接不会进仓库。

## 2. JSON 结构

```jsonc
{
  "format": 2,              // 结构版本；带迁移函数表
  "revision": 12,           // 每次写 +1
  "updatedAt": "2026-11-22T10:00:00.000Z",
  "sheets": [
    {
      "name": "幽境危战",   // 页签名，同时是标题
      "kind": "abyss",      // theater | abyss | spiral | attack
      "header": { "A": "序号", "B": "群昵称\n（保持最新）", "C": "原神游戏名", "D": "选择主播", "E": "难度及目标", "F": "备注", "G": "帮帮完成情况" },
      "options": { "anchor": ["…"], "goal": ["…"], "status": ["…"] },
      "prefill": 100,       // 导出时数据区至少铺这么多行（含公式与空行）
      "top": [              // 表头之前的原始行，按 A–I 存原文（F 列已丢弃）
        { "A": "幽境危战", "C": "…", "G": "…" }
      ],
      "rows": [             // 数据区，按顺序
        { "nickname": "…", "gameName": "…", "anchor": "…", "goal": "…", "note": "…", "status": "排队中" },
        { "blank": true }   // 空行占位（深境螺旋数据区中间那四个空行）
      ]
    }
  ]
}
```

字段口径：

- **标题**不存。第 1 行 A 格 = `sheet.name`，导出时写回；导入时也强制改成榜名（不再沿用旧表里的“2026年10月…排队”）。
- **序号**不存。数据行的序号 = 它在 `rows` 里的位置（1..N），导出写 `=ROW()-表头行` 并附缓存值 `1..N`。
- **行号**不存。`row = dataStart + index`；`dataStart = top.length + 2`；`dataEnd = dataStart + max(prefill, rows.length) - 1`。
- **账号强度**已废弃：导入丢弃 F 列，导出只有 A–G 七列。
- 所有值按**原始字符串**存：完成情况里可以出现主播名、多人逗号并列、`⚡` 等自由文本；攻炼页的「模式 + 目标」「完成人 + 等待开启」复合值不拆。
- `options` 只收三键（`anchor` / `goal` / `status`）的字符串数组；空数组不写。

## 3. 读写语义

- `model/json-table.js` 提供与旧 `model/table.js` 相同的 `read / mutate / replace / version / fingerprint` 接口，编辑器其余代码（动作、归属、锁、页面）不用改。
- `mutate` 在进程内串行：克隆文档 → 按 `inserts → sets → clearCells → clears → lists` 应用 → 校验 → 原子写 json → 导出镜像 → `afterCommit`。
- `fingerprint()` = **下一次写表会看到的那一版**的 sha256：先走一次 `#open()`（镜像比 json 新时先导回），再做版本比较，避免“版本轮询 vs 首次写入”误报冲突。
- **镜像回灌**：如果 `queue.xlsx` 的 mtime 比 json 新且内容不同，下一次读表会按表头认列把它导回 json（外部用 Excel 改过镜像的场景）；内容相同则不动，免得 revision 空转。
- 并发：同一进程内串行；跨进程靠 `revision`/指纹冲突（409）暴露，不做静默合并。

## 4. 导入规则（xlsx → json）

`model/doc-import.js`：

1. 每个工作表找 `A === "序号"` 的行当表头；列按**表头文字**认（`群昵称` / `原神游戏名` / `选择主播` / `难度及目标` / `备注` / `帮帮完成情况`），不写死列号。
2. 只保留 A–G 七列口径；**F 列账号强度丢弃**（连标题行里的也丢）。
3. 顶部区（表头之前）原样保留，行内按 A–I 存原文；第 1 行 A 格改成榜名。
4. 数据区从表头下一行到最后一条**有内容**的行；A 列公式不算内容；整行为空的存 `{blank:true}`。
5. 三列下拉从 `dataValidation` 读；`prefill` 默认 100。
6. `kind` 按页签名：`/攻炼|绝境/ → attack`、`/螺旋/ → spiral`、`/危战/ → abyss`、其余 `theater`。

## 5. 导出规则（json → xlsx，简单工作簿）

`model/doc-export.js`：

- 七列 A–G；顶部区原文写回；表头写回；第 1 行 A = 榜名。
- 数据区铺 `max(prefill, rows.length)` 行：A 列 `=ROW()-表头行` + 缓存 `<v>1..N</v>`；空行只留序号。
- D / E / G 三列写内联下拉（`errorStyle="warning"`），范围 `列 + dataStart … dataEnd`。
- **不保**：合并单元格、条件格式、配色、行高、超链接、冻结窗格、逐行样式。这是 2026-11-22 的决定（“导出按推荐来”），换来的是一份谁都能生成、能对账的简单工作簿。

## 6. 迁移与对账

```bash
# 1) 迁移（只读源表；默认输出同目录同名 .json，可显式指定）
node tools/migrate.mjs "D:\…\queue.xlsx" --out "D:\…\data\queue.json" --export "D:\…\queue.export.xlsx" --force

# 2) 三向对账：源表 = 状态文档 = 导出后再导入
node tools/verify.mjs "D:\…\queue.xlsx" --doc "D:\…\data\queue.json" --export "D:\…\queue.export.xlsx"
```

`verify` 比对页签名、表头、顶部区（F 列与标题格除外）、数据行、三列下拉；一致时退出码 0。

## 7. 备份、恢复与边界

- 历史版本 / 每日 / 每月归档都按镜像的 xlsx 快照存（可直接用 Excel 打开）；下载端点给的就是这些文件。
- 回退 = 读某个版本文件 → 按导入规则写回 json（与“上传覆盖”同一条路径），回退前也会先存一份。
- json 被手工改坏：校验器拒载并提示从 `data/versions/` 最近快照恢复；不会带着坏数据启动。
- 两个编辑器进程同时写：先抢 `data/queue.lock`（同主机看持有者 pid 是否还活，跨主机只看 2 分钟），抢不到等 3 秒后报“另一个编辑器正在写表”；进了临界区才读文档、写文档、写镜像，所以不会静默覆盖。即便锁失效（网络盘时钟漂移），后写者仍会因指纹/`revision` 不一致拿到冲突。
- 导入时重名：绑定/锁按行号 + 表指纹门禁，版本对不上会按昵称唯一命中重对账，命中不了一律作废（见 `editor/ownership.js` 头部的 AQ-03 / AQ-06 / AQ-02）。
- 尾部空行：导入会裁掉表尾的纯空行（数据区最后一条有内容的行为止）；中间的空行按 `{blank:true}` 保留。

## 8. 回归与 CI

`.github/workflows/ci.yml`：push / PR / 手动触发，Ubuntu + Node 24，`npm install --no-audit --no-fund`（不提交锁文件），跑 `node test/run.mjs`。
干净仓库上的预期结果是 **79 通过 / 1 跳过**（`test/editor-host.test.mjs` 需要 `data/queue.xlsx`，`data/` 不入库）。
