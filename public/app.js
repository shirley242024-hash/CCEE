// 학생용 채팅 화면. 서버가 준 글은 항상 textContent로만 그린다(HTML로 해석하지 않는다).
// 차시 목록(제목, 단계 이름, 시작 안내)은 서버의 /api/config에서 받는다.
const STORE_KEYS = { 1: 'ccee.lesson1.v2' }; // 1차시는 차시를 나누기 전과 같은 이름이라 열려 있던 대화가 이어진다
const CURRENT_KEY = 'ccee.current';
const HEADER_RE = /^\s*\[단계\s*(\d)\s*\/\s*(\d)\s*·\s*([^\]\n]+)\]\s*/;
const START_TEXT = '안녕하세요! 시작할게요.';
const CARD_NOTE = '(1차시 정리 카드를 함께 보냈어요)';
const SID_RE = /^\d{5}$/;

const $ = (sel) => document.querySelector(sel);
const els = {
  main: $('#main'), log: $('#log'), steps: $('#steps'), caption: $('#stage-caption'), form: $('#composer'), input: $('#input'),
  send: $('#send'), reset: $('#reset'), toPicker: $('#to-picker'), download: $('#download'), intro: $('#intro'), start: $('#start'), counter: $('#counter'),
  codeField: $('#code-field'), code: $('#code'), labelField: $('#label-field'), label: $('#label'), logNotice: $('#log-notice'),
  title: $('#title'), subtitle: $('#subtitle'), picker: $('#picker'), lessonList: $('#lesson-list'), rules: $('#rules'),
  cardIn: $('#card-in'), cardInHint: $('#card-in-hint'), cardLoad: $('#card-load'), loadSid: $('#load-sid'), loadCard: $('#load-card'),
  cardText: $('#card-text'), cardStatus: $('#card-status'),
};
const introNode = els.intro; // 시작 카드(실패했을 때 되살린다)

/*
 * 화면·저장·서버의 대화가 어긋나지 않도록 한 가지 원칙을 쓴다.
 *  - 응답이 정상으로 끝났을 때만 transcript(저장되는 대화)에 '학생 말 + 챗봇 답'을 한 쌍으로 넣는다.
 *  - 실패하면 이번에 보낸 말풍선을 지우고, 쓴 글을 입력창에 되돌려 놓는다.
 */
const state = {
  cfg: { requiresAccessCode: false, logging: false, cardStorage: false, maxChars: 1000, maxCardChars: 3000, lessons: [] },
  cfgOk: false,
  cfgError: '',
  lesson: null, // 지금 하는 차시(차시 고르기 화면에서는 null)
  token: null,
  busy: false,
  stage: 0, // 서버가 확정한 현재 단계
  transcript: [], // { role: 'student' | 'tutor', text }
  pending: null, // 응답을 기다리는 중인 학생 글(새로고침해도 잃지 않도록 저장)
  studentId: '', // 정리 카드를 저장하거나 불러올 때 쓴 학번
  leaving: false, // 새로고침·탭 닫기 중(이때의 연결 끊김은 실패로 처리하지 않는다)
};
window.addEventListener('pagehide', () => { state.leaving = true; });
window.addEventListener('beforeunload', () => { state.leaving = true; });

/* ---------- 저장(새로고침해도 대화 유지). 차시마다 따로 저장한다. 막혀 있어도 동작해야 한다. ---------- */
const storeKey = (id) => STORE_KEYS[id] || `ccee.lesson${id}.v1`;
function readKey(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function save() {
  if (!state.lesson) return;
  try {
    sessionStorage.setItem(storeKey(state.lesson.id), JSON.stringify({
      token: state.token, stage: state.stage, transcript: state.transcript, pending: state.pending,
      code: els.code.value, label: els.label.value, studentId: state.studentId,
    }));
  } catch { /* 저장 불가: 무시 */ }
}
function clearSaved() {
  try { sessionStorage.removeItem(storeKey(state.lesson.id)); } catch { /* 무시 */ }
}
/** 지금 하는 차시를 기억한다. 0은 학생이 직접 '차시 고르기'로 나온 상태다. */
function setCurrent(id) {
  try { sessionStorage.setItem(CURRENT_KEY, String(id || 0)); } catch { /* 무시 */ }
}

/* ---------- 진행 단계 ---------- */
const stageName = (n) => state.lesson?.stages[n - 1] || '';
function buildSteps() {
  els.steps.replaceChildren();
  els.steps.style.gridTemplateColumns = `repeat(${state.lesson.stages.length}, minmax(0, 1fr))`;
  state.lesson.stages.forEach((name, i) => {
    const li = document.createElement('li');
    li.dataset.step = String(i + 1);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = name;
    const s = document.createElement('span');
    s.className = 'sr-only st';
    li.append(t, s);
    els.steps.append(li);
  });
  renderStage(0);
}
/** 화면의 단계 표시만 바꾼다(확정은 commitStage). */
function renderStage(n) {
  [...els.steps.children].forEach((li) => {
    const step = Number(li.dataset.step);
    li.classList.toggle('current', step === n);
    li.classList.toggle('done', step < n);
    li.querySelector('.st').textContent = step === n ? ' (현재 단계)' : step < n ? ' (끝남)' : '';
    if (step === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  els.caption.textContent = n ? `${n}단계 · ${stageName(n)}` : '';
}
function commitStage(n) {
  state.stage = n;
  renderStage(n);
}

/* ---------- 글 그리기(안전한 간단 마크다운) ---------- */
function inline(parent, text) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  parts.forEach((part) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const s = document.createElement('strong'); s.textContent = part.slice(2, -2); parent.append(s);
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const c = document.createElement('code'); c.textContent = part.slice(1, -1); parent.append(c);
    } else {
      parent.append(document.createTextNode(part));
    }
  });
}
function renderRich(container, text) {
  container.replaceChildren();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let list = null; // { kind: 'ul' | 'ol', el }
  let para = null;
  let quote = null;
  const flush = () => { list = null; para = null; quote = null; };

  lines.forEach((raw) => {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); return; }
    let m;
    if ((m = /^\s*[-•]\s+(.*)$/.exec(line))) {
      if (!list || list.kind !== 'ul') { flush(); list = { kind: 'ul', el: document.createElement('ul') }; container.append(list.el); }
      const li = document.createElement('li'); inline(li, m[1]); list.el.append(li);
    } else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
      if (!list || list.kind !== 'ol') {
        flush(); list = { kind: 'ol', el: document.createElement('ol') };
        list.el.start = Number(m[1]); container.append(list.el);
      }
      const li = document.createElement('li'); inline(li, m[2]); list.el.append(li);
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      if (!quote) { flush(); quote = document.createElement('blockquote'); container.append(quote); }
      if (quote.childNodes.length) quote.append(document.createElement('br'));
      inline(quote, m[1]);
    } else {
      list = null; quote = null;
      if (!para) { para = document.createElement('p'); container.append(para); } else { para.append(document.createElement('br')); }
      inline(para, line.trim());
    }
  });
}

/** 챗봇 글 맨 앞의 [단계 n/전체 · 이름] 줄을 떼어 낸다. 스트리밍 중 잘린 머리글은 숨긴다. */
function splitHeader(text) {
  const m = HEADER_RE.exec(text);
  if (m) {
    const n = Number(m[1]);
    const total = state.lesson.stages.length;
    const ok = Number(m[2]) === total && n >= 1 && n <= total;
    return { stage: ok ? n : null, body: text.slice(m[0].length), pending: false };
  }
  const t = text.trimStart();
  if (t.startsWith('[') && !t.includes('\n') && !t.includes(']') && t.length < 40) return { stage: null, body: '', pending: true };
  return { stage: null, body: text, pending: false };
}

/* ---------- 말풍선 ---------- */
function addMessage(role) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.append(bubble);
  els.log.append(wrap);
  return { wrap, bubble };
}
function showDots(bubble) {
  bubble.replaceChildren();
  const d = document.createElement('span');
  d.className = 'dots';
  d.setAttribute('role', 'status');
  d.setAttribute('aria-label', '답변을 쓰는 중');
  d.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  bubble.append(d);
}
function setStageChip(wrap, stage) {
  if (!stage) return;
  let chip = wrap.querySelector('.stage-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'stage-chip';
    wrap.prepend(chip);
  }
  chip.textContent = `${stage}단계 · ${stageName(stage)}`;
}
function addNotice(text, { error = false } = {}) {
  const box = document.createElement('div');
  box.className = `notice-line${error ? ' error' : ''}`;
  box.setAttribute('role', 'alert');
  const span = document.createElement('span');
  span.textContent = text;
  box.append(span);
  els.log.append(box);
  scrollDown(true);
  return box;
}
function clearNotices() {
  els.log.querySelectorAll('.notice-line').forEach((n) => n.remove());
}

/** JSON을 보내고 { ok, data } 또는 { ok: false, code, message }를 돌려준다. */
async function postJson(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    if (res.ok) return { ok: true, data };
    return { ok: false, code: data.error || '', message: data.message || '문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.' };
  } catch {
    return { ok: false, code: 'network', message: '인터넷 연결을 확인해 주세요.' };
  }
}

/* ---------- 1차시 정리 카드 ---------- */
const isCard = (text) => !!state.lesson?.makesCard && text.includes('정리 카드') && text.includes('선택한 기술');
/** 챗봇 글에서 정리 카드(제목 줄 + 항목 줄들)만 잘라 낸다. 서버도 같은 결과가 대화 안에 있는지로 카드를 확인한다. */
function extractCard(text) {
  const lines = text.split('\n');
  let start = lines.findIndex((l) => /^\s*(\*\*)?\s*정리 카드\s*(\*\*)?\s*:?\s*$/.test(l));
  if (start < 0) {
    // 제목 줄 형식이 다르면 '선택한 기술' 항목 바로 앞 줄부터
    const first = lines.findIndex((l) => l.includes('선택한 기술'));
    start = first > 0 ? first - 1 : first;
  }
  if (start < 0) return text.replace(/\*\*/g, '').trim();
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*[-•]\s/.test(lines[i])) end = i;
    else if (lines[i].trim() === '' && end === start) continue; // 제목과 항목 사이의 빈 줄
    else break;
  }
  return lines.slice(start, end + 1).join('\n').replace(/\*\*/g, '').trim();
}
function addCardTools(wrap, text) {
  const tools = document.createElement('div');
  tools.className = 'tools';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link';
  b.textContent = '정리 카드 복사';
  const status = document.createElement('span');
  status.className = 'hint';
  status.setAttribute('aria-live', 'polite');
  b.addEventListener('click', async () => {
    const plain = extractCard(text);
    try {
      await navigator.clipboard.writeText(plain);
      status.textContent = '복사했어요.';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = plain; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      status.textContent = ok ? '복사했어요.' : '복사하지 못했어요. 글을 직접 선택해서 복사해 주세요.';
    }
  });
  tools.append(b, status);
  wrap.append(tools);
  if (state.cfg.cardStorage) wrap.append(cardSaveRow(text));
}
/** 정리 카드를 학번으로 저장하는 줄(2차시에서 학번으로 불러온다). */
function cardSaveRow(text) {
  const box = document.createElement('div');
  box.className = 'card-save';
  const row = document.createElement('div');
  row.className = 'row';
  const input = document.createElement('input');
  Object.assign(input, { type: 'text', inputMode: 'numeric', maxLength: 5, autocomplete: 'off', placeholder: '학번 5자리', className: 'sid', value: state.studentId });
  input.setAttribute('aria-label', '학번 5자리');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary';
  btn.textContent = '학번으로 저장';
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('aria-live', 'polite');
  btn.addEventListener('click', async () => {
    const sid = input.value.trim();
    if (!SID_RE.test(sid)) { status.textContent = '학번은 숫자 5자리로 입력해 주세요. (예: 20101)'; input.focus(); return; }
    btn.disabled = true;
    status.textContent = '저장하는 중이에요…';
    const r = await postJson('/api/cards/save', { accessCode: els.code.value.trim(), studentId: sid, state: state.token, card: extractCard(text) });
    btn.disabled = false;
    if (r.ok) {
      state.studentId = sid;
      save();
      status.textContent = `저장했어요. 2차시에서 학번 ${sid}로 불러올 수 있어요. 복사해서 따로 보관해 두면 더 안전해요.`;
    } else {
      status.textContent = r.message;
    }
  });
  row.append(input, btn);
  box.append(row, status);
  return box;
}
function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
els.loadCard.addEventListener('click', async () => {
  const sid = els.loadSid.value.trim();
  if (!SID_RE.test(sid)) { els.cardStatus.textContent = '학번은 숫자 5자리로 입력해 주세요. (예: 20101)'; els.loadSid.focus(); return; }
  if (!validateFields()) return;
  els.loadCard.disabled = true;
  els.cardStatus.textContent = '불러오는 중이에요…';
  const r = await postJson('/api/cards/load', { accessCode: els.code.value.trim(), studentId: sid });
  els.loadCard.disabled = false;
  if (r.ok) {
    els.cardText.value = r.data.card;
    state.studentId = sid;
    const when = formatTime(r.data.savedAt);
    els.cardStatus.textContent = `${when ? `${when}에 ` : ''}저장한 카드를 불러왔어요. 내 카드가 맞는지 확인해 주세요.`;
  } else {
    els.cardStatus.textContent = r.message;
  }
});

/* ---------- 대화 내려받기(학생이 대화를 파일로 보관한다) ---------- */
function updateDownload() {
  els.download.hidden = !state.lesson || state.transcript.length === 0;
}
function downloadTranscript() {
  const now = new Date();
  const lines = [`${state.lesson.id}차시 · ${state.lesson.title}`, `내려받은 때: ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`, ''];
  state.transcript.forEach((m) => {
    if (m.role === 'student') {
      lines.push('[나]', m.text, '');
    } else {
      const { stage, body } = splitHeader(m.text);
      lines.push(stage ? `[챗봇 · ${stage}단계 ${stageName(stage)}]` : '[챗봇]', body.replace(/\*\*/g, '').trim(), '');
    }
  });
  // 메모장 등에서 한글이 깨지지 않도록 UTF-8 표시(BOM)를 붙인다.
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = now.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);
  a.href = url;
  // 한글 파일 이름은 일부 브라우저에서 무시되어 영문으로 짓는다(예: ccee-lesson2-20261012-0930.txt).
  a.download = `ccee-lesson${state.lesson.id}-${stamp}.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
els.download.addEventListener('click', downloadTranscript);

let stick = true;
els.main.addEventListener('scroll', () => {
  stick = els.main.scrollHeight - els.main.scrollTop - els.main.clientHeight < 80;
});
function scrollDown(force = false) {
  if (force || stick) els.main.scrollTop = els.main.scrollHeight;
}

function showIntro() {
  if (els.intro) return;
  els.main.insertBefore(introNode, els.log);
  els.intro = introNode;
}
function hideIntro() {
  els.intro?.remove();
  els.intro = null;
}

/* ---------- 보내기 ---------- */
function setBusy(busy, { focus = true } = {}) {
  state.busy = busy;
  els.input.disabled = busy;
  els.send.disabled = busy;
  els.start.disabled = busy;
  // 스트리밍 중에는 스크린 리더가 글자마다 읽지 않도록 하고, 끝나면 한 번에 읽게 한다.
  els.log.setAttribute('aria-busy', String(busy));
  if (!busy && focus) els.input.focus({ preventScroll: true });
}

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { onEvent(event, JSON.parse(data)); } catch { /* 깨진 조각은 무시 */ }
    }
  }
}

async function send(text, { fromStart = false, card = '' } = {}) {
  if (state.busy) return;
  clearNotices();
  hideIntro();

  const shown = card ? `${text}\n\n${CARD_NOTE}` : text; // 화면과 저장에는 카드 대신 안내만 남긴다
  const studentMsg = addMessage('student');
  studentMsg.bubble.textContent = shown;
  const tutor = addMessage('tutor');
  showDots(tutor.bubble);
  stick = true;
  scrollDown(true);
  setBusy(true);
  state.pending = fromStart ? null : text;
  save();

  let buffer = '';
  let finished = false;
  let focusAfter = null;

  /** 실패: 이번 말풍선을 지우고, 단계 표시를 되돌리고, 쓴 글을 입력창에 돌려 놓는다. */
  const rollback = (message) => {
    if (state.leaving) return;
    finished = true;
    tutor.wrap.remove();
    studentMsg.wrap.remove();
    renderStage(state.stage);
    state.pending = null;
    save();
    if (!fromStart && !els.input.value) { els.input.value = text; autosize(); }
    if (state.transcript.length === 0) showIntro();
    addNotice(!fromStart && els.input.value === text ? `${message} 쓴 글은 입력창에 그대로 있어요.` : message, { error: true });
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text, lesson: state.lesson.id, card: card || undefined, state: state.token,
        accessCode: els.code.value.trim(), label: els.label.value.trim(),
      }),
    });

    if (!res.ok) {
      let msg = '문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.';
      let code = '';
      try { const j = await res.json(); msg = j.message || msg; code = j.error || ''; } catch { /* 본문 없음 */ }
      if (code === 'bad_code') {
        // 코드 칸이 없었던 경우(설정을 못 읽었거나 서버에서 코드를 새로 켠 경우)에도 입력할 수 있게 한다.
        state.cfg.requiresAccessCode = true;
        els.codeField.hidden = false;
        showIntro();
        focusAfter = els.code;
      }
      rollback(msg);
      return;
    }

    await readSse(res, (event, data) => {
      if (event === 'delta') {
        buffer += data.text;
        const { stage, body, pending } = splitHeader(buffer);
        if (pending) return;
        if (stage) { renderStage(stage); setStageChip(tutor.wrap, stage); }
        renderRich(tutor.bubble, body);
        scrollDown();
      } else if (event === 'done') {
        finished = true;
        state.token = data.state;
        const { body } = splitHeader(buffer);
        if (data.stage) { commitStage(data.stage); setStageChip(tutor.wrap, data.stage); }
        renderRich(tutor.bubble, body);
        state.transcript.push({ role: 'student', text: shown }, { role: 'tutor', text: buffer });
        state.pending = null;
        if (isCard(body)) addCardTools(tutor.wrap, body.trim());
        save();
        updateDownload();
        if (data.nearLimit) {
          const left = Number(data.turnsLeft);
          addNotice(left <= 0
            ? '이번이 이 대화의 마지막 답이에요. 위쪽 "대화 내려받기"로 지금까지의 대화를 저장해 두세요.'
            : left <= 5
              ? `대화가 길어지고 있어요. ${left}번 더 보낼 수 있어요. 위쪽 "대화 내려받기"로 대화를 저장해 두세요.`
              : '대화가 길어지고 있어요. 곧 더 이어갈 수 없게 되니, 위쪽 "대화 내려받기"로 대화를 저장해 두세요.');
        }
      } else if (event === 'refusal' || event === 'error') {
        rollback(data.message || '답변을 만들지 못했어요.');
      }
    });

    if (!finished) rollback('연결이 끊겼어요. 다시 보내 주세요.');
  } catch {
    if (!finished) rollback('인터넷 연결을 확인해 주세요.');
  } finally {
    setBusy(false, { focus: !focusAfter });
    focusAfter?.focus();
    scrollDown();
  }
}

/* ---------- 입력창 ---------- */
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 168)}px`;
  const len = [...els.input.value].length;
  const max = state.cfg.maxChars;
  const show = len > max * 0.8;
  els.counter.hidden = !show;
  els.counter.textContent = `${len} / ${max}`;
  els.counter.classList.toggle('over', len > max);
}
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  // 한글 조합 중(IME)의 Enter는 보내기가 아니다.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy || !state.lesson) return;
  if ([...text].length > state.cfg.maxChars) {
    clearNotices();
    addNotice(`메시지는 ${state.cfg.maxChars}자까지 보낼 수 있어요.`, { error: true });
    return;
  }
  if (!validateFields()) return;
  els.input.value = '';
  autosize();
  // 대화를 시작하기 전에 첫 메시지를 직접 쓰면, 붙여 넣은 정리 카드도 함께 보낸다.
  send(text, { card: !state.token && state.lesson.usesCard ? els.cardText.value.trim() : '' });
});

function validateFields() {
  if (state.cfg.requiresAccessCode && !els.code.value.trim()) {
    clearNotices();
    showIntro();
    addNotice('수업 코드를 먼저 입력해 주세요.', { error: true });
    els.code.focus();
    return false;
  }
  return true;
}

els.start.addEventListener('click', () => {
  if (!validateFields()) return;
  const card = state.lesson.usesCard ? els.cardText.value.trim() : '';
  if ([...card].length > state.cfg.maxCardChars) {
    clearNotices();
    addNotice(`정리 카드는 ${state.cfg.maxCardChars}자까지 보낼 수 있어요.`, { error: true });
    return;
  }
  send(START_TEXT, { fromStart: true, card });
});

/* ---------- 처음부터 다시(두 번 눌러야 지워진다)와 차시 고르기 ---------- */
let resetTimer = null;
els.reset.addEventListener('click', () => {
  if (state.busy) return;
  if (!els.reset.classList.contains('confirm')) {
    els.reset.classList.add('confirm');
    els.reset.textContent = '한 번 더 누르면 대화가 지워져요';
    resetTimer = setTimeout(resetButton, 6000);
    return;
  }
  clearTimeout(resetTimer);
  clearSaved();
  location.reload();
});
function resetButton() {
  els.reset.classList.remove('confirm');
  els.reset.textContent = '처음부터 다시';
}
// 다른 차시로 가도 이 차시의 대화는 지워지지 않는다(다시 고르면 이어진다).
els.toPicker.addEventListener('click', () => {
  if (state.busy) return;
  setCurrent(null);
  location.reload();
});

/* ---------- 차시 고르기 ---------- */
function renderPicker() {
  els.lessonList.replaceChildren();
  state.cfg.lessons.forEach((lesson) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lesson-card';
    b.disabled = !lesson.available;
    const t = document.createElement('span');
    t.className = 'lt';
    t.textContent = `${lesson.id}차시 · ${lesson.title}`;
    const s = document.createElement('span');
    s.className = 'ls';
    s.textContent = lesson.subtitle;
    b.append(t, s);
    b.addEventListener('click', () => enterLesson(lesson));
    els.lessonList.append(b);
  });
  hideIntro();
  els.picker.hidden = false;
  els.lessonList.querySelector('button:not(:disabled)')?.focus();
}

function enterLesson(lesson) {
  state.lesson = lesson;
  setCurrent(lesson.id);
  els.picker.hidden = true;
  els.title.textContent = lesson.title;
  els.subtitle.textContent = `${lesson.id}차시 · ${lesson.subtitle}`;
  document.title = `${lesson.id}차시 · ${lesson.title}`;
  els.toPicker.hidden = false;
  els.reset.hidden = false;
  els.steps.hidden = false;
  els.form.hidden = false;
  buildSteps();

  els.rules.replaceChildren(...lesson.intro.map((line) => { const li = document.createElement('li'); inline(li, line); return li; }));
  els.codeField.hidden = !state.cfg.requiresAccessCode;
  els.labelField.hidden = !state.cfg.logging;
  els.logNotice.hidden = !state.cfg.logging;
  els.cardIn.hidden = !lesson.usesCard;
  els.cardLoad.hidden = !state.cfg.cardStorage;
  els.cardInHint.textContent = state.cfg.cardStorage
    ? '1차시에 학번으로 저장했다면 불러오고, 아니면 복사해 둔 카드를 붙여 넣어요. 없으면 비워 두고 시작해도 돼요.'
    : '복사해 둔 1차시 정리 카드를 붙여 넣어요. 없으면 비워 두고 시작해도 돼요.';
  introNode.hidden = false;
  showIntro();
  restore();
  updateDownload();
}

/** 이 차시에서 저장해 둔 대화를 다시 그린다. */
function restore() {
  const saved = readKey(storeKey(state.lesson.id));
  if (saved) {
    els.code.value = saved.code || '';
    els.label.value = saved.label || '';
    state.studentId = saved.studentId || '';
    els.loadSid.value = state.studentId;
  }
  if (saved && Array.isArray(saved.transcript) && saved.transcript.length > 0) {
    state.token = saved.token || null;
    state.transcript = saved.transcript;
    hideIntro();
    state.transcript.forEach((m) => {
      if (m.role === 'student') {
        addMessage('student').bubble.textContent = m.text;
      } else {
        const { stage, body } = splitHeader(m.text);
        const t = addMessage('tutor');
        setStageChip(t.wrap, stage);
        renderRich(t.bubble, body);
        if (isCard(body)) addCardTools(t.wrap, body.trim());
      }
    });
    commitStage(Number(saved.stage) || 0);
    if (saved.pending) {
      els.input.value = saved.pending;
      autosize();
      addNotice('방금 보낸 글의 답을 받기 전에 화면이 닫혔어요. 쓴 글은 입력창에 그대로 있으니 다시 보내 주세요.');
    }
    scrollDown(true);
    els.input.focus({ preventScroll: true });
  } else if (saved && saved.pending) {
    // 첫 응답을 기다리는 중에 새로고침한 경우
    els.input.value = saved.pending;
    autosize();
  }
}

/* ---------- 시작 ---------- */
async function loadConfig() {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('/api/config');
      if (res.ok) { state.cfg = await res.json(); state.cfgOk = true; return; }
      if (res.status === 503) {
        // 서버 설정 오류는 다시 시도해도 같으므로 서버가 준 안내를 바로 보여 준다.
        try { state.cfgError = (await res.json()).message || ''; } catch { /* 본문 없음 */ }
        break;
      }
    } catch { /* 다시 시도 */ }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  state.cfgOk = false;
}

async function init() {
  hideIntro();
  await loadConfig();
  if (!state.cfgOk) {
    addNotice(state.cfgError || '설정을 불러오지 못했어요. 화면을 새로고침해 주세요.', { error: true });
    return;
  }
  els.input.maxLength = state.cfg.maxChars + 200; // 초과는 카운터와 서버가 막는다

  const available = state.cfg.lessons.filter((l) => l.available);
  let raw = null;
  try { raw = sessionStorage.getItem(CURRENT_KEY); } catch { /* 무시 */ }
  let currentId = Number(raw) || 0;
  if (raw === null) {
    // 차시를 나누기 전부터 열려 있던 1차시 대화가 있으면 그대로 이어 간다(차시 표시가 아예 없는 탭만).
    const old = readKey(storeKey(1));
    if (old && ((Array.isArray(old.transcript) && old.transcript.length > 0) || old.pending)) currentId = 1;
  }
  const current = available.find((l) => l.id === currentId);
  if (current) enterLesson(current);
  else renderPicker();
}
init();
