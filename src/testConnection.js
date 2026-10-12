import './supabaseClient.js'; // 환경변수 누락 시 여기서 에러가 난다.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

// auth.getSession()은 로컬 상태만 읽으므로 연결 검증이 되지 않는다.
// 실제로 Supabase 서버에 요청을 보내는 health 엔드포인트로 확인한다.
try {
  const res = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key } });
  const body = await res.text();
  console.log(`HTTP ${res.status}`, body);
  if (!res.ok) process.exit(1);
  console.log('Supabase 연결 성공');
} catch (err) {
  console.error('Supabase에 도달하지 못했습니다:', err.cause?.message ?? err.message);
  process.exit(1);
}
