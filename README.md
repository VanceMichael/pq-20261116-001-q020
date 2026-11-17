# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `POST /v1/feeds/:feedId/link-rules/preview`：离线预览链接参数规则迁移（只读），可在请求体用 `rules` 提供候选规则。
- `POST /v1/feeds/:feedId/link-rules/activate`：为该来源显式启用规则并建立身份层；碰撞会进入隔离而非自动合并。
- `GET /v1/feeds/:feedId/link-rules/conflicts`：列出仍待人工裁决的碰撞身份及其隔离观察。
- `POST /v1/feeds/:feedId/link-rules/conflicts/:identityId/resolve`：指定 `primaryArticleId` 完成人工裁决。
- `POST /v1/feeds/:feedId/link-rules/rollback`：关闭该来源的规则；历史身份、隔离证据和审核事件全部保留。
- `GET /v1/feeds/:feedId/link-rules/events`：读取预览、激活、裁决和回滚审计事件。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

## 链接参数规则迁移（`item_id` → `item`）

部分新来源用 `item`、旧来源用 `item_id` 表达同一个业务编号。迁移规则按来源显式启用（`linkRules.enabled=true`，可自定义 `canonicalKey` 与 `aliasKeys`），未启用的来源与全局跟踪参数（`utm_*`、`from`、`spm` 等）行为完全不变。

安全上线顺序：

1. **预览**：`link-rules/preview` 只读扫描旧库，区分安全重命名（一个旧键对应一个新键）、碰撞（多个旧 URL 归一到同一新键）和自相矛盾 URL（同一 URL 内编号不一致，直接拒绝）。预览不修改任何文章或快照行。
2. **激活**：在一个事务内建立附加式身份层（`link_identities` / `link_identity_members`），原文章行、原始 `canonical_url`、出现计数和审核历史一律不删改。安全重命名得到 `active` 身份；碰撞身份标记为 `quarantined`，其成员保留各自的出现历史与审核记录，审核状态相反时返回 `reviewConflict` 提示。
3. **隔离采集**：碰撞未裁决前，新采集命中该键的观察写入 `quarantined_observations` 留证，不会挑选或覆盖任一成员行；其余安全文章照常累计观察。
4. **人工裁决**：`resolve` 指定主文章后身份转为 `active`，后续新键观察并入主行；落选行以 `alias` 角色保留，历史与审核事件均可独立查询。
5. **回滚**：`rollback` 仅把来源规则切回关闭状态，旧键采集立即恢复；身份层、隔离观察、迁移后产生的真实观察和人工决定都不会被撤销，可再次激活且复用已有身份。

历史快照在 `capture_items.observed_url` 中保留每次采集当时实际见到的链接（只去过跟踪参数、未经身份键改写），`items/:id/history` 同时返回 `observedUrl`，因此旧键时代的来源链接仍可逐条定位。完整性审计新增 `capture_observed_urls`、`link_identity_members`、`quarantine_counters` 三项检查。旧库（schema v1）打开时自动非破坏升级到 v2 并回填历史证据。

### 当前查询如何兼容旧键

- 文章表的 `canonical_url` 永不改写，旧键 URL（如 `article-1.shtml?item_id=1`）在迁移后仍可用 `GET /v1/feeds/:feedId/items`、CSV 导出和按 URL 查询读到。
- 身份层通过 `link_identity_members` 把旧键行（`alias`）和新键主行（`primary`）挂到同一 `link_identities`，列表结果附带 `identityId`、`identityRole`、`identityCanonicalUrl`，可据此从任一旧键找到统一业务编号。
- 规则关闭（初始状态或回滚后）时，采集与查询路径与升级前完全一致；旧文章查询不需要任何调用方改动。

### 离线验证

```sh
npm test                      # 单元 + 集成测试（含 v1 旧库升级、碰撞、交错采集、回滚）
npm run verify:link-rules    # 端到端离线脚本：预览 → 激活隔离 → 交错采集 → 裁决 → 回滚
```

CLI 也提供 `link-preview`、`link-activate`、`link-conflicts`、`link-resolve <feed> <identity-id> <article-id>`、`link-rollback` 子命令，配合 `ARCHIVE_DB` 对生产库的离线副本操作。


仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
