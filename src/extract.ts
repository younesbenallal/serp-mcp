// Runs inside the Google results page (Playwright serializes it): no imports, no helpers from outside.
// Google's class names are obfuscated and change often, so it relies on ids, semantic classes and page structure.
// A block it does not recognize comes back as { heading, text, links } instead of being dropped.
export function extractSerp() {
	const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()
	const textOf = (el: Element) => (el as HTMLElement).innerText ?? ""
	const lines = (el: Element) => textOf(el).split("\n").map(clean).filter(Boolean)
	// checkVisibility() reports display:contents wrappers as hidden, though their children render.
	const shown = (el: Element): boolean => (getComputedStyle(el).display === "contents" ? !el.parentElement || shown(el.parentElement) : el.checkVisibility())
	const visible = (el: Element) => shown(el) && clean(textOf(el)) !== ""
	const before = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING

	// Result links, either direct or behind Google's /goto redirect. Google's own pages are left out.
	const outbound = (a: HTMLAnchorElement) => {
		if (!a.href.startsWith("http")) return null
		const url = new URL(a.href)
		if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname !== "/goto") return null
		return a.href
	}
	const linksIn = (el: Element, max = 20) => {
		const seen = new Map<string, string>()
		for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
			// Video key moments repeat their video's link with a timestamp.
			const url = outbound(a)?.replace(/[&?]t=\d+s?$/, "")
			const title = clean(a.getAttribute("aria-label") || (shown(a) ? textOf(a) : "")).slice(0, 150)
			if (url && (!seen.has(url) || !seen.get(url)) && (seen.size < max || seen.has(url))) seen.set(url, title)
		}
		return [...seen].map(([url, title]) => ({ title: title || undefined, url }))
	}

	// AI Overview text as light markdown: headings, bullets and bold kept, citation chips and source cards left out.
	const markdown = (root: Element) => {
		let out = ""
		const walk = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) out += node.textContent
			if (!(node instanceof HTMLElement) || !shown(node)) return
			if (node.matches("style, script, svg, img, button, [role=button], [data-src-id], [role=heading][aria-level='2']")) return
			const display = getComputedStyle(node).display
			const block = !display.startsWith("inline") && display !== "contents"
			const heading = /^H[1-6]$/.test(node.tagName) || node.getAttribute("role") === "heading"
			const bold = node.matches("strong, b")
			out += node.tagName === "LI" ? "\n- " : heading ? "\n### " : block ? "\n" : bold ? "**" : ""
			node.childNodes.forEach(walk)
			out += bold ? "**" : block ? "\n" : ""
		}
		walk(root)
		return out
			.split("\n")
			.map((l) => l.replace(/\s+/g, " ").replace(/\*\*\s*\*\*/g, "").trim())
			.filter((l) => l && l !== "-" && l !== "###")
			.join("\n")
	}

	const aiBox = [...document.querySelectorAll("[id=m-x-content]")].find((e) => !e.closest(".related-question-pair"))
	const aiBlock = aiBox?.parentElement?.closest("[data-hveid]") ?? aiBox
	const questions = [...document.querySelectorAll<HTMLElement>(".related-question-pair[data-q]")].filter(
		(e) => !e.parentElement?.closest(".related-question-pair, [id=m-x-content]") && shown(e),
	)
	const related = document.querySelector("#bres")
	const adBlocks = [...document.querySelectorAll("[data-text-ad]")].filter(visible)
	const typed = (el: Element) => [aiBlock, related, ...adBlocks, ...questions].some((t) => t && (t.contains(el) || el.contains(t)))

	// Organic results: a title link holding an h3 and the displayed URL.
	const isOrganic = (a: Element) => !a.closest(".related-question-pair") && !aiBlock?.contains(a) && !a.closest("#tads, #bottomads")
	const organicIn = (el: Element) => [...el.querySelectorAll("a:has(h3):has(cite)")].filter(isOrganic)
	const rso = document.querySelector("#rso") ?? document.querySelector("#search")
	const organicLinks = rso ? organicIn(rso) : []
	const organic = organicLinks.map((a, i) => {
		// The result block: the largest ancestor that holds this result only.
		let block: Element = a
		while (block.parentElement && block.parentElement !== rso && organicIn(block.parentElement).length === 1) block = block.parentElement
		const title = clean(textOf(a.querySelector("h3")!))
		const displayed = clean(textOf(a.querySelector("cite")!))
		const site = lines(a).find((l) => l !== title && !l.startsWith(displayed.slice(0, 12)))
		const others = [...block.querySelectorAll("a")].filter((x) => x !== a)
		const skip = new Set([a, ...others, ...block.querySelectorAll("h2, [role=heading]")].flatMap(lines))
		let snippet = lines(block)
			.filter((l) => !skip.has(l))
			.join(" ")
		const date = snippet.match(/^(.{4,25}?) — /)?.[1]
		if (date) snippet = snippet.slice(date.length + 3)
		const sitelinks = others.filter((x) => outbound(x as HTMLAnchorElement) && shown(x)).map((x) => clean(textOf(x))).filter(Boolean)
		return { position: i + 1, title, url: (a as HTMLAnchorElement).href, displayed_url: displayed, site, date, snippet, sitelinks: sitelinks.length ? sitelinks : undefined, el: block }
	})

	// Every other visible block of the results column and the right-hand panel.
	const others: Element[] = []
	const walk = (el: Element) => {
		for (const kid of el.children) {
			if (!visible(kid)) continue
			const count = organicIn(kid).length
			if (count >= 2) walk(kid)
			else if (count === 0 && !typed(kid)) others.push(kid)
		}
	}
	for (const zone of document.querySelectorAll("#rso, #botstuff, #rhs")) walk(zone)
	const other = others.map((el) => ({
		heading: clean(textOf(el.querySelector("h2, [role=heading]") ?? el).split("\n")[0]).slice(0, 100),
		text: lines(el).join("\n").slice(0, 1500),
		links: linksIn(el, 15).filter((l) => l.title),
		el,
	}))

	const ads = adBlocks.map((ad) => {
		const a = ad.querySelector<HTMLAnchorElement>("a[href]")
		return {
			placement: ad.closest("#tads") ? "top" : ad.closest("#bottomads") ? "bottom" : "middle",
			title: clean(textOf(ad.querySelector("[role=heading]") ?? ad).split("\n")[0]),
			url: a?.dataset.pcu?.split(",")[0] || a?.href,
			text: lines(ad).slice(1).join(" ").slice(0, 400),
			el: ad,
		}
	})

	const ai_overview = aiBox && {
		text: markdown(aiBox),
		sources: linksIn(aiBlock!, 30).filter((l) => !/google\.com\/(?!goto)/.test(l.url)),
	}

	// Page order of the blocks, organic runs collapsed: "organic 1-3", "people_also_ask", ...
	const placed = [
		...ads.map((ad) => ({ el: ad.el, name: `ads_${ad.placement}` })),
		...(aiBlock ? [{ el: aiBlock, name: "ai_overview" }] : []),
		...(questions[0] ? [{ el: questions[0], name: "people_also_ask" }] : []),
		...(related && visible(related) ? [{ el: related, name: "related_searches" }] : []),
		...organic.map((o) => ({ el: o.el, name: `organic ${o.position}` })),
		...other.map((o) => ({ el: o.el, name: `other: ${o.heading}` })),
	].sort((a, b) => (before(a.el, b.el) ? -1 : 1))
	const layout: string[] = []
	for (const { name } of placed) {
		const run = layout.at(-1)?.match(/^organic (\d+)(?:-(\d+))?$/)
		const pos = name.match(/^organic (\d+)$/)?.[1]
		if (run && pos && Number(pos) === Number(run[2] ?? run[1]) + 1) layout[layout.length - 1] = `organic ${run[1]}-${pos}`
		else if (layout.at(-1) !== name) layout.push(name)
	}

	return {
		layout,
		ai_overview,
		organic: organic.map(({ el, ...o }) => o),
		// Expanded questions (see search.ts) hold an answer, now mostly AI-written, and its sources.
		people_also_ask: questions.map((q) =>
			q.querySelector("[aria-expanded=true]") ? { question: q.dataset.q!, answer: markdown(q), sources: linksIn(q, 10) } : { question: q.dataset.q! },
		),
		related_searches: related ? [...new Set([...related.querySelectorAll<HTMLAnchorElement>("a[href*='/search']")].filter(shown).map((a) => clean(textOf(a))).filter(Boolean))] : [],
		ads: ads.map(({ el, ...ad }) => ad),
		other: other.map(({ el, ...o }) => o),
	}
}
