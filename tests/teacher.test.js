import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../server/config.js';
import { detectProfanity } from '../server/safety.js';
import { createTeacherStore, groupConversation, summarize } from '../server/teacher.js';
import { SECRET, startHarness } from './helpers.js';

const TEACHER = 'teacher-code-0123456789';
const SUPA = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };

const row = (id, over = {}) => ({
  id, created_at: `2026-10-15T00:00:${String(id).padStart(2, '0')}Z`, session_id: 's1', lesson: 3,
  student_id: '20101', student_name: '홍길동', role: 'student', stage: 1, flagged: false, content: `학생 글 ${id}`, ...over,
});

/** 교사용 저장소(메모리). 보낸 요청을 calls에 남긴다. */
function memoryTeacherStore({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async overview() {
      calls.push(['overview']);
      if (fail) throw new Error('읽기: 42501 permission denied');
      return { students: [], alerts: [], totalMessages: 0, truncated: false };
    },
    async conversation(studentId, lesson) {
      calls.push(['conversation', studentId, lesson]);
      return { studentId, lesson, names: [], sessions: [], truncated: false };
    },
  };
}

describe('교사용 화면', () => {
  it('욕설 검사: 흔한 욕설은 걸리고, 겹치는 일상 표현은 걸리지 않는다', () => {
    for (const t of ['씨발 이거 뭐야', 'ㅅㅂ', '병신 같은 질문', '존나 어렵네', '닥쳐', '개같은 수업', 'this is shit']) {
      assert.ok(detectProfanity(t), t);
    }
    for (const t of ['시발점이 어디예요?', '시 발표를 준비해요', '불이 꺼져서 패널이 식어요', '새끼손가락만 한 관', '엄마를 졸라서 샀어요', '미친 듯이 더워요', '개새로운 아이디어', '등신대 모형', '태양광 패널 효율']) {
      assert.ok(!detectProfanity(t), t);
    }
    assert.equal(detectProfanity(null), false);
  });

  it('설정: 코드가 짧거나, 수업 코드와 같거나, 비밀 키가 없으면 켜지 않고 경고한다', () => {
    const base = { SESSION_SECRET: SECRET, ACCESS_CODE: 'student-code-1', ...SUPA };
    const cases = [
      [{ TEACHER_CODE: 'short' }, /12자/],
      [{ TEACHER_CODE: 'student-code-1' }, /ACCESS_CODE와 같아요/],
      [{ TEACHER_CODE: TEACHER, SUPABASE_SECRET_KEY: '' }, /SUPABASE_SECRET_KEY/],
    ];
    for (const [env, re] of cases) {
      const config = loadConfig({ ...base, ...env });
      assert.equal(config.teacherCode, '', String(re));
      assert.ok(config.warnings.some((w) => re.test(w) && w.includes('켜지 않았어요')), String(re));
      assert.equal(config.errors.length, 0); // 학생용 챗봇은 그대로 시작한다
      assert.equal(createTeacherStore(config), null);
    }
    assert.equal(loadConfig({ ...base }).teacherCode, '');
    const on = loadConfig({ ...base, TEACHER_CODE: TEACHER });
    assert.equal(on.teacherCode, TEACHER);
  });

  it('학생별·차시별로 묶고, 위기 신호가 있는 대화를 먼저, 그다음 욕설 대화를 최근 순으로 모은다', () => {
    const rows = [
      row(1, { student_id: '20102', student_name: '김철수', lesson: 1 }),
      row(2, { lesson: 1, content: '존나 어렵다' }),
      row(3, { lesson: 3, session_id: 's2' }),
      row(4, { lesson: 3, session_id: 's3', student_name: '홍길동2' }),
      row(5, { student_id: '20102', student_name: '김철수', lesson: 2, flagged: true, content: '요즘 사라지고 싶어요' }),
      row(6, { student_id: null, student_name: null, lesson: null, session_id: 'old' }),
      row(7, { lesson: 1, content: 'ㅅㅂ' }),
    ];
    const o = summarize(rows);
    assert.equal(o.totalMessages, 7);
    assert.deepEqual(o.students.map((s) => s.studentId), ['20101', '20102', null]);
    const hong = o.students[0];
    assert.deepEqual(hong.names, ['홍길동', '홍길동2']);
    assert.deepEqual(hong.lessons.map((l) => [l.lesson, l.messages, l.sessions]), [[1, 2, 1], [3, 2, 2]]);
    assert.equal(hong.profanity, 2);
    // 위기 신호(20102) 묶음이 먼저, 그다음 욕설(20101 1차시)
    assert.deepEqual(o.alerts.map((a) => [a.studentId, a.lesson, a.risk, a.profanity]), [['20102', 2, 1, 0], ['20101', 1, 0, 2]]);
    assert.deepEqual(o.alerts[1].names, ['홍길동', '홍길동2']);
    assert.deepEqual(o.alerts[1].samples.map((s) => s.text), ['존나 어렵다', 'ㅅㅂ']);
  });

  it('한 차시 기록을 대화(세션)별로 나누고, 학생 메시지에만 표시를 붙인다', () => {
    const c = groupConversation([
      row(1, { session_id: 'a', content: '자살' }),
      row(2, { session_id: 'a', role: 'tutor', content: '[단계 1/8 · 기존 기술의 문제 확인]\n괜찮아요?', flagged: false }),
      row(3, { session_id: 'b', content: '닥쳐' }),
    ]);
    assert.deepEqual(c.sessions.map((s) => [s.sessionId, s.messages.length]), [['a', 2], ['b', 1]]);
    assert.deepEqual(c.sessions[0].messages.map((m) => [m.role, m.risk, m.profanity]), [['student', true, false], ['tutor', false, false]]);
    assert.equal(c.sessions[1].messages[0].profanity, true);
    assert.deepEqual(c.names, ['홍길동']);
  });

  it('Supabase 저장소: 학생 메시지를 1000줄씩 나누어 읽고, 빈 학번·차시는 is null로 찾는다', async () => {
    const calls = [];
    const pages = [Array.from({ length: 1000 }, (_, i) => row(i + 1)), [row(1001)]];
    const client = {
      from(table) {
        calls.push(['from', table]);
        const b = {
          select(cols) { calls.push(['select', cols]); return b; },
          eq(col, v) { calls.push(['eq', col, v]); return b; },
          is(col, v) { calls.push(['is', col, v]); return b; },
          order(col, opts) { calls.push(['order', col, opts.ascending]); return b; },
          range(from, to) { calls.push(['range', from, to]); return Promise.resolve({ data: pages.shift() || [], error: null }); },
        };
        return b;
      },
    };
    const store = createTeacherStore({ teacherCode: TEACHER }, { client });
    const o = await store.overview();
    assert.equal(o.totalMessages, 1001);
    assert.equal(o.truncated, false);
    assert.deepEqual(calls.filter((c) => c[0] === 'range'), [['range', 0, 999], ['range', 1000, 1999]]);
    assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'role' && c[2] === 'student'));

    calls.length = 0;
    await store.conversation(null, null);
    assert.deepEqual(calls.filter((c) => c[0] === 'is'), [['is', 'student_id', null], ['is', 'lesson', null]]);
    calls.length = 0;
    await store.conversation('20101', 3);
    assert.deepEqual(calls.filter((c) => c[0] === 'eq'), [['eq', 'student_id', '20101'], ['eq', 'lesson', 3]]);

    const failing = createTeacherStore({ teacherCode: TEACHER }, {
      client: { from: () => { const b = { select: () => b, eq: () => b, order: () => b, range: () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }) }; return b; } },
    });
    await assert.rejects(failing.overview(), /42501/);
  });

  it('API: 꺼져 있으면 404, 코드가 틀리면 401, 너무 많이 틀리면 맞는 코드도 잠시 막는다', async () => {
    const off = await startHarness({});
    try {
      const r = await off.post('/api/teacher/overview', { teacherCode: TEACHER });
      assert.equal(r.status, 404);
      assert.equal(r.json.error, 'teacher_off');
    } finally { await off.close(); }

    const store = memoryTeacherStore();
    const h = await startHarness({ TEACHER_CODE: TEACHER, ...SUPA }, { teacherStore: store });
    try {
      const ok = await fetch(`${h.base}/api/teacher/overview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teacherCode: TEACHER }) });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await ok.json(), { students: [], alerts: [], totalMessages: 0, truncated: false });

      const statuses = [];
      for (let i = 0; i < 10; i++) statuses.push((await h.post('/api/teacher/overview', { teacherCode: 'wrong' })).status);
      assert.deepEqual(statuses, Array(10).fill(401));
      const locked = await h.post('/api/teacher/overview', { teacherCode: TEACHER });
      assert.equal(locked.status, 429);
      assert.equal(store.calls.length, 1); // 막힌 요청은 기록을 읽지 않는다
    } finally { await h.close(); }
  });

  it('API: 학번·차시를 검사하고, 빈 학번(null)도 받는다. 읽기 실패는 내용 없이 502로 알린다', async (t) => {
    const store = memoryTeacherStore();
    const h = await startHarness({ TEACHER_CODE: TEACHER, ...SUPA }, { teacherStore: store });
    try {
      const good = await h.post('/api/teacher/conversation', { teacherCode: TEACHER, studentId: '20101', lesson: 3 });
      assert.equal(good.status, 200);
      const none = await h.post('/api/teacher/conversation', { teacherCode: TEACHER, studentId: null, lesson: null });
      assert.equal(none.status, 200);
      assert.deepEqual(store.calls, [['conversation', '20101', 3], ['conversation', null, null]]);
      for (const bad of [{ studentId: '2010', lesson: 3 }, { studentId: '20101', lesson: 4 }, { studentId: '20101' }, { lesson: 1 }]) {
        assert.equal((await h.post('/api/teacher/conversation', { teacherCode: TEACHER, ...bad })).status, 400, JSON.stringify(bad));
      }
    } finally { await h.close(); }

    const errors = t.mock.method(console, 'error', () => {});
    const failing = await startHarness({ TEACHER_CODE: TEACHER, ...SUPA }, { teacherStore: memoryTeacherStore({ fail: true }) });
    try {
      const r = await failing.post('/api/teacher/overview', { teacherCode: TEACHER });
      assert.equal(r.status, 502);
      assert.equal(r.json.error, 'teacher_failed');
      assert.ok(errors.mock.calls.some((c) => /\[teacher\].*42501/.test(c.arguments[0])));
    } finally { await failing.close(); }
  });

  it('교사용 화면 파일이 있고, 학생 화면은 교사용 화면을 가리키지 않는다', async () => {
    const h = await startHarness({});
    try {
      const page = await (await fetch(`${h.base}/teacher.html`)).text();
      assert.match(page, /<script type="module" src="\/teacher.js"><\/script>/);
      assert.match(page, /noindex/);
      assert.equal((await fetch(`${h.base}/teacher.js`)).status, 200);
      assert.equal((await fetch(`${h.base}/teacher.css`)).status, 200);
      const student = await (await fetch(`${h.base}/`)).text();
      assert.doesNotMatch(student, /teacher/);
      const cfg = await (await fetch(`${h.base}/api/config`)).json();
      assert.doesNotMatch(JSON.stringify(cfg), /teacher/i);
    } finally { await h.close(); }
  });
});
