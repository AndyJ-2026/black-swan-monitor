import test from "node:test";
import assert from "node:assert/strict";

import { classifyPost } from "../x_event_rules.mjs";
import { buildReport, classifyPageState, extractJson, twitterHandle } from "../cdp_x_scan.mjs";

test("classifies competitor exchange token swap posts as watch", () => {
  const baby = classifyPost("Bitget Completes $BABYSHARK Token Swap & Rebranding. The $BSU to $BABYSHARK token swap and rebranding on Bitget have been successfully completed.");
  assert.equal(baby.level, "watch");

  const hpp = classifyPost("Bithumb will support the AERGO and AQT token swap and rebrand to HPP. 1 AERGO = 1 HPP.");
  assert.equal(hpp.level, "watch");
});

test("filters non asset-event keyword noise", () => {
  assert.equal(classifyPost("HASH v2 Genesis is now live. First 3h legacy snapshot only. Anyone can mint. Price: 0.01 ETH per 1,000 HASH.").level, "noise");
  assert.equal(classifyPost("The investor rights, redemption economics, penalties, interest, deadlines, and enforcement process are defined by state law.").level, "noise");
  assert.equal(classifyPost("Do we believe that the quantum deadline will not move earlier than 2029?").level, "noise");
});

test("classifies security incidents as alerts", () => {
  const result = classifyPost("Security incident update: our bridge was exploited and withdrawals are paused while we investigate.");
  assert.equal(result.level, "alert");
  assert.equal(result.type, "疑似安全事件/被盗");
});

test("does not red-alert explicit security denials", () => {
  const result = classifyPost("The edgeX protocol were not compromised in any way. This was not a hack, exploit, or security breach.");
  assert.equal(result.level, "watch");
  assert.equal(result.type, "安全事件澄清/价格异常观察");
});

test("classifies actionable migration posts as alerts", () => {
  const result = classifyPost("Token migration is live. Old token holders must swap before June 10 through the claim portal. New contract address: 0x123.");
  assert.equal(result.level, "alert");
  assert.equal(result.type, "疑似换合约/迁移/兑换动作");
});

test("report uses watch status instead of red alert for exchange-only swap posts", () => {
  const report = buildReport(
    [
      {
        ok: true,
        status: "ok",
        coin: "HPP",
        handle: "aergo_io",
        url: "https://x.com/aergo_io",
        alerts: [],
        watches: [{ level: "watch", type: "竞品交易所换币/重品牌观察", summary: "Bithumb will support the AERGO and AQT token swap and rebrand to HPP." }],
      },
    ],
    { offset: 30 },
  );
  assert.equal(report.color, "orange");
  assert.match(report.title, /运营观察/);
  assert.equal(report.alerts.length, 0);
  assert.equal(report.watches.length, 1);
});

test("page state classifier separates frozen and no-post accounts from loading failures", () => {
  assert.equal(classifyPageState({ body: "@abstractmogu 尚未发帖", posts: [] }), "no_posts");
  assert.equal(classifyPageState({ body: "账号已被冻结 X 会冻结违反 X 规则的账号", posts: [] }), "suspended");
  assert.equal(classifyPageState({ body: "This account doesn’t exist Try searching for another.", posts: [] }), "missing_account");
  assert.equal(classifyPageState({ body: "登录 注册 X 的新用户？", posts: [] }), "public_page_no_timeline");
  assert.equal(classifyPageState({ body: "", posts: [{ text: "hello" }] }), "ok");
});

test("MiniMax JSON extraction ignores think blocks and fenced text", () => {
  const parsed = extractJson(`<think>hidden reasoning</think>\n\`\`\`json\n{"risk_level":"watch","event_subject":"MUMU Migration"}\n\`\`\``);
  assert.deepEqual(parsed, { risk_level: "watch", event_subject: "MUMU Migration" });
});

test("twitter handle parser strips trailing URL junk", () => {
  assert.equal(twitterHandle("https://x.com/abstractmogu?s=21"), "abstractmogu");
  assert.equal(twitterHandle("https://twitter.com/@EmblemVault/status/123"), "EmblemVault");
});

test("MiniMax semantic downgrade keeps third-party migration out of red alerts", () => {
  const report = buildReport(
    [
      {
        ok: true,
        status: "ok",
        coin: "EMBLEM",
        handle: "EmblemVault",
        url: "https://x.com/EmblemVault",
        alerts: [
          {
            level: "alert",
            type: "疑似换合约/迁移/兑换动作",
            summary: "Migration summer Quote: MUMU Migration",
            semantic: {
              risk_level: "watch",
              event_subject: "MUMU Migration",
              summary: "帖子引用的是 MUMU 迁移，不是 EMBLEM 自身迁移。",
            },
          },
        ],
        watches: [],
      },
    ],
    { offset: 60, dryRun: true },
  );
  assert.equal(report.alerts.length, 0);
  assert.equal(report.watches.length, 1);
  assert.equal(report.color, "orange");
});
