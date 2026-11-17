# Handoff notes for whoever continues this project

Written for a developer (human or AI) picking the project up without the
conversation that built it. Read this, then `docs/DESIGN.md` (the original
design plus an "As built" list per phase) and `docs/OPERATIONS.md` (running it).

## What this is

A persistent multiplayer WW2 dispatch game. Static front end on GitHub Pages
(Vite + vanilla JS + Leaflet), Supabase behind it (auth, Postgres, realtime).
Live at https://haileyb275.github.io/frontline-command/. Pushing to `main`
runs the tests and deploys.

The owner is a beginner-to-intermediate coder. **Every file is commented for
that reader**: say what a thing is for and why, in plain words. Keep doing that.

## The three rules that hold everything together

1. **The browser never writes game state.** Row-level security lets players
   read their own rows and write almost nothing. Every action is a Postgres
   function called with `supabase.rpc()`. Never add a client-side write, and
   never trust a number the browser sends (prices, times, rewards are all
   looked up on the server).
2. **Nothing runs in the background.** Everything is timestamps. `sync_player()`
   (called on login, every 20 s, and just after each known event) settles
   whatever should have happened by now. To add a timed thing, store when it
   ends and settle it in `fc_sync_extras()`.
3. **Content is data.** Units, buildings, missions, specialties, products,
   orders and settings live in `src/data/*.json`. `npm run seed` turns them
   into `supabase/seed.sql`, which the server reads. Change JSON → `npm run
   seed` → apply `seed.sql` → push. `npm test` fails if `seed.sql` is stale.

## Working on the database

```bash
SUPABASE_ACCESS_TOKEN=sbp_... npm run migrate                 # every migration (twice, in order), then seed.sql
SUPABASE_ACCESS_TOKEN=sbp_... npm run sql -- path/to/file.sql # one file
SUPABASE_ACCESS_TOKEN=sbp_... npm run test:db                 # 17 tests against the real project
npm test                                                      # 15 offline tests (also run in CI before deploy)
```

**How the migrations are layered (important).** Files `001`–`016` run in order
and are all safe to re-run. Big functions were *not* rewritten each phase.
Instead:

- Early files define **hooks** that later files replace. `004` creates
  placeholder versions only if nothing better exists (`fc_sync_extras`,
  `fc_on_mission_complete`, `fc_on_mission_expired`, `fc_assert_active`,
  `fc_assert_can_chat`).
- Later phases prefer **triggers** over rewriting (`dispatches` has three
  BEFORE INSERT triggers: confirmed-report check, division bonus, fuel;
  `units` has the research-year check and the stores-speed-repair trigger;
  `missions` has the after-won trigger; `profiles.xp` feeds seasons).
- Where a function *was* revised, **the highest-numbered file holds the
  current version**. If you re-run an early file, re-run every later one
  after it (`npm run migrate` does this).

Where the current version of the main functions lives:

| Function | File |
|---|---|
| `fc_sync` (settle missions, payouts, expiry, returns) | `004` |
| `fc_sync_extras` (repairs, training, transfers, production → convoys, arrivals, notices, auto-resupply) | `008` |
| `fc_snapshot` (everything the browser draws; hides unconfirmed reports) | `014` |
| `dispatch_units` (slots, supplies, weather, night, veterancy) | `012` |
| `fc_spawn_mission` (terrain, real places, home-front rule) | `012` |
| `fc_spawn_due_missions` (choice, front band, unconfirmed, offensives) | `014` |
| `fc_on_mission_complete` (experience, damage, counters, front) | `014` |
| `fc_bump` (counters, alliance operations, weekly rivalry, worldwide events) | `017` |
| `sync_player` (throttle), `fc_rate_limit`, `fc_maintenance` | `013` |
| `get_player_profile` | `011` |
| `fc_convoy_seconds`, market, `move_base`, goods triggers | `016` |

Three files were edited in place after their phase to add hooks or columns:
`004`, `007`, `008`. That is deliberate.

**Adding a column that an earlier file's function uses:** apply your new
migration first (so the column exists), then the earlier files, then yours
again. On a live database, a function that references a missing column fails
at the next check-in, for every player.

## Working on the front end

- `src/main.js` wires modules together. `src/state.js` is a tiny store
  (`state`, `setState`, `subscribe`). `src/game/actions.js` holds every server
  call; most answer with a snapshot applied by `applySnapshot()`.
- `src/ui/panel.js` is the controller for the side panel. Each tab is a module
  exporting `render(state, ui)` and optionally `handleAction`, `handleSubmit`,
  `handleChange`, `handleMapClick`, `tick`, `afterRender`, `onShow`. Buttons
  carry `data-action`; forms `data-form`; selects `data-change`.
  `data-confirm="…"` on any button asks first.
- **Always wrap player-written text in `esc()`** (names, chat, base names).
  Map tooltips use text nodes for the same reason.
- `src/game/content.js` mirrors a few server formulas for *display only*
  (prices, travel estimates, weather). `tests/logic.test.mjs` pins them. If
  you change one side, change the other.
- Icons are inline SVG in `src/ui/icons.js`. A unit's `icon` in `units.json`
  picks its picture.

## Testing habits that caught real bugs

- Test server rules through the API as a throw-away player, including the
  cheat attempts (direct table writes, other players' ids). `tests/db/helpers.mjs`
  has `createPlayer`, `sql`, `sync`, `cleanup`.
- Fast-forward time by editing timestamps in SQL, never by waiting.
- After the SQL passes, run the flow in a real browser. Several bugs only
  showed there (a form handler missing a parameter; markers not moving).
- Every phase ends with: offline tests, database tests, browser run, delete
  test accounts, commit, push, confirm the deploy.

## Things that are not what they seem

- `sync_player` ignores a second call within one second. Tests call
  `player.sync()`, which winds `last_seen_at` back first.
- `units.status = 'repairing'` also means "being refitted" and "regrouping
  after the base was overrun". `dispatches.category_id` is the *place* a unit
  fills, which can be a specialty id.
- An unconfirmed report is masked in `fc_snapshot` **and** by the missions
  read policy. Any new way of reading missions must mask it too.
- The browser cannot tell land from sea. Anything needing that is decided on
  the server (`fc_is_land`, backed by the `fc_land` PostGIS table loaded from
  `supabase/land/*.sql`, which is generated by `npm run land` and not committed).
- Each nation's first unit of every branch is available at 1939 regardless of
  its real date, so every nation can field every branch from the start.

## Known gaps (honest list)

- The live Overpass map survey was never tested against the real service
  (it was unreachable from the build sandbox); it was tested with a stand-in.
- Browser notifications and sound output were not verified in a real browser.
- The password-reset email round trip was not tested end to end.
- Unit historical notes were written from general knowledge, not checked
  against a reference.
- Sea raids apply to factory cargo convoys only, not resupply runs.
- A suspended player is blocked at check-in and in chat, not in every function.
- The owner's own account still holds millions in test funds.

## What was planned next

**Phase 17 is done** (`017_rivalry.sql`; see "Phase 17 as built" in DESIGN.md).
Left over from it: lending units to an ally, which is harder because a lent
unit must come back, with its repairs and experience.

**Phase 18 is done** (`018_history_stats.sql`; see "Phase 18 as built" in DESIGN.md).

Open ends, in rough order of value:

- Translations are partial: labels, buttons and most content names are covered. Unit names,
  descriptions, help text, sentences with numbers and server error messages are English. A full job means
  a `t()` function with placeholders and per-language content files.
- Standing orders run only in an open browser. A server-side version would belong in
  `fc_sync_extras`, with rules stored per player.
- Lending units to an ally (left over from Phase 17).
- Statistics count from Phase 18 onward; earlier payouts were not recorded.
