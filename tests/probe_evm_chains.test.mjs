import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeSymbol, probe, probeToken } from "../probe_evm_chains.mjs";

test("normalizeSymbol removes punctuation and casing", () => {
  assert.equal(normalizeSymbol("Baby-Doge"), "BABYDOGE");
});

test("probeToken resolves only on matching token symbol", async () => {
  const address = "0x0000000000000000000000000000000000000001";
  const mock = {
    [`56:${address}`]: { token_symbol: "WRONG" },
    [`8453:${address}`]: { token_symbol: "KIMA" },
  };
  const result = await probeToken(
    { currency: "KIMA", "合约地址": address },
    [["56", "BSC"], ["8453", "Base"]],
    mock,
  );
  assert.equal(result.chainId, "8453");
  assert.equal(result.status, "goplus_symbol_match");
});

test("probe skips unresolved rows unless retry is requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bsm-probe-"));
  const input = join(dir, "tokens.csv");
  const output = join(dir, "out.csv");
  const mock = join(dir, "mock.json");
  const a = "0x0000000000000000000000000000000000000001";
  const b = "0x0000000000000000000000000000000000000002";

  writeFileSync(input, [
    "currency,合约地址,family,chain_id,chain_status,dex_chain_id,chain_source",
    `AAA,${a},evm,,unresolved_no_result,,`,
    `BBB,${b},evm,,missing_chain_id,,`,
  ].join("\n"));
  writeFileSync(mock, JSON.stringify({ [`1:${b}`]: { token_symbol: "BBB" } }));

  const result = await probe({
    input,
    output,
    limit: 25,
    offset: 0,
    retryUnresolved: false,
    chains: [["1", "Ethereum"]],
    mockFile: mock,
  });

  assert.equal(result.stats.selected, 1);
  assert.equal(result.stats.resolved, 1);
  assert.match(readFileSync(output, "utf8"), /BBB.*goplus_symbol_match/);
});
