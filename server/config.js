import { randomBytes } from 'node:crypto';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'none'];

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : value;
}

/**
 * 환경 변수에서 설정을 읽고 검사한다.
 * 운영(NODE_ENV=production)에서는 필수 값이 없으면 시작하지 않는다.
 */
export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const warnings = [];
  const errors = [];

  const effort = env.CHATBOT_EFFORT || 'medium';
  if (!EFFORTS.includes(effort)) {
    errors.push(`CHATBOT_EFFORT는 ${EFFORTS.join(', ')} 중 하나여야 해요.`);
  }

  let sessionSecret = env.SESSION_SECRET || '';
  if (!sessionSecret) {
    if (prod) {
      errors.push('운영에서는 SESSION_SECRET이 꼭 필요해요. (32자 이상의 무작위 문자열)');
    } else {
      sessionSecret = randomBytes(32).toString('hex');
      warnings.push('SESSION_SECRET이 없어 임시 값을 만들었어요. 서버를 다시 켜면 진행 중인 대화가 이어지지 않아요.');
    }
  } else if (sessionSecret.length < 32) {
    errors.push('SESSION_SECRET은 32자 이상이어야 해요.');
  }

  if (prod && !env.ANTHROPIC_API_KEY) errors.push('운영에서는 ANTHROPIC_API_KEY가 꼭 필요해요.');
  // 키가 있는데 수업 코드가 없으면, 운영이 아니어도 주소를 아는 누구나 API 비용을 쓸 수 있다.
  if (env.ANTHROPIC_API_KEY && !env.ACCESS_CODE) {
    warnings.push('ACCESS_CODE가 없어요. 주소를 아는 누구나 챗봇을 쓰고 API 비용이 발생할 수 있어요.');
  }
  if (env.ACCESS_CODE && env.ACCESS_CODE.length < 8) {
    warnings.push('ACCESS_CODE가 8자보다 짧아요. 추측하기 어려운 8자 이상(영문+숫자)을 권해요.');
  }

  const logChats = env.LOG_CHATS === 'true';
  if (logChats && (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY)) {
    errors.push('LOG_CHATS=true이면 SUPABASE_URL과 SUPABASE_PUBLISHABLE_KEY가 필요해요.');
  }
  const saveCards = env.SAVE_CARDS === 'true';
  if (saveCards && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)) {
    errors.push('SAVE_CARDS=true이면 SUPABASE_URL과 SUPABASE_SECRET_KEY가 필요해요.');
  }

  return {
    prod,
    port: int(env.PORT, 3000),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),

    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.CHATBOT_MODEL || 'claude-opus-5-5',
    effort,
    // 스트리밍이라 크게 잡아도 시간 초과가 없다. thinking도 이 한도에 들어가므로 너무 작게 잡지 않는다.
    maxTokens: int(env.CHATBOT_MAX_TOKENS, 16000),

    sessionSecret,
    sessionMaxAgeMs: int(env.SESSION_MAX_AGE_HOURS, 12) * 60 * 60 * 1000,
    accessCode: env.ACCESS_CODE || '',

    maxStudentChars: int(env.MAX_STUDENT_CHARS, 1000),
    maxTurns: int(env.MAX_TURNS, 40),
    maxStateChars: int(env.MAX_STATE_CHARS, 240_000),
    perSessionPerMinute: int(env.RATE_PER_SESSION_PER_MIN, 8),
    perIpPerMinute: int(env.RATE_PER_IP_PER_MIN, 240),
    newConversationsPerIpPerMinute: int(env.NEW_CONVERSATIONS_PER_IP_PER_MIN, 60),
    badCodePerIpPerMinute: int(env.BAD_CODE_PER_IP_PER_MIN, 30),
    maxConcurrentStreams: int(env.MAX_CONCURRENT_STREAMS, 40),
    dailyRequestCap: int(env.DAILY_REQUEST_CAP, 3000),
    cardRequestsPerIpPerMinute: int(env.CARD_REQUESTS_PER_IP_PER_MIN, 120),

    logChats,
    saveCards,
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseKey: env.SUPABASE_PUBLISHABLE_KEY || '',
    supabaseSecretKey: env.SUPABASE_SECRET_KEY || '',

    warnings,
    errors,
  };
}
