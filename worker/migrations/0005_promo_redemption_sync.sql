ALTER TABLE admin_promotions
  ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days BETWEEN 1 AND 365);

INSERT INTO promo_codes (code, data_json, used_count, updated_at)
SELECT
  UPPER(code),
  json_object(
    'active', json('true'),
    'type', 'free_days',
    'value', duration_days,
    'maxUses', COALESCE(max_uses, 2147483647),
    'onePerUser', json('true'),
    'plan', CASE WHEN plan = 'Enterprise' THEN 'enterprise' ELSE 'pro' END,
    'expiresAt', CASE WHEN expires_at IS NULL THEN NULL ELSE expires_at || 'T23:59:59.999Z' END
  ),
  used_count,
  updated_at
FROM admin_promotions
WHERE 1
ON CONFLICT(code) DO UPDATE SET
  data_json = excluded.data_json,
  updated_at = excluded.updated_at;
