/**
 * 학생 메시지에서 위기 신호로 보이는 표현을 찾아 '표시'만 한다.
 * - 대화를 막거나 챗봇 응답을 바꾸지 않는다(응답은 프롬프트의 안전 규칙이 맡는다).
 * - 단순 키워드 검사라서 놓치는 경우가 많다. 안전장치가 아니라 교사가 먼저 볼 대화를 고르는 보조 표시다.
 */
const PATTERNS = [
  /죽고\s*싶/,
  /죽어\s*버리/,
  /죽을\s*것\s*같/,
  /자살/,
  /자해/,
  /사라지고\s*싶/,
  /사라져\s*버렸으면/,
  /없어지고\s*싶/,
  /살기\s*싫/,
  /살고\s*싶지\s*않/,
  /삶을\s*끝/,
  /극단적\s*선택/,
  /다\s*포기하고\s*싶/,
  /학대/,
];

export function detectRisk(text) {
  if (typeof text !== 'string') return false;
  return PATTERNS.some((re) => re.test(text));
}

/**
 * 학생 메시지에서 욕설로 보이는 표현을 찾아 교사용 화면에 '표시'만 한다(기록을 읽을 때 검사한다).
 * - 단순 낱말 검사라서 놓치는 경우도, 잘못 걸리는 경우도 있다. 교사가 대화를 읽고 판단한다.
 * - 일상 표현과 겹치는 낱말은 뺐다: '시발점·시발역', '불이 꺼져', '새끼손가락', '엄마를 졸라서', '미친 듯이', '개새로운', '등신대' 등.
 */
const PROFANITY = [
  /씨발|씨바|씨빨|시발(?!점|역|택시)|ㅅㅂ|ㅆㅂ|ㅆㅃ/,
  /병신|븅신|빙신|ㅂㅅ/,
  /좆|존나|ㅈㄴ/,
  /개새끼|개색기|개새야|새끼야/,
  /미친놈|미친년|미친새끼|ㅁㅊ/,
  /지랄|ㅈㄹ/,
  /닥쳐|닥치라/,
  /엿\s?먹어|엿같/,
  /염병|썅|쌍놈|쌍년|등신(?!대)/,
  /니애미|느금|엠창/,
  /개같(?:은|이|네|다)/,
  /\b(?:fuck|shit|bitch|asshole|wtf)/i,
];

export function detectProfanity(text) {
  if (typeof text !== 'string') return false;
  return PROFANITY.some((re) => re.test(text));
}

/**
 * 챗봇이 '다른 AI에서 붙여 넣은 글'로 판단했을 때 쓰는 문장(1~3차시 프롬프트의 같은 이름 절).
 * 판단은 챗봇이 하고, 교사용 화면은 챗봇 응답에서 이 문장을 찾아 그 앞의 학생 글을 표시한다.
 * 프롬프트의 문장을 바꾸면 여기도 함께 바꾼다(tests/teacher.test.js가 둘이 같은지 확인한다).
 */
export const PASTE_WARNING = '다른 AI에서 글을 붙여 넣은 것으로 보입니다. 교사에게 경고 메시지가 전송됩니다.';
export const CALL_TEACHER = "손을 들어 선생님을 불러 주세요. 선생님이 확인한 뒤 '호출 완료'라고 보내 주세요.";
const PASTE_WARNING_RE = /다른\s*AI에서\s*글을\s*붙여\s*넣은\s*것으로\s*보입니다/;
const CALL_TEACHER_RE = /손을\s*들어\s*선생님을\s*불러\s*주세요/;

/** 챗봇 응답이 '다른 AI 글' 경고인가. */
export function detectPasteWarning(text) {
  return typeof text === 'string' && PASTE_WARNING_RE.test(text);
}

/** 챗봇 응답이 학생에게 선생님을 부르라고 안내한 것인가(학생이 붙여 넣은 글이 아니라고 한 경우). */
export function detectCallTeacher(text) {
  return typeof text === 'string' && CALL_TEACHER_RE.test(text);
}
