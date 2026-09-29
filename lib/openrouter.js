/**
 * OpenRouter 호출 공통 기능: 원고 생성(lib/generate.js)과 관점 질문 생성(lib/questions.js)이 함께 쓴다.
 * API 키는 환경변수 OPENROUTER_API_KEY 에서만 읽고 브라우저에는 절대 보내지 않는다.
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

const OPENROUTER_ERRORS = {
  401: "API 키가 올바르지 않아요. OPENROUTER_API_KEY 값을 확인해 주세요.",
  402: "OpenRouter 크레딧이 부족하거나 키의 사용 한도에 도달했어요. 충전 또는 한도를 확인해 주세요.",
  429: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
};

/**
 * 성공하면 { ok: true, text, model, truncated, usage },
 * 실패하면 { ok: false, status, error } (status 는 브라우저에 돌려줄 HTTP 상태 코드)를 돌려준다.
 */
async function callOpenRouter({ system, user, maxTokens, timeoutMs, tag }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "API 키가 설정되지 않았어요. OPENROUTER_API_KEY 를 설정해 주세요. (로컬: .env 파일, 배포: Vercel 환경변수)",
    };
  }

  const model = process.env.AI_MODEL || DEFAULT_MODEL;
  try {
    const aiRes = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "WriteFlow AI",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    const data = await aiRes.json().catch(() => ({}));
    if (!aiRes.ok || data.error) {
      const status = aiRes.ok ? data.error?.code : aiRes.status;
      console.error(`[${tag}] OpenRouter error`, status, data.error?.message);
      return {
        ok: false,
        status: 502,
        error: OPENROUTER_ERRORS[status] || `AI 응답에 실패했어요. (${data.error?.message || "HTTP " + status})`,
      };
    }

    const choice = data.choices?.[0];
    const text = (choice?.message?.content || "").trim();
    console.log(`[${tag}] ${data.model || model} · 입력 ${data.usage?.prompt_tokens ?? "?"} / 출력 ${data.usage?.completion_tokens ?? "?"} 토큰`);
    return {
      ok: true,
      text,
      model: data.model || model,
      truncated: choice?.finish_reason === "length",
      usage: data.usage || null,
    };
  } catch (err) {
    console.error(`[${tag}]`, err);
    return {
      ok: false,
      status: 502,
      error: err.name === "TimeoutError" ? "AI 응답이 너무 오래 걸려요. 다시 시도해 주세요." : "AI 서버에 연결하지 못했어요.",
    };
  }
}

// 브라우저에서 온 값을 문자열로 바꾸고 길이를 제한한다.
function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

// 채널 기본 관점 (브라우저의 ⚙ 채널 설정). 비어 있는 항목은 뺀다.
const CHANNEL_FIELDS = [
  ["intro", "채널 소개"],
  ["audience", "주 시청자·독자"],
  ["view", "기본 관점"],
  ["avoid", "피하고 싶은 것"],
];

function formatChannel(channel) {
  const lines = CHANNEL_FIELDS.map(([key, label]) => {
    const value = clip(channel?.[key], 150);
    return value ? `- ${label}: ${value}` : "";
  }).filter(Boolean);
  return lines.length ? `채널 기본 관점:\n${lines.join("\n")}` : "";
}

module.exports = { callOpenRouter, clip, formatChannel, DEFAULT_MODEL };
