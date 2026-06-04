#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_TOKENS_FILE = "tokens.csv";
const DEFAULT_STATE_FILE = "contract_state.json";
const DEFAULT_RELAY_URL = "https://black-swan-mcp.ysf63453.workers.dev/send-lark";
const GOPLUS_DELAY_MS = Number(process.env.BSM_GOPLUS_DELAY_MS || "2100");
const REQUEST_TIMEOUT_MS = Number(process.env.BSM_REQUEST_TIMEOUT_MS || "15000");

const EVM_FIELD_MAP = {
  is_honeypot: { severity: "CRITICAL", label: "变成蜜罐" },
  selfdestruct: { severity: "CRITICAL", label: "新增自毁能力" },
  transfer_pausable: { severity: "HIGH", label: "新增暂停转账能力" },
  owner_change_balance: { severity: "HIGH", label: "新增 owner 修改余额能力" },
  can_take_back_ownership: { severity: "HIGH", label: "新增 owner 权限收回能力" },
  hidden_owner: { severity: "HIGH", label: "出现隐藏 owner" },
  slippage_modifiable: { severity: "HIGH", label: "新增税率/滑点修改能力" },
};

const SOL_FIELD_MAP = {
  "mintable.status": { severity: "HIGH", label: "Solana mint authority 可增发" },
  "freezable.status": { severity: "HIGH", label: "Solana freeze authority 可冻结" },
  "closable.status": { severity: "MEDIUM", label: "Solana token account 可关闭" },
  "balance_mutable_authority.status": { severity: "HIGH", label: "Solana 可修改余额" },
  non_transferable: { severity: "HIGH", label: "Solana token 不可转让" },
  "metadata_mutable.status": { severity: "MEDIUM", label: "Solana 元数据可改" },
};

function parseArgs(argv) {
  const args = {
    tokensFile: process.env.BSM_TOKENS_FILE || DEFAULT_TOKENS_FILE,
    stateFile: process.env.BSM_CONTRACT_STATE_FILE || DEFAULT_STATE_FILE,
    scanLimit: Number(process.env.BSM_SCAN_LIMIT || "0"),
    dryRun: process.env.BSM_DRY_RUN === "true",
    send: process.env.BSM_SEND_LARK === "true",
    mockSecurityFile: process.env.BSM_MOCK_SECURITY_FILE || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tokens") args.tokensFile = argv[++i];
    else if (arg === "--state") args.stateFile = argv[++i];
    else if (arg === "--limit") args.scanLimit = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--send") args.send = true;
    else if (arg === "--mock-security") args.mockSecurityFile = argv[++i];
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  if (!rows.length) return [];
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  const headers = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] || "").trim()])));
}

function field(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== "") return row[name];
  }
  return "";
}

function normalizeChainId(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const aliases = {
    ethereum: "1",
    eth: "1",
    bsc: "56",
    "bnb smart chain": "56",
    polygon: "137",
    matic: "137",
    arbitrum: "42161",
    arb: "42161",
    base: "8453",
    avalanche: "43114",
    avax: "43114",
    optimism: "10",
    op: "10",
    zksync: "324",
  };
  return aliases[value] || value;
}

function normalizeToken(row) {
  const currency = field(row, ["currency", "币种", "symbol", "token"]).toUpperCase();
  const contract = field(row, ["合约地址", "contract", "contract_address", "address"]).trim();
  const chainId = normalizeChainId(field(row, ["chain_id", "chainId", "链ID", "链", "chain", "network"]));
  const twitter = field(row, ["official_twitter", "twitter", "Twitter", "官方推特"]);

  let family = "missing";
  if (/^0x[a-fA-F0-9]{40}$/.test(contract)) family = "evm";
  else if (/^(EQ|UQ)[A-Za-z0-9_-]{20,}$/.test(contract)) family = "ton";
  else if (/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(contract)) family = "solana";
  else if (contract) family = "other";

  return { currency, contract, chainId, twitter, family };
}

function loadTokens(path) {
  const tokens = parseCsv(readFileSync(path, "utf8")).map(normalizeToken);
  return tokens.filter((token) => token.currency);
}

function loadState(path) {
  if (!existsSync(path)) return { version: 1, last_scan: null, tokens: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function tokenKey(token) {
  return `${token.currency}_${token.family}_${token.chainId || "na"}_${token.contract}`;
}

function getPath(obj, path) {
  return path.split(".").reduce((cur, part) => (cur && cur[part] !== undefined ? cur[part] : undefined), obj);
}

function snapshotEvm(data) {
  const keys = [
    ...Object.keys(EVM_FIELD_MAP),
    "is_mintable",
    "is_proxy",
    "is_blacklisted",
    "buy_tax",
    "sell_tax",
    "owner_address",
    "is_open_source",
    "holder_count",
    "trust_list",
  ];
  return Object.fromEntries(keys.map((key) => [key, data?.[key] ?? ""]));
}

function snapshotSolana(data) {
  const keys = [...Object.keys(SOL_FIELD_MAP), "transfer_hook", "trusted_token", "total_supply"];
  return Object.fromEntries(keys.map((key) => [key, getPath(data, key) ?? data?.[key] ?? ""]));
}

function snapshotTon(data) {
  return {
    admin_address: data?.admin_address ?? "",
    mintable: data?.mintable ?? "",
    total_supply: data?.total_supply ?? "",
  };
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compareSnapshots(token, previous, current) {
  if (!previous) return [];
  const changes = [];

  const addFlagChanges = (fieldMap) => {
    for (const [key, meta] of Object.entries(fieldMap)) {
      if (String(previous[key] ?? "0") === "0" && String(current[key] ?? "0") === "1") {
        changes.push({ field: key, before: previous[key] ?? "0", after: current[key], ...meta });
      }
    }
  };

  if (token.family === "evm") {
    addFlagChanges(EVM_FIELD_MAP);
    if ((previous.owner_address || current.owner_address) && previous.owner_address !== current.owner_address) {
      changes.push({ field: "owner_address", before: previous.owner_address, after: current.owner_address, severity: "HIGH", label: "Owner 地址变化" });
    }
    const oldHolders = asNumber(previous.holder_count);
    const newHolders = asNumber(current.holder_count);
    if (oldHolders && newHolders !== null && newHolders < oldHolders * 0.5) {
      changes.push({ field: "holder_count", before: previous.holder_count, after: current.holder_count, severity: "HIGH", label: "持有人数量下降超过 50%" });
    }
    for (const taxField of ["buy_tax", "sell_tax"]) {
      const oldTax = asNumber(previous[taxField]);
      const newTax = asNumber(current[taxField]);
      if (oldTax !== null && newTax !== null && newTax - oldTax > 0.1) {
        changes.push({ field: taxField, before: previous[taxField], after: current[taxField], severity: "HIGH", label: `${taxField} 上升超过 10%` });
      }
    }
  } else if (token.family === "solana") {
    addFlagChanges(SOL_FIELD_MAP);
    const oldSupply = asNumber(previous.total_supply);
    const newSupply = asNumber(current.total_supply);
    if (oldSupply && newSupply !== null && newSupply > oldSupply * 1.2) {
      changes.push({ field: "total_supply", before: previous.total_supply, after: current.total_supply, severity: "HIGH", label: "Solana 总供应量增长超过 20%" });
    }
  } else if (token.family === "ton") {
    if ((previous.admin_address || current.admin_address) && previous.admin_address !== current.admin_address) {
      changes.push({ field: "admin_address", before: previous.admin_address, after: current.admin_address, severity: "HIGH", label: "TON admin 地址变化" });
    }
    if (previous.mintable === false && current.mintable === true) {
      changes.push({ field: "mintable", before: previous.mintable, after: current.mintable, severity: "HIGH", label: "TON 开启增发能力" });
    }
  }

  return changes.map((change) => ({ ...change, currency: token.currency, contract: token.contract, chainId: token.chainId, family: token.family }));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSecurity(token, mockData) {
  if (mockData) {
    const byKey = mockData[tokenKey(token)] || mockData[token.currency] || mockData[token.contract];
    if (!byKey) throw new Error("mock data missing");
    return byKey;
  }

  if (token.family === "evm") {
    if (!token.chainId) throw new Error("missing chain_id");
    await sleep(GOPLUS_DELAY_MS);
    const url = `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(token.chainId)}?contract_addresses=${encodeURIComponent(token.contract)}`;
    const data = await fetchJson(url);
    const item = data?.result?.[token.contract.toLowerCase()] || data?.result?.[token.contract];
    if (!item) throw new Error("GoPlus returned empty result");
    return snapshotEvm(item);
  }

  if (token.family === "solana") {
    await sleep(GOPLUS_DELAY_MS);
    const url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(token.contract)}`;
    const data = await fetchJson(url);
    const item = Array.isArray(data?.result) ? data.result[0] : data?.result?.[token.contract] || data?.result;
    if (!item) throw new Error("GoPlus Solana returned empty result");
    return snapshotSolana(item);
  }

  if (token.family === "ton") {
    const url = `https://toncenter.com/api/v3/jetton/masters?address=${encodeURIComponent(token.contract)}&limit=1`;
    const data = await fetchJson(url);
    const item = data?.jetton_masters?.[0] || data?.masters?.[0] || data?.result?.[0];
    if (!item) throw new Error("TON Center returned empty result");
    return snapshotTon(item);
  }

  throw new Error("missing contract");
}

function severityRank(severity) {
  return { CRITICAL: 3, HIGH: 2, MEDIUM: 1, INFO: 0 }[severity] ?? 0;
}

function buildReport({ scanned, skipped, failures, changes, firstRun }) {
  const now = new Date().toISOString();
  const highChanges = changes.filter((c) => severityRank(c.severity) >= 2);
  const headerColor = failures.length ? "red" : highChanges.length ? "red" : changes.length ? "orange" : "blue";
  const headerTitle = failures.length
    ? `合约风控扫描：扫描不完整 / ${changes.length} 个变化`
    : `合约风控扫描：${changes.length} 个变化`;

  const lines = [
    `**扫描时间:** ${now}`,
    `**扫描成功:** ${scanned}`,
    `**跳过:** ${skipped}`,
    `**扫描失败:** ${failures.length}`,
    `**风险变化:** ${changes.length}`,
    "",
  ];

  if (firstRun) {
    lines.push("首次运行仅建立合约安全基线，不输出风险结论。", "");
  }

  if (changes.length) {
    lines.push("**异常变化**");
    for (const change of changes.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, 30)) {
      lines.push(`- [${change.severity}] ${change.currency} ${change.label}: ${change.before || "(空)"} -> ${change.after || "(空)"}`);
    }
    lines.push("");
  }

  if (failures.length) {
    lines.push("**扫描失败**");
    for (const failure of failures.slice(0, 30)) {
      lines.push(`- ${failure.currency}: ${failure.reason}`);
    }
    if (failures.length > 30) lines.push(`- ... 还有 ${failures.length - 30} 个失败`);
  }

  return { headerTitle, headerColor, content: lines.join("\n"), highChanges };
}

function skipReason(token) {
  if (token.family === "missing") return "missing_contract";
  if (token.family === "other") return "unsupported_address";
  if (token.family === "evm" && !token.chainId) return "missing_chain_id";
  return "";
}

function isEmptySecurityResult(error) {
  return /returned empty result/i.test(error?.message || "");
}

async function sendLark(report) {
  const relayUrl = process.env.BSM_RELAY_URL || DEFAULT_RELAY_URL;
  const body = {
    secret: process.env.BSM_RELAY_SECRET,
    webhook_url: process.env.BSM_LARK_WEBHOOK_URL,
    webhook_secret: process.env.BSM_LARK_WEBHOOK_SECRET,
    header_title: report.headerTitle,
    header_color: report.headerColor,
    content: report.content,
  };
  if (!body.secret || !body.webhook_url) throw new Error("missing BSM_RELAY_SECRET or BSM_LARK_WEBHOOK_URL");
  const resp = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Lark relay failed: HTTP ${resp.status} ${await resp.text()}`);
}

async function run(args) {
  const allTokens = loadTokens(args.tokensFile);
  const skippedTokens = allTokens
    .map((token) => ({ token, reason: skipReason(token) }))
    .filter((item) => item.reason);
  const eligible = allTokens.filter((token) => !skipReason(token));
  const selected = args.scanLimit > 0 ? eligible.slice(0, args.scanLimit) : eligible;
  const state = loadState(args.stateFile);
  const previousTokens = state.tokens || {};
  const firstRun = Object.keys(previousTokens).length === 0;
  const nextTokens = { ...previousTokens };
  const changes = [];
  const failures = [];
  const runtimeSkips = [];
  const skipped = allTokens.length - selected.length;
  const mockData = args.mockSecurityFile ? JSON.parse(readFileSync(args.mockSecurityFile, "utf8")) : null;
  let scanned = 0;

  for (const token of selected) {
    try {
      const current = await fetchSecurity(token, mockData);
      const key = tokenKey(token);
      if (!firstRun) changes.push(...compareSnapshots(token, previousTokens[key], current));
      nextTokens[key] = { currency: token.currency, family: token.family, chain_id: token.chainId, contract: token.contract, ...current };
      scanned += 1;
      console.error(`[contract] scanned ${scanned}/${selected.length} ${token.currency}`);
    } catch (error) {
      const key = tokenKey(token);
      if (isEmptySecurityResult(error) && !previousTokens[key]) {
        runtimeSkips.push({ token, reason: "api_empty_result" });
        console.error(`[contract] skipped ${token.currency}: ${error.message}`);
      } else {
        failures.push({ currency: token.currency, contract: token.contract, reason: error.message });
        console.error(`[contract] failed ${token.currency}: ${error.message}`);
      }
    }
  }

  state.version = 1;
  state.last_scan = new Date().toISOString();
  state.tokens = nextTokens;
  const report = buildReport({ scanned, skipped: skipped + runtimeSkips.length, failures, changes, firstRun });
  const skipCounts = [...skippedTokens, ...runtimeSkips].reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {});
  if (Object.keys(skipCounts).length) {
    report.content += `\n\n**暂未覆盖**\n${Object.entries(skipCounts)
      .map(([reason, count]) => `- ${reason}: ${count}`)
      .join("\n")}`;
  }

  if (!args.dryRun) saveState(args.stateFile, state);
  if (args.send && !args.dryRun) await sendLark(report);
  else console.log(report.content);

  return { scanned, skipped, failures, changes, firstRun, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  buildReport,
  compareSnapshots,
  loadState,
  loadTokens,
  normalizeChainId,
  normalizeToken,
  parseCsv,
  run,
  snapshotEvm,
  tokenKey,
};
