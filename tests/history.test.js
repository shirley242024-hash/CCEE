import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../server/config.js';
import { MAX_HISTORY_ROWS, createHistoryStore } from '../server/history.js';
import { SECRET, startHarness } from './helpers.js';

const ON = { LOG_CHATS: 'true', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', ACCESS_CODE: 'class-code-1' };
const who = { accessCode: 'class-code-1', studentId: '20101', studentName: '홍길동' };

/** 지난 대화 저장소(메모리). 받은 요청을 calls에 남긴다. */
function memoryHistoryStore(rows = [], { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async load(studentId, studentName, lesson) {
      calls.push([studentId, studentName, lesson]);
      if (fail) throw new Error('읽기: 42501 permission denied');
      return { rows, truncated: false };
    },
  };
}
const row = (id, role, content, over = {}) => ({ id, created_at: `2026-10-15T00:00:${String(id).padStart(2, '0')}Z`, session_id: 's1', role, stage: 1, content, ...over });

describe('학번·이름으로 지난 대화 이어 하기', () => {
  it('설정: 대화 기록을 비밀 키로 읽을 수 있을 때만 켜고, RESUME_BY_ID=false면 끈다', () => {
    const base = { SESSION_SECRET: SECRET };
    assert.equal(loadConfig({ ...base, ...ON }).resumeById, true);
    assert.equal(loadConfig({ ...base, ...ON, RESUME_BY_ID: 'false' }).resumeById, false);
    assert.equal(loadConfig({ ...base, ...ON, LOG_CHATS: 'false' }).resumeById, false);
    // 공개용 키로는 기록을 쓰기만 할 수 있어 읽지 못한다
    assert.equal(loadConfig({ ...base, LOG_CHATS: 'true', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub' }).resumeById, false);
    assert.equal(createHistoryStore({ resumeById: false }), null);
  });

  it('Supabase 저장소: 학번·이름·차시가 모두 같은 최근 기록을 읽어 오래된 것부터 돌려준다', async () => {
    const calls = [];
    let data = [{ id: 3 }, { id: 2 }, { id: 1 }];
    const client = {
      from(table) {
        calls.push(['from', table]);
        const b = {
          select(cols) { calls.push(['select', cols]); return b; },
          eq(col, v) { calls.push(['eq', col, v]); return b; },
          order(col, opts) { calls.push(['order', col, opts.ascending]); return b; },
          range(from, to) { calls.push(['range', from, to]); return Promise.resolve({ data, error: null }); },
        };
        return b;
      },
    };
    const store = createHistoryStore({ resumeById: true }, { client });
    const r = await store.load('20101', '홍길동', 3);
    assert.deepEqual(r.rows.map((x) => x.id), [1, 2, 3]);
    assert.equal(r.truncated, false);
    assert.deepEqual(calls.filter((c) => c[0] === 'eq'), [['eq', 'student_id', '20101'], ['eq', 'student_name', '홍길동'], ['eq', 'lesson', 3]]);
    assert.deepEqual(calls.filter((c) => c[0] === 'order' || c[0] === 'range'), [['order', 'id', false], ['range', 0, MAX_HISTORY_ROWS - 1]]);
    data = Array.from({ length: MAX_HISTORY_ROWS }, (_, i) => ({ id: MAX_HISTORY_ROWS - i }));
    assert.equal((await store.load('20101', '홍길동', 3)).truncated, true);

    const failing = createHistoryStore({ resumeById: true }, {
      client: { from: () => { const b = { select: () => b, eq: () => b, order: () => b, range: () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }) }; return b; } },
    });
    await assert.rejects(failing.load('20101', '홍길동', 3), /42501/);
  });

  it('API: 꺼져 있으면 404이고 화면 설정에도 꺼짐으로 알린다', async () => {
    const h = await startHarness(ON);
    try {
      assert.equal((await (await fetch(`${h.base}/api/config`)).json()).history, false);
      const r = await h.post('/api/history/load', { ...who, lesson: 3 });
      assert.equal(r.status, 404);
      assert.equal(r.json.error, 'history_off');
    } finally { await h.close(); }
  });

  it('API: 수업 코드·학번·이름·차시를 검사하고, 같은 학번·이름의 기록을 돌려준다', async () => {
    const store = memoryHistoryStore([
      row(1, 'student', '안녕하세요! 시작할게요.'),
      row(2, 'tutor', '[단계 1/8 · 기존 기술의 문제 확인]\n\n세 가지를 적어 주세요.'),
      row(3, 'student', '이어서 할게요.', { session_id: 's2', stage: 2 }),
      row(4, 'tutor', '[단계 2/8 · 최초 설계안]\n\n양식을 채워 주세요.', { session_id: 's2', stage: 2 }),
    ]);
    const h = await startHarness(ON, { historyStore: store });
    try {
      assert.equal((await (await fetch(`${h.base}/api/config`)).json()).history, true);
      assert.equal((await h.post('/api/history/load', { ...who, accessCode: 'wrong', lesson: 3 })).status, 401);
      assert.equal((await h.post('/api/history/load', { ...who, studentName: '', lesson: 3 })).json.error, 'need_identity');
      assert.equal((await h.post('/api/history/load', { ...who, studentId: '2010', lesson: 3 })).json.error, 'need_identity');
      assert.equal((await h.post('/api/history/load', { ...who, lesson: 9 })).json.error, 'bad_lesson');
      assert.equal(store.calls.length, 0); // 검사에 걸린 요청은 기록을 읽지 않는다

      const res = await fetch(`${h.base}/api/history/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...who, studentName: '  홍길동 ', lesson: 3 }) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const j = await res.json();
      assert.deepEqual(store.calls, [['20101', '홍길동', 3]]); // 이름 앞뒤 공백은 지우고 찾는다
      assert.deepEqual(j.messages.map((m) => [m.role, m.stage, m.sessionId]), [['student', 1, 's1'], ['tutor', 1, 's1'], ['student', 2, 's2'], ['tutor', 2, 's2']]);
      assert.equal(j.messages[1].text, '[단계 1/8 · 기존 기술의 문제 확인]\n\n세 가지를 적어 주세요.');
      assert.equal(j.truncated, false);
    } finally { await h.close(); }
  });

  it('API: 기록이 없으면 404, 읽기에 실패하면 내용 없이 502, 너무 많이 요청하면 429', async (t) => {
    const empty = await startHarness({ ...ON, CARD_REQUESTS_PER_IP_PER_MIN: '2' }, { historyStore: memoryHistoryStore([]) });
    try {
      const r = await empty.post('/api/history/load', { ...who, lesson: 1 });
      assert.equal(r.status, 404);
      assert.equal(r.json.error, 'no_history');
      assert.equal((await empty.post('/api/history/load', { ...who, lesson: 1 })).status, 404);
      assert.equal((await empty.post('/api/history/load', { ...who, lesson: 1 })).status, 429);
    } finally { await empty.close(); }

    const errors = t.mock.method(console, 'error', () => {});
    const failing = await startHarness(ON, { historyStore: memoryHistoryStore([], { fail: true }) });
    try {
      const r = await failing.post('/api/history/load', { ...who, lesson: 2 });
      assert.equal(r.status, 502);
      assert.equal(r.json.error, 'history_failed');
      assert.ok(errors.mock.calls.some((c) => /\[history\].*42501/.test(c.arguments[0])));
    } finally { await failing.close(); }
  });

  it('학생 화면에 이어 하기 버튼이 있다(설정이 꺼져 있으면 숨긴다)', async () => {
    const h = await startHarness({});
    try {
      const page = await (await fetch(`${h.base}/`)).text();
      assert.match(page, /id="history-box" class="history-box" hidden/);
      assert.match(page, /id="load-history"/);
    } finally { await h.close(); }
  });
});
