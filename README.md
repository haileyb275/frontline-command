# Frontline Command

A persistent, browser-based multiplayer WW2 command game played on a real-world
map. Build bases, raise units, dispatch them to missions, and team up in
alliances.

- **Frontend:** Vite + vanilla JavaScript, Leaflet + OpenStreetMap → GitHub Pages
- **Backend:** Supabase (auth, Postgres, row-level security, realtime) — from Phase 2

See [docs/DESIGN.md](docs/DESIGN.md) for the schema, folder structure and build phases,
and [docs/HANDOFF.md](docs/HANDOFF.md) if you are picking the project up to continue it.

## Run it locally

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open the URL it prints (usually http://localhost:5173). Edits to files reload
the page automatically.

To check the production build exactly as GitHub Pages will serve it:

```bash
npm run build
```

```bash
npm run preview
```

## Deploy to GitHub Pages

1. Create a repository on GitHub and push this folder to its `main` branch.
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` now runs `.github/workflows/deploy.yml`, which builds
   the site and publishes it at `https://<your-username>.github.io/<repo-name>/`.

## Database setup (Supabase)

In the Supabase dashboard open **SQL Editor → New query**, then paste and run,
in this order:

1. every file in `supabase/migrations/`, lowest number first (if you ever re-run an
   earlier file, re-run every later one after it: later files hold the current
   version of functions that were revised)
2. `supabase/seed.sql`
3. once per database, the coastline data: run `npm run land`, then every file in
   `supabase/land/` in order (this is what tells the server where the sea is)

After editing any JSON file in `src/data/`, regenerate the seed and run it again:

```bash
npm run seed
```

## Tests and upkeep

```bash
npm test
```

checks the content files and shared arithmetic (no network; also runs before every deploy).
See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the database tests, the usage
report, service limits, and how to move to your own routing server.

## Administrators

An administrator sees an **Admin** link in the top bar: search players, add or take
away funds, supplies and XP, move or delete bases and units, mute, suspend, rename,
delete chat messages, and read reports. Every action is written to an audit log.

Admin rights can only be granted in the Supabase SQL Editor, never from the game:

```sql
update public.profiles set is_admin = true where username = 'their_name';
```

## Adding or changing content

All content is data in `src/data/`. No game logic needs to change.

| To add… | Edit | Notes |
|---|---|---|
| a unit | `units.json` | `category_id` must exist in `categories.json`; a building must unlock that category. `icon` picks its symbol (keys are listed in `src/ui/icons.js`); `note` is its historical note |
| a building | `buildings.json` | `unlocks_categories` lists what it can station; `requires_coast` for harbors |
| a mission | `missions.json` | `requirements` are category → count; `terrain` is `land`, `water` or `any`; `min_km`/`max_km` set how far from your bases it appears |
| a nation | `nations.json` + its rows in `units.json` | bonuses are data: `cost_mult`, `speed_mult`, `power_mult`, `reward_mult`, `building_cost_mult` |
| an alliance building | `alliance_buildings.json` | bonus types: `member_cap`, `reward_money`, `reward_xp`, `speed` |
| a specialty | `specialties.json` | `category_ids` lists who can train in it; `names` gives per-nation names; use its id as a mission requirement |
| a factory product | `products.json` | `building_type` is the factory that makes it |
| a daily order | `daily_orders.json` | `counter` is the running total it watches (e.g. `missions`, `missions_cat_fire`) |
| a campaign or achievement | `objectives.json` | each step is a `counter` and a `target` |
| a rank title | `ranks.json` | the level at which the title is reached |
| a research step | `research.json` | cost and time to open each year; a unit's `year` is in `units.json` |
| an alliance operation | `operations.json` | a shared `counter` target, time limit, cost and per-member reward |
| a tuning number | `settings.json` | spawn interval, travel speed-up, caps, costs |

Then:

```bash
npm run seed
```

and run `supabase/seed.sql` in the Supabase SQL Editor, and push the code so the
browser's copy matches. To check your numbers are sensible:

```bash
npm run balance
```

## Status

- [x] Phase 1 — Project setup, deploy workflow, Leaflet map
- [x] Phase 2 — Supabase auth and nation selection
- [x] Phase 3 — Bases and units
- [x] Phase 4 — Missions and dispatching
- [x] Phase 5 — Alliances
- [x] Phase 5b — Terrain-aware missions, naval units, road-following movement
- [x] Phase 6 — Leaderboards and polish
- [x] Phase 7 — Specialists, military police, fire service, factories, home front, convoys
- [x] Phase 8 — Unit experience and repairs, base supply stocks, convoy escorts, 42 more units
- [x] Phase 9 — Admin panel, moderation (reports, mutes, suspensions), public player profiles
- [x] Phase 10 — Optional daily orders, campaigns, achievements, rank titles, task forces, renaming
- [x] Phase 11 — Research by year (1939–1945), alliance operations, seasons
- [x] Phase 12 — Missions at real places, weather and night, sounds, notifications, tutorial
- [x] Phase 13 — Automated tests, rate limits, housekeeping, usage report, operations guide
- [x] Phase 14 — A moving front line, enemy offensives, unconfirmed reports and scouting
- [x] Phase 15 — Divisions, refits, captured equipment, historical notes for every unit
- [x] Phase 16 — Fuel, parts and medical stores, Refinery, Rail Yard, Port, supply lines, market, movable bases
