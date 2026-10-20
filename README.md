# serp-mcp

An MCP server that lets an AI read Google results pages through a Chrome running in the background on your own machine. No SERP API, no proxy, no cost per query. The results are the ones a real person gets from your connection, returned as JSON.

## Why

SERP APIs charge per query, and Google now serves scraper traffic shuffled or degraded results. A real Chrome on a residential connection gets the real page. serp-mcp drives one headless Chrome with its own profile, so nothing shows on screen: no window, no Dock icon, no focus change, and your own browser and Google account stay untouched.

## What you get

One tool, `google_search`, returns for each query:

- `layout`: the blocks in page order, for example `["ads_top", "ai_overview", "organic 1-2", "people_also_ask", "organic 3-6", "other: Videos", "related_searches"]`
- `ai_overview`: the AI Overview as markdown, with its sources
- `organic`: position, title, URL, displayed URL, site name, date, snippet, sitelinks
- `people_also_ask`: the questions, and with `paa_answers` their answers and sources
- `related_searches`
- `ads`: top, middle and bottom text ads
- `other`: every block the parser has no dedicated shape for (local pack, videos, discussions, images, shopping, knowledge panel...), as `{ heading, text, links }`, so nothing on the page is dropped

A results page weighs about 2 MB of HTML. The JSON is usually 10 to 25 KB.

```json
{
  "query": "logiciel de facturation",
  "layout": ["ai_overview", "organic 1", "people_also_ask", "organic 2-6", "other: Vidéos", "organic 7", "ads_bottom", "related_searches"],
  "ai_overview": { "text": "Choisir un **logiciel de facturation** en 2026 dépend...", "sources": [{ "title": "Indy", "url": "https://www.indy.fr/guide/..." }] },
  "organic": [
    {
      "position": 1,
      "title": "Le comparatif 2026 des meilleurs logiciels de facturation",
      "url": "https://www.indy.fr/guide/facturation/logiciel/comparatif-logiciel-facturation/",
      "displayed_url": "https://www.indy.fr › guide › facturation › logiciel › co...",
      "site": "Indy",
      "snippet": "Parmi les meilleurs logiciels de facturation gratuits..."
    }
  ],
  "people_also_ask": [{ "question": "Est-il obligatoire d'avoir un logiciel de facturation ?" }],
  "related_searches": ["Logiciel de facturation gratuit à télécharger", "..."]
}
```

### Parameters

| Parameter | Default | |
| --- | --- | --- |
| `queries` | | 1 to 20 queries, run one after the other |
| `country` | `us` | Google `gl` |
| `language` | `en` | Google `hl` |
| `location` | IP location | City-level location as a [Google Ads canonical name](https://developers.google.com/google-ads/api/data/geotargets), e.g. `Paris,Ile-de-France,France` |
| `pages` | 1 | Result pages to read (1 to 5), about 10 organic results each |
| `paa_answers` | 0 | Open the first N People Also Ask questions to get answers and sources |
| `sections` | all | Return only some parts, e.g. `["organic"]` for rank checks on large batches |
| `resolve_urls` | `true` | Google hides most result URLs behind `google.com/goto` redirects. Each one is resolved with one light request that reads the redirect without loading the target page |
| `include_page_text` | `false` | Add the visible text of the whole page, as a fallback |

## Install

Requires [Bun](https://bun.sh) and Google Chrome.

```bash
git clone https://github.com/younesbenallal/serp-mcp
cd serp-mcp
bun install
```

Add it to Claude Code:

```bash
claude mcp add --scope user serp-mcp -- bun run /absolute/path/to/serp-mcp/src/index.ts
```

Or to any MCP client config:

```json
{
  "mcpServers": {
    "serp-mcp": { "command": "bun", "args": ["run", "/absolute/path/to/serp-mcp/src/index.ts"] }
  }
}
```

Try it from the terminal:

```bash
bun run search "best crm for startups" --country us --language en --pages 2 --paa 2
```

## How it works

- On the first search, the server starts Chrome headless with a dedicated profile in `~/.serp-mcp/chrome-profile` and a debugging port (9555), then drives it with Playwright over CDP. Later searches reuse it: a search takes 3 to 5 seconds.
- Every server process on the machine shares that Chrome. A lock file makes searches run one at a time, with a random pause of 2 to 4 seconds between them, so Google sees one person searching.
- The Chrome closes after 10 minutes without searches, or when the server that started it exits.
- Headless Chrome announces itself in its user agent, which Google answers with a CAPTCHA. serp-mcp sends the normal Chrome user agent instead.
- The parser runs inside the page. Google's class names are obfuscated and change often, so it relies on ids, accessibility attributes and the few semantic class names Google keeps (`related-question-pair`, `#m-x-content`, `data-text-ad`).

## CAPTCHA and cookie banner

If Google shows a CAPTCHA, the tool returns an error that says so. Open the profile in a visible window, solve it, and close the window:

```bash
bun run open
```

The cookie banner shown in Europe is refused automatically. `bun run stop` closes the background Chrome.

## Settings

Environment variables, all optional:

- `CHROME_PATH`: the Chrome executable, when it is not in the usual place
- `SERP_MCP_HOME`: where the profile and lock live (default `~/.serp-mcp`)
- `SERP_MCP_PORT`: Chrome's debugging port (default 9555)

## Limits

- Desktop results only.
- The local pack, videos, discussions and shopping blocks come back as generic `{ heading, text, links }` blocks.
- Google changes its markup. When a part goes missing, `include_page_text` still returns everything visible, and `src/extract.ts` is the only file to fix.
- Results follow the machine's connection. A VPN or a `location` changes them.

## About

Built by Younès Benallal at [Holly&Stick](https://www.holly-and-stick.com/), an SEO partner for early-stage B2B SaaS.

## License

MIT
