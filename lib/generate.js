/**
 * AI 원고 생성: 주제·사실 메모·크리에이터의 관점을 받아 OpenRouter로 해설 원고를 만든다.
 * 기사 본문은 받지 않는다. 기사는 소재 발견·출처 표시에만 쓰고, 원고는 사실과 관점으로 새로 쓴다.
 */
const { sendJson, readJsonBody, checkAccess } = require("./http");
const { callOpenRouter, clip, formatChannel, DEFAULT_MODEL } = require("./openrouter");

const GENERATE_TIMEOUT_MS = 180000;
const MAX_FACTS_CHARS = 3000;
const MAX_PRIMARY_SOURCES = 3;

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

// 같은 틀의 원고가 반복되지 않도록 전개 방식을 매번 하나 골라 쓴다.
const STRUCTURES = [
  { name: "질문형", guide: "시청자·독자에게 던지는 질문으로 시작해, 그 답을 함께 찾아가는 흐름으로 전개한다." },
  { name: "결론 먼저", guide: "크리에이터의 핵심 주장을 첫머리에 밝히고, 사실과 해설로 근거를 채워 간다." },
  { name: "비교형", guide: "이 소식을 비슷한 사례나 이전 상황과 비교하며 무엇이 다르고 왜 중요한지 짚는다." },
  { name: "장면형", guide: "이 소식이 영향을 줄 법한 구체적인 장면을 그리며 시작하고, 사실과 해설로 넘어간다. 장면은 가정임이 드러나게 쓴다." },
  { name: "통념 뒤집기", guide: "흔히 가질 만한 생각을 먼저 꺼내고, 사실과 크리에이터의 관점으로 다시 보게 만든다." },
];

const SYSTEM_PROMPT = `당신은 1인 크리에이터를 돕는 한국어 해설 콘텐츠 작가입니다.
기사를 다시 쓰는 것이 아니라, 확인된 사실을 소재로 크리에이터의 관점이 담긴 독립적인 해설 콘텐츠를 씁니다.

규칙:
- 사실 메모에 있는 사실(인물, 기관, 숫자, 날짜)만 사용하고, 없는 사실을 지어내지 않습니다. 사실 메모가 없으면 일반적으로 알려진 내용만 쓰고, 확실하지 않은 숫자나 사실은 쓰지 않습니다.
- 사실 메모의 문장을 그대로 옮기거나 순서대로 바꿔 쓰지 않습니다. 사실은 재료일 뿐이고 도입·구성·표현은 새로 만듭니다.
- 크리에이터의 관점을 원고의 중심 논지로 삼습니다. 관점 답변 중 평가는 논지와 톤에, 강조점은 본문에서 가장 비중 있게 다룰 부분에, 전망은 마무리 방향에 반영합니다. 답변이 없는 부분은 채널 기본 관점을 따릅니다.
- 기타 의견에 크리에이터의 경험이나 생각이 있으면 원고에 자연스럽게 살립니다. 크리에이터가 말하지 않은 개인 경험은 지어내지 않습니다.
- 단순한 사실 나열보다 해설(왜 중요한가, 배경, 의미, 시청자·독자에게 주는 시사점)이 절반 이상이 되게 씁니다. 사실과 의견은 구분되게 씁니다.
- 직접 인용은 꼭 필요할 때만 짧게 따옴표로 쓰고 누가 한 말인지 밝힙니다.
- 원고의 제목(제목 후보 포함)은 기사 제목이나 입력된 주제 문장을 그대로 쓰지 말고 새로 짓습니다.
- 출처나 참고자료 목록은 쓰지 않습니다. 서비스가 원고 끝에 자동으로 붙입니다.
- 마크다운 기호(#, **, - 목록 등)는 쓰지 않고, 그대로 복사해 쓸 수 있는 일반 텍스트로 씁니다.
- 원고 본문만 출력합니다. "네, 작성하겠습니다" 같은 안내 문장은 쓰지 않습니다.`;

function formatPerspective({ answers, opinion }) {
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`);
  if (opinion) lines.push(`- 기타 의견: ${opinion}`);
  return lines.length ? `크리에이터의 관점:\n${lines.join("\n")}` : "크리에이터의 관점: 따로 답하지 않음 (채널 기본 관점을 따른다)";
}

function buildUserPrompt({ topic, facts, type, style, length, structure, perspective, channel }) {
  return [
    [
      `주제: ${topic}`,
      `콘텐츠 유형: ${type} — ${TYPE_GUIDE[type]}`,
      `스타일: ${style} — ${STYLE_GUIDE[style]}`,
      `분량: ${LENGTH_GUIDE[type][length]}`,
      `전개 방식: ${structure.name} — ${structure.guide}`,
    ].join("\n"),
    formatPerspective(perspective),
    formatChannel(channel),
    facts ? `사실 메모:\n"""\n${facts}\n"""` : "사실 메모: 없음",
  ].filter(Boolean).join("\n\n");
}

// 원고 끝에 붙일 참고자료 목록. AI에게 맡기지 않고 입력받은 출처로 직접 만든다.
function buildSourceList({ news, primarySources }) {
  const lines = [];
  if (news.title) {
    const parts = [news.source, `「${news.title}」`, news.date].filter(Boolean).join(", ");
    lines.push(`- ${parts}${news.link ? " " + news.link : ""}`);
  }
  primarySources.forEach((url) => lines.push(`- ${url}`));
  return lines.length ? `참고자료\n${lines.join("\n")}` : "";
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function readPerspective(input) {
  const answers = (Array.isArray(input?.answers) ? input.answers : [])
    .slice(0, 3)
    .map((a) => ({ question: clip(a?.question, 120), answer: clip(a?.answer, 60) }))
    .filter((a) => a.question && a.answer);
  return { answers, opinion: clip(input?.opinion, 500) };
}

function readSources(input) {
  const news = {
    title: clip(input?.news?.title, 200),
    source: clip(input?.news?.source, 50),
    date: clip(input?.news?.date, 20),
    link: isHttpUrl(clip(input?.news?.link, 500)) ? clip(input?.news?.link, 500) : "",
  };
  const primarySources = (Array.isArray(input?.primary) ? input.primary : [])
    .map((url) => clip(url, 500))
    .filter(isHttpUrl)
    .slice(0, MAX_PRIMARY_SOURCES);
  return { news, primarySources };
}

async function handleGenerate(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST 요청만 받아요." });
  if (!checkAccess(req, res)) return;

  let input;
  try {
    input = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  const topic = clip(input.topic, 100);
  const facts = clip(input.facts, MAX_FACTS_CHARS);
  const { type, style, length } = input;
  if (!topic) return sendJson(res, 400, { ok: false, error: "주제를 입력해 주세요." });
  if (!TYPE_GUIDE[type] || !STYLE_GUIDE[style] || !LENGTH_GUIDE.Blog[length]) {
    return sendJson(res, 400, { ok: false, error: "콘텐츠 유형·스타일·길이 값이 올바르지 않아요." });
  }

  const structure = STRUCTURES[Math.floor(Math.random() * STRUCTURES.length)];
  const perspective = readPerspective(input.perspective);
  const sources = readSources(input.sources);

  const result = await callOpenRouter({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({ topic, facts, type, style, length, structure, perspective, channel: input.channel }),
    maxTokens: 8000,
    timeoutMs: GENERATE_TIMEOUT_MS,
    tag: "generate",
  });
  if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
  if (!result.text) return sendJson(res, 502, { ok: false, error: "AI가 빈 원고를 돌려줬어요. 다시 시도해 주세요." });

  const sourceList = buildSourceList(sources);
  sendJson(res, 200, {
    ok: true,
    text: sourceList ? `${result.text}\n\n${sourceList}` : result.text,
    structure: structure.name,
    model: result.model,
    truncated: result.truncated,
    usage: result.usage,
  });
}

module.exports = { handleGenerate, DEFAULT_MODEL };
