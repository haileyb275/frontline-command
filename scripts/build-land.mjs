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

const statements = polygons.map((rings) => {
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
