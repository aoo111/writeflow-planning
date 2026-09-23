/**
 * AI 원고 생성: 콘텐츠 설정을 받아 OpenRouter로 원고를 만든다.
 * API 키는 환경변수 OPENROUTER_API_KEY 에서만 읽고 브라우저에는 절대 보내지 않는다.
 */
const { sendJson, readJsonBody, checkAccess } = require("./http");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
const GENERATE_TIMEOUT_MS = 180000;

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

const OPENROUTER_ERRORS = {
  401: "API 키가 올바르지 않아요. OPENROUTER_API_KEY 값을 확인해 주세요.",
  402: "OpenRouter 크레딧이 부족하거나 키의 사용 한도에 도달했어요. 충전 또는 한도를 확인해 주세요.",
  429: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
};

async function handleGenerate(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST 요청만 받아요." });
  if (!checkAccess(req, res)) return;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, {
      ok: false,
      error: "API 키가 설정되지 않았어요. OPENROUTER_API_KEY 를 설정해 주세요. (로컬: .env 파일, 배포: Vercel 환경변수)",
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

module.exports = { handleGenerate, DEFAULT_MODEL };
