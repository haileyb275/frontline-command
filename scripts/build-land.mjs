// Builds the "where is land?" data the server uses to put missions in
// sensible places (land missions on land, naval missions at sea).
//
// Source: Natural Earth 1:10m land polygons (public domain), via the
// `world-atlas` npm package. Output: supabase/land/land-NN.sql — a handful of
// SQL files, each small enough to paste into the Supabase SQL Editor.
//
// Run with:   npm run land
// Then run the files in supabase/land/ in order (after 005_terrain.sql).
// You only need to do this once per database.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'supabase/land');

const topology = JSON.parse(readFileSync(require.resolve('world-atlas/land-10m.json'), 'utf8'));
const land = feature(topology, topology.objects.land);

// Collect every individual polygon (a continent, an island…).
const polygons = [];
for (const f of land.features ?? [land]) {
  const g = f.geometry;
  if (g.type === 'Polygon') polygons.push(g.coordinates);
  if (g.type === 'MultiPolygon') polygons.push(...g.coordinates);
}

// 4 decimal places of a degree is about 11 metres — plenty, and it keeps the files small.
const round = (n) => Math.round(n * 1e4) / 1e4;

// --- The 180° date line -------------------------------------------------
// In this source a shape that crosses the date line (north-east Siberia,
// Antarctica, Fiji…) is one ring whose longitude jumps from +180 to -180.
// Read as a flat shape, that jump is a line drawn right across the world,
// which turns whole bands of latitude inside out. So:
//   1. "unwrap" each ring so its longitudes run on continuously past 180;
//   2. a ring that goes all the way round the pole (Antarctica) is closed
//      by running it down to the pole and back;
//   3. a shape that now sticks out past ±180 is also stored a second time,
//      moved 360° the other way, so both sides of the line are covered.
function unwrap(ring) {
  const out = [ring[0]];
  let shift = 0;
  for (let i = 1; i < ring.length; i++) {
    const step = ring[i][0] - ring[i - 1][0];
    if (step > 180) shift -= 360;
    if (step < -180) shift += 360;
    out.push([ring[i][0] + shift, ring[i][1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (Math.abs(last[0] - first[0]) > 180) {
    const pole = first[1] < 0 ? -90 : 90;
    out.push([last[0], pole], [first[0], pole], first);
  }
  return out;
}

const shifted = (rings, by) => rings.map((ring) => ring.map(([lng, lat]) => [lng + by, lat]));

const flat = [];
for (const rings of polygons) {
  const outer = unwrap(rings[0]);
  const lngs = outer.map((pt) => pt[0]);
  const [min, max] = [Math.min(...lngs), Math.max(...lngs)];
  // Holes (lakes are not in this data, but be safe) follow their outer ring.
  const holes = rings.slice(1).map((hole) => {
    const h = unwrap(hole);
    const by = Math.round((outer[0][0] - h[0][0]) / 360) * 360;
    return h.map(([lng, lat]) => [lng + by, lat]);
  });
  const shape = [outer, ...holes];
  flat.push(shape);
  if (max > 180) flat.push(shifted(shape, -360));
  if (min < -180) flat.push(shifted(shape, 360));
}

const statements = flat.map((rings) => {
  const geojson = JSON.stringify({
    type: 'Polygon',
    coordinates: rings.map((ring) => ring.map(([lng, lat]) => [round(lng), round(lat)])),
  });
  // ST_Subdivide cuts big shapes (like Eurasia) into many small pieces so
  // that "is this point on land?" only has to look at a few of them.
  return (
    `insert into public.fc_land (geom) select extensions.ST_Subdivide(` +
    `extensions.ST_CollectionExtract(extensions.ST_MakeValid(extensions.ST_SetSRID(` +
    `extensions.ST_GeomFromGeoJSON('${geojson}'), 4326)), 3), 128);`
  );
});

// Split into files of roughly 700 KB.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let part = ['truncate public.fc_land;'];
let size = 0;
let fileNo = 0;
const flush = () => {
  if (part.length === 0) return;
  fileNo += 1;
  writeFileSync(join(outDir, `land-${String(fileNo).padStart(2, '0')}.sql`), part.join('\n') + '\n');
  part = [];
  size = 0;
};
for (const sql of statements) {
  if (size + sql.length > 700_000) flush();
  part.push(sql);
  size += sql.length;
}
flush();
console.log(`${polygons.length} land polygons written to ${fileNo} files in supabase/land/`);
