#!/usr/bin/env node
// One-off static blog builder for the "Qwen agent pays Nansen" post.
// No dependencies, no build step. Handles exactly the Markdown features
// used by docs/blog/qwen-agent-pays-nansen.md (+ .zh.md): headings,
// paragraphs, bold/italic, inline code, tables, bullet/numbered lists,
// plain-URL autolinking, and tx-hash-to-explorer linking.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'blog');
const SITE = path.join(ROOT, 'site');

const SLUG = 'qwen-agent-pays-nansen';

// Short tx hash (as printed in the tables, inside backticks) -> full tx hash.
const TX_MAP = {
  '0xb227e30f…d540': '0xb227e30f125cac1ab20977a5b9479ae538dacdec4295262173d643febc7ad540',
  '0xc739c432…163f': '0xc739c43296ed40a239bd148b60d6be230bae7a53c5795f68e389056520fc163f',
  '0x99bf9da6…2cb8': '0x99bf9da63699c1e6fd6e487bbbbfea882e882e29af30c6c178b0d277c82a2cb8',
  '0x5fab3819…f33b': '0x5fab3819a066e3f67e57109c2d6ff7f5a460d74fd6b9df4127c4bfbf4f4cf33b',
  '0xb7df9976…e0b6': '0xb7df99767f8ac3cff9ad05a3ebabe5e57a9a1ef9cc622ccad0afacab652de0b6',
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render inline Markdown (bold/italic/code/links/tx-hashes) within one line/cell.
function renderInline(raw) {
  let text = escapeHtml(raw);
  const codeStore = [];

  // Inline code spans — extracted first so ** / * / URLs inside them are
  // left untouched. A code span whose content is a known short tx hash
  // becomes a link to the explorer, wrapping the <code>.
  text = text.replace(/`([^`]+)`/g, (_, content) => {
    let html = `<code>${content}</code>`;
    const full = TX_MAP[content];
    if (full) {
      html = `<a class="tx-link" href="https://monadvision.com/tx/${full}" rel="noopener" target="_blank">${html}</a>`;
    }
    codeStore.push(html);
    return `\u0000${codeStore.length - 1}\u0000`;
  });

  // Bold, then italic (order matters: ** before *).
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Plain URLs written directly in text (not already markdown links).
  text = text.replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}" rel="noopener">${m}</a>`);

  // Restore protected code spans (and tx-hash links).
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => codeStore[Number(i)]);

  return text;
}

function renderTableRow(line) {
  // Strip leading/trailing pipe, split on unescaped pipes.
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return cells;
}

function isSeparatorRow(line) {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());
}

// Split markdown source into blank-line-separated blocks, then render each.
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  let html = '';
  let title = '';

  for (const block of blocks) {
    const first = block[0];

    if (/^#{1,3}\s+/.test(first)) {
      const m = first.match(/^(#{1,3})\s+(.*)$/);
      const level = m[1].length;
      const text = renderInline(m[2]);
      if (level === 1 && !title) title = m[2];
      html += `<h${level}>${text}</h${level}>\n`;
      continue;
    }

    if (first.trim().startsWith('|')) {
      const rows = block.map(renderTableRow);
      const headerCells = rows[0];
      const bodyRows = isSeparatorRow(block[1]) ? rows.slice(2) : rows.slice(1);
      let t = '<div class="table-scroll"><table>\n<thead><tr>';
      for (const c of headerCells) t += `<th>${renderInline(c)}</th>`;
      t += '</tr></thead>\n<tbody>\n';
      for (const row of bodyRows) {
        t += '<tr>';
        for (const c of row) t += `<td>${renderInline(c)}</td>`;
        t += '</tr>\n';
      }
      t += '</tbody></table></div>\n';
      html += t;
      continue;
    }

    if (/^\d+\.\s+/.test(first)) {
      let l = '<ol>\n';
      for (const line of block) {
        const m = line.match(/^\d+\.\s+(.*)$/);
        l += `<li>${renderInline(m[1])}</li>\n`;
      }
      l += '</ol>\n';
      html += l;
      continue;
    }

    if (/^-\s+/.test(first)) {
      let l = '<ul>\n';
      for (const line of block) {
        const m = line.match(/^-\s+(.*)$/);
        l += `<li>${renderInline(m[1])}</li>\n`;
      }
      l += '</ul>\n';
      html += l;
      continue;
    }

    // Plain paragraph (may be a single line or a wrapped multi-line block).
    const text = renderInline(block.join(' '));
    html += `<p>${text}</p>\n`;
  }

  return { html, title };
}

const PAGE = {
  en: {
    md: 'qwen-agent-pays-nansen.md',
    lang: 'en',
    htmlLang: 'en',
    dir: path.join(SITE, 'blog', SLUG),
    rootRel: '../../',
    langSwitchHref: 'zh/',
    langSwitchLabel: '中文',
    canonical: `https://moneyswitch.dev/blog/${SLUG}/`,
    altHref: `https://moneyswitch.dev/blog/${SLUG}/zh/`,
    metaDescription:
      "Qwen 3.8 Max was given a $0.09 MoneyKey budget and bought its own Nansen data on Monad mainnet over x402 — five real USDC payments, no private key.",
    navLabel: 'Blog',
    homeLabel: 'MoneySwitch',
    backToBlog: '← Blog',
    publishedLabel: 'Published',
  },
  zh: {
    md: 'qwen-agent-pays-nansen.zh.md',
    lang: 'zh',
    htmlLang: 'zh-CN',
    dir: path.join(SITE, 'blog', SLUG, 'zh'),
    rootRel: '../../../',
    langSwitchHref: '../',
    langSwitchLabel: 'EN',
    canonical: `https://moneyswitch.dev/blog/${SLUG}/zh/`,
    altHref: `https://moneyswitch.dev/blog/${SLUG}/`,
    metaDescription:
      'Qwen 3.8 Max 拿到一把 0.09 美元预算的 MoneyKey，通过 x402 在 Monad 主网上自己买了 Nansen 的数据 —— 五笔真实的 USDC 付款，全程没有碰到私钥。',
    navLabel: '博客',
    homeLabel: 'MoneySwitch',
    backToBlog: '← 博客',
    publishedLabel: '发布于',
  },
};

const PUBLISH_DATE = '2026-09-27';

function articlePage(cfg, articleHtml, title) {
  const r = cfg.rootRel;
  return `<!doctype html>
<html lang="${cfg.htmlLang}" data-lang="${cfg.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — MoneySwitch</title>
<meta name="description" content="${cfg.metaDescription}">
<meta name="theme-color" content="#07060d">
<link rel="canonical" href="${cfg.canonical}">
<link rel="alternate" hreflang="${cfg.lang === 'en' ? 'en' : 'zh'}" href="${cfg.canonical}">
<link rel="alternate" hreflang="${cfg.lang === 'en' ? 'zh' : 'en'}" href="${cfg.altHref}">
<link rel="icon" href="${r}assets/img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${r}assets/img/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${r}assets/img/apple-touch-icon.png">

<meta property="og:type" content="article">
<meta property="og:site_name" content="MoneySwitch">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${cfg.metaDescription}">
<meta property="og:url" content="${cfg.canonical}">
<meta property="og:image" content="https://moneyswitch.dev/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${cfg.metaDescription}">
<meta name="twitter:image" content="https://moneyswitch.dev/og.png">

<link rel="stylesheet" href="${r}assets/css/site.css">
<link rel="stylesheet" href="${r}assets/css/blog.css">
</head>
<body>
<a class="skip" href="#main">${cfg.lang === 'en' ? 'Skip to content' : '跳到正文'}</a>

<header class="nav" id="top">
  <div class="wrap nav-inner">
    <a class="brand" href="${r}index.html" aria-label="${cfg.homeLabel} home">
      <span class="brand-mark" aria-hidden="true"><i></i></span>
      <span class="brand-name">Money<b>Switch</b></span>
    </a>
    <nav class="nav-links" aria-label="Blog">
      <a href="../index.html">${cfg.backToBlog}</a>
    </nav>
    <div class="nav-actions">
      <div class="lang" role="group" aria-label="Language">
        <a href="${cfg.langSwitchHref}">${cfg.langSwitchLabel}</a>
      </div>
    </div>
  </div>
</header>

<main id="main">
<article class="section blog-article">
  <div class="wrap narrow">
    <p class="eyebrow">${cfg.publishedLabel} ${PUBLISH_DATE}</p>
${articleHtml}  </div>
</article>
</main>

<footer class="footer">
  <div class="wrap foot">
    <div>
      <a class="brand" href="${r}index.html"><span class="brand-mark" aria-hidden="true"><i></i></span><span class="brand-name">Money<b>Switch</b></span></a>
      <p class="dim small"><a href="https://moneyswitch.dev/">moneyswitch.dev</a></p>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

function blogIndexPage() {
  const title = 'Blog — MoneySwitch';
  const description =
    'MoneySwitch blog: write-ups on paying x402 APIs with USDC on Monad, agent budgets and real on-chain settlements.';
  return `<!doctype html>
<html lang="en" data-lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#07060d">
<link rel="canonical" href="https://moneyswitch.dev/blog/">
<link rel="icon" href="../assets/img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="../assets/img/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="../assets/img/apple-touch-icon.png">

<meta property="og:type" content="website">
<meta property="og:site_name" content="MoneySwitch">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="https://moneyswitch.dev/blog/">
<meta property="og:image" content="https://moneyswitch.dev/og.png">

<link rel="stylesheet" href="../assets/css/site.css">
<link rel="stylesheet" href="../assets/css/blog.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="nav" id="top">
  <div class="wrap nav-inner">
    <a class="brand" href="../index.html" aria-label="MoneySwitch home">
      <span class="brand-mark" aria-hidden="true"><i></i></span>
      <span class="brand-name">Money<b>Switch</b></span>
    </a>
  </div>
</header>

<main id="main">
<section class="section blog-index">
  <div class="wrap narrow">
    <p class="eyebrow">Blog · 博客</p>
    <h1 class="h2">MoneySwitch blog</h1>
    <ul class="blog-list">
      <li class="blog-list-item">
        <h2><a href="${SLUG}/">I gave Qwen 3.8 Max a $0.09 budget and a MoneyKey. It bought its own Nansen data on Monad mainnet.</a></h2>
        <p class="dim">Qwen 3.8 Max buys its own Nansen data over x402 on Monad mainnet, under a hard USDC budget. <a href="${SLUG}/">Read in English</a> · <a href="${SLUG}/zh/">阅读中文版</a></p>
      </li>
    </ul>
  </div>
</section>
</main>

<footer class="footer">
  <div class="wrap foot">
    <div>
      <a class="brand" href="../index.html"><span class="brand-mark" aria-hidden="true"><i></i></span><span class="brand-name">Money<b>Switch</b></span></a>
      <p class="dim small"><a href="https://moneyswitch.dev/">moneyswitch.dev</a></p>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

function build() {
  for (const key of Object.keys(PAGE)) {
    const cfg = PAGE[key];
    const md = fs.readFileSync(path.join(DOCS, cfg.md), 'utf8');
    const { html, title } = renderMarkdown(md);
    const page = articlePage(cfg, html, title);
    fs.mkdirSync(cfg.dir, { recursive: true });
    const outFile = path.join(cfg.dir, 'index.html');
    fs.writeFileSync(outFile, page, 'utf8');
    console.log('wrote', path.relative(ROOT, outFile));
  }

  const indexDir = path.join(SITE, 'blog');
  fs.mkdirSync(indexDir, { recursive: true });
  const indexFile = path.join(indexDir, 'index.html');
  fs.writeFileSync(indexFile, blogIndexPage(), 'utf8');
  console.log('wrote', path.relative(ROOT, indexFile));
}

build();
