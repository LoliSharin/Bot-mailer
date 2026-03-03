CREATE TABLE IF NOT EXISTS telegram_selected_order (
  chat_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
