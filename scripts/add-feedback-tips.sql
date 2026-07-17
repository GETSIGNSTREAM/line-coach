-- Feedback tips: per-store kitchen reminders generated from Momos
-- customer reviews (see lib/momos.js + lib/feedback-tips.js).
-- One row per store, overwritten on each generation run.
-- Run in the Supabase SQL editor (WINGMAN project), like the other
-- scripts in this directory.

CREATE TABLE IF NOT EXISTS lc_feedback_tips (
  store_id TEXT PRIMARY KEY,
  -- Array of { en, es, source_quote? } objects. Same { en, es } contract
  -- as lc_brand_config.quality_tips (normalizeTip in lib/line-coach.js);
  -- source_quote is an optional anonymized paraphrase of what customers
  -- said, rendered as a sub-line on the display.
  tips JSONB NOT NULL DEFAULT '[]',
  -- Generation metadata (aggregate only — raw review text is never stored)
  review_count INT NOT NULL DEFAULT 0,
  avg_rating NUMERIC,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  model TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lc_feedback_tips ENABLE ROW LEVEL SECURITY;

-- Same policy pattern as lc_config / lc_brand_config: service role writes,
-- anon may read (tips are display content, nothing sensitive).
CREATE POLICY "Service role full access on lc_feedback_tips"
  ON lc_feedback_tips FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can read feedback tips"
  ON lc_feedback_tips FOR SELECT
  USING (true);

-- NOT added to the supabase_realtime publication on purpose: tips change
-- once a day; displays pick them up via the hourly config re-poll.
