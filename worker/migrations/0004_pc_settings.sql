CREATE TABLE IF NOT EXISTS admin_pc_settings (
  server_id TEXT PRIMARY KEY CHECK (server_id IN ('pc-1', 'pc-2')),
  accept_requests INTEGER NOT NULL DEFAULT 1 CHECK (accept_requests IN (0, 1)),
  updated_at TEXT NOT NULL
);
