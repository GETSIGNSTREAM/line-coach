-- Store checklists: opening / closing / prep lists authored brand-wide
-- in the admin (lc_brand_config.checklists) and completed per store per
-- business day on the kitchen displays.
-- Run in the Supabase SQL editor (WINGMAN project), like the other
-- scripts in this directory.
--
-- Template shape (lc_brand_config.checklists — no DDL needed, JSONB):
--   [{ id, name: { en, es }, window: { start: 'HH:MM', end: 'HH:MM' } | null,
--      items: [{ id, en, es }] }]
-- Item/checklist ids are generated once in the admin and never
-- regenerated on edit — runs reference them.
--
-- Runs are keyed by (store_id, checklist_id, business_date) so a new
-- LA business day simply means a new row — no reset cron. Overnight
-- windows (closing 20:00–02:00) attribute the early-morning tail to
-- the PREVIOUS business date (see checklistWindowState in
-- lib/line-coach.js).

CREATE TABLE IF NOT EXISTS lc_checklist_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id TEXT NOT NULL,
  checklist_id TEXT NOT NULL,
  business_date DATE NOT NULL,
  -- { itemId: { at: timestamptz, device_id: text|null } } — one key per
  -- checked item. Written only through the RPC below so two tablets
  -- never lose a check to a read-modify-write race.
  checked_items JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  -- Initials typed on the kiosk at sign-off. Asserted, not
  -- authenticated — kiosks have no user accounts. Same accepted risk
  -- class as the unauthenticated bump endpoint.
  completed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, checklist_id, business_date)
);

ALTER TABLE lc_checklist_runs ENABLE ROW LEVEL SECURITY;

-- Same policy pattern as lc_feedback_tips: service role writes, anon
-- may read (completion state is display content, nothing sensitive).
CREATE POLICY "Service role full access on lc_checklist_runs"
  ON lc_checklist_runs FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can read checklist runs"
  ON lc_checklist_runs FOR SELECT
  USING (true);

-- NOT added to the supabase_realtime publication on purpose: displays
-- poll the checklist-runs endpoint (10s while the overlay is open),
-- which is plenty for two tablets to agree.

-- Atomic per-item toggle. Upserts the day's run if missing, then
-- merges (or removes) the item key — all inside one statement so
-- concurrent tablets can't clobber each other's checks. Refuses to
-- touch a signed run: zero rows returned ⇒ already completed ⇒ the
-- API returns 409.
CREATE OR REPLACE FUNCTION lc_toggle_checklist_item(
  p_store_id TEXT,
  p_checklist_id TEXT,
  p_business_date DATE,
  p_item_id TEXT,
  p_checked BOOLEAN,
  p_device_id TEXT
) RETURNS SETOF lc_checklist_runs AS $$
BEGIN
  INSERT INTO lc_checklist_runs (store_id, checklist_id, business_date)
  VALUES (p_store_id, p_checklist_id, p_business_date)
  ON CONFLICT (store_id, checklist_id, business_date) DO NOTHING;

  RETURN QUERY
  UPDATE lc_checklist_runs SET
    checked_items = CASE WHEN p_checked
      THEN checked_items || jsonb_build_object(p_item_id,
             jsonb_build_object('at', to_jsonb(now()), 'device_id', to_jsonb(p_device_id)))
      ELSE checked_items - p_item_id
    END,
    updated_at = now()
  WHERE store_id = p_store_id
    AND checklist_id = p_checklist_id
    AND business_date = p_business_date
    AND completed_at IS NULL
  RETURNING *;
END;
$$ LANGUAGE plpgsql;
