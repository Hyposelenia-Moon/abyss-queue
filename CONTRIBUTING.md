# 贡献指南

欢迎 issue 与 PR。本仓库的硬性约定写在 [`AGENTS.md`](AGENTS.md)，协作与评审细节见 [`docs/协作.md`](docs/协作.md)；这里只列最常用的几条。

## 环境

- Node.js 24（与 CI 一致）
- 依赖：`pnpm install`（仓库不提交锁文件）
- 运行框架：Yunzai / TRSS-Yunzai，把本仓库放在 `plugins/abyss-queue`

## 跑测试

```bash
pnpm test                                  # 全量套件（= node test/run.mjs）
node test/run.mjs test/queue.test.mjs      # 只跑某几套（位置参数，不是 --filter）
```

- 缺前置的套件会打印跳过并以 `exit 0` 结束，属正常。
- 没有真实表时用合成口径：`ABYSS_TEST_SYNTHETIC=1 node test/run.mjs`；要覆盖磁盘读写分支则 `XLSX_PATH=<样本表.xlsx> node test/run.mjs`。
- CI 跑两遍：合成口径 + 落盘样本（`.github/workflows/ci.yml`）。

## 改代码

- ESM、中文注释、日志走 `logger?.info/warn/error`；未匹配的消息一律放行。
- 改配置键要四处同步：`defSet` 默认值、`config.yaml.example`、读取处、文档。
- 改用户可见行为、接口或表结构时，同步升 `package.json` 的 `version` 并在 `CHANGELOG.md` 顶部加一节；版本号只进不退，平时只动后两位。
- 文档跟行为走：改完文档跑 `node tools/doc-check.mjs`（查路径、命令、套件数、已下线名字、CSS 选择器）。

## 提交

- 一次授权只做一步；改完先验证再汇报。
- 提交摘要格式：

```
prefix: 中文描述

 - 具体改动一
 - 具体改动二
```

`prefix` 用小写英文（`feat` / `fix` / `docs` / `test` / `refactor` / `ci`），逐行列出真实代码改动，不含纯文档或格式噪音。
- 不要提交 `data/`、`config/config.yaml`、日志与临时脚本。

## PR

- 说明动机与影响面（哪些命令、端点、表结构受影响）。
- 附验证方式：跑了哪些套件、结果如何；界面改动附截图。
- 有争议的设计先开 issue 讨论，避免大改后再返工。

## 行为准则

参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。