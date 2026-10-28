import { createClient } from '@supabase/supabase-js';

/** 한 학생·한 차시에서 불러오는 최근 기록 줄 수(학생 글과 챗봇 답이 한 줄씩). 이보다 오래된 줄은 빼고 알린다. */
export const MAX_HISTORY_ROWS = 1000;

/**
 * 학번·이름으로 지난 대화를 불러온다(학생이 다른 탭이나 다른 날에 이어 하기).
 * 대화 기록(LOG_CHATS=true)을 서버 전용 비밀 키로 읽을 수 있을 때만 켠다. RESUME_BY_ID=false면 끈다.
 * 학번과 이름이 모두 같은 기록만 읽는다. 실패 로그에 대화 내용과 학번은 남기지 않는다.
 */
export function createHistoryStore(config, { client } = {}) {
  if (!config.resumeById) return null;
  const supabase =
    client ||
    createClient(config.supabaseUrl, config.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  return {
    /** 최근 기록부터 MAX_HISTORY_ROWS줄을 읽어 오래된 것부터 돌려준다. */
    async load(studentId, studentName, lesson) {
      const { data, error } = await supabase
        .from('chat_logs')
        .select('id, created_at, session_id, role, stage, content')
        .eq('student_id', studentId)
        .eq('student_name', studentName)
        .eq('lesson', lesson)
        .order('id', { ascending: false })
        .range(0, MAX_HISTORY_ROWS - 1);
      if (error) throw new Error(`읽기: ${error.code || ''} ${error.message || error}`);
      const rows = (data || []).slice().reverse();
      return { rows, truncated: rows.length >= MAX_HISTORY_ROWS };
    },
  };
}
