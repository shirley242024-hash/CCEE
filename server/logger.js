import { createClient } from '@supabase/supabase-js';

const MAX_CONTENT = 4000;

/**
 * 대화 기록을 Supabase에 '쓰기 전용'으로 남긴다(교사는 Supabase 대시보드에서 읽는다).
 * 서버 전용 비밀 키가 있으면 그것을, 없으면 공개용 키(INSERT만 허용된 표)를 쓴다.
 * 학생이 입력한 학번·이름을 함께 남긴다. 기록이 실패해도 챗봇은 계속 동작한다.
 * 실패 로그에 대화 내용과 학번·이름은 남기지 않는다.
 */
export function createLogger(config, { client } = {}) {
  if (!config.logChats) {
    return { enabled: false, async log() {} };
  }
  const supabase =
    client ||
    createClient(config.supabaseUrl, config.supabaseSecretKey || config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  return {
    enabled: true,
    async log({ sessionId, lesson, studentId, studentName, stage, flagged, model, promptVersion, student, tutor }) {
      const base = {
        session_id: sessionId, lesson: lesson ?? null, student_id: studentId || null, student_name: studentName || null,
        stage: stage ?? null, flagged: !!flagged, model, prompt_version: promptVersion,
      };
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
