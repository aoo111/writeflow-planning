/**
 * WriteFlow AI 로컬 서버.
 * - 정적 파일(index.html 등) 제공
 * - GET /api/article?url=...  뉴스 원문 링크에서 기사 본문을 가져와 텍스트로 돌려준다.
 *   (브라우저에서 언론사 사이트를 직접 읽으면 CORS에 막히므로 서버가 대신 가져온다.)
 * 외부 패키지 없이 Node 18+ 내장 기능만 사용한다. `npm start`로 실행.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const root = __dirname;
const port = Number(process.env.PORT || 8820);

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 6000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/* ---------- 원문 가져오기 ---------- */

// 서버 내부망(localhost, 사설 IP)으로의 요청은 막는다.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function assertPublicUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("http/https 주소만 불러올 수 있어요.");
  }
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("접근할 수 없는 주소예요.");
  }
}

async function fetchHtml(rawUrl) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    if (!res.ok) throw new Error(`언론사 사이트가 응답하지 않았어요 (HTTP ${res.status}).`);

    const bytes = await readLimited(res, MAX_HTML_BYTES);
    return { html: decodeHtml(bytes, res.headers.get("content-type")), finalUrl: url.href };
  }
  throw new Error("리디렉션이 너무 많아요.");
}

async function readLimited(res, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 한국 언론사 중에는 EUC-KR 페이지가 아직 있어서 charset을 확인해 디코딩한다.
function decodeHtml(bytes, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType || "")?.[1];
  if (!charset) {
    const head = bytes.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ---------- 본문 추출 ---------- */

// 주요 언론사/뉴스 CMS에서 본문을 감싸는 요소들. 앞쪽일수록 우선.
const BODY_SELECTORS = [
  /itemprop=["']articleBody["']/i,
  /id=["'](article-view-content-div|articleBody|article_body|articletxt|article-body|newsct_article|dic_area|news_body_area|textBody|articeBody|article_txt|newsEndContents|CmAdContent)["']/i,
  /class=["'][^"']*\b(article_body|article-body|articleBody|news_cnt_detail_wrap|art_body|article_txt|story-news|news_view|view_con|article-text|par)\b[^"']*["']/i,
  /<article\b/i,
];

function extractArticle(html) {
  const meta = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
      "i"
    );
    const m = re.exec(html);
    return m ? decodeEntities(m[1] || m[2] || "").trim() : "";
  };

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe|svg|template|button|select|figure|figcaption)\b[\s\S]*?<\/\1>/gi, "");

  let text = "";
  for (const selector of BODY_SELECTORS) {
    const inner = findElementInner(cleaned, selector);
    if (!inner) continue;
    const candidate = htmlToText(inner);
    if (candidate.length >= 200) {
      text = candidate;
      break;
    }
  }

  // 알려진 본문 영역이 없으면 긴 <p> 문단을 모은다.
  if (!text) {
    const paragraphs = [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => htmlToText(m[1]))
      .filter((p) => p.length >= 40);
    text = paragraphs.join("\n\n");
  }

  return {
    title: meta("og:title") || decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").trim(),
    siteName: meta("og:site_name"),
    description: meta("og:description") || meta("description"),
    text: cleanupText(text),
  };
}

// 여는 태그 위치를 찾은 뒤 같은 이름의 태그 깊이를 세어 짝이 되는 닫는 태그까지 잘라낸다.
function findElementInner(html, attrPattern) {
  const match = attrPattern.exec(html);
  if (!match) return "";
  const tagStart = html.lastIndexOf("<", match.index);
  const tagName = /^<([a-z0-9]+)/i.exec(html.slice(tagStart))?.[1]?.toLowerCase();
  if (!tagName) return "";
  const openEnd = html.indexOf(">", match.index);
  if (openEnd === -1) return "";

  const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  tagRe.lastIndex = openEnd + 1;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(openEnd + 1, m.index);
  }
  return html.slice(openEnd + 1);
}

function htmlToText(fragment) {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? all;
  });
}

// 저작권 고지·기자 연락처 같은 본문 외 줄을 걸러낸다.
const NOISE_LINE = /무단\s*전재|재배포\s*금지|copyright|ⓒ|©|all rights reserved|기자\s*[\w.+-]+@|^[\w.+-]+@[\w-]+\.[\w.]+$/i;
// 버튼 문구처럼 짧은 줄에서만 거르는 단어들 (본문 문장에 들어간 경우는 남긴다)
const NOISE_SHORT_LINE = /구독|좋아요|댓글|공유|기사\s*듣기|글자\s*크기|프린트|스크랩/;

function cleanupText(text) {
  const out = text
    .replace(/[​-‍﻿]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !NOISE_LINE.test(line) && !(line.length < 25 && NOISE_SHORT_LINE.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out.length > MAX_TEXT_CHARS ? out.slice(0, MAX_TEXT_CHARS).trimEnd() + " …" : out;
}

async function handleArticle(reqUrl, res) {
  const target = reqUrl.searchParams.get("url");
  if (!target) return sendJson(res, 400, { ok: false, error: "url 파라미터가 필요해요." });
  try {
    const { html, finalUrl } = await fetchHtml(target);
    const article = extractArticle(html);
    if (article.text.length < 100) {
      return sendJson(res, 422, {
        ok: false,
        error: "기사 본문을 찾지 못했어요. 유료 기사이거나 본문이 스크립트로 그려지는 페이지일 수 있어요.",
        ...article,
        url: finalUrl,
      });
    }
    sendJson(res, 200, { ok: true, ...article, url: finalUrl, length: article.text.length });
  } catch (err) {
    const message = err.name === "TimeoutError" ? "언론사 사이트 응답이 너무 늦어요." : err.message;
    sendJson(res, 502, { ok: false, error: message || "원문을 불러오지 못했어요." });
  }
}

/* ---------- 서버 ---------- */

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(reqUrl, res) {
  let filePath = decodeURIComponent(reqUrl.pathname);
  if (filePath === "/") filePath = "/index.html";
  const full = path.join(root, filePath);
  if (!full.startsWith(root + path.sep) || /[\\/]\./.test(filePath) || /node_modules/.test(filePath)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found: " + filePath);
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(full).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

if (require.main === module) {
  http
    .createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && reqUrl.pathname === "/api/article") return handleArticle(reqUrl, res);
      serveStatic(reqUrl, res);
    })
    .listen(port, () => console.log(`WriteFlow AI: http://localhost:${port}`));
}

module.exports = { extractArticle, fetchHtml };
