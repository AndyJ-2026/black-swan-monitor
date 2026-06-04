import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { pickBestPair, prepare } from "../prepare_contract_tokens.mjs";

test("pickBestPair chooses matching pair with highest liquidity", () => {
  const address = "0x0000000000000000000000000000000000000001";
  const pair = pickBestPair(address, [
    { chainId: "bsc", baseToken: { address }, liquidity: { usd: 10 } },
    { chainId: "base", baseToken: { address }, liquidity: { usd: 100 } },
    { chainId: "ethereum", baseToken: { address: "0x2" }, liquidity: { usd: 1000 } },
  ]);
  assert.equal(pair.chainId, "base");
});

test("prepare writes chain_id from mock DexScreener and address format", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bsm-prepare-"));
  const input = join(dir, "datawind.csv");
  const output = join(dir, "tokens.csv");
  const mock = join(dir, "dex.json");
  const evm = "0x0000000000000000000000000000000000000001";
  const ton = "EQDPGjm4PU81Dez2rmQFQU2hw_i8hut5GTU91HOtzZbPEWf8";
  const sol = "SLXdx4BUt2v9uJQNzWqSfzTJ9UKLUDsvxHFMEEdrfgq";

  writeFileSync(input, [
    "asset_date,vcoin_id,currency,币种状态,开盘时间,官网,合约地址,official_twitter",
    `2026-05-31,1,KIMA,正常,,https://example.com,${evm},https://x.com/kima`,
    `2026-05-31,2,DROPEE,正常,,,${ton},`,
    `2026-05-31,3,SLX,正常,,,${sol},`,
  ].join("\n"));
  writeFileSync(mock, JSON.stringify({ [evm]: "base" }));

  const result = await prepare({ input, output, resolve: true, mockDexFile: mock });
  assert.equal(result.stats.resolved, 1);
  const csv = readFileSync(output, "utf8");
  assert.match(csv, /KIMA.*8453.*base.*mock/);
  assert.match(csv, /DROPEE.*ton/);
  assert.match(csv, /SLX.*solana/);
});
