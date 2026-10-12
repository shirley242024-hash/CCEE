import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { buildRequest, parseStage, textOf } from './chat.js';
import { DailyCap, InFlight, SlidingWindowLimiter } from './limits.js';
import { detectRisk } from './safety.js';
import { signState, StateError, verifyState } from './state.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MSG = {
  badCode: '수업 코드가 맞지 않아요. 선생님께 다시 확인해 주세요.',
  empty: '메시지를 입력해 주세요.',
  tooLongTurns: '대화가 너무 길어졌어요. "처음부터 다시"를 눌러 새로 시작해 주세요.',
  rateSession: '너무 빠르게 보내고 있어요. 잠시 뒤에 다시 보내 주세요.',
  rateIp: '지금 접속한 학생이 많아요. 잠시 뒤에 다시 보내 주세요.',
  daily: '오늘 사용할 수 있는 횟수를 모두 썼어요. 선생님께 알려 주세요.',
  busy: '이전 답변이 아직 오는 중이에요. 끝난 뒤에 보내 주세요.',
  refusal: '이 내용에는 답을 드릴 수 없어요. 다른 방식으로 물어보거나 선생님께 도움을 요청해 주세요.',
  serverConfig: '챗봇 서버 설정에 문제가 있어요. 선생님께 알려 주세요.',
  overloaded: '지금 이용하는 사람이 많아요. 잠시 뒤에 다시 보내 주세요.',
  connection: '연결이 불안정해요. 잠시 뒤에 다시 보내 주세요.',
  generic: '답변을 만들지 못했어요. 다시 보내 보거나 처음부터 시작해 주세요.',
  badRequest: '요청을 처리하지 못했어요. "처음부터 다시"를 눌러 새로 시작해 주세요.',
};

function sha(text) {
  return createHash('sha256').update(String(text)).digest();
}

/** 수업 코드를 시간 일정하게 비교한다. */
function codeMatches(given, expected) {
  return timingSafeEqual(sha(given ?? ''), sha(expected));
}

function describeError(err) {
  const status = err?.status;
  const noKey = /Could not resolve authentication method/i.test(String(err?.message || ''));
  if (noKey || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || status === 401 || status === 403) {
    return { code: 'server_config', user: MSG.serverConfig, level: 'error', detail: noKey ? 'ANTHROPIC_API_KEY가 설정되지 않았어요' : 'API 키 또는 권한 오류' };
  }
  if (err instanceof Anthropic.RateLimitError || status === 429 || status === 529 || (status >= 500 && status < 600)) {
    return { code: 'busy', user: MSG.overloaded, level: 'warn', detail: `Anthropic ${status}` };
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
 * @param {{text: string, version: string}} deps.systemPrompt
 */
export function createApp({ config, client, logger, systemPrompt }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  const sessionLimiter = new SlidingWindowLimiter({ max: config.perSessionPerMinute, windowMs: 60_000 });
  const ipLimiter = new SlidingWindowLimiter({ max: config.perIpPerMinute, windowMs: 60_000 });
  const daily = new DailyCap(config.dailyRequestCap);
  const inflight = new InFlight();

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.use(express.json({ limit: '400kb' }));
  app.use(express.static(publicDir, { maxAge: 0, etag: true }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, promptVersion: systemPrompt.version });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      requiresAccessCode: !!config.accessCode,
      logging: !!logger.enabled,
      maxChars: config.maxStudentChars,
      promptVersion: systemPrompt.version,
    });
  });

  app.post('/api/chat', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const fail = (status, error, message) => res.status(status).json({ error, message });

    if (config.accessCode && !codeMatches(body.accessCode, config.accessCode)) {
      return fail(401, 'bad_code', MSG.badCode);
    }

    // eslint-disable-next-line no-control-regex
    const message = typeof body.message === 'string' ? body.message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() : '';
    if (!message) return fail(400, 'empty', MSG.empty);
    if ([...message].length > config.maxStudentChars) {
      return fail(400, 'too_long_message', `메시지는 ${config.maxStudentChars}자까지 보낼 수 있어요.`);
    }

    let sid;
    let history;
    if (body.state) {
      try {
        const payload = verifyState(body.state, config.sessionSecret, {
          maxAgeMs: config.sessionMaxAgeMs,
          maxChars: config.maxStateChars,
        });
        if (payload.messages.length % 2 !== 0) throw new StateError('대화 정보가 올바르지 않아요.');
        sid = payload.sid;
        history = payload.messages;
      } catch (err) {
        const text = err instanceof StateError ? err.message : '대화 정보가 올바르지 않아요.';
        return fail(400, 'bad_state', `${text} "처음부터 다시"를 눌러 새로 시작해 주세요.`);
      }
    } else {
      sid = randomUUID();
      history = [];
    }

    if (history.length / 2 >= config.maxTurns) return fail(400, 'too_long', MSG.tooLongTurns);

    if (!ipLimiter.take(req.ip || 'unknown')) return fail(429, 'rate_ip', MSG.rateIp);
    if (!sessionLimiter.take(sid)) return fail(429, 'rate_session', MSG.rateSession);
    if (!daily.take()) return fail(429, 'daily_cap', MSG.daily);
    if (!inflight.acquire(sid)) return fail(409, 'in_flight', MSG.busy);

    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 30) : '';
    const flagged = detectRisk(message);
    if (flagged) console.warn(`[FLAG] 위기 신호가 의심되는 대화예요. 세션=${sid.slice(0, 8)}`);

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

    const nextMessages = [...history, { role: 'user', content: message }];

    try {
      const request = buildRequest({ config, systemPrompt: systemPrompt.text, messages: nextMessages });
      const stream = client.messages.stream(request, { signal: aborter.signal });
      stream.on('text', (delta) => send('delta', { text: delta }));
      const final = await stream.finalMessage();

      const usage = final.usage || {};
      console.log(
        `[chat] 세션=${sid.slice(0, 8)} 턴=${Math.ceil(nextMessages.length / 2)} 정지=${final.stop_reason} 입력=${usage.input_tokens ?? '-'} 캐시읽기=${usage.cache_read_input_tokens ?? 0} 출력=${usage.output_tokens ?? '-'}`,
      );

      if (final.stop_reason === 'refusal') {
        send('refusal', { message: MSG.refusal });
        logger.log({ sessionId: sid, label, stage: null, flagged, model: config.model, promptVersion: systemPrompt.version, student: message, tutor: null });
        return;
      }

      const text = textOf(final.content);
      if (!text.trim()) {
        send('error', { code: 'empty_reply', message: MSG.generic });
        return;
      }

      const state = signState(
        { v: 1, sid, iat: Date.now(), messages: [...nextMessages, { role: 'assistant', content: final.content }] },
        config.sessionSecret,
      );
      if (state.length > config.maxStateChars) {
        send('error', { code: 'too_long', message: MSG.tooLongTurns });
        return;
      }

      const stage = parseStage(text);
      send('done', { state, stage: stage?.stage ?? null, stageName: stage?.name ?? null });
      logger.log({ sessionId: sid, label, stage: stage?.stage ?? null, flagged, model: config.model, promptVersion: systemPrompt.version, student: message, tutor: text });
    } catch (err) {
      if (aborter.signal.aborted) return; // 학생이 창을 닫았거나 연결이 끊김
      const info = describeError(err);
      console[info.level === 'error' ? 'error' : 'warn'](`[chat] 실패(${info.code}): ${info.detail}`);
      send('error', { code: info.code, message: info.user });
    } finally {
      clearInterval(ping);
      inflight.release(sid);
      res.end();
    }
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
  };
  return app;
}
