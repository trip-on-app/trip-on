CREATE TABLE IF NOT EXISTS admin_promotions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  plan TEXT NOT NULL CHECK (plan IN ('Pro', 'Enterprise')),
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_promotions_updated_at
ON admin_promotions(updated_at DESC);
