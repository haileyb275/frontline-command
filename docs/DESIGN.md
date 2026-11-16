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
