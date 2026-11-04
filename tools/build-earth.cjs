// Converts Natural Earth country shapes (world-atlas, public domain) into a compact
// public/earth.json: per country an id, name, centroid, approximate area and outline rings.
// Run via tools/build-map.sh (resolves modules through NODE_PATH).
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const topo = require('world-atlas/countries-110m.json');

const geo = topojson.feature(topo, topo.objects.countries);
const r1 = (n) => Math.round(n * 10) / 10;
const rad = Math.PI / 180;

function ringArea(ring) {            // spherical polygon area (unit sphere), Chamberlain-Duquette
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [l1, p1] = ring[i], [l2, p2] = ring[i + 1];
    sum += (l2 - l1) * rad * (2 + Math.sin(p1 * rad) + Math.sin(p2 * rad));
  }
  return Math.abs(sum / 2);
}
function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const [lo, la] of ring) { x += lo; y += la; }
  return [x / ring.length, y / ring.length];
}

const countries = geo.features.map((f) => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let area = 0, best = null, bestArea = -1;
  const rings = [];
  for (const poly of polys) {
    const outer = ringArea(poly[0]);
    area += outer;
    for (let h = 1; h < poly.length; h++) area -= ringArea(poly[h]);
    if (outer > bestArea) { bestArea = outer; best = poly[0]; }
    for (const ring of poly) {
      const flat = [];
      for (const [lo, la] of ring) flat.push(r1(lo), r1(la));
      rings.push(flat);
    }
  }
  const [clon, clat] = ringCentroid(best);
  return { id: String(f.id), name: f.properties.name, c: [r1(clon), r1(clat)], a: Math.round(area * 1e4) / 1e4, r: rings };
});

const out = path.join(__dirname, '..', 'public', 'earth.json');
fs.writeFileSync(out, JSON.stringify({ countries }));
console.log('earth.json:', countries.length, 'countries,', (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
