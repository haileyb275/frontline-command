# Frontline Command — Design Document

A persistent, browser-based multiplayer strategy game. You command WW2-era
units from bases on a real-world map and dispatch them to missions. The genre
is "dispatch simulator"; the setting, content and code are our own.

**Tone:** strategy/history game. Missions are military objectives only (no
civilian targets, no atrocities, no graphic content). Every nation is framed
neutrally and the unit rosters are about equipment, not ideology.

---

## 1. Architecture: who does what

```
 Browser (GitHub Pages)                    Supabase (free tier)
 ┌───────────────────────────┐            ┌────────────────────────────────┐
 │ Static HTML/CSS/JS (Vite) │  HTTPS     │ Auth      (accounts, sessions) │
 │ Leaflet map + OSM tiles   │ ─────────► │ Postgres  (all game state)     │
 │ Draws state, animates     │            │ RLS       (who may read what)  │
 │ travel, sends *requests*  │ ◄───────── │ Functions (ALL game rules)     │
 └───────────────────────────┘  realtime  │ Realtime  (chat, shared ops)   │
                                           └────────────────────────────────┘
```

### Why GitHub Pages alone is not enough

GitHub Pages is a **static file host**: it hands the same HTML/CSS/JS files to
every visitor and runs no code of its own. That means it has:

- **no database** — nowhere to store your bases or money between visits,
- **no accounts** — no way to know who you are,
- **no shared state** — two players can never see each other,
- **no trusted referee** — everything running in the browser can be edited by
  the player (open dev tools, type `money = 999999`).

Supabase fills all four gaps for free: a Postgres database, login, realtime
push messages, and — most importantly — a place to run the game rules where the
player cannot tamper with them.

### The anti-cheat rule

> **The browser never writes game state. It only asks.**

- Row-level security (RLS) lets a player **read** their own rows (and their
  alliance's), and **write almost nothing** directly.
- Every action is a Postgres function (called from JS with `supabase.rpc()`):
  `buy_unit(...)`, `dispatch_units(...)`, etc. The function runs on the server,
  looks up the *real* price / travel time / reward from the config tables,
  checks the player can afford it, and makes the change in one transaction.
- The server uses **its own clock** (`now()`), never a time sent by the browser.

So a cheater can change what their screen *shows*, but not what the database
*holds*.

### Offline progress without a server loop

Free hosting gives us no always-on game server, so nothing "ticks". Instead we
store **timestamps** and compute what happened whenever someone looks:

- A dispatch stores `arrives_at`; a mission stores `completes_at`.
- One function, `sync_player()`, is called on login and every ~20 s while
  playing. It: (1) resolves every mission whose `completes_at` has passed and
  pays rewards, (2) frees units whose return time has passed, (3) spawns the
  missions that *would have* appeared since `last_spawn_at`, capped at a
  maximum backlog so a week away doesn't bury you in 500 missions.
- Unit movement on the map is pure animation: the browser interpolates between
  the base and the mission using `departed_at` / `arrives_at`.

For shared alliance missions, whichever member syncs first resolves the mission
for everybody (the function locks the row so it only happens once).

---

## 2. Content is data, not code

All content lives in JSON files in `src/data/`:

| File | Contents |
|---|---|
| `categories.json` | Infantry, Armor, Anti-Tank, Artillery, Air, Recon, Medical, Engineers, Logistics |
| `nations.json` | USA, UK, USSR, Germany, France, Italy, Japan — name, colour, bonus |
| `units.json` | per nation: name, category, cost, speed (km/h), power, required building |
| `buildings.json` | HQ, barracks, tank depot, airfield, artillery park, field hospital, supply depot — cost, unit capacity, which categories it unlocks |
| `missions.json` | 20+ types: requirements (`{"infantry": 2, "artillery": 1}`), duration, rewards, min level, weight, follow-ups, shareable flag |
| `alliance_buildings.json` | alliance-wide bonus buildings |

Missions ask for **categories**, never specific units, so a Sherman, a T-34 and
a Panzer IV all satisfy "1 × Armor". Adding an eighth nation is one entry in
`nations.json` plus its rows in `units.json`.

**One source of truth:** the server must know prices and rewards too (or it
couldn't validate anything). A small script, `scripts/build-seed.mjs`, converts
the JSON files into `supabase/seed.sql`, which fills the config tables. Edit
JSON → run script → paste SQL. The browser and the server always agree.

### Nation bonuses (small, ~10 %, different axes)

| Nation | Bonus |
|---|---|
| USA | Logistics units travel 15 % faster; +10 % supplies from missions |
| UK | Recon and Air units travel 10 % faster |
| Soviet Union | Infantry and Armor cost 10 % less |
| Germany | Armor counts for +10 % mission power |
| France | Bases and buildings cost 10 % less |
| Italy | Engineers and Artillery cost 10 % less |
| Japan | Infantry travel 15 % faster |

Bonuses are stored as data (`{"type": "cost_mult", "category": "armor",
"value": 0.9}`) and applied by the server functions.

---

## 3. Database schema

`uuid` ids everywhere; `timestamptz` for all times. *Config tables* are
read-only for players and filled by the seed script.

### Config tables (public read, no client writes)

| Table | Fields |
|---|---|
| `nations` | `id` text PK, `name`, `color`, `bonus` jsonb |
| `unit_categories` | `id` text PK, `name`, `icon` |
| `unit_types` | `id` text PK, `nation_id` → nations, `category_id` → unit_categories, `name`, `cost_money`, `cost_supplies`, `speed_kmh`, `power`, `required_building`, `min_level` |
| `building_types` | `id` text PK, `name`, `cost_money`, `cost_supplies`, `unit_capacity`, `unlocks_categories` text[], `min_level`, `is_hq` bool |
| `mission_types` | `id` text PK, `name`, `description`, `requirements` jsonb, `duration_seconds`, `reward_money`, `reward_supplies`, `reward_xp`, `difficulty` int, `min_level`, `spawn_weight`, `shareable` bool, `followups` jsonb, `expires_seconds` |
| `alliance_building_types` | `id` text PK, `name`, `cost`, `bonus` jsonb, `max_level` |

### Player state

| Table | Fields | Notes |
|---|---|---|
| `profiles` | `id` uuid PK → `auth.users`, `username` unique, `nation_id` (null until chosen), `money` bigint, `supplies` bigint, `xp` bigint, `level` int, `missions_completed` int, `last_spawn_at`, `last_seen_at`, `created_at` | One row per account, created by a trigger on sign-up |
| `bases` | `id`, `owner_id` → profiles, `building_type` → building_types, `name`, `lat`, `lng`, `level`, `created_at` | Each building is its own map marker |
| `units` | `id`, `owner_id`, `base_id` → bases, `unit_type` → unit_types, `status` (`idle` / `en_route` / `on_mission` / `returning`), `mission_id` (nullable), `busy_until`, `created_at` | |
| `missions` | `id`, `mission_type`, `owner_id`, `alliance_id` (null = private), `lat`, `lng`, `status` (`open` / `in_progress` / `completed` / `expired`), `spawned_at`, `expires_at`, `started_at`, `completes_at`, `parent_mission_id` | `started_at` is set when the last required unit arrives |
| `dispatches` | `id`, `mission_id`, `unit_id`, `player_id`, `category_id`, `from_lat`, `from_lng`, `departed_at`, `arrives_at`, `returns_at` | One row per unit sent. Also the record of **who contributed what** for splitting shared rewards |

### Alliances

| Table | Fields | Notes |
|---|---|---|
| `alliances` | `id`, `name` unique, `tag` unique (2–5 chars), `description`, `treasury` bigint, `xp` bigint, `created_by`, `created_at` | |
| `alliance_members` | `alliance_id`, `player_id` **unique** (one alliance per player), `role` (`leader` / `officer` / `member`), `donated_total`, `joined_at` | No nation restriction — any mix |
| `alliance_messages` | `id`, `alliance_id`, `sender_id`, `body` (≤ 500 chars), `created_at` | Realtime channel |
| `alliance_buildings` | `id`, `alliance_id`, `building_type`, `level`, `built_at` | Paid from the treasury |
| `treasury_log` | `id`, `alliance_id`, `player_id`, `amount`, `reason`, `created_at` | Audit trail of donations and spending |

### Leaderboards (views — computed, never stored by clients)

- `leaderboard_players`: username, nation, level, xp, missions_completed
- `leaderboard_alliances`: name, tag, member count, total xp, treasury

### Server functions (the only way to change state)

| Function | Checks it performs |
|---|---|
| `choose_nation(nation)` | nation exists; not already chosen; grants starting funds |
| `place_base(type, lat, lng, name)` | affordable, level OK, first base must be an HQ, minimum distance from own bases |
| `buy_unit(base, unit_type)` | unit is in *your* nation's roster, base has capacity and the right building, affordable (after nation bonus) |
| `dispatch_units(mission, unit_ids[])` | units are yours and idle; mission visible to you and open; travel time = distance ÷ speed, computed server-side |
| `sync_player()` | resolve finished missions, return units, spawn elapsed missions (capped), level-ups |
| `share_mission(mission)` | mission is yours, shareable, and you're in an alliance |
| `create_alliance` / `join_alliance` / `leave_alliance` / `set_member_role` / `kick_member` | role permissions |
| `donate_to_treasury(amount)` | amount > 0 and ≤ your money |
| `build_alliance_building(type)` | leader/officer only; treasury can afford it |

### Row-level security summary

| Table | Select | Insert / Update / Delete |
|---|---|---|
| config tables | everyone | nobody (seed only) |
| `profiles` | own row in full; others via leaderboard views only | functions only |
| `bases`, `units` | own rows (+ alliance members' bases for the map) | functions only |
| `missions`, `dispatches` | own, or mission's `alliance_id` is your alliance | functions only |
| `alliances` | everyone (for the join list) | functions only |
| `alliance_members`, `alliance_buildings`, `treasury_log` | members of that alliance | functions only |
| `alliance_messages` | members of that alliance | insert own message as a member; no edit |

### Shared mission reward split

When a shared mission completes, each player's share =
`(sum of power of the units they sent that counted toward a requirement) ÷
(total counted power)`. The mission owner gets a small finder's bonus (+10 %),
and 5 % of the reward goes to the alliance treasury.

---

## 4. Folder structure

```
frontline-command/
├── .github/workflows/deploy.yml   # auto-deploy to GitHub Pages
├── docs/DESIGN.md                 # this file
├── public/                        # copied as-is into the build (favicon…)
├── scripts/
│   └── build-seed.mjs             # JSON → supabase/seed.sql       (Phase 3)
├── supabase/
│   ├── migrations/                # numbered .sql files, one per phase
│   │   ├── 001_profiles.sql                                        (Phase 2)
│   │   ├── 002_bases_units.sql                                     (Phase 3)
│   │   ├── 003_missions.sql                                        (Phase 4)
│   │   ├── 004_alliances.sql                                       (Phase 5)
│   │   └── 005_leaderboards.sql                                    (Phase 6)
│   └── seed.sql                   # generated config data
├── src/
│   ├── main.js                    # entry point: wires modules together
│   ├── config.js                  # shared settings
│   ├── map.js                     # everything Leaflet
│   ├── style.css                  # olive/khaki theme
│   ├── supabase.js                # Supabase client                (Phase 2)
│   ├── state.js                   # in-memory copy of game state   (Phase 2)
│   ├── data/                      # ← edit content here, no logic
│   │   ├── nations.json, categories.json                           (Phase 2)
│   │   ├── units.json, buildings.json                              (Phase 3)
│   │   ├── missions.json                                           (Phase 4)
│   │   └── alliance_buildings.json                                 (Phase 5)
│   ├── game/
│   │   ├── bases.js, units.js                                      (Phase 3)
│   │   ├── missions.js, travel.js                                  (Phase 4)
│   │   └── alliance.js                                             (Phase 5)
│   └── ui/
│       ├── panel.js               # side panel + tabs
│       ├── auth.js, nationPicker.js                                (Phase 2)
│       ├── basesTab.js, unitsTab.js                                (Phase 3)
│       ├── missionsTab.js                                          (Phase 4)
│       ├── allianceTab.js, chat.js                                 (Phase 5)
│       └── leaderboard.js, toast.js                                (Phase 6)
├── index.html
├── package.json
└── vite.config.js
```

---

## 5. Build phases

| # | Phase | You'll be able to… |
|---|---|---|
| 1 | **Setup, deploy, map** | Open the live GitHub Pages URL and see the themed map and side panel |
| 2 | **Auth + nation** | Sign up, log in, pick a nation; profile row is created server-side |
| 3 | **Bases + units** | Place an HQ, build more bases, buy units from your nation's roster; refresh and it's all still there |
| 4 | **Missions** | See missions spawn, dispatch units, watch them drive, collect rewards; come back after a break and offline results are applied |
| 5 | **Alliances** | Create/join an alliance, chat live, share large missions, donate, build alliance buildings |
| 6 | **Leaderboards + polish** | Player/alliance rankings, balance pass, notifications, mobile bottom-sheet refinements |

Each phase ends with: a test checklist, the SQL to run in Supabase, and the
exact files to commit.

---

## 6. As built

The game followed this design, with a few changes made along the way:

- **Units' buildings** are derived from `buildings.json` (`unlocks_categories`) rather than a
  `required_building` field on each unit.
- **Dispatches** store the unit's power and travel time at the moment of sending, and are deleted
  when the unit gets home. Reward shares are worked out from them when a mission completes.
- **Shared rewards** are written to a `mission_payouts` table and collected by each player's own
  next sync, so two players settling at once can never block each other or be paid twice.
- **Profiles of other players** are never readable directly. Member lists, rankings and names on
  shared missions come from server functions that return only public columns.
- **Phase 5b (terrain)** was added: PostGIS coastline data (`fc_land`), a `terrain` and distance
  band on every mission type, a Naval category with a coastal Naval Base, and road-following
  movement drawn in the browser from a public OSRM routing server.
- **Phase 6** added `upgrade_base`, `dismiss_unit` and `get_leaderboard`.

Migrations `001`–`006` in `supabase/migrations/` are the authoritative schema. Where a function
was revised in a later phase, the highest-numbered file holds the current version.
- **Phase 7** added specialties (`specialties`, `train_unit`), factories (`products`,
  `start_production`, `shipments`), unit transfers (`transfer_unit`), and a `zone` on every base
  (`front` or `home`, `set_base_zone`). Mission requirement keys may now be a category or a
  specialty; `dispatches.category_id` records which place a unit filled. Mission types carry a
  `zone_rule` (`contact`, `front` or `any`) that decides where they may spawn.
- **Phase 8** added unit experience (`units.missions_done`) and damage (`repair_until`, status
  `repairing`), a supply `stock` on every base that dispatches draw down (`resupply_base`,
  automatic resupply convoys), and escort missions for threatened sea convoys
  (`missions.shipment_id`).
- **Phase 9** added administrators (`profiles.is_admin`, every `admin_*` function guarded by
  `fc_require_admin()`, all changes written to `admin_log`), moderation (`reports`,
  `muted_until`, `is_banned`) and public profiles (`get_player_profile`).
- **Phase 10** added running totals (`player_counters`, bumped in `fc_on_mission_complete`),
  optional daily orders (`daily_orders`, `claim_daily_order`), campaigns and achievements
  (`objectives`, `claim_objective`), saved task forces, and renaming of bases and units.
- **Phase 11** added research (`unit_types.year`, `profiles.research_year`, enforced by a trigger
  on `units`), alliance operations (`alliance_operations`, fed by `fc_bump`), and quarterly
  seasons (`season_scores`, filled by a trigger on `profiles.xp`).
- **Phase 12** added a map survey (`map_features`, filed by the browser from OpenStreetMap's
  Overpass service and used by `fc_spawn_mission` for missions with a `site`), and weather and
  night (`fc_weather`, `fc_is_night`, mirrored in `src/game/weather.js`).
- **Phase 13** added `fc_rate_limit`, a throttle on `sync_player`, `fc_maintenance`, and the
  test suites in `tests/`. See `docs/OPERATIONS.md` for running the game.
- **Phase 14** added a front radius per base (`bases.front_km`, moved by `fc_on_mission_complete`
  and `fc_on_mission_expired`), offensives (`missions.target_base_id`, `bases.disabled_until`), and
  unconfirmed reports (`missions.confirmed`, `scout_mission`, masked in `fc_snapshot` and by the
  missions read policy).
- **Phase 15** added divisions (`divisions`, `units.division_id`, a formation bonus applied by a
  trigger on `dispatches`), refits (`refit_unit`), captured equipment (a trigger on `missions`,
  announced through `player_notices`), and a `note` on every unit in `units.json`.
- **Phase 16** added goods (`profiles.fuel`, `parts`, `medical`, spent by triggers on `dispatches`
  and `units`), infrastructure (`building_types.infra`, used by `fc_convoy_seconds`), resupply
  overhead (`fc_resupply_overhead`), a shared market (`market`, `trade_market`), and `move_base`.

## Phase 17 as built: alliance territory, rivalry, mutual aid, worldwide events

All in `supabase/migrations/017_rivalry.sql`.

- **Alliance territory.** `get_alliance_map()` returns alliance mates' bases (owner, name, kind,
  place, front distance, nothing else). The map draws them as small blue markers with blue
  shading over the ground their front-line bases hold (`createAllyLayer` in `src/map.js`).
- **Weekly rivalry.** `fc_bump` (current version now lives in `017`) adds a point to
  `alliance_week_scores` for every mission a member completes, and a second for a hard one.
  Weeks start Monday 00:00 UTC; nothing has to "reset", a new week is simply a new row.
  `get_alliance_week()` gives this week's top 20 and last week's top 3. Shown in
  Alliance → Overview and Ranks → Alliances.
- **Mutual aid.** `send_aid(username, item, quantity)` takes supplies, fuel, parts or medical
  stores from the sender and creates a convoy owned by the receiver, from HQ to HQ, which their
  next check-in unloads like any other cargo. Same alliance only, 2,000 per convoy, 10 an hour.
  The form is under Alliance → Members.
- **Worldwide events.** An administrator starts one from the Admin panel (`admin_start_event`):
  a name, what counts (all missions or hard ones), a target for all players together, a length
  and a reward. `fc_bump` feeds it; when the target is reached everyone who contributed can
  collect the reward once (`claim_event_reward`). One runs at a time. Shown at the top of
  Missions → Orders.

Not built: lending units to an ally (ownership, repairs and veterancy make it a larger job).

## Phase 18 as built: filters, standing orders, historical operations, statistics, translations

- **Mission filters** (browser only): All, Can staff now, Under way, Land, Sea, Urgent.
- **Standing orders** (browser only, `runAutoDispatch` in `missionsTab.js`): while the game is
  open, a new report at or under a chosen difficulty that the player's idle units can fully
  staff is dispatched with the same call a click makes, so the server checks it identically.
  Nothing happens while the game is closed; this keeps the "nothing runs in the background" rule.
- **Historical operations** (`018_history_stats.sql`, content in `src/data/history.json`): seventeen
  named battles, each a chain of 3 or 4 missions at real coordinates. `start_history_op` needs
  the level, a base within `range_km` of the place, and no other operation under way. A trigger
  on `missions` puts the next step on the map when one is won, fails the operation if a step
  expires (it can be restarted), and on the last step pays the reward and records a battle
  honour, shown on the public profile via `get_player_honours`. Steps pay 1.5 times as much.
- **Statistics**: `get_my_stats()` returns lifetime counters, the last seven days, and totals
  per mission type. Payout rows are deleted as they are paid, so a before-delete trigger keeps
  the running totals in `mission_stats`. Shown only on your own profile ("Your record").
- **Translations** (`src/i18n.js`, `src/data/lang/de.json`): a word list maps English labels to
  another language and a MutationObserver swaps recognised labels as they appear. Player-typed
  text is never touched. Coverage is the fixed labels and buttons, the names of missions, buildings, arms, specialties,
  nations and ranks, and some fixed messages (about 320 entries). Unit names, descriptions, help
  text, sentences with numbers in them and most server error messages are still English.

### Coastline data and the date line (fixed after Phase 18)

`world-atlas` stores a shape that crosses 180° as one ring whose longitude jumps from +180 to
-180. Read as a flat shape that jump is a line across the whole map, which turned the band
between about 65° and 71° N inside out (land read as sea across northern Scandinavia and
Russia). `scripts/build-land.mjs` now unwraps such rings, closes the Antarctic ring at the
pole, and stores a second copy shifted 360° so both sides of the line are covered. A database
test checks twelve known points. If you rebuild a database, run `npm run land` and apply the
files again.

## Phase 19 as built: lending units

`supabase/migrations/019_loans.sql`. A lent unit really changes owner for the length of the
loan (`units.lent_by`, `lent_until`, `home_base_id`), so every existing function treats it as
the borrower's own: it is dispatched, supplied and gains experience like any other.

- `lend_unit(unit, username, hours)`: idle unit, same alliance, 1 to 72 hours, at most five out
  at once; it moves to the borrower's nearest base that stations its kind and has a free place.
- `fc_return_loans` runs at each check-in of either player (the current `sync_player` is now in
  `019`) and sends home any expired loan that is idle. `end_loan` lets either side end it early.
- `fc_guard_loan`, a trigger under all the older functions, stops a unit on loan being
  dismissed (which pays a refund), trained, refitted, transferred or lent on. If the borrower's
  base or account is deleted, the unit is copied back to the lender instead of being lost.
- Screens: "Lend to an ally" on a unit's page, a card on a borrowed unit, and "Out on loan"
  with a Recall button in the Units tab.

## Phase 20 as built: events started by alliances

`supabase/migrations/020_alliance_events.sql`, sizes in `src/data/alliance_events.json`.

- Three sizes: Local Push (15 missions, 6 h) and Theatre Offensive (50 missions, 24 h) count only
  the alliance's own members; Call to Arms (200 missions, 48 h) is a worldwide event that every
  player feeds, shown in Missions → Orders as "called by" the alliance.
- **Free:** a leader or officer may start one per alliance per UTC day.
- **Sponsored:** any member pays the size's `cost` from their own funds, once per player per day.
  If the event succeeds the sponsor collects `sponsor_return` (1.5 × cost) on top of the normal
  participant reward, even if they took no part themselves; if it fails the money is gone.
- One event per alliance at a time, and one worldwide event at a time (administrators' included).
- Events are rows in `global_events`: `alliance_id` set means members only; `sponsor_alliance_id`,
  `sponsor_id`, `sponsor_cost`, `sponsor_return`, `sponsor_claimed` record who called and paid.
  `fc_bump` (current version now in `020`) feeds every matching event; `claim_event_reward`
  (also `020`) pays the contributor's reward and the sponsor's return.
- Screen: Alliance → Ops, above the joint operations.
