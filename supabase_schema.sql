-- ============================================
-- ATLAS 기술 트렌드 예측 플랫폼 — Supabase 스키마
-- ============================================

-- ① 트렌드 테이블
create table trends (
  id uuid default gen_random_uuid() primary key,
  keyword text not null unique,
  category text,
  score float default 0,
  prev_score float default 0,
  weekly_change float default 0,
  confidence_level text default 'low',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- ② 근거 자료 테이블
create table evidence (
  id uuid default gen_random_uuid() primary key,
  trend_id uuid references trends(id) on delete cascade,
  type text check (type in ('paper','patent','law','policy','news')),
  title text not null,
  summary text,
  source_url text,
  source_name text,
  country text,
  region text,
  language text default 'en',
  published_at timestamp with time zone,
  relevance_score float default 0,
  created_at timestamp with time zone default now()
);

-- ★ 중복 삽입 방지: 같은 트렌드 + 같은 URL 조합은 1건만
create unique index evidence_dedup on evidence(trend_id, source_url)
  where source_url is not null;

-- ③ AI 예측 리포트 테이블
create table reports (
  id uuid default gen_random_uuid() primary key,
  trend_id uuid references trends(id) on delete cascade unique,
  summary text,
  prediction text,
  sector text,
  time_horizon text,
  evidence_summary jsonb,
  generated_at timestamp with time zone default now()
);

-- ④ 유저 테이블
create table users (
  id uuid references auth.users primary key,
  email text,
  nickname text,
  plan text default 'free',
  created_at timestamp with time zone default now()
);

-- ⑤ 알림 테이블
create table user_alerts (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id) on delete cascade,
  keyword text not null,
  is_active boolean default true,
  created_at timestamp with time zone default now()
);

-- ⑥ 북마크 테이블
create table bookmarks (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references users(id) on delete cascade,
  trend_id uuid references trends(id) on delete cascade,
  saved_at timestamp with time zone default now()
);

-- 인덱스
create index on trends(score desc);
create index on trends(updated_at desc);
create index on evidence(trend_id);
create index on evidence(type);
create index on evidence(country);
create index on evidence(published_at desc);
create index on reports(trend_id);

-- ============================================
-- RLS (Row Level Security) 정책
-- ============================================

alter table trends enable row level security;
alter table evidence enable row level security;
alter table reports enable row level security;

-- 트렌드/근거/리포트: 누구나 읽기 가능
create policy "trends_public_read" on trends
  for select using (true);

create policy "evidence_public_read" on evidence
  for select using (true);

create policy "reports_public_read" on reports
  for select using (true);

-- 쓰기는 service_role 키로만 (서버리스 함수에서)
-- Supabase service_role은 RLS를 우회하므로 별도 정책 불필요

-- ============================================
-- 통계용 함수: 전체 evidence 개수 반환
-- ============================================
create or replace function get_evidence_count()
returns bigint as $$
  select count(*) from evidence;
$$ language sql stable;
