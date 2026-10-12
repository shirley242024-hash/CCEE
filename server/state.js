import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * 대화 기록을 서버가 서명한 토큰으로 주고받는다.
 * - 학생이 브라우저에서 챗봇의 말을 위조해 끼워 넣는 우회를 막는다.
 * - 서버에 DB 없이도 동작한다(서버가 여러 대여도 같은 SESSION_SECRET이면 된다).
 * 토큰에는 시스템 프롬프트가 들어가지 않는다.
 * 형식: `z.<압축한 본문>.<서명>`. 압축하기 전에 만든 `<본문>.<서명>`도 계속 읽는다(진행 중인 대화가 이어지게).
 */

export class StateError extends Error {}

const ALLOWED_ASSISTANT_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking']);

function mac(body, secret) {
  return createHmac('sha256', secret).update(body).digest();
}

const ZIP = 'z';
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;

export function signState(payload, secret) {
  // 대화가 길어질수록 매번 주고받는 크기가 커지므로 압축한다(한국어 대화는 절반 안팎으로 준다).
  const body = `${ZIP}.${deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url')}`;
  return `${body}.${mac(body, secret).toString('base64url')}`;
}

/** 형식 검사: 학생/챗봇이 번갈아 나오고, 챗봇 응답은 허용된 블록만 가진다. */
export function validateMessages(messages) {
  if (!Array.isArray(messages)) throw new StateError('대화 기록 형식이 올바르지 않아요.');
  messages.forEach((m, i) => {
    const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
    if (!m || m.role !== expectedRole) throw new StateError('대화 기록 순서가 올바르지 않아요.');
    if (m.role === 'user') {
      if (typeof m.content !== 'string') throw new StateError('대화 기록 형식이 올바르지 않아요.');
    } else {
      if (!Array.isArray(m.content) || m.content.length === 0) throw new StateError('대화 기록 형식이 올바르지 않아요.');
      for (const block of m.content) {
        if (!block || !ALLOWED_ASSISTANT_BLOCKS.has(block.type)) throw new StateError('대화 기록 형식이 올바르지 않아요.');
        if (block.type === 'text' && typeof block.text !== 'string') throw new StateError('대화 기록 형식이 올바르지 않아요.');
      }
    }
  });
}

/**
 * @returns {{ v: number, sid: string, iat: number, messages: Array }}
 * @throws {StateError}
 */
export function verifyState(token, secret, { maxAgeMs, maxChars }) {
  if (typeof token !== 'string' || token.length === 0 || token.length > maxChars) {
    throw new StateError('대화 정보가 올바르지 않아요.');
  }
  const parts = token.split('.');
  const zipped = parts.length === 3 && parts[0] === ZIP;
  if (!(zipped || parts.length === 2) || parts.some((p) => !p)) throw new StateError('대화 정보가 올바르지 않아요.');
  const body = parts.slice(0, -1).join('.');
  const given = parts.at(-1);

  const expected = mac(body, secret);
  const givenBuf = Buffer.from(given, 'base64url');
  if (givenBuf.length !== expected.length || !timingSafeEqual(givenBuf, expected)) {
    throw new StateError('대화 정보가 올바르지 않아요.');
  }

  let payload;
  try {
    // 서명을 확인한 뒤에만 푼다(서버가 만든 것만 풀린다).
    const raw = Buffer.from(zipped ? parts[1] : body, 'base64url');
    payload = JSON.parse((zipped ? inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES }) : raw).toString('utf8'));
  } catch {
    throw new StateError('대화 정보가 올바르지 않아요.');
  }
  if (!payload || payload.v !== 1 || typeof payload.sid !== 'string' || typeof payload.iat !== 'number') {
    throw new StateError('대화 정보가 올바르지 않아요.');
  }
  if (Date.now() - payload.iat > maxAgeMs) throw new StateError('대화가 너무 오래되어 만료됐어요. 처음부터 다시 시작해 주세요.');
  validateMessages(payload.messages);
  return payload;
}
