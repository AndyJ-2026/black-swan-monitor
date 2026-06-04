# black-swan-monitor

币后运营项目方爆雷监控。脚本扫描上架币种项目方 Twitter/X 与新闻 fallback，识别 hack、exploit、rug、bridge issue、private key leak、contract bug、project shutdown、depeg 等项目方风险信号，通过 Cloudflare relay 发送单张 Lark interactive card，并用 `sent_events.json` 做跨运行去重。

## 架构

```text
Cloudflare Cron (BJT 08:00 / 14:00 / 20:00)
  -> black-swan-mcp scheduled()
    -> GitHub workflow_dispatch
      -> risk_monitor.py
        -> X native GraphQL scan when BSM_X_COOKIES_JSON is configured
        -> Jina Reader Twitter fallback
        -> project-risk news fallback
        -> sent_events.json dedupe
        -> Cloudflare Worker /send-lark
        -> Lark webhook
```

## 运行规则

- 只关注项目方爆雷信号，不关注交易所充提、入款、出款等币后运营噪音。
- 项目方账号默认分 3 桶扫描，降低 X 风控风险；北京时间 8:00 / 14:00 / 20:00 三轮覆盖完整列表。
- `scan_limit=0` 表示不截断账号列表；仅按桶分批。
- 配置 `BSM_X_COOKIES_JSON` 后，优先使用 X 原生 Web GraphQL 抓项目方最新推文；未配置时降级到 Jina/GDELT。
- 单账号 X 原生模式默认串行读取，减少 suspended/read-only 账号被限流的概率。
- 去重：同一 `coin + event_type + summary_hash` 不重复推送。
- 进展更新：同一 `coin + event_type` 但摘要有变化，且超过冷却时间后推送为更新。
- 空结果：默认不发 Lark，只更新 `reports/latest.json`。
- 扫描失败：红色“扫描不完整”告警，不能当作安全结论。

## GitHub Secrets

- `BSM_RELAY_SECRET`
- `BSM_LARK_WEBHOOK_URL`（可选；未配置时复用旧 `LARK_WEBHOOK_URL`）
- `BSM_LARK_WEBHOOK_SECRET`（可选；Worker 已内置已知 webhook 的签名映射）
- `BSM_X_COOKIES_JSON`（可选；X 读取账号 cookie 池，示例：`[{"cookie":"auth_token=...; ct0=...; twid=..."}]`）
- `BLACK_SWAN_GITHUB_TOKEN`（Cloudflare Worker dispatch GitHub workflow 用，可复用有 Actions write 权限的 token）
- `BSM_RELAY_URL` 可选，默认 `https://black-swan-mcp.ysf63453.workers.dev/send-lark`

## 本地调试

```bash
python risk_monitor.py --limit 5 --dry-run
python risk_monitor.py --limit 0 --buckets 3 --dry-run
python risk_monitor.py --limit 0 --buckets 1 --max-workers 8 --dry-run
BSM_SEND_LARK=true python risk_monitor.py --limit 0 --buckets 3 --send
python -m unittest
```

## 本地 X 黑天鹅复扫

新版本地 X 扫描使用标准 Chrome DevTools Protocol，会自动打开一个临时 Chrome Profile，不依赖本机主账号登录态。它适合今天这种人工试跑：扫重点池、读取 X 公共页、把疑似内容交给 MiniMax 做语义复核，再生成运营能看懂的 Lark 卡片。

```bash
# 只试跑，不写去重状态，不发群
MINIMAX_API_KEY=*** BSM_X_OFFSET=60 BSM_X_LIMIT=30 npm run scan:x-risk:dry

# 写入本地去重状态；如需发群，再加 BSM_SEND_LARK=true 和 BSM_LARK_WEBHOOK_URL
MINIMAX_API_KEY=*** BSM_X_OFFSET=60 BSM_X_LIMIT=30 npm run scan:x-risk

# 日常本地批量跑重点池：按官方 X 去重，每批 40 个账号，每个账号取最近 3 条帖子
MINIMAX_API_KEY=*** npm run scan:x-risk:batches:dry

# 全量池低频补扫
MINIMAX_API_KEY=*** npm run scan:x-risk:batches:dry -- --all

# 稳定池低频扫描：全量去重账号减去重点池
MINIMAX_API_KEY=*** npm run scan:x-risk:stable:dry
```

关键规则：

- 启动临时 Chrome 时默认打开 `about:blank`，扫描器会通过 CDP 自己开项目页面；看到登录首页不代表扫描失败。
- 扫描前会先读一个已知有帖子的公开账号做预检；预检失败时直接停止，避免输出一批假失败。
- 默认按官方 X handle 去重：同一个账号只扫一次，再把结果映射到多个币种。当前表里 960 行有官方 X，全量去重后约 759 个账号；重点池 348 行去重后约 158 个账号。
- 日常扫描按账号推进，不按币种行推进；每个账号默认读取最近 3 条帖子。重点池去重后约 158 个账号，按 40 个一批大约 4 批能扫完。
- 未登录公共 X 页面不能一口气扫全量。实测连续扫到 50-60 个左右可能出现“出错了，请尝试重新加载”，后续结果不能当作安全结论。建议 30-50 个一批，中间冷却，触发连续错误时自动熔断。
- 批次内出现临时加载失败时，会进入自动补扫队列：runner 会跳过已成功账号，只对失败账号生成 retry CSV 并单独补扫。补扫仍失败时，才保留在最终“需补扫”里。
- 高危告警只用于项目自身安全事故、换合约、迁移、兑换/claim 截止、旧币失效等会影响我方资产或充提交易处理的事件。
- 竞品交易所支持换币、第三方项目迁移、泛泛提到 migration/swap/deadline 的内容，默认降级为运营观察或噪音。
- MiniMax 语义层会识别“事件主体”和“当前上币资产”是否一致，例如 EMBLEM 账号引用 MUMU Migration，不能直接算 EMBLEM 迁移。
- 页面状态会分开输出：读取成功、账号无历史帖子、账号冻结、公开页未返回帖子流、临时加载失败。不能把“未返回帖子流”当作安全结论。
- `x_scan_state.json` 是本地去重状态，默认不提交。

## 扫描节奏

账号池只分两类：

- `重点池`：高频监控对象，主要覆盖近期上新、长尾、小市值、meme、AI、迁移风险更高的项目。
- `稳定池`：全量去重账号减去重点池后的账号。

扫描结果状态不是账号池分类。`无历史帖子`、`账号冻结`、`账号不存在`、`临时失败` 都是扫描后的状态，可能出现在重点池，也可能出现在稳定池。

推荐流程：

- 每周 DataWind 表更新后：重点池和稳定池都扫描一轮，生成基础底报，并把高危、运营观察、渠道异常按正式卡片发群。
- 日常轮询：重点池每天扫描一轮。扫描过程中只有发现高危、运营观察、渠道异常才通报；没问题不通报。
- 稳定池低频轮询：每周扫描一轮即可。发现新增高危、运营观察、渠道异常时通报；无新增事件不通报。

## 云端 MVP

云端先复用加密日报的触发方式：

```text
Cloudflare Cron
  -> GitHub workflow_dispatch
    -> GitHub Actions ubuntu-latest
      -> headless Chrome
      -> x_scan_batches.mjs
      -> reports/x-batches/*.json
      -> reports/x-run-logs/*.md
```

当前 GitHub Actions 默认 `mode=x_batches`，合约监控不参与默认定时，只保留手动 `mode=contract`。

Cloudflare Cron：

- `30 2 * * *`：加密日报，保持原逻辑。
- `0 0 * * *`：黑天鹅重点池，每天一次。
- `0 1 * * 1`：黑天鹅稳定池，每周一一次。

需要配置：

- GitHub repository secrets:
  - `BLACK_SWAN_GITHUB_TOKEN`：Cloudflare dispatch workflow 用。
  - `MINIMAX_API_KEY`：可选；配置后云端语义复核会启用。
- Cloudflare Worker secrets:
  - `BLACK_SWAN_GITHUB_TOKEN` 或复用 `CRYPTO_DAILY_GITHUB_TOKEN`。

注意：云端 MVP 的运行日志写在仓库 `reports/x-run-logs/`，不是本机 Obsidian；本机 Obsidian 日志仍由本地运行写入。
