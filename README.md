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
