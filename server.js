/**
 * WriteFlow AI 로컬 서버.
 * - 정적 파일(index.html 등) 제공
 * - GET /api/article?url=...  뉴스 원문 링크에서 기사 본문을 가져와 텍스트로 돌려준다.
 *   (브라우저에서 언론사 사이트를 직접 읽으면 CORS에 막히므로 서버가 대신 가져온다.)
 * - POST /api/generate  콘텐츠 설정을 받아 OpenRouter로 AI 원고를 생성한다.
 *   API 키는 .env 의 OPENROUTER_API_KEY 에서만 읽고 브라우저에는 절대 보내지 않는다.
 * 외부 패키지 없이 Node 내장 기능만 사용한다. `npm start`로 실행.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const root = __dirname;

// .env 파일이 있으면 환경변수로 불러온다 (Node 20.12+ 내장 기능).
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // .env 가 없으면 그냥 넘어간다. 키가 없으면 /api/generate 가 안내 메시지를 돌려준다.
}

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
  /class=["'][^"']*\bentry-content\b[^"']*["']/i, // 워드프레스 기반 매체 (벤처스퀘어, 플래텀 등)
  /<article\b/i,
];

// 본문 영역 안에 섞여 있는 공유 버튼·관련 기사·태그·자동 번역본 등은 잘라낸다.
const BODY_NOISE = [
  /class=["'][^"']*\b(sharedaddy|jp-relatedposts|sharing|share-buttons|social-share|related-posts|post-tags|tag-list|article-tags|copyright)\b[^"']*["']/i,
  /id=["'](translated-[\w-]+|jp-relatedposts|related[\w-]*)["']/i,
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
    const el = findElement(cleaned, selector);
    if (!el) continue;
    const candidate = htmlToText(removeElements(cleaned.slice(el.innerStart, el.innerEnd), BODY_NOISE));
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

// 여는 태그 위치를 찾은 뒤 같은 이름의 태그 깊이를 세어 짝이 되는 닫는 태그까지의 범위를 구한다.
// 반환값: { start, innerStart, innerEnd, end } (html 문자열 인덱스) 또는 null
function findElement(html, attrPattern) {
  const match = attrPattern.exec(html);
  if (!match) return null;
  const start = html.lastIndexOf("<", match.index);
  const tagName = /^<([a-z0-9]+)/i.exec(html.slice(start))?.[1]?.toLowerCase();
  if (!tagName) return null;
  const openEnd = html.indexOf(">", match.index);
  if (openEnd === -1) return null;

  const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  tagRe.lastIndex = openEnd + 1;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start, innerStart: openEnd + 1, innerEnd: m.index, end: tagRe.lastIndex };
  }
  return { start, innerStart: openEnd + 1, innerEnd: html.length, end: html.length };
}

function removeElements(html, patterns) {
  for (const pattern of patterns) {
    let el;
    while ((el = findElement(html, pattern))) {
      html = html.slice(0, el.start) + html.slice(el.end);
    }
  }
  return html;
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

/* ---------- AI 원고 생성 (OpenRouter) ---------- */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
const GENERATE_TIMEOUT_MS = 180000;
const MAX_BODY_BYTES = 64 * 1024;

const TYPE_GUIDE = {
  Blog:
    "블로그 글. 첫 줄에 제목을 쓰고, 도입 → 소제목으로 나눈 본문 → 마무리 순서로 구성한다. 소제목은 【 】로 감싼다.",
  YouTube:
    "유튜브 영상 대본. [제목 후보] 3개, [오프닝] 시청자를 붙잡는 첫 10초 멘트, [본문] 장면별 멘트, [마무리] 요약과 구독·댓글 유도 순서로 쓴다. 말로 읽기 좋은 구어체로 쓴다.",
  Shorts:
    "유튜브 쇼츠(세로 숏폼) 대본. [제목] 1개, [0~3초 Hook] 한 문장, [본문] 짧은 문장 위주 멘트, [마무리] 한 줄 순서로 쓴다. 한 문장은 짧고 리듬감 있게 쓴다.",
};

const STYLE_GUIDE = {
  "정보 전달형": "핵심 사실과 숫자를 정확하고 명료하게 전달한다. 과장하지 않는다.",
  "친근한 설명형": "친구에게 설명하듯 쉬운 말과 비유를 쓰고, 어려운 용어는 풀어서 설명한다.",
  "전문적인 스타일": "업계 관점의 분석과 맥락, 의미를 담아 전문가다운 어조로 쓴다.",
  "흥미 유도형": "질문과 반전, 궁금증을 활용해 끝까지 보게 만드는 흐름으로 쓴다. 단, 사실을 과장하거나 낚시성 표현은 쓰지 않는다.",
};

// 영상은 말하는 속도(1분에 약 300~350자) 기준, 블로그는 글자 수 기준으로 분량을 안내한다.
const LENGTH_GUIDE = {
  Blog: { 짧게: "약 800자", 보통: "약 1,500자", 길게: "약 3,000자" },
  YouTube: { 짧게: "약 1분 분량(약 350자)", 보통: "약 3분 분량(약 1,000자)", 길게: "약 5분 이상 분량(약 1,700자 이상)" },
  Shorts: { 짧게: "약 30초 분량(약 180자)", 보통: "약 45초 분량(약 260자)", 길게: "약 60초 분량(약 350자)" },
};

const SYSTEM_PROMPT = `당신은 1인 크리에이터를 돕는 한국어 콘텐츠 원고 작가입니다.

규칙:
- 참고자료가 있으면 그 안의 사실(인물, 기관, 숫자, 날짜)만 사용하고, 참고자료에 없는 사실을 지어내지 않습니다.
- 참고자료 문장을 그대로 옮기지 말고, 사실을 바탕으로 새로운 표현으로 다시 씁니다. 직접 인용이 필요하면 짧게 따옴표로 인용하고 누가 한 말인지 밝힙니다.
- 원고의 제목(제목 후보 포함)은 기사 제목이나 입력된 주제 문장을 그대로 쓰지 말고, 콘텐츠 유형과 스타일에 맞게 새로 짓습니다.
- 참고자료에 [출처]가 있으면 원고 맨 끝에 "출처: 매체명" 한 줄을 붙입니다.
- 마크다운 기호(#, **, - 목록 등)는 쓰지 않고, 그대로 복사해 쓸 수 있는 일반 텍스트로 씁니다.
- 원고 본문만 출력합니다. "네, 작성하겠습니다" 같은 안내 문장은 쓰지 않습니다.`;

function buildUserPrompt({ topic, reference, type, style, length }) {
  return [
    `주제: ${topic}`,
    `콘텐츠 유형: ${type} — ${TYPE_GUIDE[type]}`,
    `스타일: ${style} — ${STYLE_GUIDE[style]}`,
    `분량: ${LENGTH_GUIDE[type][length]}`,
    "",
    reference ? `참고자료:\n"""\n${reference}\n"""` : "참고자료: 없음 (일반적으로 알려진 내용만 사용하고, 확실하지 않은 숫자나 사실은 쓰지 마세요.)",
  ].join("\n");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("요청 내용이 너무 길어요."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("요청 형식이 올바르지 않아요."));
      }
    });
    req.on("error", reject);
  });
}

const OPENROUTER_ERRORS = {
  401: "API 키가 올바르지 않아요. .env 의 OPENROUTER_API_KEY 를 확인해 주세요.",
  402: "OpenRouter 크레딧이 부족하거나 키의 사용 한도에 도달했어요. 충전 또는 한도를 확인해 주세요.",
  429: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
};

async function handleGenerate(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, {
      ok: false,
      error: "API 키가 설정되지 않았어요. WriteFlow 폴더의 .env 파일에 OPENROUTER_API_KEY 를 넣고 서버를 다시 실행해 주세요.",
    });
  }

  let input;
  try {
    input = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  const topic = String(input.topic || "").trim().slice(0, 100);
  const reference = String(input.reference || "").trim().slice(0, 8000);
  const { type, style, length } = input;
  if (!topic) return sendJson(res, 400, { ok: false, error: "주제를 입력해 주세요." });
  if (!TYPE_GUIDE[type] || !STYLE_GUIDE[style] || !LENGTH_GUIDE.Blog[length]) {
    return sendJson(res, 400, { ok: false, error: "콘텐츠 유형·스타일·길이 값이 올바르지 않아요." });
  }

  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  try {
    const aiRes = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "WriteFlow AI",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt({ topic, reference, type, style, length }) },
        ],
      }),
    });

    const data = await aiRes.json().catch(() => ({}));
    if (!aiRes.ok || data.error) {
      const status = aiRes.ok ? data.error?.code : aiRes.status;
      console.error("[generate] OpenRouter error", status, data.error?.message);
      return sendJson(res, 502, {
        ok: false,
        error: OPENROUTER_ERRORS[status] || `AI 응답에 실패했어요. (${data.error?.message || "HTTP " + status})`,
      });
    }

    const choice = data.choices?.[0];
    const text = (choice?.message?.content || "").trim();
    if (!text) return sendJson(res, 502, { ok: false, error: "AI가 빈 원고를 돌려줬어요. 다시 시도해 주세요." });

    console.log(`[generate] ${data.model || model} · 입력 ${data.usage?.prompt_tokens ?? "?"} / 출력 ${data.usage?.completion_tokens ?? "?"} 토큰`);
    sendJson(res, 200, {
      ok: true,
      text,
      model: data.model || model,
      truncated: choice.finish_reason === "length",
      usage: data.usage || null,
    });
  } catch (err) {
    const message = err.name === "TimeoutError" ? "AI 응답이 너무 오래 걸려요. 다시 시도해 주세요." : "AI 서버에 연결하지 못했어요.";
    console.error("[generate]", err);
    sendJson(res, 502, { ok: false, error: message });
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
      if (req.method === "POST" && reqUrl.pathname === "/api/generate") return handleGenerate(req, res);
      serveStatic(reqUrl, res);
    })
    .listen(port, () => {
      console.log(`WriteFlow AI: http://localhost:${port}`);
      console.log(
        process.env.OPENROUTER_API_KEY
          ? `AI 모델: ${process.env.AI_MODEL || DEFAULT_MODEL}`
          : "⚠ OPENROUTER_API_KEY 가 없어 원고 생성은 비활성 상태예요 (.env 확인)"
      );
    });
}

module.exports = { extractArticle, fetchHtml };
