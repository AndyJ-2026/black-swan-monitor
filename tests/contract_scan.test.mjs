import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSnapshots,
  loadTokens,
  normalizeChainId,
  parseCsv,
  run,
  snapshotEvm,
} from "../contract_scan.mjs";

test("parseCsv handles BOM and quoted commas", () => {
  const rows = parseCsv('\uFEFFcurrency,合约地址,chain_id\n"KIMA","0xabc,def","1"\n');
  assert.equal(rows[0].currency, "KIMA");
  assert.equal(rows[0]["合约地址"], "0xabc,def");
});

test("loadTokens requires explicit chain_id for EVM tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "bsm-contract-"));
  const csv = join(dir, "tokens.csv");
  writeFileSync(csv, "currency,合约地址,chain_id,official_twitter\nKIMA,0x0000000000000000000000000000000000000001,ethereum,https://x.com/KimaNetwork\n");

  const [token] = loadTokens(csv);
  assert.equal(token.family, "evm");
  assert.equal(token.chainId, "1");
  assert.equal(normalizeChainId("BSC"), "56");
});

test("compareSnapshots detects high-risk EVM changes", () => {
  const token = {
    currency: "KIMA",
    family: "evm",
    chainId: "1",
    contract: "0x0000000000000000000000000000000000000001",
  };
  const previous = snapshotEvm({ is_honeypot: "0", owner_address: "0xold", holder_count: "1000", sell_tax: "0" });
  const current = snapshotEvm({ is_honeypot: "1", owner_address: "0xnew", holder_count: "400", sell_tax: "0.2" });

  const changes = compareSnapshots(token, previous, current);
  assert.deepEqual(
    changes.map((change) => change.field),
    ["is_honeypot", "owner_address", "holder_count", "sell_tax"],
  );
  assert.equal(changes[0].severity, "CRITICAL");
});

test("run establishes baseline first, then detects mock changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bsm-contract-"));
  const csv = join(dir, "tokens.csv");
  const state = join(dir, "contract_state.json");
  const mock1 = join(dir, "mock1.json");
  const mock2 = join(dir, "mock2.json");
  const contract = "0x0000000000000000000000000000000000000001";

  writeFileSync(csv, `currency,合约地址,chain_id\nKIMA,${contract},1\n`);
  writeFileSync(mock1, JSON.stringify({ [contract]: { is_honeypot: "0", owner_address: "0xold", holder_count: "1000", sell_tax: "0" } }));
  writeFileSync(mock2, JSON.stringify({ [contract]: { is_honeypot: "1", owner_address: "0xold", holder_count: "1000", sell_tax: "0" } }));

  const first = await run({ tokensFile: csv, stateFile: state, scanLimit: 0, dryRun: false, send: false, mockSecurityFile: mock1 });
  assert.equal(first.firstRun, true);
  assert.equal(first.changes.length, 0);

  const second = await run({ tokensFile: csv, stateFile: state, scanLimit: 0, dryRun: false, send: false, mockSecurityFile: mock2 });
  assert.equal(second.firstRun, false);
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].field, "is_honeypot");
  assert.match(readFileSync(state, "utf8"), /KIMA/);
});
