-- Quiz Bot (Cloudflare D1). Times are unix seconds.
CREATE TABLE users (
  id INTEGER PRIMARY KEY, name TEXT, username TEXT,
  premium_until INTEGER NOT NULL DEFAULT 0,
  preset TEXT,                                  -- JSON: the "Default" bulk settings
  created_at INTEGER NOT NULL
);

CREATE TABLE quizzes (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  time_limit INTEGER NOT NULL DEFAULT 30,       -- default seconds per question (0 = untimed); mirrors settings.time
  settings TEXT NOT NULL DEFAULT '{}',          -- JSON, see engine.js DEFAULT_SETTINGS
  src_id TEXT,                                  -- a clone reads its questions from this quiz
  n_questions INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,             -- Telegram Stars (0 = free)  [paywall foundation]
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_quizzes_owner ON quizzes(owner_id, created_at);
CREATE INDEX idx_quizzes_src ON quizzes(src_id);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id TEXT NOT NULL, pos INTEGER NOT NULL,
  text TEXT NOT NULL, search TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX idx_questions_quiz ON questions(quiz_id, pos);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_folders_owner ON folders(owner_id);
CREATE TABLE quiz_folder (quiz_id TEXT PRIMARY KEY, folder_id INTEGER NOT NULL);
CREATE INDEX idx_quiz_folder_folder ON quiz_folder(folder_id);

-- the missed questions of one attempt: "Retry", "Save mistakes" and "Sort in topics" buttons use it
CREATE TABLE retry_sets (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, quiz_id TEXT NOT NULL, name TEXT NOT NULL,
  time_limit INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}', data TEXT NOT NULL,
  msg_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id TEXT NOT NULL, quiz_name TEXT NOT NULL,
  user_id INTEGER NOT NULL, user_name TEXT, username TEXT, taker_info TEXT,
  score REAL NOT NULL, total INTEGER NOT NULL, correct INTEGER NOT NULL, wrong INTEGER NOT NULL, skipped INTEGER NOT NULL,
  elapsed REAL NOT NULL, passed INTEGER, n INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'solo', chat_id INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_attempts_user ON attempts(user_id, created_at);
CREATE INDEX idx_attempts_quiz ON attempts(quiz_id, user_id);

-- saved mistakes (the "review folder": pending / resolved)
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, quiz_id TEXT, quiz_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', q TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX idx_reviews_user ON reviews(user_id, status);

-- what a person is in the middle of (create / edit / import / ...). One row per person.
CREATE TABLE flows (
  user_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, msgs TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
);

-- poll id -> which running quiz (Durable Object) it belongs to
CREATE TABLE poll_map (poll_id TEXT PRIMARY KEY, run_key TEXT NOT NULL, created_at INTEGER NOT NULL);

-- groups and channels a person registered
CREATE TABLE user_chats (
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);

-- a quiz waiting to be started in a group/channel (time pick, "start" press)
CREATE TABLE pending_starts (
  token TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, chat_id INTEGER NOT NULL, kind TEXT NOT NULL,
  by_user INTEGER NOT NULL, time_override INTEGER, created_at INTEGER NOT NULL
);

-- one-time links between the bot and the web pages (mini app / vault)
CREATE TABLE tokens (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT,
  stars INTEGER NOT NULL, charge_id TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE ads (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, url TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
