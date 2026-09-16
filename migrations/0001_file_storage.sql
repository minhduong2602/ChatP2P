CREATE TABLE IF NOT EXISTS room_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_sessions_token ON room_sessions(token_hash, active, expires_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_session_id TEXT NOT NULL,
  upload_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'deleted', 'failed')),
  share_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  uploaded_at INTEGER,
  link_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at INTEGER,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_files_room ON files(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(status, expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  file_id TEXT,
  object_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
