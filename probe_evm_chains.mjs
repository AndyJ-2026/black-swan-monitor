#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { parseCsv } from "./contract_scan.mjs";

const DEFAULT_CHAINS = [
  ["1", "Ethereum"],
  ["56", "BSC"],
  ["8453", "Base"],
  ["42161", "Arbitrum"],
  ["137", "Polygon"],
  ["10", "Optimism"],
  ["43114", "Avalanche"],
  ["59144", "Linea"],
  ["5000", "Mantle"],
  ["324", "zkSync Era"],
  ["204", "opBNB"],
  ["130", "Unichain"],
  ["534352", "Scroll"],
  ["146", "Sonic"],
  ["80094", "Berachain"],
];

const REQUEST_TIMEOUT_MS = Number(process.env.BSM_REQUEST_TIMEOUT_MS || "15000");
const PROBE_DELAY_MS = Number(process.env.BSM_GOPLUS_PROBE_DELAY_MS || "2200");

function parseArgs(argv) {
  const args = {
    input: "tokens.csv",
    output: "tokens.csv",
    limit: Number(process.env.BSM_PROBE_LIMIT || "25"),
    offset: Number(process.env.BSM_PROBE_OFFSET || "0"),
    retryUnresolved: process.env.BSM_RETRY_UNRESOLVED === "true",
    chains: DEFAULT_CHAINS,
    mockFile: process.env.BSM_MOCK_GOPLUS_PROBE_FILE || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--offset") args.offset = Number(argv[++i]);
    else if (arg === "--retry-unresolved") args.retryUnresolved = true;
    else if (arg === "--chains") {
      const ids = argv[++i].split(",").map((id) => id.trim()).filter(Boolean);
      args.chains = ids.map((id) => [id, id]);
    } else if (arg === "--mock") args.mockFile = argv[++i];
  }
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

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
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

async function queryGoPlus(chainId, address, mock) {
  if (mock) {
    return mock[`${chainId}:${address.toLowerCase()}`] || null;
  }
  await sleep(PROBE_DELAY_MS);
  const url = `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(chainId)}?contract_addresses=${encodeURIComponent(address)}`;
  const data = await fetchJson(url);
  return data?.result?.[address.toLowerCase()] || data?.result?.[address] || null;
}

async function probeToken(row, chains, mock) {
  const address = row["合约地址"];
  const expected = normalizeSymbol(row.currency);
  const candidates = [];

  for (const [chainId, chainName] of chains) {
    try {
      const result = await queryGoPlus(chainId, address, mock);
      const symbol = result?.token_symbol || "";
      if (!result || !symbol) continue;
      candidates.push({ chainId, chainName, symbol });
      if (normalizeSymbol(symbol) === expected) {
        return { chainId, chainName, status: "goplus_symbol_match", candidates };
      }
    } catch (error) {
      candidates.push({ chainId, chainName, error: error.message });
    }
  }

  if (candidates.length === 1 && !candidates[0].error) {
    return {
      chainId: "",
      chainName: candidates[0].chainName,
      status: `candidate_symbol_mismatch:${candidates[0].chainId}:${candidates[0].symbol}`,
      candidates,
    };
  }

  return {
    chainId: "",
    chainName: "",
    status: candidates.length ? `unresolved_candidates:${candidates.length}` : "unresolved_no_result",
    candidates,
  };
}

async function probe(args) {
  const rows = parseCsv(readFileSync(args.input, "utf8"));
  const headers = Object.keys(rows[0] || {});
  const mock = args.mockFile ? JSON.parse(readFileSync(args.mockFile, "utf8")) : null;
  const targets = rows.filter((row) => {
    if (row.family !== "evm" || row.chain_id) return false;
    if (args.retryUnresolved) return true;
    return !row.chain_status || row.chain_status === "missing_chain_id";
  });
  const offsetTargets = targets.slice(Math.max(0, args.offset));
  const selected = args.limit > 0 ? offsetTargets.slice(0, args.limit) : offsetTargets;
  const stats = { selected: selected.length, resolved: 0, unresolved: 0 };

  for (const row of selected) {
    const result = await probeToken(row, args.chains, mock);
    if (result.chainId) {
      row.chain_id = result.chainId;
      row.dex_chain_id = result.chainName;
      row.chain_source = "goplus_probe";
      row.chain_status = result.status;
      stats.resolved += 1;
      console.error(`[probe] resolved ${row.currency} ${row["合约地址"]} -> ${result.chainName} (${result.chainId})`);
    } else {
      row.chain_status = result.status;
      stats.unresolved += 1;
      console.error(`[probe] unresolved ${row.currency}: ${result.status}`);
    }
  }

  writeFileSync(args.output, toCsv(rows, headers));
  console.error(JSON.stringify(stats, null, 2));
  return { rows, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  probe(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { normalizeSymbol, probe, probeToken };
