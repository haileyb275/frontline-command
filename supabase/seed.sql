-- GENERATED FILE — do not edit by hand.
-- Edit the JSON files in src/data/ and run `npm run seed` instead.

insert into public.nations (id, name, short, color, bonuses) values
  ('usa', 'United States', 'USA', '#4f6d8f', '[{"type":"speed_mult","category":"logistics","value":1.15},{"type":"reward_mult","resource":"supplies","value":1.1}]'::jsonb),
  ('uk', 'United Kingdom', 'UK', '#8f4f4f', '[{"type":"speed_mult","category":"recon","value":1.1},{"type":"speed_mult","category":"air","value":1.1}]'::jsonb),
  ('ussr', 'Soviet Union', 'USSR', '#a8552f', '[{"type":"cost_mult","category":"infantry","value":0.9},{"type":"cost_mult","category":"armor","value":0.9}]'::jsonb),
  ('germany', 'Germany', 'GER', '#6b6b63', '[{"type":"power_mult","category":"armor","value":1.1}]'::jsonb),
  ('france', 'France', 'FRA', '#4f5f9f', '[{"type":"building_cost_mult","value":0.9}]'::jsonb),
  ('italy', 'Italy', 'ITA', '#4f8f62', '[{"type":"cost_mult","category":"engineers","value":0.9},{"type":"cost_mult","category":"artillery","value":0.9}]'::jsonb),
  ('japan', 'Japan', 'JPN', '#9f8f4f', '[{"type":"speed_mult","category":"infantry","value":1.15}]'::jsonb)
on conflict (id) do update set name = excluded.name, short = excluded.short, color = excluded.color, bonuses = excluded.bonuses;
