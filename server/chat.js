/**
 * Anthropic 호출을 만드는 부분. 서버와 점검 스크립트(scripts/checkApi.js)가 같은 요청 모양을 쓴다.
 *
 * Claude Opus 5.5 / Sonnet 5.5 기준:
 * - thinking은 보내지 않는다(기본 적응형). disabled나 budget_tokens를 보내면 400이다.
 * - temperature, top_p, top_k, 어시스턴트 prefill은 보내지 않는다.
 * - effort는 output_config.effort로 보낸다. effort를 지원하지 않는 모델은 CHATBOT_EFFORT=none.
 */
export function buildRequest({ config, systemPrompt, messages }) {
  const request = {
    model: config.model,
    max_tokens: config.maxTokens,
    // 시스템 프롬프트는 모든 학생이 똑같으므로 캐시해서 비용과 지연을 줄인다.
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (config.effort !== 'none') request.output_config = { effort: config.effort };
  return request;
}

/** 카드를 쓰는 차시의 첫 메시지: 1차시 정리 카드를 학생 글 앞에 붙인다. */
export function withCard(card, message) {
  return card ? `[1차시 정리 카드]\n${card}\n\n${message}` : message;
}

const HEADER_RE = /^\s*\[단계\s*(\d)\s*\/\s*(\d)\s*·\s*([^\]\n]+)\]/;

/** 챗봇 응답 첫 줄의 `[단계 n/전체 · 이름]`에서 단계를 읽는다. 전체 단계 수가 다르면 무시한다. */
export function parseStage(text, total = 6) {
  const m = HEADER_RE.exec(text || '');
  if (!m) return null;
  const stage = Number(m[1]);
  if (Number(m[2]) !== total || stage < 1 || stage > total) return null;
  return { stage, name: m[3].trim() };
}

export function textOf(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
