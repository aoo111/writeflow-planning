/**
 * 관점 질문 생성: 주제와 사실 메모를 보고 크리에이터에게 물어볼 질문 3개(평가·강조점·전망)와
 * 질문마다 고를 수 있는 보기 3개를 만든다. 기사 본문은 받지 않는다.
 */
const { sendJson, readJsonBody, checkAccess } = require("./http");
const { callOpenRouter, clip, formatChannel } = require("./openrouter");

const QUESTIONS_TIMEOUT_MS = 60000;

const SYSTEM_PROMPT = `당신은 1인 크리에이터가 뉴스 해설 콘텐츠의 관점을 정하도록 돕는 편집자입니다.
주어진 주제와 사실 메모를 보고, 크리에이터에게 물어볼 관점 질문 3개를 만듭니다. 질문은 반드시 아래 순서와 역할을 따릅니다.
1. 평가: 이 소식의 핵심 결정이나 사건을 어떻게 보는지 묻는다.
2. 강조점: 시청자·독자에게 가장 전하고 싶은 포인트가 무엇인지 묻는다.
3. 전망: 앞으로 어떻게 될 것 같은지 묻는다.

규칙:
- 질문은 이 소식에 맞게 구체적으로, 30자 안팎의 짧은 한 문장으로 씁니다.
- 질문마다 보기를 3개 만듭니다. 보기는 15자 이내의 짧은 구절입니다.
- 평가와 전망의 보기는 긍정적인 입장, 부정적·비판적인 입장, 중립·조건부 입장이 하나씩 되게 합니다.
- 강조점의 보기는 서로 다른 측면(예: 기술, 산업·시장, 일상·개인)을 다룹니다.
- 사실 메모에 없는 사실을 질문이나 보기에 지어내지 않습니다.
- 아래 JSON 형식으로만 답합니다. 다른 말은 쓰지 않습니다.
{"questions":[{"question":"...","options":["...","...","..."]},{"question":"...","options":["...","...","..."]},{"question":"...","options":["...","...","..."]}]}`;

// 모델이 JSON 앞뒤에 말을 붙이거나 코드 블록으로 감싸도 JSON 부분만 읽는다.
function parseQuestions(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const questions = (Array.isArray(data.questions) ? data.questions : [])
    .map((q) => ({
      question: clip(q?.question, 120),
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => clip(o, 40)).filter(Boolean).slice(0, 3),
    }))
    .filter((q) => q.question && q.options.length >= 2);
  return questions.length === 3 ? questions : null;
}

async function handleQuestions(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST 요청만 받아요." });
  if (!checkAccess(req, res)) return;

  let input;
  try {
    input = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  const topic = clip(input.topic, 100);
  const facts = clip(input.facts, 3000);
  if (!topic) return sendJson(res, 400, { ok: false, error: "주제를 먼저 입력해 주세요." });

  const user = [
    `주제: ${topic}`,
    formatChannel(input.channel),
    facts ? `사실 메모:\n"""\n${facts}\n"""` : "사실 메모: 없음",
  ].filter(Boolean).join("\n\n");

  const result = await callOpenRouter({
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 1000,
    timeoutMs: QUESTIONS_TIMEOUT_MS,
    tag: "questions",
  });
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });

  const questions = parseQuestions(result.text);
  if (!questions) {
    console.error("[questions] 형식이 맞지 않는 응답", result.text.slice(0, 300));
    return sendJson(res, 502, { ok: false, error: "관점 질문을 만들지 못했어요. 다시 시도해 주세요." });
  }
  sendJson(res, 200, { ok: true, questions });
}

module.exports = { handleQuestions };
