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
  champion_display_name text not null default '',
  first_solver_player_id bigint,
  guess_window_opened_at timestamptz,
  results_window_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_state add column if not exists champion_display_name text not null default '';
alter table app_state add column if not exists first_solver_player_id bigint;

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

create table if not exists guess_submissions (
  id bigserial primary key,
  session_id text not null,
  player_id bigint not null references players(id) on delete cascade,
  round_number integer not null,
  guess text not null,
  submitted_at timestamptz not null default now()
);

create table if not exists words (
  word text primary key,
  created_at timestamptz not null default now(),
  constraint words_format_chk check (word ~ '^[A-Z]{5}$')
);

create index if not exists idx_players_session on players(session_id);
create index if not exists idx_guess_submissions_session_round on guess_submissions(session_id, round_number);
