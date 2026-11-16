# Frontline Command

A persistent, browser-based multiplayer WW2 command game played on a real-world
map. Build bases, raise units, dispatch them to missions, and team up in
alliances.

- **Frontend:** Vite + vanilla JavaScript, Leaflet + OpenStreetMap → GitHub Pages
- **Backend:** Supabase (auth, Postgres, row-level security, realtime) — from Phase 2

See [docs/DESIGN.md](docs/DESIGN.md) for the schema, folder structure and build phases.

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

1. every file in `supabase/migrations/`, lowest number first
2. `supabase/seed.sql`

After editing any JSON file in `src/data/`, regenerate the seed and run it again:

```bash
npm run seed
```

## Status

- [x] Phase 1 — Project setup, deploy workflow, Leaflet map
- [x] Phase 2 — Supabase auth and nation selection
- [ ] Phase 3 — Bases and units
- [ ] Phase 4 — Missions and dispatching
- [ ] Phase 5 — Alliances
- [ ] Phase 6 — Leaderboards and polish
