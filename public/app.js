// 학생용 채팅 화면. 서버가 준 글은 항상 textContent로만 그린다(HTML로 해석하지 않는다).
const STAGES = ['기술 고르기', '해결하려는 문제', '과학적 원리', '배출이 줄어드는 이유', '가장 큰 문제점', '나만의 탐구 질문'];
const STORE_KEY = 'ccee.lesson1.v1';
const HEADER_RE = /^\s*\[단계\s*([1-6])\s*\/\s*6\s*·\s*([^\]\n]+)\]\s*/;

const $ = (sel) => document.querySelector(sel);
const els = {
  log: $('#log'), steps: $('#steps'), caption: $('#stage-caption'), form: $('#composer'), input: $('#input'),
  send: $('#send'), reset: $('#reset'), intro: $('#intro'), start: $('#start'), counter: $('#counter'),
  codeField: $('#code-field'), code: $('#code'), labelField: $('#label-field'), label: $('#label'), logNotice: $('#log-notice'),
};

const introNode = els.intro; // 수업 코드를 잘못 넣었을 때 되살린다
const state = {
  cfg: { requiresAccessCode: false, logging: false, maxChars: 1000 },
  token: null,
  busy: false,
  maxStage: 0,
  transcript: [], // { role: 'student' | 'tutor', text }
  lastText: '',
};

/* ---------- 저장(새로고침해도 대화 유지). 막혀 있어도 동작해야 한다. ---------- */
function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({
      token: state.token, maxStage: state.maxStage, transcript: state.transcript,
      code: els.code.value, label: els.label.value,
    }));
  } catch { /* 저장 불가: 무시 */ }
}
function load() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSaved() {
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* 무시 */ }
}

/* ---------- 진행 단계 ---------- */
function buildSteps() {
  STAGES.forEach((name, i) => {
    const li = document.createElement('li');
    li.dataset.step = String(i + 1);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = name;
    li.append(t);
    els.steps.append(li);
  });
  setStage(0);
}
function setStage(n) {
  state.maxStage = Math.max(state.maxStage, n);
  [...els.steps.children].forEach((li) => {
    const step = Number(li.dataset.step);
    li.classList.toggle('current', step === n);
    li.classList.toggle('done', step < n);
    if (step === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  els.caption.textContent = n ? `${n}단계 · ${STAGES[n - 1]}` : '';
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

/** 챗봇 글 맨 앞의 [단계 n/6 · 이름] 줄을 떼어 낸다. 스트리밍 중 잘린 머리글은 숨긴다. */
function splitHeader(text) {
  const m = HEADER_RE.exec(text);
  if (m) return { stage: Number(m[1]), body: text.slice(m[0].length), pending: false };
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
  chip.textContent = `${stage}단계 · ${STAGES[stage - 1]}`;
}
function addNotice(text, { error = false, retry = null } = {}) {
  const box = document.createElement('div');
  box.className = `notice-line${error ? ' error' : ''}`;
  box.setAttribute('role', 'alert');
  const span = document.createElement('span');
  span.textContent = text;
  box.append(span);
  if (retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '다시 보내기';
    b.addEventListener('click', () => { box.remove(); retry(); });
    box.append(b);
  }
  els.log.append(box);
  scrollDown(true);
  return box;
}
function isCard(text) { return text.includes('정리 카드') && text.includes('선택한 기술'); }
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
    const plain = text.replace(/\*\*/g, '');
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
}

let stick = true;
els.log.addEventListener('scroll', () => {
  stick = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
});
function scrollDown(force = false) {
  if (force || stick) els.log.scrollTop = els.log.scrollHeight;
}

/* ---------- 보내기 ---------- */
function setBusy(busy) {
  state.busy = busy;
  els.input.disabled = busy;
  els.send.disabled = busy;
  els.start.disabled = busy;
  // 스트리밍 중에는 스크린 리더가 글자마다 읽지 않도록 하고, 끝나면 한 번에 읽게 한다.
  els.log.setAttribute('aria-busy', String(busy));
  if (!busy) els.input.focus({ preventScroll: true });
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

async function send(text, { isRetry = false } = {}) {
  if (state.busy) return;
  els.intro?.remove();
  els.intro = null;
  state.lastText = text;

  let studentMsg = null;
  if (!isRetry) {
    studentMsg = addMessage('student');
    studentMsg.bubble.textContent = text;
    state.transcript.push({ role: 'student', text });
  }
  const tutor = addMessage('tutor');
  showDots(tutor.bubble);
  stick = true;
  scrollDown(true);
  setBusy(true);

  let buffer = '';
  let finished = false;
  const dropBubble = () => tutor.wrap.remove();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, state: state.token, accessCode: els.code.value.trim(), label: els.label.value.trim() }),
    });

    if (!res.ok) {
      let msg = '문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.';
      let code = '';
      try { const j = await res.json(); msg = j.message || msg; code = j.error || ''; } catch { /* 본문 없음 */ }
      dropBubble();
      if (code === 'bad_state' || code === 'too_long') {
        addNotice(msg, { error: true });
      } else if (code === 'bad_code') {
        // 시작 카드를 되살려 수업 코드를 다시 입력하게 한다. 보냈던 말은 입력창에 돌려 둔다.
        studentMsg?.wrap.remove();
        if (studentMsg) state.transcript.pop();
        els.log.prepend(introNode);
        els.intro = introNode;
        els.input.value = text;
        autosize();
        addNotice(msg, { error: true });
        els.code.focus();
      } else {
        addNotice(msg, { error: true, retry: () => send(text, { isRetry: true }) });
      }
      return;
    }

    await readSse(res, (event, data) => {
      if (event === 'delta') {
        buffer += data.text;
        const { stage, body, pending } = splitHeader(buffer);
        if (pending) return;
        if (stage) { setStage(stage); setStageChip(tutor.wrap, stage); }
        renderRich(tutor.bubble, body);
        scrollDown();
      } else if (event === 'done') {
        finished = true;
        state.token = data.state;
        const { body } = splitHeader(buffer);
        if (data.stage) { setStage(data.stage); setStageChip(tutor.wrap, data.stage); }
        renderRich(tutor.bubble, body);
        state.transcript.push({ role: 'tutor', text: buffer });
        if (isCard(body)) addCardTools(tutor.wrap, body.trim());
        save();
      } else if (event === 'refusal' || event === 'error') {
        finished = true;
        dropBubble();
        addNotice(data.message || '답변을 만들지 못했어요.', { error: true, retry: event === 'error' && data.code !== 'too_long' ? () => send(text, { isRetry: true }) : null });
      }
    });

    if (!finished) {
      dropBubble();
      addNotice('연결이 끊겼어요. 다시 보내 주세요.', { error: true, retry: () => send(text, { isRetry: true }) });
    }
  } catch {
    dropBubble();
    addNotice('인터넷 연결을 확인해 주세요.', { error: true, retry: () => send(text, { isRetry: true }) });
  } finally {
    setBusy(false);
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
  if (!text || state.busy) return;
  if ([...text].length > state.cfg.maxChars) {
    addNotice(`메시지는 ${state.cfg.maxChars}자까지 보낼 수 있어요.`, { error: true });
    return;
  }
  if (!validateFields()) return;
  els.input.value = '';
  autosize();
  send(text);
});

function validateFields() {
  if (state.cfg.requiresAccessCode && !els.code.value.trim()) {
    els.code.focus();
    if (!els.intro) addNotice('수업 코드가 필요해요. 화면을 새로고침한 뒤 입력해 주세요.', { error: true });
    return false;
  }
  return true;
}

els.start.addEventListener('click', () => {
  if (!validateFields()) return;
  send('안녕하세요! 시작할게요.');
});

/* ---------- 처음부터 다시(두 번 눌러야 지워진다) ---------- */
let resetTimer = null;
els.reset.addEventListener('click', () => {
  if (state.busy) return;
  if (!els.reset.classList.contains('confirm')) {
    els.reset.classList.add('confirm');
    els.reset.textContent = '정말 지울까요? 한 번 더';
    resetTimer = setTimeout(resetButton, 4000);
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

/* ---------- 시작 ---------- */
async function init() {
  buildSteps();
  try {
    const res = await fetch('/api/config');
    if (res.ok) state.cfg = await res.json();
  } catch { /* 기본값 사용 */ }

  els.codeField.hidden = !state.cfg.requiresAccessCode;
  els.labelField.hidden = !state.cfg.logging;
  els.logNotice.hidden = !state.cfg.logging;
  els.input.maxLength = state.cfg.maxChars + 200; // 초과는 카운터와 서버가 막는다

  const saved = load();
  if (saved && Array.isArray(saved.transcript) && saved.transcript.length > 0) {
    els.code.value = saved.code || '';
    els.label.value = saved.label || '';
    state.token = saved.token || null;
    state.transcript = saved.transcript;
    els.intro.remove();
    els.intro = null;
    state.transcript.forEach((m) => {
      if (m.role === 'student') {
        addMessage('student').bubble.textContent = m.text;
      } else {
        const { stage, body } = splitHeader(m.text);
        const t = addMessage('tutor');
        setStageChip(t.wrap, stage);
        renderRich(t.bubble, body);
        if (isCard(body)) addCardTools(t.wrap, body.trim());
        if (stage) setStage(stage);
      }
    });
    scrollDown(true);
  }
  els.input.focus({ preventScroll: true });
}
init();
