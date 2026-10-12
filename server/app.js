import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { MAX_CARD_CHARS, STUDENT_ID_RE } from './cards.js';
import { buildRequest, parseStage, textOf, withCard } from './chat.js';
import { publicLessons } from './lessons.js';
import { DailyCap, InFlight, SlidingWindowLimiter } from './limits.js';
import { detectRisk } from './safety.js';
import { signState, StateError, verifyState } from './state.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MSG = {
  badCode: '수업 코드가 맞지 않아요. 선생님께 다시 확인해 주세요.',
  rateCode: '수업 코드를 너무 많이 틀렸어요. 1분 뒤에 다시 시도해 주세요.',
  empty: '메시지를 입력해 주세요.',
  tooLongTurns: '대화가 너무 길어져 더 이어갈 수 없어요. 위쪽의 "대화 내려받기"로 지금까지의 대화를 저장한 뒤 선생님께 알려 주세요.',
  rateSession: '너무 빠르게 보내고 있어요. 잠시 뒤에 다시 보내 주세요.',
  rateIp: '지금 접속한 학생이 많아요. 잠시 뒤에 다시 보내 주세요.',
  daily: '오늘 사용할 수 있는 횟수를 모두 썼어요. 선생님께 알려 주세요.',
  busy: '이전 답변이 아직 오는 중이에요. 끝난 뒤에 보내 주세요.',
  refusal: '이 내용에는 답을 드릴 수 없어요. 다른 방식으로 물어보거나 선생님께 도움을 요청해 주세요.',
  serverConfig: '챗봇 서버 설정에 문제가 있어요. 선생님께 알려 주세요.',
  billing: '챗봇 사용 한도에 도달했어요. 선생님께 알려 주세요.',
  stale: '수업 내용이 업데이트되어 이 대화를 이어갈 수 없어요. "처음부터 다시"를 눌러 새로 시작해 주세요.',
  truncated: '답변이 너무 길어서 중간에 끊겼어요. 다시 보내 주세요.',
  overloaded: '지금 이용하는 사람이 많아요. 잠시 뒤에 다시 보내 주세요.',
  connection: '연결이 불안정해요. 잠시 뒤에 다시 보내 주세요.',
  generic: '답변을 만들지 못했어요. 다시 보내 보거나 처음부터 시작해 주세요.',
  badRequest: '요청을 처리하지 못했어요. "처음부터 다시"를 눌러 새로 시작해 주세요.',
  badLesson: '아직 열리지 않은 차시예요. 차시를 다시 골라 주세요.',
  otherLesson: '다른 차시의 대화 정보예요. "처음부터 다시"를 눌러 새로 시작해 주세요.',
  tooLongCard: `정리 카드는 ${MAX_CARD_CHARS}자까지 보낼 수 있어요.`,
  cardsOff: '학번으로 정리 카드를 저장하는 기능이 꺼져 있어요. 카드를 복사해서 보관해 주세요.',
  rateCards: '요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.',
  badStudentId: '학번은 숫자 5자리로 입력해 주세요. (예: 20101)',
  badCard: '챗봇이 대화에서 만든 정리 카드만 저장할 수 있어요.',
  noCard: '이 학번으로 저장된 1차시 정리 카드가 없어요. 학번을 확인하거나, 카드를 직접 붙여 넣어 주세요.',
  cardsFailed: '정리 카드를 저장하거나 불러오지 못했어요. 잠시 뒤에 다시 시도해 주세요.',
};

function sha(text) {
  return createHash('sha256').update(String(text)).digest();
}

/** 수업 코드를 시간 일정하게 비교한다. */
function codeMatches(given, expected) {
  return timingSafeEqual(sha(given ?? ''), sha(expected));
}

/** 제어 문자를 지우고 앞뒤 공백을 자른다. 문자열이 아니면 빈 문자열. */
function cleanText(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() : '';
}

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function describeError(err) {
  const status = err?.status;
  const type = String(err?.error?.error?.type ?? err?.error?.type ?? '');
  const noKey = /Could not resolve authentication method/i.test(String(err?.message || ''));
  if (noKey || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || status === 401 || status === 403) {
    return { code: 'server_config', user: MSG.serverConfig, level: 'error', detail: noKey ? 'ANTHROPIC_API_KEY가 설정되지 않았어요' : 'API 키 또는 권한 오류' };
  }
  if (status === 402 || type === 'billing_error') {
    return { code: 'billing', user: MSG.billing, level: 'error', detail: 'Anthropic 결제 또는 사용 한도 문제' };
  }
  if (status === 413 || type === 'request_too_large') {
    return { code: 'too_long', user: MSG.tooLongTurns, level: 'warn', detail: '요청이 너무 큼' };
  }
  if (err instanceof Anthropic.RateLimitError || status === 429 || status === 529 || (status >= 500 && status < 600) || type === 'overloaded_error' || type === 'api_error') {
    return { code: 'busy', user: MSG.overloaded, level: 'warn', detail: `Anthropic ${status ?? type}` };
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || status === 400 || status === 404) {
    return { code: 'bad_request', user: MSG.badRequest, level: 'error', detail: `Anthropic ${status}: ${err.message}` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: 'connection', user: MSG.connection, level: 'warn', detail: '연결 오류' };
  }
  return { code: 'generic', user: MSG.generic, level: 'error', detail: String(err?.message || err) };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./config.js').loadConfig>} deps.config
 * @param {Anthropic} deps.client
 * @param {{enabled: boolean, log: Function}} deps.logger
 * @param {ReturnType<import('./lessons.js').loadLessons>} deps.lessons
 * @param {ReturnType<import('./cards.js').createCardStore>} [deps.cardStore] 학번 카드 저장소(꺼져 있으면 null)
 */
export function createApp({ config, client, logger, lessons, cardStore = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  const sessionLimiter = new SlidingWindowLimiter({ max: config.perSessionPerMinute, windowMs: 60_000 });
  const ipLimiter = new SlidingWindowLimiter({ max: config.perIpPerMinute, windowMs: 60_000 });
  const startLimiter = new SlidingWindowLimiter({ max: config.newConversationsPerIpPerMinute, windowMs: 60_000 });
  const badCodeLimiter = new SlidingWindowLimiter({ max: config.badCodePerIpPerMinute, windowMs: 60_000 });
  const cardLimiter = new SlidingWindowLimiter({ max: config.cardRequestsPerIpPerMinute, windowMs: 60_000 });
  const daily = new DailyCap(config.dailyRequestCap);
  const inflight = new InFlight();
  let activeStreams = 0;

  /**
   * 수업 코드 검사. 틀리면 응답을 보내고 true를 돌려준다.
   * 틀린 코드를 계속 대입하는 것을 막는다. 한도를 넘으면 맞는 코드도 잠시 받지 않는다
   * (맞는 코드만 통과시키면 응답 차이로 코드를 알아낼 수 있다).
   */
  function rejectedByCode(req, res, body) {
    if (!config.accessCode) return false;
    const ip = req.ip || 'unknown';
    if (badCodeLimiter.count(ip) >= config.badCodePerIpPerMinute) {
      fail(res, 429, 'rate_code', MSG.rateCode);
      return true;
    }
    if (!codeMatches(body.accessCode, config.accessCode)) {
      badCodeLimiter.take(ip);
      fail(res, 401, 'bad_code', MSG.badCode);
      return true;
    }
    return false;
  }

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  // 긴 대화의 대화 정보(최대 maxStateChars자)를 받을 수 있게 한다.
  app.use(express.json({ limit: Math.max(400_000, config.maxStateChars + 100_000) }));
  app.use(express.static(publicDir, { maxAge: 0, etag: true }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, promptVersions: Object.fromEntries([...lessons].map(([id, l]) => [id, l.prompt.version])) });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      requiresAccessCode: !!config.accessCode,
      logging: !!logger.enabled,
      cardStorage: !!cardStore,
      maxChars: config.maxStudentChars,
      maxCardChars: MAX_CARD_CHARS,
      lessons: publicLessons().map((l) => ({ ...l, available: l.available && lessons.has(l.id) })),
    });
  });

  app.post('/api/chat', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ip = req.ip || 'unknown';

    if (rejectedByCode(req, res, body)) return;

    const message = cleanText(body.message);
    if (!message) return fail(res, 400, 'empty', MSG.empty);
    if ([...message].length > config.maxStudentChars) {
      return fail(res, 400, 'too_long_message', `메시지는 ${config.maxStudentChars}자까지 보낼 수 있어요.`);
    }

    // 차시 번호가 없는 요청과 대화 정보는 1차시로 본다(차시를 나누기 전에 시작한 대화도 이어지게).
    const requestedLesson = body.lesson === undefined ? 1 : Number(body.lesson);
    if (!lessons.has(requestedLesson)) return fail(res, 400, 'bad_lesson', MSG.badLesson);

    // 대화 정보가 한도에 거의 찼으면, 답을 만들기 전에(비용을 쓰기 전에) 멈춘다.
    if (typeof body.state === 'string' && body.state.length > config.maxStateChars * 0.95) {
      console.warn(`[chat] 대화 길이 한도(크기)에 닿았어요. 차시=${requestedLesson}`);
      return fail(res, 400, 'too_long', MSG.tooLongTurns);
    }

    let sid;
    let history;
    let lesson;
    if (body.state) {
      try {
        const payload = verifyState(body.state, config.sessionSecret, {
          maxAgeMs: config.sessionMaxAgeMs,
          maxChars: config.maxStateChars,
        });
        if (payload.messages.length % 2 !== 0) throw new StateError('대화 정보가 올바르지 않아요.');
        if ((payload.l ?? 1) !== requestedLesson) throw new StateError(MSG.otherLesson);
        lesson = lessons.get(requestedLesson);
        // 프롬프트나 모델이 바뀌면 이전 응답(thinking 블록)이 더는 맞지 않아 API가 거절할 수 있다.
        if (payload.pv !== lesson.prompt.version || payload.m !== config.model) throw new StateError(MSG.stale);
        sid = payload.sid;
        history = payload.messages;
      } catch (err) {
        const text = err instanceof StateError ? err.message : '대화 정보가 올바르지 않아요.';
        return fail(res, 400, 'bad_state', text.includes('처음부터 다시') ? text : `${text} "처음부터 다시"를 눌러 새로 시작해 주세요.`);
      }
    } else {
      sid = randomUUID();
      history = [];
      lesson = lessons.get(requestedLesson);
    }

    // 1차시 정리 카드는 카드를 쓰는 차시의 첫 메시지에만 붙인다.
    const card = !body.state && lesson.usesCard ? cleanText(body.card) : '';
    if ([...card].length > MAX_CARD_CHARS) return fail(res, 400, 'too_long_card', MSG.tooLongCard);

    if (history.length / 2 >= config.maxTurns) {
      console.warn(`[chat] 대화 길이 한도(주고받기 ${config.maxTurns}번)에 닿았어요. 차시=${lesson.id} 세션=${sid.slice(0, 8)}`);
      return fail(res, 400, 'too_long', MSG.tooLongTurns);
    }

    // 싸게 거절할 수 있는 검사를 먼저 하고, 공용 주소 한도와 하루 상한은
    // 실제로 Anthropic까지 가는 요청에만 쓴다. 한 학생이 반 전체의 한도를 태우지 못하게 하기 위해서다.
    if (!body.state) {
      // 상태 없이 보내면 매번 새 대화라서 대화별 제한을 피할 수 있으므로 주소별로 따로 막는다.
      if (!startLimiter.take(ip)) return fail(res, 429, 'rate_ip', MSG.rateIp);
      sessionLimiter.take(sid); // 새 대화의 첫 요청도 이 대화의 횟수에 센다
    } else if (!sessionLimiter.take(sid)) {
      return fail(res, 429, 'rate_session', MSG.rateSession);
    }
    if (!inflight.acquire(sid)) return fail(res, 409, 'in_flight', MSG.busy);
    if (activeStreams >= config.maxConcurrentStreams) {
      inflight.release(sid);
      return fail(res, 429, 'busy', MSG.overloaded);
    }
    if (!ipLimiter.take(ip)) {
      inflight.release(sid);
      return fail(res, 429, 'rate_ip', MSG.rateIp);
    }
    if (!daily.take()) {
      inflight.release(sid);
      return fail(res, 429, 'daily_cap', MSG.daily);
    }
    activeStreams += 1;

    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 30) : '';
    const flagged = detectRisk(message);
    if (flagged) console.warn(`[FLAG] 위기 신호가 의심되는 대화예요. 차시=${lesson.id} 세션=${sid.slice(0, 8)}`);
    const logBase = { sessionId: sid, lesson: lesson.id, label, flagged, model: config.model, promptVersion: lesson.prompt.version, student: message };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) aborter.abort();
    });

    const nextMessages = [...history, { role: 'user', content: withCard(card, message) }];

    try {
      const request = buildRequest({ config, systemPrompt: lesson.prompt.text, messages: nextMessages });
      const stream = client.messages.stream(request, { signal: aborter.signal });
      stream.on('text', (delta) => send('delta', { text: delta }));
      const final = await stream.finalMessage();

      const usage = final.usage || {};
      console.log(
        `[chat] 차시=${lesson.id} 세션=${sid.slice(0, 8)} 턴=${Math.ceil(nextMessages.length / 2)} 정지=${final.stop_reason} 입력=${usage.input_tokens ?? '-'} 캐시읽기=${usage.cache_read_input_tokens ?? 0} 출력=${usage.output_tokens ?? '-'}`,
      );

      if (final.stop_reason === 'refusal') {
        send('refusal', { message: MSG.refusal });
        await logger.log({ ...logBase, stage: null, tutor: null });
        return;
      }
      if (final.stop_reason === 'model_context_window_exceeded') {
        send('error', { code: 'too_long', message: MSG.tooLongTurns });
        return;
      }
      if (final.stop_reason === 'max_tokens') {
        // 잘린 답변은 질문이 빠졌을 수 있어 기록에 남기지 않고 다시 보내게 한다.
        send('error', { code: 'truncated', message: MSG.truncated });
        return;
      }

      const text = textOf(final.content);
      if (!text.trim()) {
        send('error', { code: 'empty_reply', message: MSG.generic });
        return;
      }

      const state = signState(
        { v: 1, sid, l: lesson.id, pv: lesson.prompt.version, m: config.model, iat: Date.now(), messages: [...nextMessages, { role: 'assistant', content: final.content }] },
        config.sessionSecret,
      );
      if (state.length > config.maxStateChars) {
        console.warn(`[chat] 대화 길이 한도(크기)를 답변 뒤에 넘었어요. 차시=${lesson.id} 세션=${sid.slice(0, 8)}`);
        send('error', { code: 'too_long', message: MSG.tooLongTurns });
        return;
      }

      const stage = parseStage(text, lesson.stages.length);
      // 한도에 가까워지면 화면이 미리 알려 주도록 남은 횟수를 함께 보낸다.
      const turnsLeft = config.maxTurns - (history.length / 2 + 1);
      const nearLimit = turnsLeft <= 5 || state.length > config.maxStateChars * 0.8;
      send('done', { state, stage: stage?.stage ?? null, stageName: stage?.name ?? null, turnsLeft, nearLimit });
      // 서버리스(Vercel)에서는 응답을 닫으면 함수가 멈출 수 있어서, 기록을 마친 뒤에 닫는다.
      await logger.log({ ...logBase, stage: stage?.stage ?? null, tutor: text });
    } catch (err) {
      if (aborter.signal.aborted) return; // 학생이 창을 닫았거나 연결이 끊김
      const info = describeError(err);
      console[info.level === 'error' ? 'error' : 'warn'](`[chat] 실패(${info.code}): ${info.detail}`);
      daily.refund(); // 응답을 못 만들었으니 하루 상한에서 되돌린다
      send('error', { code: info.code, message: info.user });
    } finally {
      clearInterval(ping);
      activeStreams -= 1;
      inflight.release(sid);
      res.end();
    }
  });

  /** 카드 요청 공통 검사. 통과하면 학번을, 아니면 응답을 보내고 null을 돌려준다. */
  function checkCardRequest(req, res, body) {
    if (!cardStore) {
      fail(res, 404, 'cards_off', MSG.cardsOff);
      return null;
    }
    if (rejectedByCode(req, res, body)) return null;
    if (!cardLimiter.take(req.ip || 'unknown')) {
      fail(res, 429, 'rate_cards', MSG.rateCards);
      return null;
    }
    const studentId = cleanText(body.studentId);
    if (!STUDENT_ID_RE.test(studentId)) {
      fail(res, 400, 'bad_student_id', MSG.badStudentId);
      return null;
    }
    return studentId;
  }

  app.post('/api/cards/save', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const studentId = checkCardRequest(req, res, body);
    if (!studentId) return;

    const card = cleanText(body.card);
    if (!card || [...card].length > MAX_CARD_CHARS) return fail(res, 400, 'bad_card', MSG.badCard);
    let payload;
    try {
      payload = verifyState(body.state, config.sessionSecret, { maxAgeMs: config.sessionMaxAgeMs, maxChars: config.maxStateChars });
    } catch (err) {
      const text = err instanceof StateError ? err.message : '대화 정보가 올바르지 않아요.';
      return fail(res, 400, 'bad_state', text);
    }
    // 학생이 지어낸 글이 아니라, 서버가 서명한 1차시 대화에서 챗봇이 보여 준 카드인지 확인한다.
    // 화면의 '정리 카드 복사'와 같은 규칙으로 잘라 낸 글이므로 굵게 표시(**)를 빼고 비교한다.
    const lesson1 = lessons.get(1);
    const shown = (payload.l ?? 1) === 1 && lesson1?.makesCard
      && payload.messages.some((m) => m.role === 'assistant' && textOf(m.content).replace(/\*\*/g, '').includes(card));
    if (!shown || !card.includes('선택한 기술')) return fail(res, 400, 'bad_card', MSG.badCard);

    try {
      await cardStore.save({ studentId, card, sessionId: payload.sid, promptVersion: payload.pv });
    } catch (err) {
      console.error(`[cards] ${err.message}`);
      return fail(res, 502, 'cards_failed', MSG.cardsFailed);
    }
    res.json({ ok: true });
  });

  app.post('/api/cards/load', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const studentId = checkCardRequest(req, res, body);
    if (!studentId) return;

    let found;
    try {
      found = await cardStore.load(studentId);
    } catch (err) {
      console.error(`[cards] ${err.message}`);
      return fail(res, 502, 'cards_failed', MSG.cardsFailed);
    }
    if (!found) return fail(res, 404, 'no_card', MSG.noCard);
    res.json(found);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: '없는 주소예요.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: '보낸 내용이 너무 커요. 처음부터 다시 시작해 주세요.' });
    if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: '요청 형식이 올바르지 않아요.' });
    console.error(`[server] 처리되지 않은 오류: ${err?.message || err}`);
    res.status(500).json({ error: 'server_error', message: MSG.generic });
  });

  app.close = () => {
    sessionLimiter.close();
    ipLimiter.close();
    startLimiter.close();
    badCodeLimiter.close();
    cardLimiter.close();
  };
  return app;
}
