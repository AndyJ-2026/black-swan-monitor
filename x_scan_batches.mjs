#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { loadAccounts } from "./cdp_x_scan.mjs";

const DEFAULT_OUTPUT_DIR = "reports/x-batches";
const DEFAULT_OBSIDIAN_LOG_DIR = "/Users/jaker/Documents/Obsidian Vault/黑天鹅监控/运行日志";

function parseArgs(argv) {
  const args = {
    tokensFile: process.env.BSM_TOKENS_FILE || "tokens.csv",
    allAccounts: process.env.BSM_X_ALL === "true",
    stableAccounts: process.env.BSM_X_STABLE === "true",
    batchSize: Number(process.env.BSM_X_BATCH_SIZE || "40"),
    cooldownMs: Number(process.env.BSM_X_BATCH_COOLDOWN_MS || "30000"),
    retryCooldownMs: Number(process.env.BSM_X_RETRY_COOLDOWN_MS || "60000"),
    maxPosts: Number(process.env.BSM_X_MAX_POSTS || "3"),
    startBatch: Number(process.env.BSM_X_START_BATCH || "0"),
    maxBatches: Number(process.env.BSM_X_MAX_BATCHES || "0"),
    cdpPortBase: Number(process.env.BSM_CDP_PORT_BASE || String(24000 + (process.pid % 10000))),
    outputDir: process.env.BSM_X_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    runLogDir: process.env.BSM_X_RUN_LOG_DIR || DEFAULT_OBSIDIAN_LOG_DIR,
    dryRun: process.env.BSM_DRY_RUN !== "false",
    send: process.env.BSM_SEND_LARK === "true",
    useMiniMax: process.env.BSM_USE_MINIMAX === "true",
    headless: process.env.BSM_CHROME_HEADLESS !== "false",
    resume: process.env.BSM_X_RESUME !== "false",
    force: process.env.BSM_X_FORCE === "true",
    retryFailed: process.env.BSM_X_RETRY_FAILED !== "false",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tokens") args.tokensFile = argv[++i];
    else if (arg === "--all") args.allAccounts = true;
    else if (arg === "--stable") args.stableAccounts = true;
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (arg === "--cooldown-ms") args.cooldownMs = Number(argv[++i]);
    else if (arg === "--retry-cooldown-ms") args.retryCooldownMs = Number(argv[++i]);
    else if (arg === "--max-posts") args.maxPosts = Number(argv[++i]);
    else if (arg === "--start-batch") args.startBatch = Number(argv[++i]);
    else if (arg === "--max-batches") args.maxBatches = Number(argv[++i]);
    else if (arg === "--cdp-port-base") args.cdpPortBase = Number(argv[++i]);
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "--run-log-dir") args.runLogDir = argv[++i];
    else if (arg === "--send") args.send = true;
    else if (arg === "--minimax") args.useMiniMax = true;
    else if (arg === "--no-minimax") args.useMiniMax = false;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--no-headless") args.headless = false;
    else if (arg === "--no-resume") args.resume = false;
    else if (arg === "--force") args.force = true;
    else if (arg === "--no-retry-failed") args.retryFailed = false;
    else if (arg === "--write-state") args.dryRun = false;
  }
  return args;
}

function runCommand(command, commandArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code || 0));
  });
}

function summarizeBatch(file) {
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8"));
  return {
    file,
    title: data.title,
    loaded: data.loaded || 0,
    noPosts: data.noPosts?.length || 0,
    suspended: data.suspended?.length || 0,
    missingAccounts: data.missingAccounts?.length || 0,
    retryNeeded: data.retryNeeded?.length || 0,
    alerts: data.alerts?.length || 0,
    watches: data.watches?.length || 0,
    retryAccounts: (data.retryNeeded || []).map((item) => ({
      coin: item.coin,
      handle: item.handle,
      twitter: item.twitter || `https://x.com/${item.handle}`,
      status: item.status,
    })),
    aborted: Boolean(data.abortedReason),
    abortedReason: data.abortedReason || "",
  };
}

function csvCell(value) {
  const text = String(value || "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeRetryCsv(file, accounts) {
  const lines = ["currency,asset_date,official_twitter"];
  for (const account of accounts) lines.push([account.coin, new Date().toISOString().slice(0, 10), account.twitter || `https://x.com/${account.handle}`].map(csvCell).join(","));
  writeFileSync(file, `${lines.join("\n")}\n`);
}

async function runRetryForBatch(args, summary, meta) {
  if (!args.retryFailed || !summary?.retryAccounts?.length) return null;
  const { offset, limit, port, runId, batch } = meta;
  if (args.retryCooldownMs > 0) {
    console.error(`[retry] cooldown ${args.retryCooldownMs}ms before retrying ${summary.retryAccounts.length} accounts`);
    await sleep(args.retryCooldownMs);
  }
  const scope = poolName(args);
  const retryCsv = join(args.outputDir, `retry-${scope}-${String(offset).padStart(4, "0")}-${String(offset + limit - 1).padStart(4, "0")}.csv`);
  const retryOutput = join(args.outputDir, `x-${scope}-retry-${String(offset).padStart(4, "0")}-${String(offset + limit - 1).padStart(4, "0")}.json`);
  if (args.resume && !args.force && existsSync(retryOutput)) {
    console.error(`[retry] skipped existing ${retryOutput}`);
    return summarizeBatch(retryOutput);
  }
  writeRetryCsv(retryCsv, summary.retryAccounts);
  const retryArgs = [
    "cdp_x_scan.mjs",
    "--tokens", retryCsv,
    "--all",
    "--limit", "0",
    "--max-posts", String(args.maxPosts),
    "--retries", "2",
    "--max-consecutive-errors", "3",
    "--cdp-port", String(port + 1000),
    "--chrome-profile", `/tmp/bsm-chrome-cdp-${scope}-${runId}-${batch}-retry`,
    "--output", retryOutput,
    "--launch-chrome",
  ];
  if (args.useMiniMax) retryArgs.push("--minimax");
  if (args.headless) retryArgs.push("--headless");
  if (args.dryRun) retryArgs.push("--dry-run");
  if (args.send) retryArgs.push("--send");
  console.error(`[retry] batch ${batch + 1} retrying ${summary.retryAccounts.length} accounts output=${retryOutput}`);
  const retryCode = await runCommand("node", retryArgs, {
    BSM_LAUNCH_CHROME: "true",
    BSM_CHROME_HEADLESS: args.headless ? "true" : "false",
    BSM_DRY_RUN: args.dryRun ? "true" : "false",
    BSM_USE_MINIMAX: args.useMiniMax ? "true" : "false",
    BSM_SEND_LARK: args.send ? "true" : "false",
  });
  if (retryCode !== 0) console.error(`[retry] batch ${batch + 1} retry exited with code ${retryCode}`);
  return summarizeBatch(retryOutput);
}

function buildSummary(summaries, args, totalAccounts) {
  const totals = summaries.reduce((acc, item) => {
    for (const key of ["loaded", "noPosts", "suspended", "missingAccounts", "retryNeeded", "alerts", "watches"]) acc[key] += item[key] || 0;
    if (item.aborted) acc.aborted += 1;
    return acc;
  }, { loaded: 0, noPosts: 0, suspended: 0, missingAccounts: 0, retryNeeded: 0, alerts: 0, watches: 0, aborted: 0 });
  return {
    generatedAt: new Date().toISOString(),
    scope: poolName(args),
    totalAccounts,
    batchSize: args.batchSize,
    completedBatches: summaries.length,
    totals,
    batches: summaries,
  };
}

function writeRunLog(summary, args) {
  if (!args.runLogDir) return "";
  if (!existsSync(args.runLogDir)) mkdirSync(args.runLogDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(args.runLogDir, `${stamp}-${summary.scope}.md`);
  const totals = summary.totals;
  const lines = [
    `# 黑天鹅监控运行日志 - ${summary.scope}`,
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 扫描池：${summary.scope === "priority" ? "重点池" : summary.scope === "stable" ? "稳定池" : "全量池"}`,
    `- 应扫去重账号：${summary.totalAccounts}`,
    `- 批次大小：${summary.batchSize}`,
    `- 完成批次：${summary.completedBatches}`,
    `- 成功读取帖子账号：${totals.loaded}`,
    `- 无历史帖子账号：${totals.noPosts}`,
    `- 账号冻结：${totals.suspended}`,
    `- 账号不存在：${totals.missingAccounts}`,
    `- 临时失败/仍需内部补扫：${totals.retryNeeded}`,
    `- 熔断批次：${totals.aborted}`,
    `- 高危告警：${totals.alerts}`,
    `- 运营观察：${totals.watches}`,
    "",
    "## 批次明细",
    "",
    "| 批次文件 | 读取 | 无帖 | 冻结 | 不存在 | 失败 | 高危 | 观察 | 熔断 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.batches.map((batch) => `| ${batch.file} | ${batch.loaded} | ${batch.noPosts} | ${batch.suspended} | ${batch.missingAccounts || 0} | ${batch.retryNeeded} | ${batch.alerts} | ${batch.watches} | ${batch.aborted ? 1 : 0} |`),
  ];
  const retryAccounts = summary.batches.flatMap((batch) => (batch.retryAccounts || []).map((account) => ({ ...account, file: batch.file })));
  if (retryAccounts.length) {
    lines.push("", "## 内部补扫队列", "");
    for (const account of retryAccounts) lines.push(`- ${account.coin} @${account.handle}：${account.status}（来源：${account.file}）`);
  }
  const aborted = summary.batches.filter((batch) => batch.abortedReason);
  if (aborted.length) {
    lines.push("", "## 熔断记录", "");
    for (const batch of aborted) lines.push(`- ${batch.file}：${batch.abortedReason}`);
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function poolName(args) {
  if (args.allAccounts) return "all";
  if (args.stableAccounts) return "stable";
  return "priority";
}

function loadExistingSummaries(outputDir, scope) {
  if (!existsSync(outputDir)) return [];
  const pattern = new RegExp(`^x-${scope}-(?:\\d{4}-\\d{4}|retry-\\d{4}-\\d{4})\\.json$`);
  return readdirSync(outputDir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => summarizeBatch(join(outputDir, name)))
    .filter(Boolean);
}

async function run(args) {
  if (!existsSync(args.outputDir)) mkdirSync(args.outputDir, { recursive: true });
  const accounts = loadAccounts(args.tokensFile, {
    allAccounts: args.allAccounts,
    stableAccounts: args.stableAccounts,
    uniqueHandles: true,
  });
  const totalBatches = Math.ceil(accounts.length / args.batchSize);
  const endBatch = args.maxBatches > 0 ? Math.min(totalBatches, args.startBatch + args.maxBatches) : totalBatches;
  const summaries = [];

  const runId = `${Date.now()}-${process.pid}`;
  const scope = poolName(args);
  console.error(`[batch] scope=${scope} accounts=${accounts.length} batchSize=${args.batchSize} batches=${totalBatches} portBase=${args.cdpPortBase}`);

  for (let batch = args.startBatch; batch < endBatch; batch += 1) {
    const offset = batch * args.batchSize;
    const limit = Math.min(args.batchSize, accounts.length - offset);
    const port = args.cdpPortBase + batch;
    const outputFile = join(args.outputDir, `x-${scope}-${String(offset).padStart(4, "0")}-${String(offset + limit - 1).padStart(4, "0")}.json`);
    const chromeProfile = `/tmp/bsm-chrome-cdp-${scope}-${runId}-${batch}`;
    const commandArgs = [
      "cdp_x_scan.mjs",
      "--offset", String(offset),
      "--limit", String(limit),
      "--max-posts", String(args.maxPosts),
      "--retries", "1",
      "--max-consecutive-errors", "3",
      "--cdp-port", String(port),
      "--chrome-profile", chromeProfile,
      "--output", outputFile,
      "--launch-chrome",
    ];
    if (args.allAccounts) commandArgs.push("--all");
    if (args.stableAccounts) commandArgs.push("--stable");
    if (args.useMiniMax) commandArgs.push("--minimax");
    if (args.headless) commandArgs.push("--headless");
    if (args.dryRun) commandArgs.push("--dry-run");
    if (args.send) commandArgs.push("--send");

    console.error(`[batch] ${batch + 1}/${totalBatches} offset=${offset} limit=${limit} output=${outputFile}`);
    if (args.resume && !args.force && existsSync(outputFile)) {
      const summary = summarizeBatch(outputFile);
      if (summary) {
        summaries.push(summary);
        console.error(`[batch] skipped existing ${outputFile}`);
        const retrySummary = await runRetryForBatch(args, summary, { offset, limit, port, runId, batch });
        if (retrySummary) summaries.push(retrySummary);
      }
      continue;
    }
    const code = await runCommand("node", commandArgs, {
      BSM_LAUNCH_CHROME: "true",
      BSM_CHROME_HEADLESS: args.headless ? "true" : "false",
      BSM_DRY_RUN: args.dryRun ? "true" : "false",
      BSM_USE_MINIMAX: args.useMiniMax ? "true" : "false",
      BSM_SEND_LARK: args.send ? "true" : "false",
    });
    const summary = summarizeBatch(outputFile);
    if (summary) summaries.push(summary);
    if (code !== 0) {
      console.error(`[batch] stopped because batch ${batch + 1} exited with code ${code}`);
      break;
    }
    const retrySummary = await runRetryForBatch(args, summary, { offset, limit, port, runId, batch });
    if (retrySummary) summaries.push(retrySummary);
    if (batch + 1 < endBatch && args.cooldownMs > 0) {
      console.error(`[batch] cooldown ${args.cooldownMs}ms`);
      await sleep(args.cooldownMs);
    }
  }

  const existing = loadExistingSummaries(args.outputDir, scope);
  const byFile = new Map();
  for (const item of [...existing, ...summaries]) byFile.set(item.file, item);
  const summary = buildSummary(Array.from(byFile.values()).sort((a, b) => a.file.localeCompare(b.file)), args, accounts.length);
  const summaryFile = join(args.outputDir, `summary-${scope}.json`);
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  const runLogFile = writeRunLog(summary, args);
  console.log(JSON.stringify(summary, null, 2));
  console.error(`[summary] ${summaryFile}`);
  if (runLogFile) console.error(`[run-log] ${runLogFile}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { buildSummary, parseArgs, run, summarizeBatch };
