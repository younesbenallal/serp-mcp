import type { Page } from "playwright-core"
import { setTimeout as sleep } from "node:timers/promises"
import { browser, exclusive, touch } from "./chrome"
import { extractSerp } from "./extract"

export type SearchOptions = {
	query: string
	country?: string
	language?: string
	location?: string
	pages?: number
	paaAnswers?: number
	resolveUrls?: boolean
	pageText?: boolean
}

export const CAPTCHA =
	"Google answered with a CAPTCHA. Run `bun run open` in the serp-mcp folder, solve it in the window that opens, close the window, then retry."

// Google's "uule" parameter takes a canonical location name from Google Ads geotargets, e.g. "Paris,Ile-de-France,France".
const KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const uule = (name: string) => `w+CAIQICI${KEY[Buffer.byteLength(name) % 64]}${Buffer.from(name).toString("base64")}`

function searchUrl(o: SearchOptions, start: number) {
	const url = new URL("https://www.google.com/search")
	url.searchParams.set("q", o.query)
	url.searchParams.set("hl", o.language ?? "en")
	url.searchParams.set("gl", o.country ?? "us")
	if (start) url.searchParams.set("start", String(start))
	// Appended raw: Google expects the "+" of this parameter unescaped.
	return o.location ? `${url.href}&uule=${uule(o.location)}` : url.href
}

async function rejectCookies(page: Page) {
	const buttons = page.locator("form button, [role=button]")
	const reject = buttons.filter({ hasText: /reject all|tout refuser|alle ablehnen|rechazar todo|rifiuta tutto|alles afwijzen|rejeitar tudo/i })
	await (await reject.count() ? reject : buttons).first().click()
	await page.waitForURL(/google\.[a-z.]+\/search/, { timeout: 15_000 })
}

async function load(page: Page, url: string) {
	await page.goto(url, { waitUntil: "domcontentloaded" })
	if (page.url().includes("consent.google.")) await rejectCookies(page)
	if (page.url().includes("/sorry/")) throw new Error(CAPTCHA)
	await page.waitForSelector("#search, #botstuff", { state: "attached", timeout: 15_000 })
	// The AI Overview streams in after the results: wait until its text stops growing.
	let last = -1
	for (let stable = 0, waited = 0; stable < 3 && waited < 8000; waited += 300) {
		await sleep(300)
		const length = await page.evaluate(() => document.querySelector("[id=m-x-content]")?.textContent?.length ?? 0)
		if (length === 0 && waited >= 1500) break
		stable = length === last ? stable + 1 : 0
		last = length
	}
}

// Opens the first People Also Ask questions one by one. Google appends new questions below as they open.
async function expandQuestions(page: Page, count: number) {
	const questions = page.locator(".related-question-pair[data-q]")
	for (let i = 0; i < Math.min(count, await questions.count()); i++) {
		const toggle = questions.nth(i).locator("[aria-expanded=false]").first()
		if (!(await toggle.isVisible())) continue
		await toggle.click()
		await page.waitForTimeout(1200 + Math.random() * 600)
	}
}

// Google hides result URLs behind /goto redirects. Each one answers a 302 to the real URL, read without following it.
async function resolveUrls<T>(page: Page, data: T): Promise<T> {
	const json = JSON.stringify(data)
	const links = [...new Set(json.match(/https:\/\/www\.google\.com\/goto\?url=[^"]+/g) ?? [])]
	const real = new Map<string, string>()
	for (let i = 0; i < links.length; i += 4) {
		await Promise.all(
			links.slice(i, i + 4).map(async (link) => {
				const response = await page.request.get(link, { maxRedirects: 0 }).catch(() => null)
				const location = response?.headers()["location"]
				if (location?.startsWith("http")) real.set(link, location)
			}),
		)
	}
	return JSON.parse(json.replace(/https:\/\/www\.google\.com\/goto\?url=[^"]+/g, (link) => real.get(link) ?? link))
}

export function search(o: SearchOptions) {
	return exclusive(async () => {
		touch()
		const page = await (await browser()).contexts()[0]!.newPage()
		try {
			const url = searchUrl(o, 0)
			await load(page, url)
			if (o.paaAnswers) await expandQuestions(page, o.paaAnswers)
			const serp = await page.evaluate(extractSerp)
			const pageText = o.pageText ? await page.locator("#rcnt").innerText() : undefined
			for (let p = 1; p < (o.pages ?? 1); p++) {
				await sleep(1500 + Math.random() * 1500)
				await load(page, searchUrl(o, p * 10))
				const { organic } = await page.evaluate(extractSerp)
				serp.organic.push(...organic.map((r) => ({ ...r, position: serp.organic.length + r.position })))
			}
			const result = { query: o.query, country: o.country ?? "us", language: o.language ?? "en", location: o.location, url, ...serp, page_text: pageText }
			return o.resolveUrls === false ? result : await resolveUrls(page, result)
		} finally {
			await page.close().catch(() => {})
			touch()
		}
	})
}
