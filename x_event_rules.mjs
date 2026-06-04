const SECURITY_RE = /\b(hack(?:ed)?|exploit(?:ed)?|stolen|drain(?:ed)?|compromised|private key|key leak|security incident)\b|bridge (?:hack|exploit|pause|halt)|被盗|攻击|漏洞|私钥/i;
const NEGATED_SECURITY_RE = /\b(?:not|no|never|wasn.t|wasn’t|were not|without)\b.{0,80}\b(?:hack(?:ed)?|exploit(?:ed)?|compromised|security breach|security incident)\b|\b(?:hack(?:ed)?|exploit(?:ed)?|compromised|security breach|security incident)\b.{0,80}\b(?:did not|does not|no funds|not affected|safe|secure)\b|未被攻击|并非攻击|没有被盗|未受影响/i;
const MIGRATION_RE = /\b(token swap|swap ratio|rebrand(?:ing)?|migration|migrate|new contract|old contract|contract swap|claim portal|redemption|snapshot|conversion)\b|换合约|迁移|兑换|新合约/i;
const ACTION_RE = /\b(new contract|old contract|contract address|claim portal|redemption|deadline|snapshot|suspend(?:ed)?|pause(?:d)?|deposit|withdrawal|must|required|before|until|migration portal|swap portal)\b|合约地址|截止|暂停|充提|快照/i;
const EXCHANGE_SUPPORT_RE = /\b(?:binance|bitget|bithumb|bybit|okx|kucoin|gate|mexc|coinbase|upbit|kraken|htx)\b.{0,80}\b(?:support|supports|supported|complete[sd]?|will support)\b.{0,120}\b(?:token swap|rebrand|rebranding|migration)\b|\b(?:token swap|rebrand|rebranding|migration)\b.{0,120}\b(?:on|by)\s+\b(?:binance|bitget|bithumb|bybit|okx|kucoin|gate|mexc|coinbase|upbit|kraken|htx)\b/i;
const NOISE_RE = /\b(tokenomics|governance token|community token|tax lien|property taxes|redemption economics|enforcement process|quantum deadline|whitelist mint|genesis is now live|anyone can mint|price:|max .* per tx)\b/i;

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function summarize(text, maxLength = 360) {
  const value = cleanText(text);
  return value.length > maxLength ? `${value.slice(0, maxLength)}` : value;
}

function classifyPost(text) {
  const content = cleanText(text);
  if (!content) {
    return { level: "none", type: "", reason: "", summary: "" };
  }

  if (NOISE_RE.test(content)) {
    return { level: "noise", type: "非资产事件语境", reason: "命中常见噪音语境", summary: summarize(content) };
  }

  if (SECURITY_RE.test(content)) {
    if (NEGATED_SECURITY_RE.test(content)) {
      return {
        level: "watch",
        type: "安全事件澄清/价格异常观察",
        reason: "文本提到安全事件词，但语义是否定或澄清",
        summary: summarize(content),
      };
    }
    return { level: "alert", type: "疑似安全事件/被盗", reason: "命中安全事故关键词", summary: summarize(content) };
  }

  const hasMigration = MIGRATION_RE.test(content);
  if (!hasMigration) {
    return { level: "none", type: "", reason: "", summary: "" };
  }

  const exchangeOnly = EXCHANGE_SUPPORT_RE.test(content);
  const hasAction = ACTION_RE.test(content);
  if (exchangeOnly && !/\b(new contract|old contract|contract address|claim portal|redemption|deadline|before|must|required)\b|合约地址|截止/i.test(content)) {
    return {
      level: "watch",
      type: "竞品交易所换币/重品牌观察",
      reason: "竞品交易所支持公告，未见我方必须立即处理的截止或合约动作",
      summary: summarize(content),
    };
  }

  if (hasAction) {
    return { level: "alert", type: "疑似换合约/迁移/兑换动作", reason: "同时命中迁移语义和行动要素", summary: summarize(content) };
  }

  return { level: "watch", type: "项目迁移/重品牌观察", reason: "命中迁移语义但缺少明确行动要素", summary: summarize(content) };
}

function classifyAccountPosts(posts) {
  const classified = posts.map((post) => ({ post, ...classifyPost(post) }));
  return {
    alerts: classified.filter((item) => item.level === "alert"),
    watches: classified.filter((item) => item.level === "watch"),
    noises: classified.filter((item) => item.level === "noise"),
  };
}

export { classifyAccountPosts, classifyPost, summarize };
