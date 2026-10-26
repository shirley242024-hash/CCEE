/* 교사용 대화 기록 화면. 기록을 보기만 한다(서버의 /api/teacher/*).
 * 선생님 코드는 이 페이지의 메모리에만 두고 브라우저 저장소에는 남기지 않는다.
 * 학생이 쓴 글은 모두 textContent로만 넣는다(HTML로 해석하지 않는다). */

const $ = (sel) => document.querySelector(sel);
const els = {
  login: $('#login'), form: $('#login-form'), code: $('#code'), loginStatus: $('#login-status'),
  board: $('#board'), summary: $('#summary'), truncated: $('#truncated'),
  alerts: $('#alerts'), pasted: $('#pasted'), students: $('#students'), filter: $('#filter'),
  detail: $('#detail'), detailTitle: $('#detail-title'), detailStatus: $('#detail-status'), sessions: $('#sessions'),
  back: $('#back'), reload: $('#reload'), lock: $('#lock'),
  printList: $('#print-list'), printStatus: $('#print-status'), printOne: $('#print-one'), printArea: $('#print-area'),
};
const state = { code: '', overview: null, scrollY: 0, listed: [], detailStudent: null, lessonInfo: null, printing: false };

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
    card.append(ul, openButton(a.studentId, a.lesson, a.names));
    els.alerts.append(card);
  }
  renderPasted(o.pasted || []);
  renderStudents();
}

function openButton(studentId, lesson, names) {
  const open = el('button', 'secondary', '대화 보기');
  open.type = 'button';
  open.addEventListener('click', () => openConversation(studentId, lesson, names));
  return open;
}

/** 챗봇이 '다른 AI 글'로 경고한 학생. 경고한 글과, 그 뒤에 학생이 보낸 글(다시 쓰기·선생님 호출·호출 완료)을 함께 보인다. */
function renderPasted(list) {
  els.pasted.replaceChildren();
  if (!list.length) els.pasted.append(el('p', 'hint', '다른 AI 글로 보인다고 경고한 대화가 없어요.'));
  for (const p of list) {
    const card = el('article', 't-alert paste');
    const head = el('div', 't-alert-head');
    head.append(el('strong', '', `${who(p.studentId, p.names)} · ${lessonLabel(p.lesson)}`));
    head.append(badge('paste', `경고 ${p.warnings}`));
    if (p.calls) head.append(badge('note', `선생님 호출 ${p.calls}`));
    head.append(el('span', 'hint', `마지막 ${fmt(p.lastAt)}`));
    card.append(head);
    const ul = el('ul', 't-samples');
    for (const item of p.items) {
      const li = el('li', 't-paste-item');
      const line = el('div');
      line.append(el('span', 'hint', `${fmt(item.createdAt)} 경고한 글: `), document.createTextNode(item.text ?? '(학생 글을 찾지 못했어요)'));
      li.append(line);
      if (item.next) {
        const next = el('div');
        next.append(el('span', 'hint', '그다음 학생 글: '), document.createTextNode(item.next));
        li.append(next);
      }
      ul.append(li);
    }
    card.append(ul, openButton(p.studentId, p.lesson, p.names));
    els.pasted.append(card);
  }
}

function renderStudents() {
  const q = els.filter.value.trim();
  els.students.replaceChildren();
  const list = state.overview.students.filter((s) => !q || (s.studentId || '').includes(q) || s.names.some((n) => n.includes(q)));
  state.listed = list;
  els.printList.textContent = q ? `찾은 학생 ${list.length}명 PDF로 저장` : `전체 학생 ${list.length}명 PDF로 저장`;
  els.printList.disabled = state.printing || !list.length;
  if (!list.length) els.students.append(el('p', 'hint', q ? '찾는 학생이 없어요.' : '아직 저장된 대화가 없어요.'));
  for (const s of list) {
    const row = el('article', 't-student');
    const head = el('div', 't-student-head');
    head.append(el('strong', '', s.studentId ?? '학번 없음'), el('span', '', s.names.join(' / ') || '이름 없음'));
    if (s.names.length > 1) head.append(badge('note', '이름이 여러 개'));
    if (s.risk) head.append(badge('risk', `위기 신호 ${s.risk}`));
    if (s.profanity) head.append(badge('prof', `욕설 ${s.profanity}`));
    if (s.pasted) head.append(badge('paste', `AI 글 경고 ${s.pasted}`));
    const pdf = el('button', 'ghost t-print', 'PDF로 저장');
    pdf.type = 'button';
    pdf.disabled = state.printing;
    pdf.addEventListener('click', () => printStudents([s], studentFileName(s), els.printStatus));
    head.append(pdf);
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
  state.detailStudent = state.overview?.students.find((s) => s.studentId === studentId) || null;
  els.printOne.hidden = !state.detailStudent;
  els.printOne.disabled = state.printing;
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
      if (m.pasted) meta.append(badge('paste', '다른 AI 글 경고'));
      if (m.call) meta.append(badge('note', '선생님 호출 안내'));
      const bubble = el('div', `bubble${m.risk || m.profanity ? ' t-marked' : m.pasted ? ' t-pasted' : ''}`);
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

/* ---------- PDF로 저장(브라우저 인쇄) ----------
 * 학생의 1~3차시 대화를 인쇄용으로 정리해 #print-area에 그리고 브라우저 인쇄 창을 연다.
 * 인쇄 창에서 대상을 'PDF로 저장'으로 고르면 PDF가 된다(파일 이름은 페이지 제목에서 온다).
 * 서버는 이미 있는 /api/teacher/conversation만 쓴다. 학생마다 새 쪽에서 시작하고, 쪽마다 학번·이름이 위에 찍힌다. */
const PRINT_CONCURRENCY = 4;
const KST = { timeZone: 'Asia/Seoul' };
const dayOf = (iso) => new Date(iso).toLocaleDateString('ko-KR', { ...KST, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const clockOf = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { ...KST, hour: '2-digit', minute: '2-digit', hour12: false });
const fileSafe = (text) => text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120);
const studentFileName = (s) => `${s.studentId ?? '학번없음'}_${s.names.join('_') || '이름없음'}_대화기록`;

/** 차시 제목과 단계 이름(학생 화면과 같은 /api/config). 못 읽으면 차시 번호만 쓴다. */
async function loadLessonInfo() {
  if (state.lessonInfo) return state.lessonInfo;
  const info = new Map();
  try {
    const cfg = await (await fetch('/api/config')).json();
    for (const l of cfg.lessons || []) info.set(l.id, { title: l.title, stages: l.stages || [] });
  } catch { /* 제목 없이도 인쇄한다 */ }
  state.lessonInfo = info;
  return info;
}

/** 학생들의 차시별 대화를 몇 개씩 나란히 읽는다. 하나라도 실패하면 멈추고 그 응답을 던진다. */
async function fetchConversations(students, onProgress) {
  const tasks = students.flatMap((s) => s.lessons.map((l) => ({ studentId: s.studentId, lesson: l.lesson })));
  const results = new Map();
  let next = 0;
  let done = 0;
  let failure = null;
  async function worker() {
    while (!failure && next < tasks.length) {
      const t = tasks[next++];
      const r = await post('/api/teacher/conversation', t);
      if (!r.ok) { failure = failure || r; return; }
      results.set(`${t.studentId}|${t.lesson}`, r.json);
      done += 1;
      onProgress(done, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PRINT_CONCURRENCY, tasks.length) }, worker));
  if (failure) throw failure;
  return results;
}

function stageLabel(info, n) {
  const name = info?.stages[n - 1];
  return `${n}단계${info?.stages.length ? `/${info.stages.length}` : ''}${name ? ` · ${name}` : ''}`;
}
function periodOf(messages) {
  if (!messages.length) return '-';
  const first = messages[0].createdAt;
  const last = messages[messages.length - 1].createdAt;
  const minutes = Math.round((new Date(last) - new Date(first)) / 60000);
  const range = dayOf(first) === dayOf(last)
    ? `${dayOf(first)} ${clockOf(first)}~${clockOf(last)}`
    : `${dayOf(first)} ${clockOf(first)} ~ ${dayOf(last)} ${clockOf(last)}`;
  return `${range} (${minutes}분)`;
}
function flagBadges(messages) {
  const count = (key) => messages.filter((m) => m[key]).length;
  const out = [];
  for (const [key, kind, label] of [['risk', 'risk', '위기 신호'], ['profanity', 'prof', '욕설'], ['pasted', 'paste', 'AI 글 경고']]) {
    const n = count(key);
    if (n) out.push(el('span', `p-badge ${kind}`, `${label} ${n}`));
  }
  return out;
}

/** 학생 한 명의 인쇄용 기록. 표의 머리(thead)는 쪽이 넘어가도 쪽마다 다시 찍힌다. */
function buildStudentPrint(student, results, lessonInfo, printedOn) {
  const sid = student.studentId ?? '학번 없음';
  const names = student.names.join(' / ') || '이름 없음';
  const table = el('table', 'p-table');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('td', 'p-running', `${sid} ${names} · 교사용 대화 기록 · ${printedOn} 출력`));
  thead.append(headRow);
  const tbody = el('tbody');
  const row = (...children) => {
    const tr = el('tr');
    const td = el('td');
    td.append(...children);
    tr.append(td);
    tbody.append(tr);
  };

  row(el('h1', 'p-title', `${sid} ${names}`));
  if (student.names.length > 1) row(el('p', 'p-note', '같은 학번으로 이름이 여러 개 기록되었어요. 학번·이름은 학생이 입력한 값이에요.'));

  // 요약: 차시마다 대화한 때, 주고받은 횟수, 마지막 단계, 표시
  const summary = el('table', 'p-summary');
  const sh = el('tr');
  for (const h of ['차시', '대화한 때', '주고받기', '마지막 단계', '표시']) sh.append(el('th', '', h));
  summary.append(sh);
  const lessons = student.lessons.map((l) => {
    const data = results.get(`${student.studentId}|${l.lesson}`) || { sessions: [], truncated: false };
    const messages = data.sessions.flatMap((x) => x.messages);
    return { lesson: l.lesson, info: lessonInfo.get(l.lesson), data, messages };
  });
  for (const l of lessons) {
    const tr = el('tr');
    const stages = l.messages.filter((m) => m.role !== 'student' && m.stage).map((m) => m.stage);
    const turns = l.messages.filter((m) => m.role === 'student').length;
    const flags = el('td');
    const badges = flagBadges(l.messages);
    if (badges.length) flags.append(...badges); else flags.textContent = '없음';
    tr.append(
      el('td', '', lessonLabel(l.lesson)),
      el('td', '', periodOf(l.messages)),
      el('td', '', `${turns}번${l.data.sessions.length > 1 ? ` (대화 ${l.data.sessions.length}개)` : ''}`),
      el('td', '', stages.length ? stageLabel(l.info, Math.max(...stages)) : '-'),
      flags,
    );
    summary.append(tr);
  }
  row(summary);

  // 차시별 대화 전문: 챗봇의 단계가 바뀌는 곳에 단계 제목을 넣는다
  for (const l of lessons) {
    row(el('h2', 'p-lesson', `${lessonLabel(l.lesson)}${l.info ? ` · ${l.info.title}` : ''}`));
    if (l.data.truncated) row(el('p', 'p-note', '기록이 너무 많아 앞부분만 담았어요.'));
    if (!l.data.sessions.length) row(el('p', 'p-note', '저장된 대화가 없어요.'));
    l.data.sessions.forEach((session, i) => {
      if (l.data.sessions.length > 1) row(el('h3', 'p-session', `대화 ${i + 1} · ${periodOf(session.messages)}`));
      let stage = null;
      for (const m of session.messages) {
        const student = m.role === 'student';
        if (!student && m.stage && m.stage !== stage) {
          stage = m.stage;
          row(el('div', 'p-stage', stageLabel(l.info, m.stage)));
        }
        const box = el('div', `p-msg ${student ? 'student' : 'tutor'}${m.risk || m.profanity ? ' marked' : m.pasted ? ' pasted' : ''}`);
        const who = el('div', 'p-who');
        who.append(el('strong', '', student ? '학생' : '챗봇'), el('span', '', clockOf(m.createdAt)));
        if (m.risk) who.append(el('span', 'p-badge risk', '위기 신호'));
        if (m.profanity) who.append(el('span', 'p-badge prof', '욕설'));
        if (m.pasted) who.append(el('span', 'p-badge paste', '다른 AI 글 경고'));
        if (m.call) who.append(el('span', 'p-badge note', '선생님 호출 안내'));
        const text = el('div', `p-text${student ? ' plain' : ''}`);
        if (student) text.textContent = m.content;
        else renderRich(text, m.content.replace(HEADER_RE, ''));
        box.append(who, text);
        row(box);
      }
    });
  }
  table.append(thead, tbody);
  const section = el('section', 'p-student');
  section.append(table);
  return section;
}

function setPrinting(on) {
  state.printing = on;
  els.printList.disabled = on || !state.listed.length;
  els.printOne.disabled = on;
  for (const b of document.querySelectorAll('.t-print')) b.disabled = on;
}

let endPrint = null;
/** 인쇄 창을 연다. 창이 닫히면(afterprint) 인쇄용 기록을 지우고 페이지 제목을 되돌린다. */
function openPrint(fileName) {
  endPrint?.();
  const title = document.title;
  document.title = fileSafe(fileName); // 'PDF로 저장'의 기본 파일 이름이 된다
  document.body.classList.add('printing');
  endPrint = () => {
    endPrint = null;
    document.body.classList.remove('printing');
    document.title = title;
    els.printArea.replaceChildren();
  };
  window.addEventListener('afterprint', () => endPrint?.(), { once: true });
  window.print();
}

async function printStudents(students, fileName, status) {
  if (state.printing || !students.length) return;
  setPrinting(true);
  status.textContent = 'PDF로 저장할 기록을 불러오는 중…';
  try {
    const lessonInfo = await loadLessonInfo();
    const results = await fetchConversations(students, (done, total) => {
      status.textContent = `기록을 불러오는 중… ${done}/${total}`;
    });
    const printedOn = dayOf(new Date().toISOString());
    els.printArea.replaceChildren(...students.map((s) => buildStudentPrint(s, results, lessonInfo, printedOn)));
    status.textContent = `인쇄 창에서 대상을 'PDF로 저장'으로 고르세요(${students.length}명). 인쇄 창이 열리지 않으면 다시 눌러 주세요.`;
    openPrint(fileName);
  } catch (r) {
    if (r?.status === 401 || r?.status === 429 || r?.status === 404) lock(r.message);
    else status.textContent = r?.message || 'PDF로 저장할 기록을 준비하지 못했어요.';
  } finally {
    setPrinting(false);
  }
}

function lock(message = '') {
  state.code = '';
  state.overview = null;
  els.code.value = '';
  els.printArea.replaceChildren();
  els.printStatus.textContent = '';
  els.alerts.replaceChildren();
  els.pasted.replaceChildren();
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
els.printList.addEventListener('click', () => {
  const q = els.filter.value.trim();
  const today = new Date().toLocaleDateString('sv-SE', KST).replaceAll('-', '');
  printStudents(state.listed, q ? `대화기록_찾은학생_${q}_${state.listed.length}명_${today}` : `대화기록_전체학생_${state.listed.length}명_${today}`, els.printStatus);
});
els.printOne.addEventListener('click', () => {
  if (state.detailStudent) printStudents([state.detailStudent], studentFileName(state.detailStudent), els.detailStatus);
});
els.back.addEventListener('click', backToList);
els.reload.addEventListener('click', () => { els.detail.hidden = true; loadOverview(); });
els.lock.addEventListener('click', () => lock('잠갔어요.'));
