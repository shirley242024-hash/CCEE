import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStage, buildRequest } from '../server/chat.js';
import { loadConfig } from '../server/config.js';
import { DailyCap, InFlight, SlidingWindowLimiter } from '../server/limits.js';
import { detectRisk } from '../server/safety.js';
import { signState, verifyState, StateError } from '../server/state.js';

const SECRET = 'k'.repeat(40);
const opts = { maxAgeMs: 60_000, maxChars: 100_000 };
const good = () => ({ v: 1, sid: 'abc', iat: Date.now(), messages: [{ role: 'user', content: '안녕' }, { role: 'assistant', content: [{ type: 'text', text: '네' }] }] });

describe('상태 토큰', () => {
  it('서명하고 다시 읽으면 같다', () => {
    const p = good();
    const out = verifyState(signState(p, SECRET), SECRET, opts);
    assert.deepEqual(out.messages, p.messages);
  });
  it('다른 비밀키로는 읽히지 않는다', () => {
    assert.throws(() => verifyState(signState(good(), SECRET), 'z'.repeat(40), opts), StateError);
  });
  it('허용되지 않은 블록과 순서는 서명이 맞아도 거절한다', () => {
    const badBlock = good(); badBlock.messages[1].content = [{ type: 'tool_use', id: 'x' }];
    assert.throws(() => verifyState(signState(badBlock, SECRET), SECRET, opts), StateError);
    const badOrder = good(); badOrder.messages[0].role = 'assistant';
    assert.throws(() => verifyState(signState(badOrder, SECRET), SECRET, opts), StateError);
  });
  it('너무 큰 토큰과 비문자열은 거절한다', () => {
    assert.throws(() => verifyState('a'.repeat(200), SECRET, { ...opts, maxChars: 100 }), StateError);
    assert.throws(() => verifyState(null, SECRET, opts), StateError);
    assert.throws(() => verifyState('', SECRET, opts), StateError);
  });
});

describe('요청 제한', () => {
  it('슬라이딩 윈도: 한도까지 허용하고 시간이 지나면 풀린다', () => {
    const l = new SlidingWindowLimiter({ max: 2, windowMs: 1000 });
    assert.equal(l.take('a', 0), true);
    assert.equal(l.take('a', 10), true);
    assert.equal(l.take('a', 20), false);
    assert.equal(l.take('b', 20), true);
    assert.equal(l.take('a', 1500), true);
    l.close();
  });
  it('하루 상한은 한국 날짜가 바뀌면 초기화된다', () => {
    const c = new DailyCap(1);
    assert.equal(c.take(new Date('2026-10-12T00:00:00+09:00')), true);
    assert.equal(c.take(new Date('2026-10-12T23:59:00+09:00')), false);
    assert.equal(c.take(new Date('2026-10-13T00:01:00+09:00')), true);
  });
  it('InFlight: 같은 대화는 하나씩만', () => {
    const f = new InFlight();
    assert.equal(f.acquire('s'), true);
    assert.equal(f.acquire('s'), false);
    f.release('s');
    assert.equal(f.acquire('s'), true);
  });
});

describe('위기 신호 표시', () => {
  it('걸러야 할 표현', () => {
    for (const t of ['죽고 싶어요', '그냥 다 사라지고 싶다', '자해 생각이 나요', '살기 싫어', '다 사라져 버렸으면 좋겠어요']) {
      assert.equal(detectRisk(t), true, t);
    }
  });
  it('수업 내용은 걸리지 않는다', () => {
    for (const t of ['태양광 발전이요', '이산화탄소를 땅에 묻는 거예요', '석탄 발전소가 사라지면 좋겠어요', '수소차 정답 알려줘']) {
      assert.equal(detectRisk(t), false, t);
    }
  });
});

describe('단계 읽기와 요청 만들기', () => {
  it('머리글에서 단계를 읽는다', () => {
    assert.deepEqual(parseStage('[단계 3/6 · 과학적 원리]\n본문'), { stage: 3, name: '과학적 원리' });
    assert.equal(parseStage('머리글 없음'), null);
    assert.equal(parseStage('[단계 7/6 · 이상한]'), null);
  });
  it('effort=none이면 output_config를 보내지 않는다', () => {
    const cfg = loadConfig({ SESSION_SECRET: SECRET, CHATBOT_EFFORT: 'none' });
    const req = buildRequest({ config: cfg, systemPrompt: 'sys', messages: [] });
    assert.ok(!('output_config' in req));
  });
});

describe('설정 검사', () => {
  it('운영에서는 필수 값이 없으면 오류', () => {
    const cfg = loadConfig({ NODE_ENV: 'production' });
    assert.ok(cfg.errors.some((e) => e.includes('SESSION_SECRET')));
    assert.ok(cfg.errors.some((e) => e.includes('ANTHROPIC_API_KEY')));
  });
  it('운영에서 수업 코드가 없으면 경고', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: SECRET, ANTHROPIC_API_KEY: 'k' });
    assert.equal(cfg.errors.length, 0);
    assert.ok(cfg.warnings.some((w) => w.includes('ACCESS_CODE')));
  });
  it('짧은 SESSION_SECRET과 잘못된 effort는 오류', () => {
    assert.ok(loadConfig({ SESSION_SECRET: 'short' }).errors.length > 0);
    assert.ok(loadConfig({ SESSION_SECRET: SECRET, CHATBOT_EFFORT: 'turbo' }).errors.length > 0);
  });
  it('대화 기록 저장은 Supabase 설정이 있어야 켤 수 있다', () => {
    assert.ok(loadConfig({ SESSION_SECRET: SECRET, LOG_CHATS: 'true' }).errors.length > 0);
  });
});
