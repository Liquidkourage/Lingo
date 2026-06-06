create table if not exists app_state (
  id integer primary key,
  version integer not null default 1,
  mode text not null default 'lingo',
  phase text not null default 'idle',
  session_id text not null,
  round_number integer not null default 0,
  current_word text not null default '',
  answer_revealed boolean not null default false,
  ball_multiplier integer not null default 1,
  balls_remaining integer not null default 0,
  guess_window_seconds integer not null default 90,
  results_window_seconds integer not null default 45,
  host_note text not null default '',
  host_word_suggestions jsonb not null default '[]'::jsonb,
  host_word_exclusions jsonb not null default '[]'::jsonb,
  host_word_queue jsonb not null default '[]'::jsonb,
  host_word_history jsonb not null default '[]'::jsonb,
  champion_display_name text not null default '',
  first_solver_player_id bigint,
  guess_window_opened_at timestamptz,
  results_window_opened_at timestamptz,
  timer_paused boolean not null default false,
  timer_paused_remaining_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_state add column if not exists timer_paused boolean not null default false;
alter table app_state add column if not exists timer_paused_remaining_seconds integer;
alter table app_state add column if not exists champion_display_name text not null default '';
alter table app_state add column if not exists first_solver_player_id bigint;
alter table app_state add column if not exists host_word_suggestions jsonb not null default '[]'::jsonb;
alter table app_state add column if not exists host_word_exclusions jsonb not null default '[]'::jsonb;
alter table app_state add column if not exists host_word_queue jsonb not null default '[]'::jsonb;
alter table app_state add column if not exists host_word_history jsonb not null default '[]'::jsonb;
alter table app_state add column if not exists round_ball_stakes jsonb not null default '[]'::jsonb;
alter table app_state add column if not exists guess_window_seq integer not null default 0;
alter table app_state add column if not exists all_players_submitted_at timestamptz;

insert into app_state (
  id,
  version,
  mode,
  phase,
  session_id,
  round_number,
  current_word,
  answer_revealed,
  ball_multiplier,
  balls_remaining,
  guess_window_seconds,
  results_window_seconds,
  host_note
)
values (
  1,
  1,
  'lingo',
  'idle',
  concat('session_', floor(extract(epoch from now()) * 1000)::bigint),
  0,
  '',
  false,
  1,
  0,
  90,
  45,
  ''
)
on conflict (id) do nothing;

create table if not exists players (
  id bigserial primary key,
  session_id text not null,
  display_name text not null,
  normalized_display_name text not null,
  current_guess text not null default '',
  round_number integer not null default 0,
  first_letter text not null default '',
  submitted_at timestamptz,
  balls integer not null default 0,
  solved_current_word boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, normalized_display_name)
);

alter table players add column if not exists balls integer not null default 0;
alter table players add column if not exists solved_current_word boolean not null default false;
alter table players add column if not exists player_token text;
create unique index if not exists idx_players_player_token on players(player_token) where player_token is not null;

create table if not exists guess_submissions (
  id bigserial primary key,
  session_id text not null,
  player_id bigint not null references players(id) on delete cascade,
  round_number integer not null,
  guess text not null,
  submitted_at timestamptz not null default now(),
  result_pattern text not null default '',
  result_label text not null default '',
  is_official boolean not null default false
);

alter table guess_submissions add column if not exists result_pattern text not null default '';
alter table guess_submissions add column if not exists result_label text not null default '';
alter table guess_submissions add column if not exists is_official boolean not null default false;
alter table guess_submissions add column if not exists ball_stake integer not null default 0;
alter table guess_submissions add column if not exists guess_window_seq integer not null default 0;

create table if not exists words (
  word text primary key,
  created_at timestamptz not null default now(),
  constraint words_format_chk check (word ~ '^[A-Z]{5}$')
);

create index if not exists idx_players_session on players(session_id);
create index if not exists idx_guess_submissions_session_round on guess_submissions(session_id, round_number);

create table if not exists bingo_games (
  id text primary key,
  session_id text not null,
  call_sheet jsonb not null,
  call_index integer not null default -1,
  winner_player_id bigint references players(id) on delete set null,
  winner_display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bingo_games_session on bingo_games(session_id);

create table if not exists host_messages (
  id bigserial primary key,
  session_id text not null,
  display_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_host_messages_session on host_messages(session_id, created_at desc);
