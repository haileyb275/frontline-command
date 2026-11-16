# Running Frontline Command

What you need to know to keep the game healthy once other people are playing.
The figures for free allowances were correct to the best of my knowledge when
this was written; providers change them, so check their pricing pages before
relying on a number.

## The services the game depends on

| Service | Used for | Cost | Where it is set |
|---|---|---|---|
| GitHub Pages | Hosting the game's files | Free | `.github/workflows/deploy.yml` |
| Supabase | Accounts, database, all game rules, live chat | Free tier | `src/config.js` |
| OpenStreetMap tile server | The map imagery | Free, light use only | `MAP_CONFIG.tileUrl` in `src/config.js` |
| OSRM demo server | Road routes for moving units | Free, light use only | `ROUTING_URL` in `src/config.js` |
| Overpass | Finding real bridges, airfields and towns | Free, light use only | `OVERPASS_URL` in `src/config.js` |

The last three are **shared community services, not products**. They are fine
for you and a few dozen friends. If the game grows they are the first things to
replace, because their operators may block heavy users.

If any of the three is down, the game keeps working: the map shows blank tiles,
units move in straight lines, and missions appear at ordinary spots.

## Routine checks

```bash
SUPABASE_ACCESS_TOKEN=sbp_... npm run usage
```

prints database size, player counts and the largest tables, with a warning if
something needs attention. Once a month is plenty at first.

**Free projects are paused after about a week with no activity.** If nobody
logs in for a week, open the Supabase dashboard and press Restore. Nothing is
lost, but the game shows an error until you do.

## Limits already built in

- **Check-ins** closer than one second apart are answered without redoing the
  settling work (`sync_player` in `013_limits.sql`).
- **Chat**: one message a second per player, 500 characters.
- **Reports**: five an hour per player.
- **Map surveys**: 40 an hour per player.
- **Housekeeping** runs by itself about once every hundred check-ins: chat older
  than 30 days, old logs and finished missions are deleted (`fc_maintenance`).
- To limit anything else, add one line at the top of its function:
  `perform public.fc_rate_limit('name', 20, 60);` (20 times per 60 seconds).

## Supabase free-tier ceilings to watch

| Ceiling | Roughly | What hits it first |
|---|---|---|
| Database size | 500 MB | The coastline table is about 8 MB and fixed. Each active player adds a few kilobytes. Thousands of players fit. |
| Realtime connections | 200 at once | One per logged-in player who is in an alliance. |
| Sign-up emails | 2 an hour | Confirmation and password-reset emails. The first limit real players will notice. |
| Monthly active users | 50,000 | Not a concern. |

**The email limit is the one to fix first.** In Supabase: Authentication →
Emails → SMTP Settings, connect a free transactional email account (Resend,
Brevo and similar offer a free allowance). After that the limit is your email
provider's, not Supabase's.

## When you outgrow the free services

### Map imagery
Above a few hundred daily players, switch to a tile provider with a free plan
and an API key (for example MapTiler or Stadia Maps). Change `tileUrl` and
`tileAttribution` in `src/config.js`. Keep the OpenStreetMap credit: it is a
licence requirement whichever provider serves the tiles.

### Road routing: your own server
The demo server asks for at most about one request a second and offers no
guarantee. The game already asks for one route per group of units and caches
it, so it is gentle, but a busy evening with many players could be refused.
Three options, cheapest effort first:

1. **A hosted free plan with a key.** openrouteservice offers a free daily
   allowance. Its request format differs from OSRM's, so `src/game/routes.js`
   needs a small change to the URL and to how the answer is read.
2. **Your own OSRM server.** This keeps `routes.js` unchanged; only
   `ROUTING_URL` changes.
   - Rent a small Linux server. Memory is what matters: a single country needs
     2–4 GB, all of Europe about 32 GB, the whole planet far more. Start with
     the region most of your players build in.
   - Download that region's `.osm.pbf` extract from Geofabrik.
   - Run the three OSRM steps with its Docker image (`osrm-extract` with the
     car profile, `osrm-partition`, `osrm-customize`), then start `osrm-routed`.
   - Put it behind HTTPS (Caddy does this in two lines), and allow your game's
     address in its CORS settings.
   - Set `ROUTING_URL` to `https://your-server/route/v1/driving`.
   - Routes outside your region simply fail, and units there move in straight
     lines, exactly as they do today when the demo server is unavailable.
3. **Turn road-following off.** Have `getRoute` in `src/game/routes.js` return
   `null`. Travel times are unaffected, because the server never used the road
   route for timing.

### The database
If the database or connection limits are reached, Supabase's first paid plan
raises them considerably. Nothing in the game needs to change.

## Tests

```bash
npm test
```

checks the content files against each other and the shared arithmetic. It needs
no network, runs in a second, and runs automatically before every deploy: a
broken edit to a JSON file stops the deploy instead of reaching players.

```bash
SUPABASE_ACCESS_TOKEN=sbp_... npm run test:db
```

plays through the real rules against a real Supabase project: cheating
attempts, bases, missions, offline completion, shared rewards, the admin panel.
It creates throw-away accounts and deletes them afterwards. It briefly changes
one game setting (unit damage) while it runs, so **once you have real players,
point it at a second, empty Supabase project** by setting `FC_SUPABASE_URL` and
`FC_SUPABASE_KEY` as well. Run it after any change to the SQL files.

## Keys and access

- The **publishable key** in `src/config.js` is public by design.
- The **access token** (`sbp_…`) can manage your whole Supabase account. Keep it
  out of the repository, and revoke it at Dashboard → Account → Access Tokens
  when you no longer need it.
- **Administrators** are made only in the SQL Editor:
  `update public.profiles set is_admin = true where username = 'name';`
- **Backups**: the free tier keeps none you can restore yourself. Before any
  risky change, export from Dashboard → Database → Backups, or copy the tables
  that matter (`profiles`, `bases`, `units`, `alliances`, `alliance_members`).

## Changing the database

Migrations in `supabase/migrations/` are numbered and run in order. Several
functions were revised in later files; **the highest-numbered file holds the
current version**. If you re-run an early file, re-run every later one after
it, then `supabase/seed.sql`.
