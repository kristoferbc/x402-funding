/**
 * Pages publiques du service : accueil, llms.txt, robots.txt, sitemap.xml.
 *
 * Module separe et sans dependance. Il ne connait ni le facilitateur, ni les
 * capteurs : on lui passe les quelques valeurs d'affichage et il rend du texte.
 * Une erreur ici ne peut donc pas atteindre /funding ni /ultra, qui n'importent
 * jamais ce fichier.
 */

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** "0.02" -> "0.02" ; "$0.02" -> "0.02" */
const barePrice = (p) => String(p).replace(/^\$/, "");

export function renderHome({ baseUrl, price, ultraPrice, network, payTo }) {
  const fundingPrice = barePrice(price);
  const ultra = barePrice(ultraPrice);
  const isMainnet = network === "eip155:8453";
  const networkLabel = isMainnet ? "Base mainnet" : network;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "x402 Funding Divergence",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    description:
      "Perpetual funding-rate divergence between Hyperliquid and a liquid CEX benchmark (Binance, or OKX where Binance restricts the region), annualised with each venue's real funding interval, liquidity-filtered on both legs, with the direction of the basis trade resolved.",
    url: `${baseUrl}/`,
    sameAs: [
      "https://github.com/kristoferbc/x402-funding",
      "https://www.npmjs.com/package/x402-funding-divergence",
    ],
    offers: [
      {
        "@type": "Offer",
        name: "Funding divergence",
        price: fundingPrice,
        priceCurrency: "USD",
        description: "Ranked divergence for every tradable pair, plus the anomaly flag and the benchmark venue used.",
        url: `${baseUrl}/funding`,
      },
      {
        "@type": "Offer",
        name: "Funding divergence with execution capacity",
        price: ultra,
        priceCurrency: "USD",
        description: "Adds the largest notional executable on both legs before combined market impact exceeds a stated budget.",
        url: `${baseUrl}/ultra`,
      },
    ],
  };

  const responseExample = `{
  "updated_at": "2026-11-02T02:00:00.000Z",
  "benchmark": { "venue": "okx", "funding_interval": 8, "fallbacks": ["binance"] },
  "methodology": "...",
  "anomaly_threshold_bps": 500,
  "pairs_compared": 46,
  "pairs_tradable": 29,
  "pairs_flagged_anomaly": 2,
  "top": [
    {
      "coin": "ZRO",
      "hl_apr_pct": 10.95,
      "cex_apr_pct": -3.40,
      "divergence_bps": 1423.3,
      "hl_interval_hours": 1,
      "cex_interval_hours": 8,
      "anomaly": false,
      "trade": "short_hyperliquid_long_okx"
    }
  ]
}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 Funding Divergence — perpetual funding rates, payable per call</title>
<meta name="description" content="Perpetual funding-rate divergence between Hyperliquid and Binance or OKX, annualised with each venue's real funding interval. Pay per call in USDC on Base over x402. No account, no API key.">
<link rel="canonical" href="${baseUrl}/">
<link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable summary">
<meta property="og:type" content="website">
<meta property="og:title" content="x402 Funding Divergence">
<meta property="og:description" content="Perpetual funding-rate divergence between Hyperliquid and a CEX benchmark. Pay per call in USDC on Base over x402.">
<meta property="og:url" content="${baseUrl}/">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  :root {
    --bg: #0a0b0d;
    --panel: #111318;
    --line: #22262e;
    --text: #e7e9ee;
    --muted: #9aa1ad;
    --accent: #7dd3fc;
    --good: #4ade80;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 940px; margin: 0 auto; padding: 0 24px; }
  header { border-bottom: 1px solid var(--line); }
  header .wrap { display: flex; align-items: center; justify-content: space-between; height: 64px; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -0.01em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); box-shadow: 0 0 12px var(--good); }
  nav { display: flex; gap: 20px; font-size: 14px; color: var(--muted); }
  nav a { color: var(--muted); }
  h1 { font-size: 40px; line-height: 1.15; letter-spacing: -0.03em; margin: 64px 0 16px; }
  .lede { font-size: 18px; color: var(--muted); max-width: 660px; margin: 0 0 12px; }
  .status { font-family: var(--mono); font-size: 13px; color: var(--muted); margin: 20px 0 0; }
  .status b { color: var(--text); font-weight: 500; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); font-weight: 600; margin: 64px 0 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; display: flex; flex-direction: column; }
  .card .route { font-family: var(--mono); font-size: 14px; color: var(--accent); }
  .card .price { font-size: 32px; font-weight: 600; letter-spacing: -0.02em; margin: 8px 0 2px; }
  .card .price span { font-size: 14px; font-weight: 400; color: var(--muted); letter-spacing: 0; }
  .card p { color: var(--muted); font-size: 14px; margin: 12px 0 16px; }
  .card ul { margin: 0; padding-left: 18px; color: var(--text); font-size: 14px; }
  .card li { margin: 6px 0; }
  .card li::marker { color: var(--accent); }
  .free { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
  .free div { font-family: var(--mono); font-size: 13px; color: var(--muted); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
  .free b { color: var(--text); font-weight: 500; }
  pre { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; overflow-x: auto; font-family: var(--mono); font-size: 13px; line-height: 1.7; margin: 0; }
  .step { display: grid; grid-template-columns: 28px 1fr; gap: 16px; margin: 0 0 20px; }
  .step .n { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--line); display: grid; place-items: center; font-size: 13px; color: var(--muted); font-family: var(--mono); }
  .step h3 { margin: 2px 0 6px; font-size: 15px; font-weight: 600; }
  .step p { margin: 0; color: var(--muted); font-size: 14px; }
  code { font-family: var(--mono); font-size: 13px; background: #1a1d24; padding: 2px 6px; border-radius: 5px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .cols ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
  .cols li { margin: 8px 0; }
  .cols li::marker { color: var(--accent); }
  .cols li b { color: var(--text); font-weight: 500; }
  footer { border-top: 1px solid var(--line); margin-top: 80px; padding: 32px 0 64px; color: var(--muted); font-size: 13px; }
  footer p { margin: 0 0 8px; }
  .warn { border-left: 2px solid var(--accent); padding-left: 14px; color: var(--muted); font-size: 14px; }
  @media (max-width: 760px) {
    h1 { font-size: 30px; margin-top: 40px; }
    .grid, .cols { grid-template-columns: 1fr; }
    nav { display: none; }
  }
</style>
</head>
<body>

<header>
  <div class="wrap">
    <div class="brand"><span class="dot"></span> x402 Funding Divergence</div>
    <nav>
      <a href="#pricing">Pricing</a>
      <a href="#quickstart">Quickstart</a>
      <a href="#method">Method</a>
      <a href="https://github.com/kristoferbc/x402-funding">GitHub</a>
    </nav>
  </div>
</header>

<main class="wrap">

  <h1>Perpetual funding divergence,<br>payable per call.</h1>
  <p class="lede">
    Hyperliquid against a liquid CEX benchmark — Binance, or OKX where Binance restricts the region.
    Every rate is annualised using the interval that venue actually pays on, not an assumed one.
    Both legs are liquidity-filtered, and the basis trade comes out already resolved.
  </p>
  <p class="status">
    <b>${esc(networkLabel)}</b> &middot; USDC over x402 &middot; no account &middot; no API key &middot; no subscription
  </p>

  <h2 id="pricing">Pricing</h2>
  <div class="grid">
    <div class="card">
      <div class="route">GET /funding</div>
      <div class="price">$${fundingPrice} <span>per call</span></div>
      <p>One ranked response, ready to act on.</p>
      <ul>
        <li>Every tradable pair, sorted by absolute divergence</li>
        <li>Anomalies flagged, never silently ranked first</li>
        <li>The benchmark venue actually used, disclosed in the payload</li>
        <li>Direction of the basis trade, not just the rate gap</li>
      </ul>
    </div>
    <div class="card">
      <div class="route">GET /ultra</div>
      <div class="price">$${ultra} <span>per call</span></div>
      <p>Same divergence, sized for execution.</p>
      <ul>
        <li>Largest notional executable on both legs at once</li>
        <li>Order-book depth behind that number</li>
        <li>Combined market impact against your bps budget</li>
        <li>Carry per day and breakeven days after entry cost</li>
      </ul>
    </div>
  </div>

  <div class="free">
    <div><b>GET /health</b> &nbsp;free &mdash; status and facilitator</div>
    <div><b>GET /sources</b> &nbsp;free &mdash; which venues answer from this host</div>
  </div>

  <h2 id="quickstart">Quickstart</h2>

  <div class="step">
    <div class="n">1</div>
    <div>
      <h3>Call the route without payment</h3>
      <p>You get <code>402</code> and a <code>payment-required</code> header: base64 JSON with the amount in atomic units, the asset, the network and the address to pay.</p>
    </div>
  </div>

<pre>curl -i ${baseUrl}/funding?limit=3</pre>

  <div class="step">
    <div class="n">2</div>
    <div>
      <h3>Sign an EIP-3009 authorization</h3>
      <p>Your x402 client signs <code>transferWithAuthorization</code> for the exact amount. It costs a signature, not a transaction: the facilitator submits it.</p>
    </div>
  </div>

  <div class="step">
    <div class="n">3</div>
    <div>
      <h3>Retry with the signature</h3>
      <p>Same request, plus <code>PAYMENT-SIGNATURE</code>. The response comes back <code>200</code> with a <code>payment-response</code> header carrying the settlement transaction hash.</p>
    </div>
  </div>

<pre>curl -i ${baseUrl}/funding?limit=3 \\
  -H "PAYMENT-SIGNATURE: &lt;base64 payload&gt;"</pre>

  <div class="step">
    <div class="n">4</div>
    <div>
      <h3>If we fail, you are not charged</h3>
      <p>An upstream failure returns <code>502</code> before settlement, and the facilitator cancels the payment. A charge only settles against a <code>200</code>.</p>
    </div>
  </div>

  <h2>Response</h2>
<pre>${esc(responseExample)}</pre>

  <h2 id="method">Method</h2>
  <div class="cols">
    <ul>
      <li><b>Interval from the venue.</b> Hyperliquid pays hourly, many CEX pairs every 8 hours. Annualising both at 8 h would be wrong by a factor of 8, so the interval is read, never assumed.</li>
      <li><b>Liquidity floor on both legs.</b> A pair is compared only if it clears a minimum on Hyperliquid <em>and</em> on the benchmark. Illiquid pairs are counted, not hidden.</li>
      <li><b>Anomaly threshold.</b> Implausible divergences are flagged and pushed to the end of the ranking instead of topping it.</li>
    </ul>
    <ul>
      <li><b>Benchmark disclosed.</b> <code>benchmark.venue</code> tells you which venue was actually used, and <code>fallbacks</code> lists the rest in order.</li>
      <li><b>Measured, or absent.</b> Capacity is either measured from public order books or marked unavailable. It is never estimated to fill a slot.</li>
      <li><b>No advice.</b> Measurements from public data. No recommendation, no position sizing, no investment advice.</li>
    </ul>
  </div>

  <h2>Use it from an MCP client</h2>
<pre>{
  "mcpServers": {
    "x402-funding": {
      "command": "npx",
      "args": ["-y", "x402-funding-divergence"]
    }
  }
}</pre>
  <p class="warn" style="margin-top:20px">
    The MCP tool is free and local: it calls the same venues from your machine.
    The routes above are the paid, hosted equivalent — same maths, no infrastructure to run.
  </p>

</main>

<footer>
  <div class="wrap">
    <p><b>x402 Funding Divergence</b> &mdash; <a href="https://github.com/kristoferbc/x402-funding">GitHub</a> &middot; <a href="https://www.npmjs.com/package/x402-funding-divergence">npm</a> &middot; <a href="/llms.txt">llms.txt</a> &middot; <a href="/health">status</a></p>
    <p>Measurements computed from public venue data. No recommendation, no position sizing, no investment advice.</p>
    <p>Payments settle in USDC on ${esc(networkLabel)}. Merchant address <code>${esc(payTo)}</code>.</p>
  </div>
</footer>

</body>
</html>
`;
}

export function renderLlmsTxt({ baseUrl, price, ultraPrice }) {
  const fundingPrice = barePrice(price);
  const ultra = barePrice(ultraPrice);

  return `# x402 Funding Divergence

> Perpetual funding-rate divergence between Hyperliquid and a liquid CEX benchmark (Binance, or OKX where Binance restricts the region), annualised with each venue's real funding interval, liquidity-filtered on both legs, with the direction of the basis trade resolved. Paid per call over x402 in USDC on Base.

## Endpoints

- \`GET /funding\` — $${fundingPrice} per call. Query: \`limit\` (1-50, default 5). Ranked divergence for every tradable pair, anomaly flag, benchmark venue used.
- \`GET /ultra\` — $${ultra} per call. Query: \`limit\` (1-20, default 5), \`capacity\` (1-10, default 5), \`fees_bps\` (0-200). Adds execution capacity: the largest notional executable on both legs before combined market impact exceeds a stated budget, the book depth behind it, carry per day and breakeven days.
- \`GET /health\` — free. Status, network, facilitator.
- \`GET /sources\` — free. Which benchmark venues this host can reach, probed live.

## Payment

Standard x402: a request without payment returns \`402\` with a \`payment-required\` header holding base64 JSON. The amount is in \`accepts[0].amount\`, in 6-decimal atomic units. Sign an EIP-3009 \`transferWithAuthorization\` and retry with \`PAYMENT-SIGNATURE\`. Settlement is reported in the \`payment-response\` header.

No account, no API key, no subscription. An upstream failure returns \`502\` and is not charged.

## Method

- Funding intervals are read from each venue, never assumed: Hyperliquid pays hourly, many CEX pairs every 8 hours.
- A pair is compared only if it clears a liquidity floor on both legs.
- Divergences above the anomaly threshold are flagged and ranked last, not first.
- Capacity is measured from public order books or reported unavailable; it is never estimated.
- Measurements from public data. No recommendation, no position sizing, no investment advice.

## Links

- Homepage: ${baseUrl}/
- Repository: https://github.com/kristoferbc/x402-funding
- npm library (free, zero dependencies): https://www.npmjs.com/package/x402-funding-divergence
- MCP tool (free, local): \`npx -y x402-funding-divergence\`
- x402 protocol: https://www.x402.org
`;
}

export function renderRobotsTxt({ baseUrl }) {
  return `# x402 Funding Divergence
# The paid routes are meant for programmatic clients, not crawlers.
User-agent: *
Allow: /
Disallow: /funding
Disallow: /ultra

Sitemap: ${baseUrl}/sitemap.xml
`;
}

export function renderSitemapXml({ baseUrl, lastmod }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}
