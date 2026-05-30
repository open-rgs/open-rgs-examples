#!/usr/bin/env bun
// docs/build.ts — generate the static site for examples.open-rgs.dev.
//
//   bun run docs:build      # → docs/dist/{index.html, math-testing.html}
//
// The gallery is built from each game's game.json, so adding a game needs no
// edit here. The math-testing guide is rendered from docs/math-testing.md by a
// tiny dependency-free Markdown converter (we control the Markdown, so it only
// supports what these docs use).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)); // docs/ → repo root
const gamesDir = resolve(root, "games");
const outDir = resolve(root, "docs/dist");

interface Game {
  id: string; title: string; emoji: string; kind: "simple" | "complex";
  category: string; rtp: number; tagline: string; mechanic: string;
  showcases: string[]; params: { name: string; type: string; default: unknown; range?: string; note?: string }[];
  maxWin: string; strategyDependent: boolean; mathTest: string; suggestedPort?: number;
}

function loadGames(): Game[] {
  return readdirSync(gamesDir)
    .filter((d) => { try { return statSync(resolve(gamesDir, d, "game.json")).isFile(); } catch { return false; } })
    .map((d) => JSON.parse(readFileSync(resolve(gamesDir, d, "game.json"), "utf8")) as Game)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n: number) => (n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 1) + "%";

// ── tiny Markdown → HTML (headings, code fences, tables, lists, quotes, hr, inline) ──
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
}

function markdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  // strip link-reference definitions like [x]: url and resolve them
  const refs: Record<string, string> = {};
  for (const l of lines) { const m = l.match(/^\[([^\]]+)\]:\s+(\S+)/); if (m) refs[m[1]!.toLowerCase()] = m[2]!; }
  const resolveRefs = (html: string) =>
    html.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (_m, t, r) => {
      const u = refs[(r || t).toLowerCase()]; return u ? `<a href="${u}">${t}</a>` : t;
    }).replace(/<a href="([^"]+)">/g, (m, u) => refs[u.toLowerCase()] ? `<a href="${refs[u.toLowerCase()]}">` : m);

  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\[([^\]]+)\]:\s+\S+/.test(line)) { i++; continue; } // ref def
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("```")) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) { buf.push(lines[i]!); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = h[1]!.length; out.push(`<h${n}>${inline(h[2]!)}</h${n}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push("<hr>"); i++; continue; }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) { buf.push(lines[i]!.replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${markdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1]!)) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      const [head, , ...body] = rows;
      const th = (head ?? []).map((c) => `<th>${inline(c)}</th>`).join("");
      const trs = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) { items.push(`<li>${inline(lines[i]!.replace(/^\s*[-*]\s+/, ""))}</li>`); i++; }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) { items.push(`<li>${inline(lines[i]!.replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i]!)) { buf.push(lines[i]!); i++; }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return resolveRefs(out.join("\n"));
}

// ── shared chrome ─────────────────────────────────────────────────────────────
const CSS = `
:root{--bg:#0c0e12;--panel:#14171f;--line:#262b36;--fg:#e6e9ef;--mut:#98a1b3;--acc:#5eead4;--acc2:#a78bfa;--warn:#fbbf24}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--acc)}a:hover{color:#fff}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:#1b1f29;padding:.1em .35em;border-radius:4px;font-size:.88em;color:#cdd6f4}
pre{background:#0a0c10;border:1px solid var(--line);border-radius:10px;padding:16px;overflow:auto;font-size:13.5px;line-height:1.5}
pre code{background:none;padding:0;color:#c8d3e6}
.wrap{max-width:980px;margin:0 auto;padding:0 22px}
header.hero{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#11141b,#0c0e12)}
.hero .wrap{padding:54px 22px 40px}
.hero h1{font-size:40px;margin:0 0 6px;letter-spacing:-.02em}
.hero p.sub{color:var(--mut);font-size:18px;margin:.2em 0 0;max-width:62ch}
.kbd{display:inline-block;background:#0a0c10;border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;padding:2px 8px;font:13px ui-monospace,monospace;color:#cdd6f4}
nav.top{display:flex;gap:18px;margin-top:24px;flex-wrap:wrap}
nav.top a{font-size:14px}
h2.section{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:var(--mut);margin:46px 0 16px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;display:flex;flex-direction:column}
.card h3{margin:0;font-size:20px;display:flex;align-items:center;gap:9px}
.card .em{font-size:22px}
.badges{margin-left:auto;display:flex;gap:6px}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.badge.simple{color:#7dd3fc;border-color:#1e3a5f}
.badge.complex{color:var(--acc2);border-color:#3b2f63}
.badge.rtp{color:var(--acc);border-color:#1f4d44}
.badge.strat{color:var(--warn);border-color:#5c4710}
.card .tag{margin:10px 0 6px;font-weight:600}
.card .mech{color:var(--mut);font-size:13.5px;margin:0 0 12px}
.card ul.show{margin:0 0 12px;padding-left:18px;color:var(--mut);font-size:12.5px}
.card ul.show li{margin:2px 0}
.card .run{margin-top:auto;border-top:1px solid var(--line);padding-top:12px;font-size:12.5px;color:var(--mut)}
.card .run code{font-size:12px}
.params{font-size:12px;color:var(--mut);margin:0 0 12px}
.params b{color:var(--fg);font-weight:600}
footer{border-top:1px solid var(--line);margin-top:60px;color:var(--mut);font-size:13px}
footer .wrap{padding:24px 22px 50px}
article h1{font-size:32px;letter-spacing:-.02em;margin:36px 0 6px}
article h2{font-size:23px;margin:40px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
article h3{font-size:18px;margin:26px 0 8px}
article table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}
article th,article td{border:1px solid var(--line);padding:7px 11px;text-align:left}
article th{background:#11141b}
article blockquote{border-left:3px solid var(--acc2);margin:16px 0;padding:2px 16px;color:var(--mut);background:#10131a;border-radius:0 8px 8px 0}
article hr{border:none;border-top:1px solid var(--line);margin:34px 0}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="A gallery of worked open-rgs games — bootable, math-testable, MIT.">
<style>${CSS}</style></head><body>${body}
<footer><div class="wrap">open-rgs-examples · MIT · built on <a href="https://open-rgs.dev">open-rgs</a> · <a href="https://github.com/open-rgs/open-rgs-examples">source</a></div></footer>
</body></html>`;
}

function card(g: Game): string {
  const params = g.params.length
    ? `<p class="params">params: ${g.params.map((p) => `<b>${esc(p.name)}</b> <span>(${esc(String(p.default))}${p.range ? "; " + esc(p.range) : ""})</span>`).join(" · ")}</p>`
    : "";
  return `<div class="card">
  <h3><span class="em">${g.emoji}</span> ${esc(g.title)}
    <span class="badges">
      <span class="badge ${g.kind}">${g.kind}</span>
      <span class="badge rtp">RTP ${pct(g.rtp)}</span>
      ${g.strategyDependent ? `<span class="badge strat">strategy</span>` : ""}
    </span>
  </h3>
  <p class="tag">${esc(g.tagline)}</p>
  <p class="mech">${esc(g.mechanic)}</p>
  ${params}
  <ul class="show">${g.showcases.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
  <div class="run">
    <code>cd games/${g.id} &amp;&amp; bun run dev</code><br>
    <code>bun run play --game ${g.id}</code> · <code>bun run sim --game ${g.id}</code>
  </div>
</div>`;
}

function buildIndex(games: Game[]): string {
  const groups: { key: string; title: string }[] = [
    { key: "instant", title: "Instant games" },
    { key: "ladder", title: "Survival ladders" },
    { key: "table", title: "Table games" },
  ];
  const sections = groups.map((grp) => {
    const inGroup = games.filter((g) => g.category === grp.key);
    if (!inGroup.length) return "";
    return `<h2 class="section">${grp.title}</h2><div class="grid">${inGroup.map(card).join("")}</div>`;
  }).join("");

  const body = `
<header class="hero"><div class="wrap">
  <h1>open-rgs examples</h1>
  <p class="sub">A gallery of worked casino games built on <a href="https://open-rgs.dev">open-rgs</a> — each one boots with one Bun file and is math-testable with the simulator. MIT.</p>
  <p style="margin-top:18px"><span class="kbd">cd games/limbo</span> &nbsp;<span class="kbd">bun install</span> &nbsp;<span class="kbd">bun run dev</span></p>
  <nav class="top">
    <a href="./math-testing.html">→ How to math-test these games</a>
    <a href="https://github.com/open-rgs/open-rgs-examples">GitHub</a>
    <a href="https://open-rgs.dev">open-rgs docs</a>
  </nav>
</div></header>
<main class="wrap">
  ${sections}
  <h2 class="section">The shared pieces</h2>
  <div class="grid">
    <div class="card"><h3>🧩 mock-platform</h3><p class="tag">A PlatformAdapter you can read in one sitting.</p><p class="mech">In-memory balance, idempotency, integer-money guards — and it logs every wallet call so you can watch the protocol happen.</p><div class="run"><code>packages/mock-platform</code></div></div>
    <div class="card"><h3>🎰 simulator</h3><p class="tag">RTP + strategy testing.</p><p class="mech">Default report, plus <code>--compare</code> to prove the ladders are constant-EV and Blackjack is strategy-dependent.</p><div class="run"><code>bun run sim --game &lt;name&gt; --compare</code></div></div>
    <div class="card"><h3>🎮 play</h3><p class="tag">See one round, end to end.</p><p class="mech">Boots a game in-process and drives a real round over the WebSocket client — the whole stack, with the wallet logging each call.</p><div class="run"><code>bun run play --game &lt;name&gt;</code></div></div>
  </div>
</main>`;
  return page("open-rgs examples", body);
}

function buildGuide(): string {
  const mdPath = resolve(root, "docs/math-testing.md");
  const html = existsSync(mdPath) ? markdown(readFileSync(mdPath, "utf8")) : "<p>missing math-testing.md</p>";
  const body = `<header class="hero"><div class="wrap">
  <h1 style="font-size:30px">open-rgs examples</h1>
  <nav class="top"><a href="./index.html">← Gallery</a><a href="https://github.com/open-rgs/open-rgs-examples">GitHub</a><a href="https://open-rgs.dev">open-rgs docs</a></nav>
</div></header>
<main class="wrap"><article>${html}</article></main>`;
  return page("How to math-test — open-rgs examples", body);
}

const games = loadGames();
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), buildIndex(games), "utf8");
writeFileSync(resolve(outDir, "math-testing.html"), buildGuide(), "utf8");
console.log(`docs: wrote ${games.length} games → docs/dist/index.html + math-testing.html`);
