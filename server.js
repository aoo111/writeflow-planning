/**
 * WriteFlow AI 로컬 서버 (`npm start`).
 * 배포(Vercel)에서는 이 파일 대신 api/*.js 함수가 같은 lib/ 코드를 실행한다.
 * - 정적 파일(index.html 등) 제공
 * - GET  /api/article?url=...  뉴스 원문 본문 가져오기 (lib/article.js)
 * - POST /api/generate         OpenRouter로 AI 원고 생성 (lib/generate.js)
 * 외부 패키지 없이 Node 내장 기능만 사용한다.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;

// .env 파일이 있으면 환경변수로 불러온다 (Node 20.12+ 내장 기능).
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // .env 가 없으면 그냥 넘어간다. 키가 없으면 /api/generate 가 안내 메시지를 돌려준다.
}

const { handleArticle } = require("./lib/article");
const { handleGenerate, DEFAULT_MODEL } = require("./lib/generate");

const port = Number(process.env.PORT || 8820);

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

http
  .createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (reqUrl.pathname === "/api/article") return handleArticle(req, res);
    if (reqUrl.pathname === "/api/generate") return handleGenerate(req, res);
    serveStatic(reqUrl, res);
  })
  .listen(port, () => {
    console.log(`WriteFlow AI: http://localhost:${port}`);
    console.log(
      process.env.OPENROUTER_API_KEY
        ? `AI 모델: ${process.env.AI_MODEL || DEFAULT_MODEL}`
        : "⚠ OPENROUTER_API_KEY 가 없어 원고 생성은 비활성 상태예요 (.env 확인)"
    );
    console.log(process.env.ACCESS_CODE ? "🔒 접근 코드 잠금 사용 중" : "접근 코드 없음 (로컬에서는 잠금 없이 동작)");
  });
