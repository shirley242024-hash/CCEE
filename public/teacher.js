/* 교사용 대화 기록 화면. 기록을 보기만 한다(서버의 /api/teacher/*).
 * 선생님 코드는 이 페이지의 메모리에만 두고 브라우저 저장소에는 남기지 않는다.
 * 학생이 쓴 글은 모두 textContent로만 넣는다(HTML로 해석하지 않는다). */

const $ = (sel) => document.querySelector(sel);
const els = {
  login: $('#login'), form: $('#login-form'), code: $('#code'), loginStatus: $('#login-status'),
  board: $('#board'), summary: $('#summary'), truncated: $('#truncated'),
  alerts: $('#alerts'), students: $('#students'), filter: $('#filter'),
  detail: $('#detail'), detailTitle: $('#detail-title'), detailStatus: $('#detail-status'), sessions: $('#sessions'),
  back: $('#back'), reload: $('#reload'), lock: $('#lock'),
};
const state = { code: '', overview: null, scrollY: 0 };

const HEADER_RE = /^\s*\[단계\s*\d\s*\/\s*\d\s*·\s*[^\]\n]+\]\s*/;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '');
const lessonLabel = (n) => (n == null ? '차시 없음' : `${n}차시`);
const who = (studentId, names) => `${studentId ?? '학번 없음'}${names?.length ? ` ${names.join(' / ')}` : ''}`;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
function badge(kind, text) { return el('span', `t-badge ${kind}`, text); }

/* ---------- 글 그리기: 학생 화면(app.js)의 renderRich와 같은 규칙(굵게, 목록, 줄바꿈) ---------- */
function inline(parent, text) {
  text.split(/(\*\*[^*\n]+\*\*)/g).forEach((part) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(el('strong', '', part.slice(2, -2)));
    else parent.append(document.createTextNode(part));
  });
}
function renderRich(container, text) {
  let list = null;
  let para = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { list = null; para = null; continue; }
    if ((m = /^\s*[-•]\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      const kind = /^\s*[-•]/.test(line) ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== kind) { para = null; list = el(kind); container.append(list); }
      const li = el('li'); inline(li, m[1]); list.append(li);
    } else {
      list = null;
      if (!para) { para = el('p'); container.append(para); } else para.append(document.createElement('br'));
      inline(para, line.trim());
    }
  }
}

/* ---------- 서버 요청 ---------- */
async function post(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teacherCode: state.code, ...body }) });
  } catch {
    return { ok: false, status: 0, message: '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.' };
  }
  let json = null;
  try { json = await res.json(); } catch { /* 무시 */ }
  return { ok: res.ok, status: res.status, json, message: json?.message || `요청이 실패했어요(${res.status}).` };
}

/* ---------- 목록 ---------- */
async function loadOverview() {
  // 처음 열 때는 코드 칸 아래에, 다시 불러올 때는 목록 위에 상태를 보인다.
  const status = els.login.hidden ? els.summary : els.loginStatus;
  status.textContent = '불러오는 중…';
  const r = await post('/api/teacher/overview', {});
  if (!r.ok) {
    if (r.status === 401 || r.status === 429 || r.status === 404) lock(r.message);
    else status.textContent = r.message;
    return;
  }
  state.overview = r.json;
  els.loginStatus.textContent = '';
  els.login.hidden = true;
  els.board.hidden = false;
  els.detail.hidden = true;
  els.reload.hidden = false;
  els.lock.hidden = false;
  renderOverview();
}

function renderOverview() {
  const o = state.overview;
  els.summary.textContent = `학생 ${o.students.length}명 · 학생 메시지 ${o.totalMessages}개 · ${fmt(new Date().toISOString())}에 불러옴`;
  els.truncated.hidden = !o.truncated;
  els.truncated.textContent = '기록이 너무 많아 앞부분만 불러왔어요. 오래된 기록은 Supabase SQL Editor에서 정리해 주세요(docs/DEPLOY.md 2).';

  els.alerts.replaceChildren();
  if (!o.alerts.length) els.alerts.append(el('p', 'hint', '위기 신호나 욕설로 보이는 표현이 있는 대화가 없어요.'));
  for (const a of o.alerts) {
    const card = el('article', `t-alert${a.risk ? ' risk' : ''}`);
    const head = el('div', 't-alert-head');
    head.append(el('strong', '', `${who(a.studentId, a.names)} · ${lessonLabel(a.lesson)}`));
    if (a.risk) head.append(badge('risk', `위기 신호 ${a.risk}`));
    if (a.profanity) head.append(badge('prof', `욕설 ${a.profanity}`));
    head.append(el('span', 'hint', `마지막 ${fmt(a.lastAt)}`));
    card.append(head);
    const ul = el('ul', 't-samples');
    for (const s of a.samples) {
      const li = el('li');
      li.append(el('span', 'hint', `${fmt(s.createdAt)} `), document.createTextNode(s.text));
      ul.append(li);
    }
    card.append(ul);
    const open = el('button', 'secondary', '대화 보기');
    open.type = 'button';
    open.addEventListener('click', () => openConversation(a.studentId, a.lesson, a.names));
    card.append(open);
    els.alerts.append(card);
  }
  renderStudents();
}

function renderStudents() {
  const q = els.filter.value.trim();
  els.students.replaceChildren();
  const list = state.overview.students.filter((s) => !q || (s.studentId || '').includes(q) || s.names.some((n) => n.includes(q)));
  if (!list.length) els.students.append(el('p', 'hint', q ? '찾는 학생이 없어요.' : '아직 저장된 대화가 없어요.'));
  for (const s of list) {
    const row = el('article', 't-student');
    const head = el('div', 't-student-head');
    head.append(el('strong', '', s.studentId ?? '학번 없음'), el('span', '', s.names.join(' / ') || '이름 없음'));
    if (s.names.length > 1) head.append(badge('note', '이름이 여러 개'));
    if (s.risk) head.append(badge('risk', `위기 신호 ${s.risk}`));
    if (s.profanity) head.append(badge('prof', `욕설 ${s.profanity}`));
    row.append(head);
    const lessons = el('div', 't-lessons');
    for (const l of s.lessons) {
      const b = el('button', 'secondary t-lesson');
      b.type = 'button';
      b.append(el('span', '', lessonLabel(l.lesson)), el('span', 't-lesson-sub', `메시지 ${l.messages}개${l.sessions > 1 ? ` · 대화 ${l.sessions}개` : ''} · ${fmt(l.lastAt)}`));
      b.addEventListener('click', () => openConversation(s.studentId, l.lesson, s.names));
      lessons.append(b);
    }
    row.append(lessons);
    els.students.append(row);
  }
}

/* ---------- 한 학생의 한 차시 대화 ---------- */
async function openConversation(studentId, lesson, names) {
  state.scrollY = window.scrollY;
  els.board.hidden = true;
  els.detail.hidden = false;
  els.detailTitle.textContent = `${who(studentId, names)} · ${lessonLabel(lesson)}`;
  els.sessions.replaceChildren();
  els.detailStatus.textContent = '불러오는 중…';
  window.scrollTo(0, 0);
  const r = await post('/api/teacher/conversation', { studentId, lesson });
  if (!r.ok) {
    if (r.status === 401 || r.status === 429 || r.status === 404) lock(r.message);
    else els.detailStatus.textContent = r.message;
    return;
  }
  const c = r.json;
  els.detailTitle.textContent = `${who(studentId, c.names)} · ${lessonLabel(lesson)}`;
  els.detailStatus.textContent = c.truncated ? '기록이 너무 많아 앞부분만 보여요.' : '';
  if (!c.sessions.length) els.sessions.append(el('p', 'hint', '이 차시에 저장된 대화가 없어요.'));
  c.sessions.forEach((s, i) => {
    const block = el('section', 't-session');
    block.append(el('h3', '', `대화 ${i + 1} · ${fmt(s.startedAt)} 시작`));
    const thread = el('div', 'thread');
    for (const m of s.messages) {
      const wrap = el('div', `msg ${m.role === 'student' ? 'student' : 'tutor'}`);
      const meta = el('div', 't-meta');
      if (m.role === 'tutor' && m.stage) meta.append(el('span', 'stage-chip', `${m.stage}단계`));
      meta.append(el('span', 'hint', `${m.role === 'student' ? '학생' : '챗봇'} · ${fmt(m.createdAt)}`));
      if (m.risk) meta.append(badge('risk', '위기 신호'));
      if (m.profanity) meta.append(badge('prof', '욕설'));
      const bubble = el('div', `bubble${m.risk || m.profanity ? ' t-marked' : ''}`);
      if (m.role === 'student') bubble.textContent = m.content;
      else renderRich(bubble, m.content.replace(HEADER_RE, ''));
      wrap.append(meta, bubble);
      thread.append(wrap);
    }
    block.append(thread);
    els.sessions.append(block);
  });
}

function backToList() {
  els.detail.hidden = true;
  els.board.hidden = false;
  window.scrollTo(0, state.scrollY);
}

function lock(message = '') {
  state.code = '';
  state.overview = null;
  els.code.value = '';
  els.alerts.replaceChildren();
  els.students.replaceChildren();
  els.sessions.replaceChildren();
  els.board.hidden = true;
  els.detail.hidden = true;
  els.reload.hidden = true;
  els.lock.hidden = true;
  els.login.hidden = false;
  els.loginStatus.textContent = message;
  els.code.focus();
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = els.code.value.trim();
  if (!code) { els.loginStatus.textContent = '선생님 코드를 입력해 주세요.'; return; }
  state.code = code;
  els.code.value = '';
  loadOverview();
});
els.filter.addEventListener('input', renderStudents);
els.back.addEventListener('click', backToList);
els.reload.addEventListener('click', () => { els.detail.hidden = true; loadOverview(); });
els.lock.addEventListener('click', () => lock('잠갔어요.'));
