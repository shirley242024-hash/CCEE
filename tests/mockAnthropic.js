import { createServer } from 'node:http';

/**
 * Anthropic Messages API(스트리밍)를 흉내 내는 모의 서버. 테스트와 화면 확인용.
 * 시스템 프롬프트로 차시를 알아보고(2차시: '비판적 토론', 3차시: '설계 심사 챗봇'), 마지막 학생 메시지에 들어 있는 낱말로 동작이 바뀐다.
 *   REFUSE → 거절(stop_reason: refusal) / ERR401, ERR429, ERR500 → 해당 오류
 *   ERR402(결제/한도) / TRUNC(max_tokens로 잘림) / CARD(정리 카드가 든 응답)
 *   SLOW → 천천히 / EMPTY → 글 없이 thinking만 / 그 외 → 단계 머리글이 있는 정상 응답
 */
const STAGE_NAMES = {
  1: ['기술 고르기', '해결하려는 문제', '과학적 원리', '배출이 줄어드는 이유', '가장 큰 문제점', '나만의 탐구 질문'],
  2: ['주장 확인', '근거 확인', '주장-근거 연결 검토', '반론 제시', '반론 평가', '최종 판단과 성찰'],
  3: ['기존 기술의 문제 확인', '최초 설계안', '자기 점검', 'AI 설계 심사', '심사 의견 판단', '설계 수정', '최종 설계안', '수정 전후 비교 및 성찰'],
};

function lessonOf(system) {
  if (system.includes('설계 심사 챗봇')) return 3;
  if (system.includes('비판적 토론')) return 2;
  return 1;
}

function lastUserText(messages) {
  const last = messages[messages.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startMockAnthropic() {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'nope' } }));
      }
      const body = JSON.parse(raw);
      requests.push({ body, headers: req.headers });
      const text = lastUserText(body.messages);

      const error = (status, type, message) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type, message } }));
      };
      if (text.includes('ERR401')) return error(401, 'authentication_error', 'invalid x-api-key');
      if (text.includes('ERR402')) return error(402, 'billing_error', 'credit balance is too low');
      if (text.includes('ERR429')) return error(429, 'rate_limit_error', 'slow down');
      if (text.includes('ERR500')) return error(500, 'api_error', 'internal boom');

      const turn = body.messages.filter((m) => m.role === 'user').length;
      const lesson = lessonOf(body.system?.[0]?.text || '');
      const total = STAGE_NAMES[lesson].length;
      const stage = Math.min(turn, total);
      const header = `[단계 ${stage}/${total} · ${STAGE_NAMES[lesson][stage - 1]}]\n`;
      const delay = text.includes('SLOW') ? 250 : 0;

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: `msg_mock_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [],
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: requests.length > 1 ? 100 : 0, cache_creation_input_tokens: 0 },
        },
      });

      // thinking 블록(표시는 생략되고 서명만 온다)
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `SIG-${requests.length}` } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      if (delay) await sleep(delay);

      if (text.includes('EMPTY')) {
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
        sse(res, 'message_stop', { type: 'message_stop' });
        return res.end();
      }

      const truncate = text.includes('TRUNC');
      const refuse = text.includes('REFUSE');
      const card = text.includes('CARD');
      const cardReply = '[단계 6/6 · 나만의 탐구 질문 만들기]\n오늘 말해 준 내용을 정리 카드로 모아 볼게요.\n\n**정리 카드**\n- 선택한 기술: 수소차\n- 나만의 탐구 질문: \"수소를 만드는 과정까지 따지면 수소차는 탄소를 줄일까?\"\n\n다음 차시에서 이 탐구 질문으로 AI와 논쟁해 볼 거예요. 정리 카드는 저장해 두세요.\n\n그런데 하나만 더 물어볼게요. 이 질문을 고른 이유는 무엇인가요?';
      const reply = refuse ? '' : card ? cardReply : `${header}(데모 응답) 질문 ${turn}번에 답해 줘서 고마워요. 그 생각이 왜 그렇다고 생각하나요?`;
      sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      const chunks = refuse ? ['잠시만요'] : reply.match(/.{1,8}/gs);
      for (const chunk of chunks) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: chunk } });
        if (delay) await sleep(delay);
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });
      sse(res, 'message_delta', {
        type: 'message_delta',
        delta: refuse
          ? { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'general_harms', explanation: null } }
          : { stop_reason: truncate ? 'max_tokens' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 30 },
      });
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}
