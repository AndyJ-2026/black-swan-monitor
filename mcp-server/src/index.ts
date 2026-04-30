import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const RELAY_SECRET = "bsm-9f3a7c";
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
				},
			},
			async ({ webhook_url, header_title, header_color, content, secret }) => {
				if (secret !== RELAY_SECRET) {
					return {
						content: [{ type: "text", text: "Error: Invalid secret" }],
					};
				}

				const card = {
					msg_type: "interactive",
					card: {
						header: {
							title: { tag: "plain_text", content: header_title },
							template: header_color,
						},
						elements: [{ tag: "markdown", content }],
					},
				};

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
		// Scrape a JS-rendered page via Firecrawl (works on x.com/Twitter)
		this.server.registerTool(
			"scrape_page",
			{
				description: "Scrape a JavaScript-rendered page using Firecrawl. Returns clean markdown content. Works on Twitter/X pages.",
				inputSchema: {
					url: z.string().describe("The URL to scrape"),
				},
			},
			async ({ url }) => {
				try {
					const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
						},
						body: JSON.stringify({
							url,
							formats: ["markdown"],
							waitFor: 3000,
						}),
					});
					const data = await resp.json() as any;
					if (!data.success) {
						return {
							content: [{ type: "text", text: `Scrape failed: ${data.error || "unknown error"}` }],
						};
					}
					const md = data.data?.markdown || "";
					const truncated = md.length > 30000 ? md.slice(0, 30000) + "\n...[truncated]" : md;
					return {
						content: [{ type: "text", text: truncated }],
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Scrape error: ${e.message}` }],
					};
				}
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
