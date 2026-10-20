#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { parseArgs } from "node:util"
import { z } from "zod"
import { closeChrome, openVisible } from "./chrome"
import { CAPTCHA, search } from "./search"

const SECTIONS = ["layout", "ai_overview", "organic", "people_also_ask", "related_searches", "ads", "other"] as const

const [command] = process.argv.slice(2)

if (command === "search") {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(3),
		allowPositionals: true,
		options: {
			country: { type: "string" },
			language: { type: "string" },
			location: { type: "string" },
			pages: { type: "string" },
			paa: { type: "string" },
			"no-resolve": { type: "boolean" },
			text: { type: "boolean" },
		},
	})
	const result = await search({
		query: positionals.join(" "),
		country: values.country,
		language: values.language,
		location: values.location,
		pages: Number(values.pages ?? 1),
		paaAnswers: Number(values.paa ?? 0),
		resolveUrls: !values["no-resolve"],
		pageText: values.text,
	})
	console.log(JSON.stringify(result, null, 2))
	process.exit(0)
} else if (command === "open") {
	console.log("Chrome is open with the serp-mcp profile. Sign in to Google or solve the CAPTCHA if needed, then close the window.")
	await openVisible()
	process.exit(0)
} else if (command === "stop") {
	console.log((await closeChrome()) ? "Chrome closed." : "Chrome was not running.")
	process.exit(0)
}

const server = new McpServer({ name: "serp-mcp", version: "0.1.0" })

server.registerTool(
	"google_search",
	{
		title: "Google search",
		description:
			"Search Google from a background Chrome on the user's machine and get the results page as JSON: page layout, AI Overview (markdown + sources), organic results (position, title, URL, snippet, date), People Also Ask questions, related searches, ads, and every other block (local pack, videos, discussions, shopping, knowledge panel...) as heading + text + links. Searches run one at a time with a pause of a few seconds between them, so a batch of N queries takes about 5 × N seconds.",
		inputSchema: {
			queries: z.array(z.string().min(1)).min(1).max(20).describe("Search queries, run one after the other"),
			country: z.string().length(2).optional().describe("Country of the results (Google `gl`), ISO code such as fr, us, de. Default us"),
			language: z.string().optional().describe("Interface language (Google `hl`), such as fr, en, de. Default en"),
			location: z
				.string()
				.optional()
				.describe(
					"City-level location as a Google Ads canonical name, e.g. 'Paris,Ile-de-France,France' or 'Austin,Texas,United States'. Without it, local results follow the IP of the machine",
				),
			pages: z.number().int().min(1).max(5).optional().describe("Result pages to read, about 10 organic results each. Default 1"),
			paa_answers: z
				.number()
				.int()
				.min(0)
				.max(10)
				.optional()
				.describe("Open the first N People Also Ask questions to read their answers and sources. Google adds new questions as they open. About 1.5 s each. Default 0"),
			sections: z
				.array(z.enum(SECTIONS))
				.optional()
				.describe("Only return these parts of each results page, to save tokens on large batches. Default all"),
			resolve_urls: z
				.boolean()
				.optional()
				.describe("Google hides most result URLs behind google.com/goto redirects. Resolve them to the real URLs (one light request each). Default true"),
			include_page_text: z
				.boolean()
				.optional()
				.describe("Also return the visible text of the whole results page, a fallback when something is missing from the structured parts. Default false"),
		},
	},
	async (input) => {
		const results = []
		for (const query of input.queries) {
			try {
				const serp = await search({
					query,
					country: input.country,
					language: input.language,
					location: input.location,
					pages: input.pages,
					paaAnswers: input.paa_answers,
					resolveUrls: input.resolve_urls,
					pageText: input.include_page_text,
				})
				const kept = Object.entries(serp).filter(([key, value]) => {
					if (Array.isArray(value) && value.length === 0) return false
					const section = SECTIONS.find((s) => s === key)
					return !section || !input.sections || input.sections.includes(section)
				})
				results.push(Object.fromEntries(kept))
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				results.push({ query, error: message })
				if (message === CAPTCHA) break
			}
		}
		return { content: [{ type: "text" as const, text: JSON.stringify(input.queries.length === 1 ? results[0] : results) }] }
	},
)

// Exit with the client, which also closes the Chrome this process started.
process.stdin.on("close", () => process.exit(0))
await server.connect(new StdioServerTransport())
