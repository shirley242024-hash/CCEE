import { createClient } from '@supabase/supabase-js';
import { detectCallTeacher, detectPasteWarning, detectProfanity, detectRisk } from './safety.js';

/** Supabase가 한 번에 돌려주는 최대 줄 수에 맞춰 나누어 읽는다. */
const PAGE = 1000;
/** 이보다 많으면 읽기를 멈추고 화면에 일부만 보인다고 알린다(요청 시간과 응답 크기를 지키기 위해). */
export const MAX_ROWS = 20_000;
const SAMPLE_CHARS = 120;
const PASTE_CHARS = 200; // 붙여 넣은 것으로 보인 글은 판단 근거라서 조금 더 길게 보인다
const SAMPLES_PER_GROUP = 3;

const excerpt = (text, max = SAMPLE_CHARS) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
};
/** 학생 글과 그에 대한 챗봇 응답은 한 번에 기록되어 대화(세션)와 시각이 같다(server/logger.js). */
const turnKey = (row) => `${row.session_id}|${row.created_at}`;

/**
 * 학생 메시지 줄(role='student')을 학번별·차시별로 묶고, 먼저 볼 대화(위기 신호·욕설)를 따로 모은다.
 * 위기 신호는 기록할 때 붙인 표시와 지금의 검사를 함께 본다. 욕설은 읽을 때 검사한다.
 * marks는 '다른 AI 글' 경고나 선생님 호출 안내가 들어 있는 챗봇 응답 줄이다. 같은 턴의 학생 글과 묶어 따로 모은다.
 */
export function summarize(rows, marks = []) {
  const students = new Map();
  const alerts = new Map();
  for (const row of rows) {
    const studentId = row.student_id || null;
    const lesson = row.lesson ?? null;
    const risk = !!row.flagged || detectRisk(row.content);
    const profanity = detectProfanity(row.content);

    let s = students.get(studentId);
    if (!s) {
      s = { studentId, names: [], lessons: new Map(), risk: 0, profanity: 0, pasted: 0, lastAt: null };
      students.set(studentId, s);
    }
    if (row.student_name && !s.names.includes(row.student_name)) s.names.push(row.student_name);
    let l = s.lessons.get(lesson);
    if (!l) {
      l = { lesson, messages: 0, sessions: new Set(), firstAt: row.created_at, lastAt: row.created_at, risk: 0, profanity: 0, pasted: 0 };
      s.lessons.set(lesson, l);
    }
    l.messages += 1;
    l.sessions.add(row.session_id);
    l.lastAt = row.created_at;
    s.lastAt = row.created_at;
    if (risk) { l.risk += 1; s.risk += 1; }
    if (profanity) { l.profanity += 1; s.profanity += 1; }

    if (risk || profanity) {
      const key = `${studentId ?? ''}|${lesson ?? ''}`;
      let a = alerts.get(key);
      if (!a) {
        a = { studentId, lesson, risk: 0, profanity: 0, lastAt: null, samples: [] };
        alerts.set(key, a);
      }
      if (risk) a.risk += 1;
      if (profanity) a.profanity += 1;
      a.lastAt = row.created_at;
      a.samples.push({ createdAt: row.created_at, risk, profanity, text: excerpt(row.content) });
      if (a.samples.length > SAMPLES_PER_GROUP) a.samples.shift(); // 최근 것만 남긴다
    }
  }

  // 다른 AI 글 경고: 경고한 챗봇 응답과 같은 턴의 학생 글, 그리고 그 대화에서 학생이 바로 다음에 보낸 글을 모은다.
  const turnIndex = new Map(rows.map((row, i) => [turnKey(row), i]));
  const studentRowOf = (m) => {
    const i = turnIndex.get(turnKey(m));
    if (i !== undefined) return i;
    // 시각이 다르게 기록된 경우를 대비해, 같은 대화에서 이 응답 바로 앞의 학생 글을 쓴다(줄 번호 순서).
    let found;
    for (let j = 0; j < rows.length && rows[j].id < m.id; j += 1) if (rows[j].session_id === m.session_id) found = j;
    return found;
  };
  const pasted = new Map();
  for (const m of marks) {
    const warning = detectPasteWarning(m.content);
    const call = detectCallTeacher(m.content);
    if (!warning && !call) continue;
    const studentId = m.student_id || null;
    const lesson = m.lesson ?? null;
    const key = `${studentId ?? ''}|${lesson ?? ''}`;
    let p = pasted.get(key);
    if (!p) {
      p = { studentId, lesson, fallbackName: m.student_name || null, warnings: 0, calls: 0, lastAt: null, items: [] };
      pasted.set(key, p);
    }
    if (call) p.calls += 1;
    if (!warning) continue;
    p.warnings += 1;
    if (!p.lastAt || m.created_at > p.lastAt) p.lastAt = m.created_at;
    const i = studentRowOf(m);
    let next = null;
    if (i !== undefined) {
      for (let j = i + 1; j < rows.length; j += 1) {
        if (rows[j].session_id === m.session_id) { next = rows[j]; break; }
      }
    }
    p.items.push({
      createdAt: m.created_at,
      text: i === undefined ? null : excerpt(rows[i].content, PASTE_CHARS),
      next: next ? excerpt(next.content) : null,
    });
    if (p.items.length > SAMPLES_PER_GROUP) p.items.shift(); // 최근 것만 남긴다
  }
  for (const p of pasted.values()) {
    const s = students.get(p.studentId);
    const l = s?.lessons.get(p.lesson);
    if (l) l.pasted += p.warnings;
    if (s) s.pasted += p.warnings;
  }

  const byLesson = (a, b) => (a.lesson ?? 99) - (b.lesson ?? 99);
  const list = [...students.values()]
    .map((s) => ({
      ...s,
      lessons: [...s.lessons.values()].map((l) => ({ ...l, sessions: l.sessions.size })).sort(byLesson),
    }))
    // 학번 순서, 학번 없는 기록은 맨 뒤
    .sort((a, b) => (a.studentId ?? '￿').localeCompare(b.studentId ?? '￿'));
  const names = new Map(list.map((s) => [s.studentId, s.names]));
  const alertList = [...alerts.values()]
    .map((a) => ({ ...a, names: names.get(a.studentId) || [] }))
    // 위기 신호가 있는 묶음을 먼저, 그다음 최근 것부터
    .sort((a, b) => (b.risk > 0) - (a.risk > 0) || String(b.lastAt).localeCompare(String(a.lastAt)));
  const pastedList = [...pasted.values()]
    .filter((p) => p.warnings > 0)
    .map(({ fallbackName, ...p }) => {
      const known = names.get(p.studentId);
      return { ...p, names: known?.length ? known : fallbackName ? [fallbackName] : [] };
    })
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return { students: list, alerts: alertList, pasted: pastedList, totalMessages: rows.length };
}

/** 한 학생의 한 차시 기록을 대화(세션)별로 나눈다. 대화 순서는 처음 나온 순서. */
export function groupConversation(rows) {
  const sessions = new Map();
  const lastStudent = new Map(); // 대화별로 바로 앞의 학생 메시지(챗봇이 '다른 AI 글'로 경고하면 여기에 표시한다)
  for (const row of rows) {
    let s = sessions.get(row.session_id);
    if (!s) {
      s = { sessionId: row.session_id, startedAt: row.created_at, messages: [] };
      sessions.set(row.session_id, s);
    }
    const student = row.role === 'student';
    const message = {
      id: row.id,
      createdAt: row.created_at,
      role: row.role,
      stage: row.stage ?? null,
      content: row.content,
      risk: student && (!!row.flagged || detectRisk(row.content)),
      profanity: student && detectProfanity(row.content),
      pasted: false,
      call: !student && detectCallTeacher(row.content),
    };
    s.messages.push(message);
    if (student) lastStudent.set(row.session_id, message);
    else if (detectPasteWarning(row.content) && lastStudent.has(row.session_id)) lastStudent.get(row.session_id).pasted = true;
  }
  const names = [];
  for (const row of rows) if (row.student_name && !names.includes(row.student_name)) names.push(row.student_name);
  return { names, sessions: [...sessions.values()] };
}

/**
 * 교사용 화면이 읽는 대화 기록(chat_logs). 읽기만 한다.
 * 서버 전용 비밀 키(secret key)로만 읽는다. 공개용 키로는 이 표를 읽을 수 없다(supabase/schema.sql).
 * 실패 로그에 대화 내용과 학번은 남기지 않는다.
 */
export function createTeacherStore(config, { client } = {}) {
  if (!config.teacherCode) return null;
  const supabase =
    client ||
    createClient(config.supabaseUrl, config.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  /** 질의를 PAGE줄씩 나누어 모두 읽는다. build()는 매번 새 질의를 만든다. */
  async function readAll(build) {
    const rows = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw new Error(`읽기: ${error.code || ''} ${error.message || error}`);
      rows.push(...(data || []));
      if (!data || data.length < PAGE) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }

  return {
    async overview() {
      // 경고·호출 안내 문장이 든 챗봇 응답만 따로 읽는다(띄어쓰기가 조금 달라도 찾도록 낱말 사이를 %로 둔다).
      const tutorRows = (pattern) => () => supabase
        .from('chat_logs')
        .select('id, created_at, session_id, lesson, student_id, student_name, content')
        .eq('role', 'tutor')
        .like('content', pattern)
        .order('id', { ascending: true });
      const [student, warnings, calls] = await Promise.all([
        readAll(() => supabase
          .from('chat_logs')
          .select('id, created_at, session_id, lesson, student_id, student_name, flagged, content')
          .eq('role', 'student')
          .order('id', { ascending: true })),
        readAll(tutorRows('%붙여%넣은%것으로%보입니다%')),
        readAll(tutorRows('%손을%들어%선생님을%불러%주세요%')),
      ]);
      const marks = [...new Map([...warnings.rows, ...calls.rows].map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id);
      return { ...summarize(student.rows, marks), truncated: student.truncated || warnings.truncated || calls.truncated };
    },
    /** studentId·lesson이 null이면 그 값이 비어 있는 기록을 읽는다. */
    async conversation(studentId, lesson) {
      const { rows, truncated } = await readAll(() => {
        let q = supabase
          .from('chat_logs')
          .select('id, created_at, session_id, role, stage, flagged, content, student_name');
        q = studentId === null ? q.is('student_id', null) : q.eq('student_id', studentId);
        q = lesson === null ? q.is('lesson', null) : q.eq('lesson', lesson);
        return q.order('id', { ascending: true });
      });
      return { studentId, lesson, ...groupConversation(rows), truncated };
    },
  };
}
