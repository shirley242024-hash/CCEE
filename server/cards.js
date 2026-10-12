import { createClient } from '@supabase/supabase-js';

export const STUDENT_ID_RE = /^\d{5}$/;
export const MAX_CARD_CHARS = 3000;

/**
 * 1차시 정리 카드를 학번으로 저장하고 불러온다(SAVE_CARDS=true일 때만).
 * 서버 전용 비밀 키(secret key)로만 접근한다. 테이블은 공개 키로 읽거나 쓸 수 없게 만든다(supabase/schema.sql).
 * 실패 로그에 카드 내용과 학번은 남기지 않는다.
 */
export function createCardStore(config, { client } = {}) {
  if (!config.saveCards) return null;
  const supabase =
    client ||
    createClient(config.supabaseUrl, config.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const fail = (what, error) => new Error(`${what}: ${error.code || ''} ${error.message || error}`);

  return {
    async save({ studentId, card, sessionId, promptVersion }) {
      const { error } = await supabase
        .from('lesson1_cards')
        .insert({ student_id: studentId, card, session_id: sessionId, prompt_version: promptVersion });
      if (error) throw fail('저장', error);
    },
    /** 가장 최근에 저장한 카드. 없으면 null. */
    async load(studentId) {
      const { data, error } = await supabase
        .from('lesson1_cards')
        .select('card, created_at')
        .eq('student_id', studentId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1);
      if (error) throw fail('불러오기', error);
      const row = data?.[0];
      return row ? { card: row.card, savedAt: row.created_at } : null;
    },
  };
}
