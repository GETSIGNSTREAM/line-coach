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
    -- Each menu item supports an optional bilingual coach_tip {en, es}
    -- shown in the Display's focus mode (when only 1 order is on the
    -- board). Spanish translations included by default for the WILDBIRD
    -- kitchen team.
    menu_data := '[
      {"name":"Quarter Bird","station":"oven","cook_time":0,"category":"Better Chicken","coach_tip":{"en":"Check internal temp — 165°F. Golden skin, no pale spots. Pull oldest bird from the cabinet first.","es":"Verifica temperatura interna — 74°C (165°F). Piel dorada, sin partes pálidas. Saca primero el pollo más viejo del calentador."}},
      {"name":"Half Bird","station":"oven","cook_time":0,"category":"Better Chicken","coach_tip":{"en":"Check internal temp — 165°F. Golden skin, no pale spots. Pull oldest bird from the cabinet first.","es":"Verifica temperatura interna — 74°C (165°F). Piel dorada, sin partes pálidas. Saca primero el pollo más viejo del calentador."}},
      {"name":"Whole Bird","station":"oven","cook_time":0,"category":"Better Chicken","coach_tip":{"en":"Whole bird presentation — even golden color, breast-up. Confirm 165°F at thickest part of the thigh.","es":"Presentación de pollo entero — color dorado uniforme, pechuga arriba. Confirma 74°C (165°F) en la parte más gruesa del muslo."}},
      {"name":"Chicken Dinner Box","station":"oven","cook_time":0,"category":"Better Chicken","coach_tip":{"en":"Pack hot items together, cold items separate. Tortillas warm and pliable, salsa fresh.","es":"Empaca lo caliente junto, lo frío aparte. Tortillas calientes y suaves, salsa fresca."}},
      {"name":"Protein Plate","station":"line","cook_time":3,"category":"Better Chicken","coach_tip":{"en":"Portion chicken by weight — 51+ grams protein. Two sides, no shorting the guest.","es":"Porciona el pollo por peso — 51+ gramos de proteína. Dos guarniciones, no le faltes al cliente."}},
      {"name":"Boneless Breast Market Plate","station":"line","cook_time":4,"category":"Market Plate","coach_tip":{"en":"Boneless breast: even slice, juicy. Two sides per plate. Garnish before it leaves the pass.","es":"Pechuga sin hueso: rebanada pareja, jugosa. Dos guarniciones por plato. Decora antes de que salga del pase."}},
      {"name":"Chicken Tinga Market Plate","station":"line","cook_time":4,"category":"Market Plate","coach_tip":{"en":"Tinga should be saucy, not dry. Taste the salsa before plating. Two sides per plate.","es":"La tinga debe estar con salsa, no seca. Prueba la salsa antes de servir. Dos guarniciones por plato."}},
      {"name":"Veggie Market Plate","station":"line","cook_time":4,"category":"Market Plate","coach_tip":{"en":"No protein on this plate — double-check before firing. Two sides, full portion.","es":"Sin proteína en este plato — confirma antes de empezar. Dos guarniciones, porción completa."}},
      {"name":"Pollo Verde Market Plate","station":"line","cook_time":4,"category":"Market Plate","coach_tip":{"en":"Verde should be bright green, not muddy. Taste before plating. Two sides per plate.","es":"El pollo verde debe estar verde brillante, no opaco. Prueba antes de servir. Dos guarniciones por plato."}},
      {"name":"Tacos Dorados","station":"fryer","cook_time":5,"category":"Modern Mexican","coach_tip":{"en":"Fry oil at 350°F — golden and crisp, not greasy. Plate immediately, no sitting.","es":"Aceite a 175°C (350°F) — dorados y crujientes, no grasosos. Sirve de inmediato, que no se enfríen."}},
      {"name":"Burrito Mexicano","station":"line","cook_time":4,"category":"Modern Mexican","coach_tip":{"en":"Wrap tight — no air gaps. Tortilla pliable from the warmer. Cut on the bias before plating.","es":"Enróllalo apretado — sin huecos de aire. Tortilla suave del calentador. Córtalo en diagonal antes de servir."}},
      {"name":"Tostada Bowl","station":"line","cook_time":4,"category":"Modern Mexican","coach_tip":{"en":"Build cold to hot — base, protein, garnish last. Tostada shell crisp, not chewy.","es":"Arma de frío a caliente — base, proteína, decoración al final. Tostada crujiente, no aguada."}},
      {"name":"Superfood Ensalada","station":"cold","cook_time":3,"category":"Plant Forward","coach_tip":{"en":"Dress to order — never pre-dressed. Toss gently, plate high. Greens crisp.","es":"Aderézala al momento — nunca aderezada antes. Mézclala con cuidado, monta alto. Verduras crujientes."}},
      {"name":"Harvest Bowl","station":"line","cook_time":4,"category":"Plant Forward","coach_tip":{"en":"Build base first, layer toppings. Grains hot, greens cold. Plate vibrant.","es":"Arma la base primero, luego pon los toppings. Granos calientes, verduras frías. Presentación vibrante."}},
      {"name":"Chicken Leg","station":"oven","cook_time":0,"category":"A La Carte","coach_tip":{"en":"Single piece — confirm 165°F. Pull from oldest tray. Garnish before it goes out.","es":"Una pieza — confirma 74°C (165°F). Saca de la charola más vieja. Decora antes de que salga."}},
      {"name":"Chicken Thigh","station":"oven","cook_time":0,"category":"A La Carte","coach_tip":{"en":"Single piece — confirm 165°F. Pull from oldest tray. Garnish before it goes out.","es":"Una pieza — confirma 74°C (165°F). Saca de la charola más vieja. Decora antes de que salga."}},
      {"name":"Chicken Breast","station":"oven","cook_time":0,"category":"A La Carte","coach_tip":{"en":"Single piece — confirm 165°F. Slice on the bias if requested. Pull from oldest tray.","es":"Una pieza — confirma 74°C (165°F). Rebana en diagonal si lo piden. Saca de la charola más vieja."}},
      {"name":"Chicken Wing","station":"oven","cook_time":0,"category":"A La Carte","coach_tip":{"en":"Crispy skin, juicy meat. Pull from oldest tray. Sauce only if requested.","es":"Piel crujiente, carne jugosa. Saca de la charola más vieja. Salsa solo si la piden."}},
      {"name":"Whole Bird (A La Carte)","station":"oven","cook_time":0,"category":"A La Carte","coach_tip":{"en":"No sides — bird only. Even golden color. Confirm 165°F at thickest part of the thigh.","es":"Sin guarniciones — solo el pollo. Color dorado uniforme. Confirma 74°C (165°F) en la parte más gruesa del muslo."}},
      {"name":"Kids Quesadilla","station":"grill","cook_time":4,"category":"Other","coach_tip":{"en":"Cheese fully melted, tortilla golden — not pale. Cut into 4 triangles before plating.","es":"Queso bien derretido, tortilla dorada — no pálida. Córtala en 4 triángulos antes de servir."}},
      {"name":"Taco (Single)","station":"line","cook_time":3,"category":"Other","coach_tip":{"en":"Tortilla warm and pliable. Build hot to cold. Garnish last.","es":"Tortilla caliente y suave. Arma de caliente a frío. Decora al final."}}
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

    -- Bilingual {en, es} tips. Spanish translations included by
    -- default for the WILDBIRD kitchen team.
    tips_data := '[
      {"en": "Check chicken internal temp — must hit 165°F before serving.", "es": "Verifica la temperatura interna del pollo — debe llegar a 74°C (165°F) antes de servir."},
      {"en": "Golden roast color on every bird — no pale skin leaving the pass.", "es": "Color dorado en cada pollo — nada de piel pálida saliendo del pase."},
      {"en": "Rotate birds in the holding cabinet — oldest out first.", "es": "Rota los pollos en el calentador — primero sale el más viejo."},
      {"en": "Salsa should be made fresh every shift — taste before service.", "es": "Haz la salsa fresca cada turno — pruébala antes del servicio."},
      {"en": "Tortillas should be warm and pliable — check the warmer every 15 min.", "es": "Las tortillas deben estar calientes y suaves — revisa el calentador cada 15 minutos."},
      {"en": "Portion chicken by weight — Quarter Bird is 51+ grams protein.", "es": "Porciona el pollo por peso — el Quarter Bird lleva 51+ gramos de proteína."},
      {"en": "Rice should be fluffy, not clumped — stir and check every 20 min.", "es": "El arroz debe estar suelto, no apelmazado — revuélvelo y revisa cada 20 minutos."},
      {"en": "Aguas frescas should be fresh-mixed — taste for sweetness balance.", "es": "Las aguas frescas deben prepararse al momento — prueba el balance de dulzor."},
      {"en": "Wipe down the line between every 5th order — keep it clean.", "es": "Limpia la línea cada 5 órdenes — mantén todo limpio."},
      {"en": "Market plates get 2 sides — don''t short the guest.", "es": "Los Market Plates llevan 2 guarniciones — no le faltes al cliente."},
      {"en": "Chips should be warm and crispy — fry in small batches.", "es": "Los chips deben estar calientes y crujientes — fríelos en tandas pequeñas."},
      {"en": "Check guac freshness — max 2 hours in the well, then refresh.", "es": "Revisa la frescura del guacamole — máximo 2 horas en el insertable, luego cámbialo."},
      {"en": "Kale slaw should be dressed to order — don''t let it sit.", "es": "El kale slaw se adereza al momento — no lo dejes reposando."},
      {"en": "Clear the bump bar every 10 minutes to keep the board accurate.", "es": "Limpia el bump bar cada 10 minutos para mantener el tablero al día."},
      {"en": "Hot hold items max 30 minutes — toss and refresh after that.", "es": "Productos en hot hold máximo 30 minutos — tíralos y renueva después de ese tiempo."},
      {"en": "Keep the pass clean — no clutter between expo and window.", "es": "Mantén el pase limpio — sin desorden entre expo y la ventana."}
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
