import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'SUPABASE_URL 또는 SUPABASE_PUBLISHABLE_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
