/**
 * API 공통 기능: JSON 응답, 요청 본문 읽기, 접근 코드 검사.
 * 로컬 서버(server.js)와 Vercel 함수(api/*.js)가 함께 사용한다.
 */
const crypto = require("crypto");

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  // Vercel은 JSON 본문을 미리 읽어 req.body에 넣어 준다.
  if (req.body !== undefined) {
    if (typeof req.body !== "string") return Promise.resolve(req.body || {});
    try {
      return Promise.resolve(JSON.parse(req.body || "{}"));
    } catch {
      return Promise.reject(new Error("요청 형식이 올바르지 않아요."));
    }
  }

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

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest();
}

/**
 * 운영자만 원고 작성·원문 가져오기를 쓸 수 있도록 접근 코드를 확인한다.
 * - 환경변수 ACCESS_CODE 와 요청 헤더 X-Access-Code 가 같아야 통과한다.
 * - 배포 환경(Vercel)에서 ACCESS_CODE 가 비어 있으면 모두 막는다 (설정 실수로 열리지 않도록).
 * - 로컬 개발에서 ACCESS_CODE 가 비어 있으면 검사하지 않는다.
 * 통과하면 true, 막았으면 응답을 보내고 false 를 돌려준다.
 */
function checkAccess(req, res) {
  const expected = process.env.ACCESS_CODE || "";
  if (!expected) {
    if (!process.env.VERCEL) return true;
    sendJson(res, 503, {
      ok: false,
      code: "ACCESS_NOT_CONFIGURED",
      error: "서버에 ACCESS_CODE 가 설정되지 않아 원고 작성이 잠겨 있어요.",
    });
    return false;
  }

  let given = String(req.headers["x-access-code"] || "");
  try {
    given = decodeURIComponent(given);
  } catch {
    // 인코딩되지 않은 값이면 그대로 비교한다.
  }

  // 길이·내용이 달라도 비교 시간이 같도록 해시끼리 비교한다.
  if (given && crypto.timingSafeEqual(sha256(given), sha256(expected))) return true;

  sendJson(res, 401, {
    ok: false,
    code: "ACCESS_REQUIRED",
    error: given ? "접근 코드가 올바르지 않아요." : "원고 작성은 운영자만 사용할 수 있어요. 접근 코드를 입력해 주세요.",
  });
  return false;
}

module.exports = { sendJson, readJsonBody, checkAccess };
