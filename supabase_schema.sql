-- ① 트렌드 테이블
create table trends (
  id uuid default gen_random_uuid() primary key,
  keyword text not null unique,
  category text,
  score float default 0,
  weekly_change float default 0,
  confidence_level text default 'low',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- ② 근거 자료 테이블 (논문/특허/법안/정책/뉴스 전부)
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
create index on reports(trend_id);
