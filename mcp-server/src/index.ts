import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const RELAY_SECRET = "bsm-9f3a7c";
const CRYPTO_DAILY_OWNER = "AndyJ-2026";
const CRYPTO_DAILY_REPO = "crypto-daily-report";
const CRYPTO_DAILY_WORKFLOW = "crypto-daily-report.yml";
const CRYPTO_DAILY_DISPATCH_TIMEOUT_MS = 10000;

type Env = {
	CRYPTO_DAILY_LARK_WEBHOOK_URL?: string;
	CRYPTO_DAILY_LARK_WEBHOOK_SECRET?: string;
	CRYPTO_DAILY_GITHUB_TOKEN?: string;
};

// Lark webhook signing secrets (webhook_url suffix → secret)
const WEBHOOK_SECRETS: Record<string, string> = {
	"cd9e30ce-42bb-4eed-8724-cdb233db49e8": "35sHqGGvABJIzv36bkoKD",
};
const FIRECRAWL_API_KEY = "fc-933c9b80dfbd4675ad15f2602646bff6";

async function buildLarkCard({
	webhookUrl,
	headerTitle,
	headerColor,
	content,
	webhookSecret,
}: {
	webhookUrl: string;
	headerTitle: string;
	headerColor: "red" | "orange" | "green" | "blue";
	content: string;
	webhookSecret?: string;
}) {
	const card: Record<string, any> = {
		msg_type: "interactive",
		card: {
			header: {
				title: { tag: "plain_text", content: headerTitle },
				template: headerColor,
			},
			elements: [{ tag: "markdown", content }],
		},
	};

	const urlId = webhookUrl.split("/").pop() || "";
	const signingSecret = webhookSecret || WEBHOOK_SECRETS[urlId];

	if (signingSecret) {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const stringToSign = `${timestamp}\n${signingSecret}`;
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(stringToSign),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
		card.timestamp = timestamp;
		card.sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
	}

	return card;
}

async function sendLarkCard(params: {
	webhookUrl: string;
	headerTitle: string;
	headerColor: "red" | "orange" | "green" | "blue";
	content: string;
	webhookSecret?: string;
}) {
	const card = await buildLarkCard(params);
	const resp = await fetch(params.webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(card),
	});
	return { status: resp.status, body: await resp.text() };
}

async function dispatchCryptoDailyWorkflow(env: Env, dryRun = false) {
	if (!env.CRYPTO_DAILY_GITHUB_TOKEN) {
		throw new Error("Missing CRYPTO_DAILY_GITHUB_TOKEN");
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CRYPTO_DAILY_DISPATCH_TIMEOUT_MS);
	try {
		const resp = await fetch(
			`https://api.github.com/repos/${CRYPTO_DAILY_OWNER}/${CRYPTO_DAILY_REPO}/actions/workflows/${CRYPTO_DAILY_WORKFLOW}/dispatches`,
			{
				method: "POST",
				headers: {
					"Accept": "application/vnd.github+json",
					"Authorization": `Bearer ${env.CRYPTO_DAILY_GITHUB_TOKEN}`,
					"Content-Type": "application/json",
					"User-Agent": "black-swan-mcp-cloudflare-cron",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				body: JSON.stringify({
					ref: "main",
					inputs: { dry_run: dryRun ? "true" : "false" },
				}),
				signal: controller.signal,
			},
		);

		const body = await resp.text();
		if (resp.status !== 204) {
			throw new Error(`GitHub dispatch failed: HTTP ${resp.status} ${body}`);
		}
	} finally {
		clearTimeout(timeout);
	}

	return { ok: true, status: 204, dryRun };
}

export class BlackSwanMCP extends McpAgent {
	server = new McpServer({
		name: "Black Swan Monitor",
		version: "1.0.0",
	});

	async init() {
		// Fetch any URL and return its content as text
		this.server.registerTool(
			"fetch_url",
			{
				description: "Fetch a URL and return its content. Supports any HTTP method.",
				inputSchema: {
					url: z.string().describe("The URL to fetch"),
					method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
					headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
					body: z.string().optional().describe("Optional request body for POST"),
				},
			},
			async ({ url, method, headers, body }) => {
				try {
					const resp = await fetch(url, {
						method,
						headers: (headers || {}) as HeadersInit,
						body: method === "POST" ? body : undefined,
					});
					const text = await resp.text();
					// Truncate to 50k chars to avoid token explosion
					const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n...[truncated]" : text;
					return {
						content: [{ type: "text", text: `HTTP ${resp.status}\n\n${truncated}` }],
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Fetch error: ${e.message}` }],
					};
				}
			},
		);

		// Send a Lark card message via webhook
		this.server.registerTool(
			"send_lark",
			{
				description: "Send a card message to Lark group via webhook",
				inputSchema: {
					webhook_url: z.string().describe("Lark webhook URL"),
					header_title: z.string().describe("Card header title"),
					header_color: z.enum(["red", "orange", "green", "blue"]).describe("Card header color"),
					content: z.string().describe("Markdown content for the card body"),
					secret: z.string().describe("Relay secret for authentication"),
					webhook_secret: z.string().optional().describe("Lark webhook signing secret (for signature verification)"),
				},
			},
			async ({ webhook_url, header_title, header_color, content, secret, webhook_secret }) => {
				if (secret !== RELAY_SECRET) {
					return {
						content: [{ type: "text", text: "Error: Invalid secret" }],
					};
				}

				try {
					const result = await sendLarkCard({
						webhookUrl: webhook_url,
						headerTitle: header_title,
						headerColor: header_color,
						content,
						webhookSecret: webhook_secret,
					});
					return {
						content: [{ type: "text", text: result.body }],
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Send error: ${e.message}` }],
					};
				}
			},
		);
		// Batch scan Twitter accounts for risk keywords via Jina Reader
		this.server.registerTool(
			"batch_scan_twitter",
			{
				description: "Batch scan Twitter accounts for risk keywords (migration, hack, exploit, delist, etc). Uses Jina Reader (free). Returns ONLY matches. Pass a JSON array of {coin, handle} objects.",
				inputSchema: {
					accounts: z.array(z.object({
						coin: z.string().describe("Coin ticker e.g. KIMA"),
						handle: z.string().describe("Twitter handle without @ e.g. KimaNetwork"),
					})).describe("List of Twitter accounts to scan"),
				},
			},
			async ({ accounts }) => {
				const KEYWORDS = ['migration', 'migrate', 'new contract', 'contract swap', 'token swap',
					'hack', 'exploit', 'pause', 'suspend', 'delist', 'rebrand',
					'bridge clos', 'conversion', 'upgrade to', 'moving to'];

				const matches: string[] = [];
				const failed: string[] = [];
				let scanned = 0;

				for (const { coin, handle } of accounts) {
					let success = false;
					for (let attempt = 0; attempt < 3; attempt++) {
						try {
							const resp = await fetch(`https://r.jina.ai/https://x.com/${handle}`, {
								headers: { "Accept": "text/markdown" },
								signal: AbortSignal.timeout(15000),
							});
							if (!resp.ok) {
								await new Promise(r => setTimeout(r, 2000));
								continue;
							}
							const text = await resp.text();
							if (text.length < 100) {
								await new Promise(r => setTimeout(r, 2000));
								continue;
							}
							const lower = text.toLowerCase();
							const hits = KEYWORDS.filter(kw => lower.includes(kw));
							if (hits.length > 0) {
								// Extract relevant lines
								const lines = text.split('\n');
								const relevant: string[] = [];
								for (let i = 0; i < lines.length; i++) {
									if (KEYWORDS.some(kw => lines[i].toLowerCase().includes(kw))) {
										const s = Math.max(0, i - 1);
										const e = Math.min(lines.length, i + 3);
										for (let j = s; j < e; j++) relevant.push(lines[j]);
									}
								}
								const context = [...new Set(relevant)].slice(0, 15).join('\n');
								matches.push(`MATCH: ${coin} (@${handle})\nKeywords: ${hits.join(', ')}\n${context}\n---`);
							}
							success = true;
							scanned++;
							break;
						} catch {
							await new Promise(r => setTimeout(r, 2000));
						}
					}
					if (!success) failed.push(`${coin}(@${handle})`);
					// Rate limit: 1s between requests
					await new Promise(r => setTimeout(r, 1000));
				}

				const result = [
					`Scanned: ${scanned}/${accounts.length}`,
					matches.length > 0 ? matches.join('\n\n') : 'No matches found.',
					failed.length > 0 ? `Failed (${failed.length}): ${failed.join(', ')}` : '',
				].filter(Boolean).join('\n\n');

				return { content: [{ type: "text", text: result }] };
			},
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return BlackSwanMCP.serve("/mcp").fetch(request, env, ctx);
		}

		if (url.pathname === "/send-lark" && request.method === "POST") {
			try {
				const body: any = await request.json();
				if (body.secret !== RELAY_SECRET) {
					return Response.json({ ok: false, error: "Invalid secret" }, { status: 401 });
				}

				const result = await sendLarkCard({
					webhookUrl: body.webhook_url,
					headerTitle: body.header_title || "加密货币日报",
					headerColor: body.header_color || "blue",
					content: body.content,
					webhookSecret: body.webhook_secret,
				});

				return Response.json({ ok: result.status >= 200 && result.status < 300, status: result.status, body: result.body });
			} catch (e: any) {
				return Response.json({ ok: false, error: e.message }, { status: 500 });
			}
		}

		if (url.pathname === "/crypto-daily-report/run" && request.method === "POST") {
			try {
				const body: any = await request.json().catch(() => ({}));
				if (body.secret !== RELAY_SECRET) {
					return Response.json({ ok: false, error: "Invalid secret" }, { status: 401 });
				}

				const result = await dispatchCryptoDailyWorkflow(env, body.dry_run === true);

				return Response.json(result);
			} catch (e: any) {
				return Response.json({ ok: false, error: e.message }, { status: 500 });
			}
		}

		return new Response("Black Swan MCP Server", { status: 200 });
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(dispatchCryptoDailyWorkflow(env, false));
	},
};
