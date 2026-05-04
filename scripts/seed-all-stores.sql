-- Seed config for all WILDBIRD locations
-- All stores share the same menu, sides, quality tips
-- Run this in Supabase SQL Editor

DO $$
DECLARE
  store_slugs TEXT[] := ARRAY['culver-city', '3rd-la-brea', 'westwood', 'dtla', 'el-segundo'];
  slug TEXT;
  menu_data JSONB;
  sides_data JSONB;
  tips_data JSONB;
  hold_data JSONB;
  settings_data JSONB;
BEGIN
  -- Get config from hollywood (already seeded)
  SELECT menu_items, sides, quality_tips, hold_times, settings
  INTO menu_data, sides_data, tips_data, hold_data, settings_data
  FROM lc_config
  WHERE store_id = 'hollywood';

  -- If hollywood doesn't exist, use defaults
  IF menu_data IS NULL THEN
    menu_data := '[
      {"name":"Quarter Bird","station":"oven","cook_time":0,"category":"Better Chicken"},
      {"name":"Half Bird","station":"oven","cook_time":0,"category":"Better Chicken"},
      {"name":"Whole Bird","station":"oven","cook_time":0,"category":"Better Chicken"},
      {"name":"Chicken Dinner Box","station":"oven","cook_time":0,"category":"Better Chicken"},
      {"name":"Protein Plate","station":"line","cook_time":3,"category":"Better Chicken"},
      {"name":"Boneless Breast Market Plate","station":"line","cook_time":4,"category":"Market Plate"},
      {"name":"Chicken Tinga Market Plate","station":"line","cook_time":4,"category":"Market Plate"},
      {"name":"Veggie Market Plate","station":"line","cook_time":4,"category":"Market Plate"},
      {"name":"Pollo Verde Market Plate","station":"line","cook_time":4,"category":"Market Plate"},
      {"name":"Tacos Dorados","station":"fryer","cook_time":5,"category":"Modern Mexican"},
      {"name":"Burrito Mexicano","station":"line","cook_time":4,"category":"Modern Mexican"},
      {"name":"Tostada Bowl","station":"line","cook_time":4,"category":"Modern Mexican"},
      {"name":"Superfood Ensalada","station":"cold","cook_time":3,"category":"Plant Forward"},
      {"name":"Harvest Bowl","station":"line","cook_time":4,"category":"Plant Forward"},
      {"name":"Chicken Leg","station":"oven","cook_time":0,"category":"A La Carte"},
      {"name":"Chicken Thigh","station":"oven","cook_time":0,"category":"A La Carte"},
      {"name":"Chicken Breast","station":"oven","cook_time":0,"category":"A La Carte"},
      {"name":"Chicken Wing","station":"oven","cook_time":0,"category":"A La Carte"},
      {"name":"Whole Bird (A La Carte)","station":"oven","cook_time":0,"category":"A La Carte"},
      {"name":"Kids Quesadilla","station":"grill","cook_time":4,"category":"Other"},
      {"name":"Taco (Single)","station":"line","cook_time":3,"category":"Other"}
    ]'::jsonb;

    sides_data := '[
      {"name":"Spanish Rice","station":"hot_hold","cook_time":0,"batch_size":8},
      {"name":"Kale Slaw","station":"cold","cook_time":0,"batch_size":8},
      {"name":"Sweet Potatoes","station":"hot_hold","cook_time":0,"batch_size":6},
      {"name":"Broccoli","station":"hot_hold","cook_time":0,"batch_size":6},
      {"name":"Charro Beans","station":"hot_hold","cook_time":0,"batch_size":8},
      {"name":"Mac Salad","station":"cold","cook_time":0,"batch_size":6},
      {"name":"Mexican Street Corn","station":"grill","cook_time":5,"batch_size":4},
      {"name":"Chips and Guac","station":"cold","cook_time":0,"batch_size":6},
      {"name":"Brussel Sprouts","station":"oven","cook_time":8,"batch_size":4},
      {"name":"Green Chicken Pozole","station":"hot_hold","cook_time":0,"batch_size":4},
      {"name":"Uptown Mac & Cheese","station":"hot_hold","cook_time":0,"batch_size":6},
      {"name":"Buffalo Cauliflower","station":"fryer","cook_time":6,"batch_size":4}
    ]'::jsonb;

    tips_data := '[
      "Check chicken internal temp — must hit 165°F before serving.",
      "Golden roast color on every bird — no pale skin leaving the pass.",
      "Rotate birds in the holding cabinet — oldest out first.",
      "Salsa should be made fresh every shift — taste before service.",
      "Tortillas should be warm and pliable — check the warmer every 15 min.",
      "Portion chicken by weight — Quarter Bird is 51+ grams protein.",
      "Rice should be fluffy, not clumped — stir and check every 20 min.",
      "Aguas frescas should be fresh-mixed — taste for sweetness balance.",
      "Wipe down the line between every 5th order — keep it clean.",
      "Market plates get 2 sides — don''t short the guest.",
      "Chips should be warm and crispy — fry in small batches.",
      "Check guac freshness — max 2 hours in the well, then refresh.",
      "Kale slaw should be dressed to order — don''t let it sit.",
      "Clear the bump bar every 10 minutes to keep the board accurate.",
      "Hot hold items max 30 minutes — toss and refresh after that.",
      "Keep the pass clean — no clutter between expo and window."
    ]'::jsonb;

    hold_data := '{"fire_now": 5, "staging": 15, "on_deck": 30}'::jsonb;
    settings_data := '{"quality_coach_interval": 30, "side_batch_threshold": 3}'::jsonb;
  END IF;

  -- Insert config for each store
  FOREACH slug IN ARRAY store_slugs LOOP
    INSERT INTO lc_config (store_id, menu_items, sides, quality_tips, hold_times, settings)
    VALUES (slug, menu_data, sides_data, tips_data, hold_data, settings_data)
    ON CONFLICT (store_id) DO NOTHING;
  END LOOP;
END $$;
