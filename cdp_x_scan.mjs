#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { parseCsv } from "./contract_scan.mjs";
import { classifyAccountPosts } from "./x_event_rules.mjs";

const DEFAULT_TOKENS_FILE = "tokens.csv";
const DEFAULT_STATE_FILE = "x_scan_state.json";
const DEFAULT_CDP_PORT = 9333;
const DEFAULT_CHROME_PROFILE = "/tmp/bsm-chrome-cdp";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.7";
const DEFAULT_PREFLIGHT_HANDLE = "intodotspace";
const X_POST_URL_RE = /https:\/\/x\.com\/[^/\s]+\/status\/\d+/i;

function parseArgs(argv) {
  const args = {
    tokensFile: process.env.BSM_TOKENS_FILE || DEFAULT_TOKENS_FILE,
    stateFile: process.env.BSM_X_STATE_FILE || DEFAULT_STATE_FILE,
    offset: Number(process.env.BSM_X_OFFSET || "0"),
    limit: Number(process.env.BSM_X_LIMIT || "30"),
    allAccounts: process.env.BSM_X_ALL === "true",
    stableAccounts: process.env.BSM_X_STABLE === "true",
    uniqueHandles: process.env.BSM_X_UNIQUE_HANDLES !== "false",
    maxPosts: Number(process.env.BSM_X_MAX_POSTS || "8"),
    retries: Number(process.env.BSM_X_RETRIES || "2"),
    maxConsecutiveErrors: Number(process.env.BSM_X_MAX_CONSECUTIVE_ERRORS || "3"),
    cdpPort: Number(process.env.BSM_CDP_PORT || DEFAULT_CDP_PORT),
    cdpUrl: process.env.BSM_CDP_URL || "",
    launchChrome: process.env.BSM_LAUNCH_CHROME === "true",
    chromePath: process.env.BSM_CHROME_PATH || "",
    headless: process.env.BSM_CHROME_HEADLESS === "true",
    chromeProfile: process.env.BSM_CHROME_PROFILE || DEFAULT_CHROME_PROFILE,
    send: process.env.BSM_SEND_LARK === "true",
    useMiniMax: process.env.BSM_USE_MINIMAX === "true",
    miniMaxKey: process.env.MINIMAX_API_KEY || process.env.BSM_MINIMAX_API_KEY || "",
    miniMaxBaseUrl: process.env.MINIMAX_BASE_URL || process.env.BSM_MINIMAX_BASE_URL || DEFAULT_MINIMAX_BASE_URL,
    miniMaxModel: process.env.MINIMAX_MODEL || process.env.BSM_MINIMAX_MODEL || DEFAULT_MINIMAX_MODEL,
    preflightHandle: process.env.BSM_X_PREFLIGHT_HANDLE || DEFAULT_PREFLIGHT_HANDLE,
    outputFile: process.env.BSM_X_OUTPUT_FILE || "",
    dryRun: process.env.BSM_DRY_RUN === "true",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tokens") args.tokensFile = argv[++i];
    else if (arg === "--state") args.stateFile = argv[++i];
    else if (arg === "--offset") args.offset = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--all") args.allAccounts = true;
    else if (arg === "--stable") args.stableAccounts = true;
    else if (arg === "--allow-duplicate-handles") args.uniqueHandles = false;
    else if (arg === "--max-posts") args.maxPosts = Number(argv[++i]);
    else if (arg === "--retries") args.retries = Number(argv[++i]);
    else if (arg === "--max-consecutive-errors") args.maxConsecutiveErrors = Number(argv[++i]);
    else if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
    else if (arg === "--cdp-url") args.cdpUrl = argv[++i];
    else if (arg === "--launch-chrome") args.launchChrome = true;
    else if (arg === "--chrome-path") args.chromePath = argv[++i];
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--chrome-profile") args.chromeProfile = argv[++i];
    else if (arg === "--send") args.send = true;
    else if (arg === "--minimax") args.useMiniMax = true;
    else if (arg === "--preflight-handle") args.preflightHandle = argv[++i];
    else if (arg === "--no-preflight") args.preflightHandle = "";
    else if (arg === "--output") args.outputFile = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
  }

  return args;
}

function field(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== "") return row[name];
  }
  return "";
}

function ageDays(row) {
  const openedAt = field(row, ["开盘时间", "asset_date"]);
  const parsed = Date.parse(openedAt.replace(" ", "T"));
  if (!Number.isFinite(parsed)) return 9999;
  return Math.floor((Date.now() - parsed) / 86400000);
}

function twitterHandle(url) {
  const match = String(url || "").match(/(?:twitter\.com|x\.com)\/@?([^/?#\s]+)/i);
  if (!match) return "";
  return match[1].replace(/^@/, "").replace(/[^A-Za-z0-9_].*$/, "");
}

function isHighPriority(row) {
  const symbol = field(row, ["currency", "币种"]).toUpperCase();
  if (ageDays(row) <= 60) return true;
  if (/AI|AGENT|GPT|PRE|DOGE|PEPE|SHIB|CAT|MOON|PUMP|MEME|TRUMP|MUSK/.test(symbol)) return true;
  if (/ON$|X$/.test(symbol) && symbol.length >= 4) return true;
  return false;
}

function loadAccounts(path, options = {}) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const toAccounts = (selectedRows) => selectedRows
    .map((row) => ({
      coin: field(row, ["currency", "币种"]),
      handle: twitterHandle(field(row, ["official_twitter", "twitter", "Twitter", "官方推特"])),
      twitter: field(row, ["official_twitter", "twitter", "Twitter", "官方推特"]),
      age: ageDays(row),
    }))
    .filter((item) => item.coin && item.handle);

  const priorityRows = rows.filter(isHighPriority);
  let accounts;
  if (options.allAccounts) {
    accounts = toAccounts(rows);
  } else if (options.stableAccounts) {
    const priorityHandles = new Set(toAccounts(priorityRows).map((account) => account.handle.toLowerCase()));
    accounts = toAccounts(rows).filter((account) => !priorityHandles.has(account.handle.toLowerCase()));
  } else {
    accounts = toAccounts(priorityRows);
  }

  if (options.uniqueHandles === false) return accounts;
  const byHandle = new Map();
  for (const account of accounts) {
    const key = account.handle.toLowerCase();
    const existing = byHandle.get(key);
    if (existing) {
      existing.coins.push(account.coin);
      existing.coin = existing.coins.slice(0, 4).join("/");
      if (existing.coins.length > 4) existing.coin = `${existing.coins.slice(0, 4).join("/")} +${existing.coins.length - 4}`;
    } else {
      byHandle.set(key, { ...account, coins: [account.coin] });
    }
  }
  return Array.from(byHandle.values());
}

function loadState(path) {
  if (!existsSync(path)) return { seen: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { seen: {} };
  }
}

function saveState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function eventFingerprint(account, event) {
  const url = event.url || "";
  const summary = event.semantic?.summary || event.summary || "";
  return `${account.coin}|${account.handle}|${event.type}|${url}|${summary.slice(0, 160)}`;
}

function classifyPageState(data) {
  const body = data.body || "";
  const posts = data.posts || [];
  if (/账号已被冻结|account is suspended|Your account is suspended/i.test(body)) return "suspended";
  if (/This account doesn.t exist|This account doesn’t exist|账号不存在|此账号不存在/i.test(body)) return "missing_account";
  if (/尚未发帖|hasn.t posted|hasn’t posted|has not posted/i.test(body)) return "no_posts";
  if (posts.length > 0) return "ok";
  if (/出错了|请尝试重新加载|Something went wrong|Try reloading|Rate limit/i.test(body)) return "transient_error";
  if (/登录|注册|Sign in|Sign up/i.test(body)) return "public_page_no_timeline";
  return "empty";
}

function statusLabel(status) {
  const labels = {
    ok: "读取成功",
    no_posts: "账号无历史帖子",
    suspended: "账号冻结",
    missing_account: "账号不存在",
    public_page_no_timeline: "公开页未返回帖子流",
    transient_error: "临时加载失败",
    empty: "空页面",
    cdp_error: "CDP 错误",
  };
  return labels[status] || status;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function getBrowserWebSocketUrl(args) {
  if (args.cdpUrl) return args.cdpUrl;
  const url = `http://127.0.0.1:${args.cdpPort}/json/version`;
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const version = await requestJson(url);
      if (!version.webSocketDebuggerUrl) throw new Error(`CDP port ${args.cdpPort} did not expose webSocketDebuggerUrl`);
      return version.webSocketDebuggerUrl;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError || new Error(`CDP port ${args.cdpPort} did not become ready`);
}

function launchChrome(args) {
  const chromeFlags = [
    `--remote-debugging-port=${args.cdpPort}`,
    `--user-data-dir=${args.chromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ];
  if (args.headless) {
    chromeFlags.splice(chromeFlags.length - 1, 0, "--headless=new", "--disable-gpu", "--window-size=1280,1600");
  }
  const chromePath = args.chromePath || [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/jaker/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((path) => existsSync(path));
  if (process.env.GITHUB_ACTIONS === "true") chromeFlags.splice(chromeFlags.length - 1, 0, "--no-sandbox", "--disable-dev-shm-usage");
  const child = chromePath
    ? spawn(chromePath, chromeFlags, { stdio: "ignore", detached: true })
    : spawn("open", ["-g", "-na", "Google Chrome", "--args", ...chromeFlags], { stdio: "ignore" });
  child.unref();
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket connect timeout")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket error"));
      }, { once: true });
    });
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  send(method, params = {}, sessionId = "") {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 30000);
    });
  }

  close() {
    this.ws?.close();
  }
}

async function createPage(cdp) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  return {
    sessionId,
    async close() {
      await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    },
  };
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate exception");
  return result.result?.value;
}

async function navigateAndRead(cdp, page, account, maxPosts) {
  const url = `https://x.com/${account.handle}`;
  await cdp.send("Page.navigate", { url }, page.sessionId);
  await sleep(2500);

  const expression = `async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clickShowPosts = () => {
      for (const el of Array.from(document.querySelectorAll("span, div"))) {
        if (/Show \\d+ posts|查看新帖子/.test(el.innerText || "")) {
          el.click();
          return true;
        }
      }
      return false;
    };
    for (let i = 0; i < 8; i += 1) {
      clickShowPosts();
      const articles = Array.from(document.querySelectorAll("article"));
      const body = document.body?.innerText || "";
      if (articles.length > 0 || /尚未发帖|账号已被冻结|account is suspended|This account doesn.t exist|This account doesn’t exist|hasn.t posted|hasn’t posted/i.test(body)) break;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
      await sleep(1100);
    }
    const posts = Array.from(document.querySelectorAll("article"))
      .slice(0, ${JSON.stringify(maxPosts)})
      .map((article) => {
        const text = article.innerText || "";
        const status = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map((a) => a.href)
          .find(Boolean) || "";
        return { text, url: status };
      })
      .filter((post) => post.text.trim());
    return {
      title: document.title,
      body: (document.body?.innerText || "").slice(0, 3000),
      url: location.href,
      posts,
    };
  }`;

  return evaluate(cdp, page.sessionId, `(${expression})()`);
}

async function scanAccount(cdp, account, args) {
  const page = await createPage(cdp);
  const result = {
    ...account,
    url: `https://x.com/${account.handle}`,
    ok: false,
    status: "empty",
    title: "",
    articleCount: 0,
    posts: [],
    alerts: [],
    watches: [],
    noises: [],
    warning: "",
  };

  try {
    for (let attempt = 0; attempt <= args.retries; attempt += 1) {
      const data = await navigateAndRead(cdp, page, account, args.maxPosts);
      const status = classifyPageState(data);
      result.status = status;
      result.title = data.title || "";
      result.posts = (data.posts || []).map((post) => ({
        text: post.text,
        url: post.url || post.text.match(X_POST_URL_RE)?.[0] || "",
      }));
      result.articleCount = result.posts.length;

      if (status === "ok" || status === "no_posts" || status === "suspended" || status === "missing_account") break;
      if (attempt < args.retries) await sleep(1500 + attempt * 1000);
    }

    result.ok = result.status === "ok";
    const classified = classifyAccountPosts(result.posts.map((post) => post.text));
    result.alerts = attachPostMeta(classified.alerts, result.posts);
    result.watches = attachPostMeta(classified.watches, result.posts);
    result.noises = attachPostMeta(classified.noises, result.posts);
  } catch (error) {
    result.status = "cdp_error";
    result.warning = error.message;
  } finally {
    await page.close();
  }

  return result;
}

function attachPostMeta(events, posts) {
  return events.map((event) => {
    const post = posts.find((item) => item.text === event.post) || {};
    return { ...event, url: post.url || "" };
  });
}

function stripThinkBlocks(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJson(text) {
  const cleaned = stripThinkBlocks(text);
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : cleaned;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`MiniMax did not return JSON: ${cleaned.slice(0, 300)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

async function analyzeWithMiniMax(event, account, args) {
  if (!args.miniMaxKey) throw new Error("missing MINIMAX_API_KEY");
  const prompt = [
    "你是交易所币后运营风险监控助手。请判断这条 X 帖子是否表示该币种自身发生了资产风险事件。",
    "只输出 JSON，不要 markdown。",
    "JSON 字段：risk_level(alert/watch/noise), event_type, event_subject, is_same_as_listed_token(boolean), summary, evidence, recommended_action。",
    "判定规则：如果只是引用/转发/提到第三方项目迁移，且主体不是 listed_token，不能给 alert；如果是交易所支持公告但没有我方必须处理的截止/合约动作，最多 watch；只有项目自身安全事故、迁移、换合约、兑换/claim 截止、旧币失效等才可 alert。",
    `listed_token: ${account.coin}`,
    `source_account: @${account.handle}`,
    `rule_hit_type: ${event.type}`,
    `post_text: ${event.post || event.summary}`,
  ].join("\n");

  const response = await fetch(`${args.miniMaxBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.miniMaxKey}`,
    },
    body: JSON.stringify({
      model: args.miniMaxModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MiniMax HTTP ${response.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content || "";
  return extractJson(content);
}

async function enrichEvents(results, args) {
  if (!args.useMiniMax) return results;
  if (!args.miniMaxKey) {
    console.error("[minimax] MINIMAX_API_KEY missing; semantic review skipped");
    return results;
  }
  for (const account of results) {
    for (const bucket of ["alerts", "watches"]) {
      for (const event of account[bucket]) {
        try {
          event.semantic = await analyzeWithMiniMax(event, account, args);
          if (event.semantic.risk_level && event.semantic.risk_level !== event.level) {
            event.originalLevel = event.level;
            event.level = event.semantic.risk_level;
          }
        } catch (error) {
          event.semanticError = error.message;
        }
      }
    }
  }
  return results;
}

function normalizeEvents(results) {
  const alerts = [];
  const watches = [];
  for (const account of results) {
    for (const event of [...account.alerts, ...account.watches]) {
      const level = event.semantic?.risk_level || event.level;
      const item = { ...event, account };
      if (level === "alert") alerts.push(item);
      else if (level === "watch") watches.push(item);
    }
  }
  return { alerts, watches };
}

function filterNewEvents(events, state, dryRun) {
  const fresh = [];
  const seen = state.seen || {};
  for (const event of events) {
    const key = eventFingerprint(event.account, event);
    if (seen[key]) continue;
    fresh.push(event);
    if (!dryRun) seen[key] = new Date().toISOString();
  }
  state.seen = seen;
  return fresh;
}

function buildReport(results, args, state = { seen: {} }) {
  const loaded = results.filter((item) => item.status === "ok").length;
  const noPosts = results.filter((item) => item.status === "no_posts");
  const suspended = results.filter((item) => item.status === "suspended");
  const missingAccounts = results.filter((item) => item.status === "missing_account");
  const retryNeeded = results.filter((item) => !["ok", "no_posts", "suspended", "missing_account"].includes(item.status));
  const events = normalizeEvents(results);
  const freshAlerts = filterNewEvents(events.alerts, state, args.dryRun);
  const freshWatches = filterNewEvents(events.watches, state, args.dryRun);
  const title = freshAlerts.length
    ? "黑天鹅告警：发现需立即复核的项目方事件"
    : freshWatches.length
      ? "黑天鹅监控：发现运营观察项"
      : retryNeeded.length
        ? "黑天鹅监控：本轮有账号需补扫"
        : "黑天鹅监控：本轮未发现高危事件";
  const color = freshAlerts.length ? "red" : freshWatches.length || retryNeeded.length ? "orange" : "green";
  const lines = [];

  if (freshAlerts.length) {
    lines.push("**高危告警**");
    for (const event of freshAlerts.slice(0, 10)) lines.push(formatEvent(event, "请人工复核公告原文，确认是否需暂停充提/交易或跟进换币。"));
    lines.push("");
  }

  if (freshWatches.length) {
    lines.push("**运营观察**");
    for (const event of freshWatches.slice(0, 10)) lines.push(formatEvent(event, "核对主体是否为我方上币资产；若仅为第三方/竞品支持公告，记录即可。"));
    lines.push("");
  }

  if (!freshAlerts.length && !freshWatches.length) lines.push("本轮未发现需要立即处理的换合约、被盗、迁移、兑换截止相关事件。", "");

  if (suspended.length) {
    lines.push("**账号异常**");
    for (const item of suspended.slice(0, 10)) lines.push(`- ${item.coin} @${item.handle}: 账号冻结，建议人工确认是否为项目方官方号异常。`);
    lines.push("");
  }

  if (missingAccounts.length) {
    lines.push("**渠道异常观察**");
    for (const item of missingAccounts.slice(0, 10)) lines.push(`- ${item.coin} @${item.handle}: 官方 X 页面显示账号不存在，建议确认是否已更换官方账号或 DataWind 链接过期。`);
    lines.push("");
  }

  if (noPosts.length) {
    lines.push("**无历史帖子**");
    lines.push(noPosts.slice(0, 12).map((item) => `${item.coin} @${item.handle}`).join("、"));
    lines.push("");
  }

  if (retryNeeded.length) {
    lines.push("**需补扫**");
    for (const item of retryNeeded.slice(0, 12)) lines.push(`- ${item.coin} @${item.handle}: ${statusLabel(item.status)}${item.warning ? `，${item.warning}` : ""}`);
    lines.push("");
  }

  lines.push("**本轮覆盖**");
  const scopeName = args.allAccounts ? "全量池" : args.stableAccounts ? "稳定池" : "重点池";
  lines.push(`扫描范围：${scopeName}第 ${args.offset + 1}-${args.offset + results.length} 个官方 X`);
  lines.push(`帖子读取成功：${loaded}`);
  lines.push(`账号无历史帖子：${noPosts.length}`);
  lines.push(`账号冻结：${suspended.length}`);
  lines.push(`账号不存在：${missingAccounts.length}`);
  lines.push(`需补扫：${retryNeeded.length}`);
  lines.push(`新高危告警：${freshAlerts.length}`);
  lines.push(`新运营观察：${freshWatches.length}`);

  return { title, color, content: lines.join("\n"), loaded, noPosts, suspended, missingAccounts, retryNeeded, alerts: freshAlerts, watches: freshWatches };
}

function formatEvent(event, action) {
  const semantic = event.semantic || {};
  const subject = semantic.event_subject ? `主体：${semantic.event_subject}` : `类型：${event.type}`;
  const summary = semantic.summary || event.summary;
  const url = event.url || event.account.url;
  return [
    `- ${event.account.coin} @${event.account.handle}: ${subject}`,
    `  ${summary}`,
    `  链接：${url}`,
    `  建议：${semantic.recommended_action || action}`,
  ].join("\n");
}

function buildLarkCard(report) {
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template: report.color, title: { tag: "plain_text", content: report.title } },
      elements: [{ tag: "div", text: { tag: "lark_md", content: report.content } }],
    },
  };
}

async function sendLark(report) {
  const webhook = process.env.BSM_LARK_WEBHOOK_URL || "";
  if (!webhook) throw new Error("missing BSM_LARK_WEBHOOK_URL");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildLarkCard(report)),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Lark webhook failed: HTTP ${response.status} ${text}`);
  return text;
}

async function run(args) {
  const allAccounts = loadAccounts(args.tokensFile, {
    allAccounts: args.allAccounts,
    stableAccounts: args.stableAccounts,
    uniqueHandles: args.uniqueHandles,
  });
  const accounts = args.limit > 0 ? allAccounts.slice(args.offset, args.offset + args.limit) : allAccounts.slice(args.offset);
  const state = loadState(args.stateFile);
  if (args.launchChrome) {
    launchChrome(args);
    await sleep(2500);
  }
  const wsUrl = await getBrowserWebSocketUrl(args);
  const cdp = new CdpConnection(wsUrl);
  await cdp.connect();
  const results = [];
  let report;
  let abortedReason = "";

  try {
    if (args.preflightHandle) {
      const preflight = await scanAccount(cdp, { coin: "PREFLIGHT", handle: args.preflightHandle, age: 0 }, { ...args, maxPosts: 1, retries: Math.max(args.retries, 1) });
      if (preflight.status !== "ok") {
        throw new Error(`X preflight failed for @${args.preflightHandle}: ${statusLabel(preflight.status)}${preflight.warning ? ` ${preflight.warning}` : ""}`);
      }
    }
    for (const [idx, account] of accounts.entries()) {
      console.error(`[x] ${idx + 1}/${accounts.length} ${account.coin} @${account.handle}`);
      const result = await scanAccount(cdp, account, args);
      results.push(result);
      const tail = results.slice(-args.maxConsecutiveErrors);
      if (
        args.maxConsecutiveErrors > 0
        && tail.length === args.maxConsecutiveErrors
        && tail.every((item) => item.status === "transient_error" || item.status === "public_page_no_timeline")
      ) {
        abortedReason = `连续 ${args.maxConsecutiveErrors} 个账号未返回帖子流，疑似 X 公共页限流/错误页，已熔断`;
        console.error(`[abort] ${abortedReason}`);
        break;
      }
    }
  } finally {
    cdp.close();
  }

  await enrichEvents(results, args);
  report = buildReport(results, args, state);
  if (abortedReason) {
    report.title = "黑天鹅监控：本轮已熔断，需稍后分批补扫";
    report.color = "orange";
    report.content = `${abortedReason}\n\n${report.content}`;
    report.abortedReason = abortedReason;
  }
  if (!args.dryRun) saveState(args.stateFile, state);
  if (args.send) {
    const lark = await sendLark(report);
    console.error(`[lark] ${lark}`);
  }
  const output = { ...report, results };
  if (args.outputFile) {
    writeFileSync(args.outputFile, `${JSON.stringify(output, null, 2)}\n`);
    console.error(`[output] ${args.outputFile}`);
    console.log(report.content);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
  return { report, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  buildReport,
  classifyPageState,
  extractJson,
  loadAccounts,
  normalizeEvents,
  parseArgs,
  run,
  statusLabel,
  stripThinkBlocks,
  twitterHandle,
};
