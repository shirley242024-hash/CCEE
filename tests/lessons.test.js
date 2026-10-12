import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCardStore } from '../server/cards.js';
import { parseStage } from '../server/chat.js';
import { loadConfig } from '../server/config.js';
import { loadLessons } from '../server/lessons.js';
import { createLogger } from '../server/logger.js';
import { signState } from '../server/state.js';
import { memoryCardStore, SECRET, startHarness } from './helpers.js';

const CODE = 'sun-48217x';
// 모의 서버의 CARD 응답에서 화면의 '정리 카드 복사'가 잘라 내는 글(public/app.js의 extractCard와 같은 결과)
const MOCK_CARD = '정리 카드\n- 선택한 기술: 수소차\n- 나만의 탐구 질문: "수소를 만드는 과정까지 따지면 수소차는 탄소를 줄일까?"';

describe('차시 나누기', () => {
  it('설정에 1~3차시 목록이 오고, 3차시는 8단계다', async () => {
    const h = await startHarness();
    try {
      const cfg = await (await fetch(`${h.base}/api/config`)).json();
      assert.deepEqual(cfg.lessons.map((l) => [l.id, l.available, l.stages.length]), [[1, true, 6], [2, true, 6], [3, true, 8]]);
      assert.equal(cfg.lessons[1].stages[0], '주장 확인');
      assert.equal(cfg.lessons[2].stages[7], '수정 전후 비교 및 성찰');
      assert.deepEqual(cfg.lessons.map((l) => [l.makesCard, l.usesCard]), [[true, false], [false, true], [false, false]]);
      assert.equal(cfg.cardStorage, false);
      const sent = JSON.stringify(cfg);
      for (const secret of ['[가장 중요한 원칙]', '[가장 중요한 운영 원칙]', '설계 심사 챗봇']) {
        assert.ok(!sent.includes(secret), `프롬프트 내용은 보내지 않는다: ${secret}`);
      }
      const health = await (await fetch(`${h.base}/api/health`)).json();
      assert.deepEqual(Object.keys(health.promptVersions), ['1', '2', '3']);
    } finally { await h.close(); }
  });

  it('3차시 프롬프트의 단계 머리글이 차시 목록의 단계 이름과 같다', () => {
    const lesson = loadLessons().get(3);
    const total = lesson.stages.length;
    lesson.stages.forEach((name, i) => {
      const header = `[단계 ${i + 1}/${total} · ${name}]`;
      assert.ok(lesson.prompt.text.includes(header), header);
      assert.deepEqual(parseStage(header, total), { stage: i + 1, name });
    });
  });

  it('3차시는 3차시 프롬프트와 8단계 머리글을 쓰고, 1차시 카드는 붙이지 않는다', async () => {
    const h = await startHarness({ RATE_PER_SESSION_PER_MIN: '20' }); // 한 대화에서 9번 연달아 보낸다
    try {
      let r = await h.chat({ message: '안녕하세요! 시작할게요.', lesson: 3, card: MOCK_CARD });
      assert.equal(r.status, 200);
      let done = h.doneOf(r);
      assert.deepEqual([done.stage, done.stageName], [1, '기존 기술의 문제 확인']);
      const { body } = h.mock.requests.at(-1);
      assert.ok(body.system[0].text.includes('설계 심사 챗봇'));
      assert.equal(body.messages[0].content, '안녕하세요! 시작할게요.');
      assert.equal(h.logs.at(-1).lesson, 3);

      // 모의 서버는 턴마다 한 단계씩 올라간다: 8단계까지 가고 그 뒤로는 8단계에 머문다.
      for (let turn = 2; turn <= 9; turn += 1) {
        r = await h.chat({ message: `답 ${turn}`, lesson: 3, state: done.state });
        assert.equal(r.status, 200);
        done = h.doneOf(r);
      }
      assert.deepEqual([done.stage, done.stageName], [8, '수정 전후 비교 및 성찰']);
      assert.equal(h.logs.at(-1).stage, 8);

      // 3차시 대화 정보는 다른 차시에서 쓸 수 없다.
      const crossed = await h.chat({ message: '이어서', lesson: 2, state: done.state });
      assert.equal(crossed.status, 400);
      assert.match(crossed.json.message, /다른 차시/);
    } finally { await h.close(); }
  });

  it('학생 메시지는 기본 2000자까지 받는다(3차시 설계 양식)', async () => {
    const h = await startHarness();
    try {
      assert.equal(h.config.maxStudentChars, 2000);
      assert.equal((await h.chat({ message: '가'.repeat(2000), lesson: 3 })).status, 200);
      const long = await h.chat({ message: '가'.repeat(2001), lesson: 3 });
      assert.equal(long.status, 400);
      assert.equal(long.json.error, 'too_long_message');
    } finally { await h.close(); }
  });

  it('2차시 첫 메시지에는 1차시 정리 카드를 붙이고, 2차시 프롬프트와 단계 이름을 쓴다', async () => {
    const h = await startHarness();
    try {
      const r = await h.chat({ message: '안녕하세요! 시작할게요.', lesson: 2, card: MOCK_CARD });
      assert.equal(r.status, 200);
      const done = h.doneOf(r);
      assert.equal(done.stage, 1);
      assert.equal(done.stageName, '주장 확인');
      const { body } = h.mock.requests.at(-1);
      assert.ok(body.system[0].text.includes('비판적 토론 챗봇'));
      assert.equal(body.messages[0].content, `[1차시 정리 카드]\n${MOCK_CARD}\n\n안녕하세요! 시작할게요.`);
      assert.equal(h.logs.at(-1).lesson, 2);

      // 다음 턴에 카드를 또 보내도 붙이지 않는다
      await h.chat({ message: '① 수소차', lesson: 2, card: MOCK_CARD, state: done.state });
      assert.equal(h.mock.requests.at(-1).body.messages.at(-1).content, '① 수소차');
    } finally { await h.close(); }
  });

  it('1차시는 카드를 받아도 붙이지 않고, 너무 긴 카드는 거절한다', async () => {
    const h = await startHarness();
    try {
      await h.chat({ message: '안녕', lesson: 1, card: MOCK_CARD });
      assert.equal(h.mock.requests.at(-1).body.messages[0].content, '안녕');
      const long = await h.chat({ message: '안녕', lesson: 2, card: '가'.repeat(3001) });
      assert.equal(long.status, 400);
      assert.equal(long.json.error, 'too_long_card');
      assert.equal(h.mock.requests.length, 1);
    } finally { await h.close(); }
  });

  it('없는 차시와 다른 차시의 대화 정보는 거절한다', async () => {
    const h = await startHarness();
    try {
      for (const lesson of [0, 4, 9, 'x']) {
        const r = await h.chat({ message: '안녕', lesson });
        assert.equal(r.status, 400, String(lesson));
        assert.equal(r.json.error, 'bad_lesson');
      }
      const one = h.doneOf(await h.chat({ message: '안녕', lesson: 1 }));
      const crossed = await h.chat({ message: '이어서', lesson: 2, state: one.state });
      assert.equal(crossed.status, 400);
      assert.match(crossed.json.message, /다른 차시/);
    } finally { await h.close(); }
  });

  it('차시를 나누기 전에 시작한 1차시 대화(차시 번호 없는 정보)도 이어진다', async () => {
    const h = await startHarness();
    try {
      const old = signState({
        v: 1, sid: 'old-session-1234', pv: h.systemPrompt.version, m: h.config.model, iat: Date.now(),
        messages: [{ role: 'user', content: '안녕' }, { role: 'assistant', content: [{ type: 'text', text: '[단계 1/6 · 기술 고르기]\n어떤 기술을 고를까요?' }] }],
      }, SECRET);
      const r = await h.chat({ message: '태양광이요', state: old });
      assert.equal(r.status, 200);
      assert.equal(h.doneOf(r).stage, 2);
      assert.equal((await h.chat({ message: '태양광이요', lesson: 1, state: old })).status, 200);
    } finally { await h.close(); }
  });

  it('이어 하는 새 대화: 첫 메시지에 지난 대화 정리를 붙이고(카드가 있으면 카드 다음), 다음 턴부터는 붙이지 않는다', async () => {
    const h = await startHarness();
    try {
      const resume = '지금 단계: [단계 4/6 · 반론 제시]\n학생이 쓴 글(오래된 것부터):\n[학생 1] 태양광은 좋다';
      const r = await h.chat({ message: '이어서 할게요.', lesson: 2, card: MOCK_CARD, resume });
      assert.equal(r.status, 200);
      assert.equal(h.mock.requests.at(-1).body.messages[0].content,
        `[1차시 정리 카드]\n${MOCK_CARD}\n\n[이전 대화 이어 하기]\n${resume}\n\n이어서 할게요.`);
      await h.chat({ message: '다음', lesson: 2, resume, state: h.doneOf(r).state });
      assert.equal(h.mock.requests.at(-1).body.messages.at(-1).content, '다음');

      const one = await h.chat({ message: '이어서 할게요.', lesson: 1, resume });
      assert.equal(h.mock.requests.at(-1).body.messages[0].content, `[이전 대화 이어 하기]\n${resume}\n\n이어서 할게요.`);
      assert.equal(one.status, 200);

      const long = await h.chat({ message: '이어서', resume: '가'.repeat(20001) });
      assert.equal(long.status, 400);
      assert.equal(long.json.error, 'too_long_resume');
    } finally { await h.close(); }
  });

  it('모든 차시 프롬프트가 이어 하기를 다루고, 끝난 대화는 이어 하기를 안내한다', async () => {
    const h = await startHarness({ SESSION_MAX_AGE_HOURS: '1' });
    try {
      for (const [, lesson] of h.lessons) assert.ok(lesson.prompt.text.includes('[이전 대화 이어 하기]'), `${lesson.id}차시`);
      const old = signState({ v: 1, sid: 'expired-0001', l: 1, pv: h.systemPrompt.version, m: h.config.model, iat: Date.now() - 2 * 3600_000,
        messages: [{ role: 'user', content: '안녕' }, { role: 'assistant', content: [{ type: 'text', text: '[단계 1/6 · 기술 고르기]\n안녕하세요' }] }] }, SECRET);
      const expired = await h.chat({ message: '다시', state: old });
      assert.equal(expired.status, 400);
      assert.match(expired.json.message, /만료됐어요\. "이어서 새 대화 시작"/);
    } finally { await h.close(); }
  });

  it('단계 머리글은 그 차시의 전체 단계 수와 맞을 때만 읽는다', () => {
    assert.deepEqual(parseStage('[단계 2/6 · 근거 확인]\n본문', 6), { stage: 2, name: '근거 확인' });
    assert.equal(parseStage('[단계 2/5 · 근거 확인]', 6), null);
    assert.equal(parseStage('[단계 0/6 · 없음]', 6), null);
    assert.equal(parseStage('[단계 7/8 · 최종 설계안]', 6), null);
    assert.deepEqual(parseStage('[단계 7/8 · 최종 설계안]', 8), { stage: 7, name: '최종 설계안' });
  });
});

describe('대화 기록과 학번·이름', () => {
  const LOG_ENV = { LOG_CHATS: 'true', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };

  it('기록을 켜면 학번·이름이 있어야 대화할 수 있고, 기록마다 함께 남는다', async () => {
    const h = await startHarness(LOG_ENV);
    try {
      const cfg = await (await fetch(`${h.base}/api/config`)).json();
      assert.equal(cfg.askIdentity, true);
      for (const who of [{}, { studentId: '20101' }, { studentId: '2010', studentName: '홍길동' }, { studentId: '20101', studentName: '가'.repeat(21) }, { studentId: '20101', studentName: '   ' }]) {
        const r = await h.chat({ message: '안녕', ...who });
        assert.equal(r.status, 400, JSON.stringify(who));
        assert.equal(r.json.error, 'need_identity');
      }
      assert.equal(h.mock.requests.length, 0, '학번·이름이 없으면 Anthropic을 부르지 않는다');

      const ok = await h.chat({ message: '안녕', lesson: 2, studentId: ' 20101 ', studentName: ' 홍길동 ' });
      assert.equal(ok.status, 200);
      const entry = h.logs.at(-1);
      assert.deepEqual([entry.studentId, entry.studentName, entry.lesson], ['20101', '홍길동', 2]);
    } finally { await h.close(); }
  });

  it('기록 설정: 비밀 키가 있으면 공개용 키 없이도 켜지고, 기록 줄에 학번·이름 열이 들어간다', async () => {
    assert.deepEqual(loadConfig({ SESSION_SECRET: SECRET, ...LOG_ENV }).errors, []);
    const noKey = loadConfig({ SESSION_SECRET: SECRET, LOG_CHATS: 'true', SUPABASE_URL: 'https://x.supabase.co' });
    assert.ok(noKey.errors.some((e) => e.includes('SUPABASE_SECRET_KEY')));

    const rows = [];
    const logger = createLogger({ logChats: true }, { client: { from: () => ({ insert: async (r) => { rows.push(...r); return { error: null }; } }) } });
    await logger.log({ sessionId: 's', lesson: 1, studentId: '20101', studentName: '홍길동', stage: 2, flagged: false, model: 'm', promptVersion: 'v', student: '학생 글', tutor: '챗봇 글' });
    assert.deepEqual(rows.map((r) => [r.role, r.student_id, r.student_name, r.lesson]), [['student', '20101', '홍길동', 1], ['tutor', '20101', '홍길동', 1]]);
  });

  it('표의 단계 범위가 옛것(1~6)이라 막히면 단계만 비우고 다시 남긴다', async () => {
    const rows = [];
    const calls = [];
    const client = { from: () => ({ insert: async (r) => {
      calls.push(r.map((x) => x.stage));
      if (r.some((x) => x.stage > 6)) return { error: { code: '23514', message: 'violates check constraint "chat_logs_stage_check"' } };
      rows.push(...r);
      return { error: null };
    } }) };
    const logger = createLogger({ logChats: true }, { client });
    const errors = [];
    const original = console.error;
    console.error = (m) => errors.push(String(m));
    try {
      await logger.log({ sessionId: 's', lesson: 3, studentId: '20101', studentName: '홍길동', stage: 8, flagged: false, model: 'm', promptVersion: 'v', student: '성찰', tutor: '마무리' });
    } finally { console.error = original; }
    assert.deepEqual(calls, [[8, 8], [null, null]]);
    assert.deepEqual(rows.map((r) => [r.role, r.lesson, r.stage, r.content]), [['student', 3, null, '성찰'], ['tutor', 3, null, '마무리']]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /schema\.sql/);
  });
});

describe('학번으로 1차시 정리 카드 저장·불러오기', () => {
  /** 수업 코드와 카드 저장소를 켠 서버에서, 정리 카드가 나온 1차시 대화를 만든다. */
  async function withCardConversation(env = {}) {
    const store = memoryCardStore();
    const h = await startHarness({ ACCESS_CODE: CODE, ...env }, { cardStore: store });
    const done = h.doneOf(await h.chat({ message: 'CARD', accessCode: CODE }));
    return { h, store, state: done.state };
  }

  it('기능이 꺼져 있으면 저장·불러오기 모두 cards_off', async () => {
    const h = await startHarness();
    try {
      for (const path of ['/api/cards/save', '/api/cards/load']) {
        const r = await h.post(path, { studentId: '20101' });
        assert.equal(r.status, 404);
        assert.equal(r.json.error, 'cards_off');
      }
    } finally { await h.close(); }
  });

  it('챗봇이 보여 준 카드를 학번으로 저장하고, 2차시에서 가장 최근 것을 불러온다', async () => {
    const { h, store, state } = await withCardConversation();
    try {
      assert.equal((await (await fetch(`${h.base}/api/config`)).json()).cardStorage, true);
      const saved = await h.post('/api/cards/save', { accessCode: CODE, studentId: '20101', state, card: MOCK_CARD });
      assert.equal(saved.status, 200);
      assert.equal(store.rows.length, 1);
      assert.equal(store.rows[0].studentId, '20101');
      assert.equal(store.rows[0].promptVersion, h.systemPrompt.version);

      const loaded = await h.post('/api/cards/load', { accessCode: CODE, studentId: '20101' });
      assert.equal(loaded.status, 200);
      assert.equal(loaded.json.card, MOCK_CARD);
      assert.ok(loaded.json.savedAt);

      const missing = await h.post('/api/cards/load', { accessCode: CODE, studentId: '20102' });
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error, 'no_card');
      assert.equal(h.mock.requests.length, 1, '카드 요청은 Anthropic을 부르지 않는다');
    } finally { await h.close(); }
  });

  it('수업 코드, 학번 형식, 카드 출처를 검사한다', async () => {
    const { h, store, state } = await withCardConversation();
    try {
      const noCode = await h.post('/api/cards/load', { studentId: '20101' });
      assert.equal(noCode.status, 401);
      for (const studentId of ['2010', '201011', '2010a', '', 20101]) {
        const r = await h.post('/api/cards/load', { accessCode: CODE, studentId });
        assert.equal(r.status, 400, String(studentId));
        assert.equal(r.json.error, 'bad_student_id');
      }
      // 대화에 없던 글을 카드라고 보내면 저장하지 않는다
      const forged = await h.post('/api/cards/save', { accessCode: CODE, studentId: '20101', state, card: '정리 카드\n- 선택한 기술: 지어낸 내용' });
      assert.equal(forged.status, 400);
      assert.equal(forged.json.error, 'bad_card');
      // 서명이 없거나 바뀐 대화 정보도 거절한다
      const tampered = await h.post('/api/cards/save', { accessCode: CODE, studentId: '20101', state: `${state}x`, card: MOCK_CARD });
      assert.equal(tampered.status, 400);
      assert.equal(tampered.json.error, 'bad_state');
      // 2차시 대화 정보로는 1차시 카드를 저장하지 않는다
      const two = h.doneOf(await h.chat({ message: '안녕', lesson: 2, card: MOCK_CARD, accessCode: CODE }));
      const fromLesson2 = await h.post('/api/cards/save', { accessCode: CODE, studentId: '20101', state: two.state, card: MOCK_CARD });
      assert.equal(fromLesson2.status, 400);
      assert.equal(store.rows.length, 0);
    } finally { await h.close(); }
  });

  it('주소별 요청 한도를 넘으면 잠시 막는다', async () => {
    const { h } = await withCardConversation({ CARD_REQUESTS_PER_IP_PER_MIN: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await h.post('/api/cards/load', { accessCode: CODE, studentId: '20101' })).status);
      assert.deepEqual(codes, [404, 404, 404, 429]);
    } finally { await h.close(); }
  });

  it('Supabase 저장소: 비밀 키 설정이 있어야 켜지고, 최근 것을 고르는 질의를 보낸다', async () => {
    assert.equal(createCardStore({ saveCards: false }), null);
    const missingKey = loadConfig({ SESSION_SECRET: SECRET, SAVE_CARDS: 'true', SUPABASE_URL: 'https://x.supabase.co' });
    assert.ok(missingKey.errors.some((e) => e.includes('SUPABASE_SECRET_KEY')));

    const calls = [];
    const builder = {
      insert(row) { calls.push(['insert', row]); return Promise.resolve({ error: null }); },
      select(cols) { calls.push(['select', cols]); return builder; },
      eq(col, value) { calls.push(['eq', col, value]); return builder; },
      order(col, opts) { calls.push(['order', col, opts.ascending]); return builder; },
      limit(n) { calls.push(['limit', n]); return Promise.resolve({ data: [{ card: 'C', created_at: '2026-10-12T00:00:00Z' }], error: null }); },
    };
    const store = createCardStore({ saveCards: true }, { client: { from(table) { calls.push(['from', table]); return builder; } } });
    await store.save({ studentId: '20101', card: 'C', sessionId: 's', promptVersion: 'v' });
    assert.deepEqual(await store.load('20101'), { card: 'C', savedAt: '2026-10-12T00:00:00Z' });
    assert.deepEqual(calls, [
      ['from', 'lesson1_cards'], ['insert', { student_id: '20101', card: 'C', session_id: 's', prompt_version: 'v' }],
      ['from', 'lesson1_cards'], ['select', 'card, created_at'], ['eq', 'student_id', '20101'],
      ['order', 'created_at', false], ['order', 'id', false], ['limit', 1],
    ]);

    const failing = createCardStore({ saveCards: true }, {
      client: { from: () => ({ insert: () => Promise.resolve({ error: { code: '42501', message: 'permission denied' } }) }) },
    });
    await assert.rejects(failing.save({ studentId: '20101', card: '비밀 카드 내용' }), (err) => !err.message.includes('비밀 카드 내용') && err.message.includes('42501'));
  });
});
