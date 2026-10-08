#!/usr/bin/env node
// Static blog builder. Markdown in docs/blog is the article source of truth;
// this manifest adds publication dates and per-language search descriptions.
// No dependencies. Supports the Markdown features used by these articles.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'blog');
const SITE = path.join(ROOT, 'site');
const ORIGIN = 'https://moneyswitch.dev';

const ARTICLES = [
  {
    slug: 'agent-wallet-trial',
    date: '2026-10-08',
    shareImage: { en: 'cover-en', zh: 'cover-zh' },
    description: {
      en: 'Try MoneySwitch with two agents, independent spending keys, a 0.01 test-USDC payment, human approval and bills. Rewards may be offered at our discretion based on trial participation and feedback.',
      zh: '邀请多 Agent 开发者试用 MoneySwitch：自部署、两把独立额度 key、0.01 测试 USDC 付款、人工审批与账单反馈。视试用与反馈情况酌情给予奖励。',
    },
  },
  {
    slug: 'one-wallet-many-agents',
    date: '2026-10-08',
    shareImage: { en: 'cover-en', zh: 'cover-zh' },
    description: {
      en: 'Why we are building a programmable, self-hosted spending wallet for agents across computers: one wallet service, separate budgets and human approvals over x402.',
      zh: '多台电脑上的 Codex、Claude Code 和云端 Agent，如何通过自己托管的钱包服务共享资金、分配独立额度，并在需要时交给人审批。',
    },
  },
  {
    slug: 'qwen-agent-pays-nansen',
    date: '2026-09-27',
    description: {
      en: 'Qwen 3.8 Max was given a $0.09 MoneyKey budget and bought its own Nansen data on Monad mainnet over x402 — five real USDC payments, no private key.',
      zh: 'Qwen 3.8 Max 拿到一把 0.09 美元预算的 MoneyKey，通过 x402 在 Monad 主网上自己买了 Nansen 的数据 —— 五笔真实的 USDC 付款，全程没有碰到私钥。',
    },
  },
];

// Keep the original, published mainnet transaction links intact.
const TX_MAP = {
  '0xb227e30f…d540': '0xb227e30f125cac1ab20977a5b9479ae538dacdec4295262173d643febc7ad540',
  '0xc739c432…163f': '0xc739c43296ed40a239bd148b60d6be230bae7a53c5795f68e389056520fc163f',
  '0x99bf9da6…2cb8': '0x99bf9da63699c1e6fd6e487bbbbfea882e882e29af30c6c178b0d277c82a2cb8',
  '0x5fab3819…f33b': '0x5fab3819a066e3f67e57109c2d6ff7f5a460d74fd6b9df4127c4bfbf4f4cf33b',
  '0xb7df9976…e0b6': '0xb7df99767f8ac3cff9ad05a3ebabe5e57a9a1ef9cc622ccad0afacab652de0b6',
};

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeHref(href) {
  return !/[\u0000-\u0020]/.test(href) && /^(?:https?:\/\/|\/(?!\/)|\.{1,2}\/|#)/.test(href);
}

function renderEmphasis(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

export function renderInline(raw, links = true) {
  const stored = [];
  const protect = (html) => {
    stored.push(html);
    return `\u0000${stored.length - 1}\u0000`;
  };

  // Code and explicit links are protected before emphasis and URL autolinking.
  // This prevents URLs inside code and href attributes becoming nested anchors.
  let text = raw.replace(/`([^`]+)`/g, (_, content) => {
    const code = `<code>${escapeHtml(content)}</code>`;
    return protect(TX_MAP[content]
      ? `<a class="tx-link" href="https://monadvision.com/tx/${TX_MAP[content]}" rel="noopener" target="_blank">${code}</a>`
      : code);
  });

  if (links) {
    text = text.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (match, label, href) => {
      if (!safeHref(href)) return protect(escapeHtml(match));
      return protect(`<a href="${escapeHtml(href)}" rel="noopener">${renderEmphasis(label)}</a>`);
    });
    text = text.replace(/https?:\/\/[^\s<>"'\u0000]+/g, (match) => {
      let href = match.replace(/[.,;:!?，。；：！？]+$/u, '');
      while (href.endsWith(')') && (href.match(/\)/g)?.length ?? 0) > (href.match(/\(/g)?.length ?? 0)) {
        href = href.slice(0, -1);
      }
      return protect(`<a href="${escapeHtml(href)}" rel="noopener">${escapeHtml(href)}</a>`) + match.slice(href.length);
    });
  }

  text = renderEmphasis(text);
  // Restore repeatedly: link labels may contain a protected code span.
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => stored[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_, i) => stored[Number(i)]);
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line = '') {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());
}

export function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let title = '';
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const illustration = line.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
    if (illustration && safeHref(illustration[2])) {
      const imageUrl = new URL(illustration[2], ORIGIN);
      const src = imageUrl.origin === ORIGIN ? imageUrl.pathname : imageUrl.href;
      html += `<figure class="article-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(illustration[1])}" loading="lazy" decoding="async"><figcaption>${escapeHtml(illustration[1])}</figcaption></figure>\n`;
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (level === 1 && !title) title = heading[2];
      html += `<h${level}>${renderInline(heading[2])}</h${level}>\n`;
      i++;
      continue;
    }

    if (line.trim().startsWith('|') && isTableSeparator(lines[i + 1])) {
      html += '<div class="table-scroll"><table>\n<thead><tr>';
      html += tableCells(line).map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      html += '</tr></thead>\n<tbody>\n';
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        html += '<tr>' + tableCells(lines[i++]).map((cell) => `<td>${renderInline(cell)}</td>`).join('') + '</tr>\n';
      }
      html += '</tbody></table></div>\n';
      continue;
    }

    const listMatch = line.match(/^(?:\d+\.|-)\s+/);
    if (listMatch) {
      const ordered = /^\d/.test(line);
      const pattern = ordered ? /^\d+\.\s+(.*)$/ : /^-\s+(.*)$/;
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>\n`;
      while (i < lines.length) {
        const item = lines[i].match(pattern);
        if (!item) break;
        html += `<li>${renderInline(item[1])}</li>\n`;
        i++;
      }
      html += `</${tag}>\n`;
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}|\d+\.|-)\s+/.test(lines[i])) {
      if (paragraph.length && lines[i].trim().startsWith('|') && isTableSeparator(lines[i + 1])) break;
      paragraph.push(lines[i++]);
    }
    html += `<p>${renderInline(paragraph.join(' '))}</p>\n`;
  }
  if (!title) throw new Error('Blog article is missing an H1 title');
  return { html, title };
}

const LOCALES = {
  en: { htmlLang: 'en', suffix: '', label: 'English', blog: 'Blog', published: 'Published', skip: 'Skip to content', home: 'MoneySwitch home', pilot: 'Try with two agents', indexTitle: 'MoneySwitch blog', indexIntro: 'Building a self-hosted spending wallet for agents: product notes, early trials and recorded payments.', read: 'Read article' },
  zh: { htmlLang: 'zh-CN', suffix: 'zh/', label: '中文', blog: '博客', published: '发布于', skip: '跳到正文', home: 'MoneySwitch 首页', pilot: '用两个 Agent 试一试', indexTitle: 'MoneySwitch 博客', indexIntro: '一个自己托管的多 Agent 支出钱包：产品思路、早期试用与已记录的付款实验。', read: '阅读全文' },
};

function pageShell({ lang, title, description, canonicalPath, alternatePath, article, content, shareImage }) {
  const l = LOCALES[lang];
  const otherLang = lang === 'en' ? 'zh' : 'en';
  const canonical = ORIGIN + canonicalPath;
  return `<!doctype html>
<html lang="${l.htmlLang}" data-lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — MoneySwitch</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#07060d">
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="${lang}" href="${canonical}">
<link rel="alternate" hreflang="${otherLang}" href="${ORIGIN}${alternatePath}">
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/img/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<meta property="og:type" content="${article ? 'article' : 'website'}">
<meta property="og:site_name" content="MoneySwitch">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ORIGIN}${shareImage ? `/assets/img/launch-2026-10/${shareImage}.png` : '/og.png'}">
<meta property="og:image:width" content="${shareImage ? '1672' : '1200'}">
<meta property="og:image:height" content="${shareImage ? '941' : '630'}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${ORIGIN}${shareImage ? `/assets/img/launch-2026-10/${shareImage}.png` : '/og.png'}">
<link rel="stylesheet" href="/assets/css/site.css">
<link rel="stylesheet" href="/assets/css/blog.css">
</head>
<body>
<a class="skip" href="#main">${l.skip}</a>
<header class="nav" id="top">
  <div class="wrap nav-inner">
    <a class="brand" href="/${lang === 'zh' ? '?lang=zh' : ''}" aria-label="${l.home}">
      <span class="brand-mark" aria-hidden="true"><i></i></span><span class="brand-name">Money<b>Switch</b></span>
    </a>
    <nav class="nav-links" aria-label="${l.blog}">
      <a href="/blog/${l.suffix}">${article ? '← ' : ''}${l.blog}</a>
      <a href="/pilot/${l.suffix}">${l.pilot}</a>
    </nav>
    <div class="nav-actions"><div class="lang" role="group" aria-label="${lang === 'en' ? 'Language' : '语言'}"><a href="${alternatePath}" lang="${LOCALES[otherLang].htmlLang}">${LOCALES[otherLang].label}</a></div></div>
  </div>
</header>
<main id="main">
${content}
</main>
<footer class="footer">
  <div class="wrap foot">
    <div><a class="brand" href="/${lang === 'zh' ? '?lang=zh' : ''}"><span class="brand-mark" aria-hidden="true"><i></i></span><span class="brand-name">Money<b>Switch</b></span></a><p class="dim small"><a href="${ORIGIN}/">moneyswitch.dev</a></p></div>
    <nav class="blog-footer-links" aria-label="${l.blog}"><a href="/blog/${l.suffix}">← ${l.blog}</a><a href="/pilot/${l.suffix}">${l.pilot}</a></nav>
  </div>
</footer>
</body>
</html>
`;
}

function articlePage(entry, lang, rendered) {
  const l = LOCALES[lang];
  return pageShell({
    lang,
    title: rendered.title,
    shareImage: entry.shareImage?.[lang],
    description: entry.description[lang],
    canonicalPath: `/blog/${entry.slug}/${l.suffix}`,
    alternatePath: `/blog/${entry.slug}/${lang === 'en' ? 'zh/' : ''}`,
    article: true,
    content: `<article class="section blog-article"><div class="wrap narrow">
<p class="eyebrow">${l.published} <time datetime="${entry.date}">${entry.date}</time></p>
${rendered.html}</div></article>`,
  });
}

function blogIndexPage(lang, entries) {
  const l = LOCALES[lang];
  const items = entries.map(({ entry, rendered }) => `<li class="blog-list-item">
  <p class="eyebrow"><time datetime="${entry.date}">${entry.date}</time></p>
  <h2><a href="/blog/${entry.slug}/${l.suffix}">${escapeHtml(rendered[lang].title)}</a></h2>
  <p class="dim">${escapeHtml(entry.description[lang])}</p>
  <p><a href="/blog/${entry.slug}/${l.suffix}">${l.read} →</a> · <a href="/blog/${entry.slug}/${lang === 'en' ? 'zh/' : ''}" lang="${lang === 'en' ? 'zh-CN' : 'en'}">${lang === 'en' ? '阅读中文版' : 'Read in English'}</a></p>
</li>`).join('\n');
  return pageShell({
    lang,
    title: l.indexTitle,
    description: l.indexIntro,
    canonicalPath: `/blog/${l.suffix}`,
    alternatePath: `/blog/${lang === 'en' ? 'zh/' : ''}`,
    article: false,
    content: `<section class="section blog-index"><div class="wrap narrow">
<p class="eyebrow">Blog · 博客</p>
<h1 class="h2">${l.indexTitle}</h1>
<p class="lead">${l.indexIntro}</p>
<ul class="blog-list">${items}</ul>
</div></section>`,
  });
}

export function build() {
  // Parse all sources before writing, so a missing article cannot leave a
  // freshly generated index pointing at an article the build did not produce.
  const entries = ARTICLES.map((entry) => ({
    entry,
    rendered: Object.fromEntries(Object.keys(LOCALES).map((lang) => [lang,
      renderMarkdown(fs.readFileSync(path.join(DOCS, `${entry.slug}${lang === 'zh' ? '.zh' : ''}.md`), 'utf8')),
    ])),
  }));
  const outputs = [];
  for (const { entry, rendered } of entries) {
    for (const lang of Object.keys(LOCALES)) {
      outputs.push([path.join(SITE, 'blog', entry.slug, LOCALES[lang].suffix, 'index.html'), articlePage(entry, lang, rendered[lang])]);
    }
  }
  for (const lang of Object.keys(LOCALES)) {
    outputs.push([path.join(SITE, 'blog', LOCALES[lang].suffix, 'index.html'), blogIndexPage(lang, entries)]);
  }
  for (const [outFile, html] of outputs) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');
    console.log('wrote', path.relative(ROOT, outFile));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
