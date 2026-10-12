-- Supabase 대시보드의 SQL Editor에 이 파일 전체를 붙여 넣어 실행하세요. 여러 번 실행해도 안전합니다.
-- 1) chat_logs     : 대화 기록(LOG_CHATS=true일 때). 서버는 공개용(publishable) 키로 '쓰기만' 합니다.
-- 2) lesson1_cards : 학번으로 저장한 1차시 정리 카드(SAVE_CARDS=true일 때). 서버의 비밀(secret) 키로만 읽고 씁니다.
-- 읽기는 대시보드(교사 계정)에서 합니다.

create table if not exists public.chat_logs (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  session_id     text        not null check (char_length(session_id) <= 64),
  label          text        check (char_length(label) <= 30),   -- 학생이 적은 별명/번호(선택)
  role           text        not null check (role in ('student', 'tutor')),
  content        text        not null check (char_length(content) <= 4000),
  stage          smallint    check (stage between 1 and 6),
  flagged        boolean     not null default false,     -- 위기 신호 표현이 감지된 학생 메시지
  model          text        check (char_length(model) <= 100),
  prompt_version text        check (char_length(prompt_version) <= 16)
);

-- 차시를 나누기 전에 만든 테이블에도 차시 열을 더한다.
alter table public.chat_logs add column if not exists lesson smallint check (lesson between 1 and 3);

create index if not exists chat_logs_session_idx on public.chat_logs (session_id, created_at);
create index if not exists chat_logs_flagged_idx on public.chat_logs (created_at) where flagged;

alter table public.chat_logs enable row level security;

-- 공개 키(anon 역할)에는 INSERT만 허용합니다. 테이블 권한(grant)과 행 정책(RLS)을 둘 다 INSERT로만 좁혀서,
-- 나중에 정책 하나가 실수로 추가되어도 공개 키로 기록을 읽거나 지울 수 없게 합니다.
revoke all on public.chat_logs from anon, authenticated;
grant insert on public.chat_logs to anon;
-- identity 열(id)에 쓰려면 시퀀스 권한도 필요합니다.
grant usage on all sequences in schema public to anon;

drop policy if exists "anon can insert chat logs" on public.chat_logs;
create policy "anon can insert chat logs"
  on public.chat_logs
  for insert
  to anon
  with check (true);

-- ---------------------------------------------------------------------------
-- 학번으로 저장한 1차시 정리 카드
-- 학생이 같은 학번으로 다시 저장하면 새 줄이 추가되고, 2차시에서는 가장 최근 것을 불러옵니다(이전 것도 남습니다).
create table if not exists public.lesson1_cards (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  student_id     text        not null check (student_id ~ '^[0-9]{5}$'),
  card           text        not null check (char_length(card) <= 3000),
  session_id     text        check (char_length(session_id) <= 64),
  prompt_version text        check (char_length(prompt_version) <= 16)
);

create index if not exists lesson1_cards_student_idx on public.lesson1_cards (student_id, created_at desc);

alter table public.lesson1_cards enable row level security;

-- 공개 키(anon)와 로그인 사용자 역할에는 아무 권한도 주지 않고, 행 정책(RLS)도 만들지 않습니다.
-- 서버의 비밀 키(service_role)는 RLS를 우회하므로 아래 권한만으로 읽고 씁니다.
revoke all on public.lesson1_cards from anon, authenticated;
grant select, insert on public.lesson1_cards to service_role;

-- ---------------------------------------------------------------------------
-- 교사가 SQL Editor에서 쓸 수 있는 조회 예시
--
-- 위기 신호가 감지된 대화를 먼저 보기:
--   select created_at, session_id, label, content
--   from public.chat_logs where flagged order by created_at desc;
--
-- 한 대화를 처음부터 읽기(위 결과의 session_id를 넣으세요):
--   select created_at, role, stage, content
--   from public.chat_logs where session_id = '여기에_session_id' order by id;
--
-- 수업이 끝난 뒤 기록 지우기(학교 지침에 맞는 보관 기간을 정하세요):
--   delete from public.chat_logs where created_at < now() - interval '90 days';
--
-- 한 학생이 저장한 1차시 정리 카드 모두 보기(최근 것부터):
--   select created_at, card from public.lesson1_cards where student_id = '20101' order by created_at desc;
--
-- 다른 학생이 잘못 저장한 카드 지우기(위 결과에서 지울 줄의 시각을 확인하세요):
--   delete from public.lesson1_cards where student_id = '20101' and created_at = '여기에_시각';
--
-- 학기가 끝난 뒤 카드 모두 지우기:
--   delete from public.lesson1_cards;
-- ---------------------------------------------------------------------------
