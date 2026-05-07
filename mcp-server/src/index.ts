import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const RELAY_SECRET = "bsm-9f3a7c";

// Lark webhook signing secrets (webhook_url suffix → secret)
const WEBHOOK_SECRETS: Record<string, string> = {
	"cd9e30ce-42bb-4eed-8724-cdb233db49e8": "35sHqGGvABJIzv36bkoKD",
};
const FIRECRAWL_API_KEY = "fc-933c9b80dfbd4675ad15f2602646bff6";

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
					headers: z.record(z.string()).optional().describe("Optional HTTP headers"),
					body: z.string().optional().describe("Optional request body for POST"),
				},
			},
			async ({ url, method, headers, body }) => {
				try {
					const resp = await fetch(url, {
						method,
						headers: headers || {},
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

				const card: Record<string, any> = {
					msg_type: "interactive",
					card: {
						header: {
							title: { tag: "plain_text", content: header_title },
							template: header_color,
						},
						elements: [{ tag: "markdown", content }],
					},
				};

				// Determine webhook signing secret: explicit param > lookup by URL
				const urlId = webhook_url.split("/").pop() || "";
				const signingSecret = webhook_secret || WEBHOOK_SECRETS[urlId];

				// Add Lark webhook signature if signing secret is available
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
					const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
					card.timestamp = timestamp;
					card.sign = sign;
				}

				try {
					const resp = await fetch(webhook_url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(card),
					});
					const result = await resp.text();
					return {
						content: [{ type: "text", text: result }],
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
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return BlackSwanMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Black Swan MCP Server", { status: 200 });
	},
};
