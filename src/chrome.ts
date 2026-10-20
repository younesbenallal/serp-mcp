// The background Chrome: a dedicated profile running headless, shared by every server process on the machine.
import { chromium, type Browser } from "playwright-core"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const HOME = process.env.SERP_MCP_HOME ?? join(homedir(), ".serp-mcp")
const PROFILE = join(HOME, "chrome-profile")
const PORT = Number(process.env.SERP_MCP_PORT ?? 9555)
const ENDPOINT = `http://127.0.0.1:${PORT}`
const IDLE_CLOSE = 10 * 60_000

const CHROME_PATHS: Record<string, string[]> = {
	darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
	linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
	win32: [
		`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
		`${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
		`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
	],
}

function chromePath() {
	const found = process.env.CHROME_PATH ?? CHROME_PATHS[platform()]?.find((p) => existsSync(p))
	if (!found) throw new Error("Google Chrome not found. Set CHROME_PATH to the Chrome executable.")
	return found
}

// Headless Chrome says "HeadlessChrome" in its user agent, and Google answers that with a CAPTCHA.
function userAgent(chrome: string) {
	const major = spawnSync(chrome, ["--version"]).stdout?.toString().match(/(\d+)\./)?.[1] ?? "140"
	const os = { darwin: "Macintosh; Intel Mac OS X 10_15_7", win32: "Windows NT 10.0; Win64; x64" }[platform() as string] ?? "X11; Linux x86_64"
	return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

let child: ChildProcess | undefined
let connecting: Promise<Browser> | undefined
let idle: ReturnType<typeof setTimeout> | undefined

function launch(headless: boolean, url?: string) {
	const chrome = chromePath()
	mkdirSync(PROFILE, { recursive: true })
	const args = [
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${PROFILE}`,
		"--no-first-run",
		"--no-default-browser-check",
		// Same cookie encryption in headless and visible mode, and no keychain prompt.
		"--use-mock-keychain",
		"--password-store=basic",
		"--window-size=1440,900",
		`--user-agent=${userAgent(chrome)}`,
		...(headless ? ["--headless"] : []),
		...(url ? [url] : []),
	]
	return spawn(chrome, args, { stdio: "ignore" })
}

async function connect() {
	const existing = await chromium.connectOverCDP(ENDPOINT).catch(() => null)
	if (existing) return existing
	child = launch(true)
	for (let i = 0; i < 60; i++) {
		await sleep(250)
		const browser = await chromium.connectOverCDP(ENDPOINT).catch(() => null)
		if (browser) return browser
	}
	throw new Error(`Chrome did not open its debugging port ${PORT}.`)
}

export function browser() {
	connecting ??= connect().then(
		(b) => {
			b.on("disconnected", () => (connecting = undefined))
			return b
		},
		(error) => {
			connecting = undefined
			throw error
		},
	)
	return connecting
}

// A Chrome this process started closes after a while without searches, and when the process exits.
export function touch() {
	clearTimeout(idle)
	idle = setTimeout(() => child?.kill(), IDLE_CLOSE).unref()
}
process.on("exit", () => child?.kill())
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0))

export async function closeChrome() {
	const running = await chromium.connectOverCDP(ENDPOINT).catch(() => null)
	if (!running) return false
	const cdp = await running.newBrowserCDPSession()
	await cdp.send("Browser.close").catch(() => {})
	await sleep(500)
	return true
}

// Opens the same profile in a visible window, to solve a CAPTCHA or answer the cookie banner once.
export async function openVisible() {
	await closeChrome()
	const visible = launch(false, "https://www.google.com/search?q=google")
	await new Promise((resolve) => visible.on("exit", resolve))
}

// One search at a time on the machine, with a pause between searches, whatever the number of server processes.
const LOCK = join(HOME, "search.lock")
const LAST = join(HOME, "last-search")

export async function exclusive<T>(fn: () => Promise<T>) {
	mkdirSync(HOME, { recursive: true })
	for (;;) {
		try {
			writeFileSync(LOCK, String(process.pid), { flag: "wx" })
			break
		} catch {
			const age = Date.now() - (statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
			if (age > 120_000) rmSync(LOCK, { force: true })
			else await sleep(300)
		}
	}
	try {
		const last = statSync(LAST, { throwIfNoEntry: false })?.mtimeMs ?? 0
		await sleep(Math.max(0, last + 2000 + Math.random() * 2000 - Date.now()))
		return await fn()
	} finally {
		if (existsSync(LAST)) utimesSync(LAST, new Date(), new Date())
		else writeFileSync(LAST, "")
		rmSync(LOCK, { force: true })
	}
}
