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
        let { error } = await supabase.from('chat_logs').insert(rows);
        // 표의 단계 범위가 아직 1~6이면(schema.sql을 다시 실행하기 전) 3차시 7·8단계 기록이 통째로 막힌다.
        // 대화 내용을 잃지 않도록 단계만 비우고 한 번 더 남긴다.
        if (error?.code === '23514' && base.stage != null) {
          console.error(`[log] 표가 단계 ${base.stage}을(를) 받지 않아 단계 없이 기록해요. supabase/schema.sql을 다시 실행해 주세요.`);
          ({ error } = await supabase.from('chat_logs').insert(rows.map((r) => ({ ...r, stage: null }))));
        }
        if (error) console.error(`[log] 기록 실패: ${error.code || ''} ${error.message}`);
      } catch (err) {
        console.error(`[log] 기록 실패: ${err?.message || err}`);
      }
    },
  };
}
