#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { normalizeChainId, normalizeToken, parseCsv } from "./contract_scan.mjs";

const DEXSCREENER_DELAY_MS = Number(process.env.BSM_DEXSCREENER_DELAY_MS || "250");
const REQUEST_TIMEOUT_MS = Number(process.env.BSM_REQUEST_TIMEOUT_MS || "15000");

const DEX_TO_GOPLUS_CHAIN_ID = {
  ethereum: "1",
  ether: "1",
  bsc: "56",
  bnb: "56",
  polygon: "137",
  arbitrum: "42161",
  arbitrumone: "42161",
  base: "8453",
  avalanche: "43114",
  optimism: "10",
  zksync: "324",
  linea: "59144",
  mantle: "5000",
  scroll: "534352",
  fantom: "250",
  cronos: "25",
  heco: "128",
  gnosis: "100",
  kcc: "321",
  sonic: "146",
  berachain: "80094",
};

function parseArgs(argv) {
  const args = {
    input: "",
    output: "tokens.csv",
    resolve: process.env.BSM_RESOLVE_CHAINS === "true",
    mockDexFile: process.env.BSM_MOCK_DEXSCREENER_FILE || "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--resolve") args.resolve = true;
    else if (arg === "--mock-dex") args.mockDexFile = argv[++i];
  }
  if (!args.input) throw new Error("missing --input");
  return args;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, headers) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n") + "\n";
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function pickBestPair(address, pairs) {
  const lower = address.toLowerCase();
  return (pairs || [])
    .filter((pair) => {
      const base = pair?.baseToken?.address?.toLowerCase();
      const quote = pair?.quoteToken?.address?.toLowerCase();
      return base === lower || quote === lower;
    })
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
}

async function resolveViaDexScreener(token, mockDex) {
  if (mockDex) {
    const chain = mockDex[token.contract] || mockDex[token.contract.toLowerCase()] || "";
    return { dex_chain_id: chain, chain_id: DEX_TO_GOPLUS_CHAIN_ID[chain] || normalizeChainId(chain), source: "mock" };
  }

  await sleep(DEXSCREENER_DELAY_MS);
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(token.contract)}`;
  const data = await fetchJson(url);
  const pair = pickBestPair(token.contract, data?.pairs);
  const dexChain = pair?.chainId || "";
  return {
    dex_chain_id: dexChain,
    chain_id: DEX_TO_GOPLUS_CHAIN_ID[dexChain] || normalizeChainId(dexChain),
    source: dexChain ? "dexscreener" : "",
  };
}

async function prepare(args) {
  const inputRows = parseCsv(readFileSync(args.input, "utf8"));
  const mockDex = args.mockDexFile ? JSON.parse(readFileSync(args.mockDexFile, "utf8")) : null;
  const rows = [];
  const stats = { evm: 0, solana: 0, ton: 0, missing: 0, other: 0, resolved: 0, unresolved: 0 };

  for (const row of inputRows) {
    const token = normalizeToken(row);
    const out = {
      asset_date: row.asset_date || "",
      vcoin_id: row.vcoin_id || "",
      currency: token.currency,
      "币种状态": row["币种状态"] || "",
      "开盘时间": row["开盘时间"] || "",
      "官网": row["官网"] || "",
      "合约地址": token.contract,
      official_twitter: token.twitter,
      family: token.family,
      chain_id: token.chainId,
      dex_chain_id: "",
      chain_source: token.chainId ? "input" : "",
      chain_status: "",
    };

    stats[token.family] = (stats[token.family] || 0) + 1;
    if (token.family === "solana") {
      out.chain_id = "solana";
      out.dex_chain_id = "solana";
      out.chain_source = "address_format";
    } else if (token.family === "ton") {
      out.chain_id = "ton";
      out.dex_chain_id = "ton";
      out.chain_source = "address_format";
    } else if (token.family === "evm" && !out.chain_id) {
      if (args.resolve) {
        try {
          const resolved = await resolveViaDexScreener(token, mockDex);
          out.chain_id = resolved.chain_id;
          out.dex_chain_id = resolved.dex_chain_id;
          out.chain_source = resolved.source;
        } catch (error) {
          out.chain_status = `resolve_error: ${error.message}`;
        }
      }
      if (out.chain_id) stats.resolved += 1;
      else {
        stats.unresolved += 1;
        if (!out.chain_status) out.chain_status = "missing_chain_id";
      }
    }

    rows.push(out);
  }

  const headers = [
    "asset_date",
    "vcoin_id",
    "currency",
    "币种状态",
    "开盘时间",
    "官网",
    "合约地址",
    "official_twitter",
    "family",
    "chain_id",
    "dex_chain_id",
    "chain_source",
    "chain_status",
  ];
  writeFileSync(args.output, toCsv(rows, headers));
  console.error(JSON.stringify(stats, null, 2));
  return { rows, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  prepare(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { DEX_TO_GOPLUS_CHAIN_ID, pickBestPair, prepare, resolveViaDexScreener };
