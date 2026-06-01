# black-swan-monitor

加密货币黑天鹅币种监控。脚本扫描上架币种项目方 Twitter 与新闻 fallback，识别 hack、exploit、stolen、pause、suspend、migration、delist 等风险信号，通过 Cloudflare relay 发送单张 Lark interactive card，并用 `sent_events.json` 做跨运行去重。

## 架构

```text
Cloudflare Cron (BJT 08:00 / 14:00 / 20:00)
  -> black-swan-mcp scheduled()
    -> GitHub workflow_dispatch
      -> risk_monitor.py
        -> Jina Reader Twitter scan
        -> GDELT news fallback
        -> sent_events.json dedupe
        -> Cloudflare Worker /send-lark
        -> Lark webhook
```

## 运行规则

- 高优先级币种：`SWEAT,AAVE,DRIFT` 每次必扫。
- 普通币种：按 `sent_events.json.meta.scan_offset` 轮转扫描，默认 8 路并发。
- 去重：同一 `coin + event_type + summary_hash` 不重复推送。
- 进展更新：同一 `coin + event_type` 但摘要有变化，且超过冷却时间后推送为更新。
- 空结果：默认不发 Lark，只更新 `reports/latest.json`。

## GitHub Secrets

- `BSM_RELAY_SECRET`
- `BSM_LARK_WEBHOOK_URL`（可选；未配置时复用旧 `LARK_WEBHOOK_URL`）
- `BSM_LARK_WEBHOOK_SECRET`（可选；Worker 已内置已知 webhook 的签名映射）
- `BLACK_SWAN_GITHUB_TOKEN`（Cloudflare Worker dispatch GitHub workflow 用，可复用有 Actions write 权限的 token）
- `BSM_RELAY_URL` 可选，默认 `https://black-swan-mcp.ysf63453.workers.dev/send-lark`

## 本地调试

```bash
python risk_monitor.py --limit 5 --dry-run
python risk_monitor.py --limit 30
python risk_monitor.py --limit 120 --max-workers 8 --dry-run
BSM_SEND_LARK=true python risk_monitor.py --limit 30 --send
python -m unittest
```
