import { createClient } from '@supabase/supabase-js';

const MAX_CONTENT = 4000;

/**
 * 대화 기록을 Supabase에 '쓰기 전용'으로 남긴다(교사는 Supabase 대시보드에서 읽는다).
 * 기록이 실패해도 챗봇은 계속 동작한다. 실패 로그에 대화 내용은 남기지 않는다.
 */
export function createLogger(config, { client } = {}) {
  if (!config.logChats) {
    return { enabled: false, async log() {} };
  }
  const supabase =
    client ||
    createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  return {
    enabled: true,
    async log({ sessionId, label, stage, flagged, model, promptVersion, student, tutor }) {
      const base = { session_id: sessionId, label: label || null, stage: stage ?? null, flagged: !!flagged, model, prompt_version: promptVersion };
      const rows = [{ ...base, role: 'student', content: String(student).slice(0, MAX_CONTENT) }];
      if (tutor) rows.push({ ...base, role: 'tutor', content: String(tutor).slice(0, MAX_CONTENT), flagged: false });
      try {
        const { error } = await supabase.from('chat_logs').insert(rows);
        if (error) console.error(`[log] 기록 실패: ${error.code || ''} ${error.message}`);
      } catch (err) {
        console.error(`[log] 기록 실패: ${err?.message || err}`);
      }
    },
  };
}
