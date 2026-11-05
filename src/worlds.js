// Worlds for Ascension: Type Omega.
// Every civilization owns its own planet: you hold real Earth (Natural Earth countries),
// each rival holds a procedurally generated alien world with its own palette and provinces.
// A civilization claims regions around its capital as its output grows.
// The galaxy map and the globe view share these worlds (and their textures).

import { civsFromView, mulberry32 } from './map.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

export const UNCLAIMABLE = new Set(['Antarctica', 'Fr. S. Antarctic Lands']);
const EARTH_W = 2048, EARTH_H = 1024;
const PW = 640, PH = 320, NREG = 40;

export const WORLD_DEFS = [
  { key: 'earth', name: 'Earth', owner: 'You', kind: 'earth', atmos: 0x4aa8ff, noun: 'countries' },
  { key: 'crystal', name: 'Virel IV', owner: 'Vael Collective', kind: 'proc', atmos: 0x9b7bff, noun: 'provinces',
    ocean: [14, 12, 58], shallow: [44, 40, 130], land: [[150, 132, 228], [226, 216, 255]], ice: [238, 240, 255], sea: 0.53, freq: 2.3 },
  { key: 'desert', name: 'Kharon', owner: 'Orion Hegemony', kind: 'proc', atmos: 0xff8c42, noun: 'provinces',
    ocean: [34, 12, 8], shallow: [96, 40, 16], land: [[150, 78, 34], [236, 172, 96]], ice: [250, 228, 196], sea: 0.50, freq: 2.0 },
  { key: 'shadow', name: 'Umbra', owner: 'Nyx Syndicate', kind: 'proc', atmos: 0xff4d8d, noun: 'provinces',
    ocean: [5, 3, 14], shallow: [30, 10, 52], land: [[58, 26, 84], [168, 64, 176]], ice: [214, 176, 232], sea: 0.52, freq: 2.6 },
  { key: 'garden', name: 'Eden Reach', owner: 'Aurelian Concord', kind: 'proc', atmos: 0x5be37d, noun: 'provinces',
    ocean: [6, 54, 94], shallow: [24, 128, 156], land: [[34, 112, 56], [170, 196, 92]], ice: [246, 250, 255], sea: 0.55, freq: 2.2 },
];

// ---------- geometry helpers ----------

/** Matches three.js SphereGeometry + an equirectangular texture. */
export function latLonToXYZ(lat, lon, r = 1) {
  const la = lat * DEG, lo = lon * DEG;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo)];
}

export function angularDistance(lat1, lon1, lat2, lon2) {
  const a = latLonToXYZ(lat1, lon1), b = latLonToXYZ(lat2, lon2);
  return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) / DEG;
}

/** Territory reach in degrees of arc around the capital. */
export const radiusDeg = (progress) => 7 + 95 * clamp(progress, 0, 1);

/** Regions (each {c:[lon,lat], claimable}) within reach of the home region; home is always claimed. */
export function claimRegions(regions, home, progress) {
  const out = new Uint8Array(regions.length);
  const reach = radiusDeg(progress), h = regions[home];
  regions.forEach((r, i) => {
    if (i === home) { out[i] = 1; return; }
    if (!r.claimable) return;
    if (angularDistance(r.c[1], r.c[0], h.c[1], h.c[0]) < reach) out[i] = 1;
  });
  return out;
}

const EARTH_HOMES = [
  'United States of America', 'Brazil', 'Russia', 'China', 'India', 'Australia', 'Nigeria', 'Germany',
  'Canada', 'Egypt', 'Argentina', 'South Africa', 'Indonesia', 'Mexico', 'Kazakhstan', 'Saudi Arabia',
  'Turkey', 'France', 'Algeria', 'Dem. Rep. Congo',
];

/** Seed-based choice of the player's Earth home country. */
export function pickEarthHome(earth, seed) {
  const rng = mulberry32(((seed >>> 0) || 1) ^ 0x9e3779b9);
  const pool = EARTH_HOMES.map((n) => earth.countries.findIndex((c) => c.name === n)).filter((i) => i >= 0);
  return pool[Math.floor(rng() * pool.length)];
}

// ---------- Earth painting ----------

export function drawEarth(ctx, W, H, earth, claimed, color) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#071a33'); g.addColorStop(0.5, '#06203f'); g.addColorStop(1, '#071a33');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const X = (lon) => (lon + 180) / 360 * W, Y = (lat) => (90 - lat) / 180 * H;
  ctx.strokeStyle = 'rgba(120,170,255,0.08)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) { ctx.beginPath(); ctx.moveTo(X(lon), 0); ctx.lineTo(X(lon), H); ctx.stroke(); }
  for (let lat = -60; lat <= 60; lat += 30) { ctx.beginPath(); ctx.moveTo(0, Y(lat)); ctx.lineTo(W, Y(lat)); ctx.stroke(); }
  earth.countries.forEach((ct, i) => {
    ctx.beginPath();
    for (const ring of ct.r) {
      for (let k = 0; k < ring.length; k += 2) {
        const x = X(ring[k]), y = Y(ring[k + 1]);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fillStyle = UNCLAIMABLE.has(ct.name) ? '#cfd9e8' : '#4b5c70';
    ctx.fill('evenodd');
    if (claimed[i]) { ctx.globalAlpha = 0.88; ctx.fillStyle = color; ctx.fill('evenodd'); ctx.globalAlpha = 1; }
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

// ---------- procedural alien worlds ----------

function noise3Factory(seed) {
  const rng = mulberry32(seed | 0);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
  const perm = new Uint8Array(512), vals = new Float32Array(256);
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  for (let i = 0; i < 256; i++) vals[i] = rng();
  const fade = (t) => t * t * (3 - 2 * t);
  const h = (x, y, z) => vals[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const x00 = lerp(h(xi, yi, zi), h(xi + 1, yi, zi), xf), x10 = lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf);
    const x01 = lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), x11 = lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf);
    return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
  };
}

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Pure generator: elevation-based surface, Voronoi provinces, borders. No DOM needed. */
export function genProcWorld(def, seed) {
  const noise = noise3Factory(seed), detail = noise3Factory(seed + 977);
  const rng = mulberry32((seed ^ 0x51ed) | 0);
  const seeds = [];
  for (let i = 0; i < NREG; i++) {           // evenly spread (Fibonacci sphere) with jitter
    const y = clamp(1 - 2 * (i + 0.5) / NREG + (rng() - 0.5) * 0.1, -0.98, 0.98);
    const r = Math.sqrt(1 - y * y), th = i * 2.399963 + (rng() - 0.5) * 0.9;
    seeds.push([r * Math.cos(th), y, r * Math.sin(th)]);
  }
  const N = PW * PH;
  const region = new Uint8Array(N), land = new Uint8Array(N), border = new Uint8Array(N);
  const base = new Uint8ClampedArray(N * 4);
  const landPx = new Float64Array(NREG), regionPx = new Float64Array(NREG), area = new Float64Array(NREG);
  const sum = new Float64Array(NREG * 3);
  let totalLandPx = 0;
  const off = rng() * 50;

  for (let y = 0; y < PH; y++) {
    const lat = (0.5 - (y + 0.5) / PH) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat), latDeg = lat / DEG;
    for (let x = 0; x < PW; x++) {
      const i = y * PW + x, lon = ((x + 0.5) / PW - 0.5) * 2 * Math.PI;
      const vx = cl * Math.cos(lon), vy = sl, vz = -cl * Math.sin(lon);
      let e = 0, amp = 0.5, f = def.freq;
      for (let o = 0; o < 4; o++) { e += amp * noise(vx * f + off, vy * f, vz * f); f *= 2.1; amp *= 0.5; }
      e /= 0.9375;
      let best = 0, bd = -2;
      for (let s = 0; s < NREG; s++) {
        const d = seeds[s][0] * vx + seeds[s][1] * vy + seeds[s][2] * vz;
        if (d > bd) { bd = d; best = s; }
      }
      region[i] = best; regionPx[best]++;
      const polar = Math.abs(latDeg) > 72 + (detail(vx * 3, vy * 3, vz * 3) - 0.5) * 22;
      const dn = 0.82 + 0.36 * detail(vx * 9 + 5, vy * 9, vz * 9);
      let col;
      if (polar) col = def.ice;
      else if (e > def.sea) {
        land[i] = 1; landPx[best]++; totalLandPx++;
        area[best] += cl;
        sum[best * 3] += vx; sum[best * 3 + 1] += vy; sum[best * 3 + 2] += vz;
        col = mix3(def.land[0], def.land[1], clamp((e - def.sea) / (1 - def.sea) * 1.7, 0, 1)).map((c) => c * dn);
      } else col = mix3(def.ocean, def.shallow, Math.pow(clamp(e / def.sea, 0, 1), 3));
      base[i * 4] = col[0]; base[i * 4 + 1] = col[1]; base[i * 4 + 2] = col[2]; base[i * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < PH - 1; y++) for (let x = 0; x < PW; x++) {
    const i = y * PW + x;
    if (land[i] && (region[i] !== region[i + PW] || region[i] !== region[y * PW + ((x + 1) % PW)])) border[i] = 1;
  }
  let totalArea = 0;
  for (let s = 0; s < NREG; s++) totalArea += area[s];
  const regions = seeds.map((sd, s) => {
    let v = sd;
    if (landPx[s] > 0) { const m = Math.hypot(sum[s * 3], sum[s * 3 + 1], sum[s * 3 + 2]) || 1; v = [sum[s * 3] / m, sum[s * 3 + 1] / m, sum[s * 3 + 2] / m]; }
    return {
      c: [Math.atan2(-v[2], v[0]) / DEG, Math.asin(clamp(v[1], -1, 1)) / DEG],
      a: totalArea ? area[s] / totalArea : 0,
      claimable: landPx[s] >= 150 && landPx[s] >= 0.2 * regionPx[s],
      name: def.name + ' ' + (s + 1),
    };
  });
  let home = -1, bestScore = -1;
  regions.forEach((r, i) => {
    if (!r.claimable) return;
    const score = r.a * (Math.abs(r.c[1]) < 50 ? 1 : 0.5);
    if (score > bestScore) { bestScore = score; home = i; }
  });
  if (home < 0) home = 0;
  return { W: PW, H: PH, region, land, border, base, regions, home, landFraction: totalLandPx / N };
}

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function paintProc(world, ctx, claimed, colorHex) {
  const { W, H, region, land, border, base } = world.proc;
  if (!world.img) world.img = ctx.createImageData(W, H);
  const d = world.img.data, [cr, cg, cb] = hexToRgb(colorHex);
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    let r = base[j], g = base[j + 1], b = base[j + 2];
    if (land[i]) {
      const own = claimed[region[i]];
      if (own) { r = r * 0.32 + cr * 0.68; g = g * 0.32 + cg * 0.68; b = b * 0.32 + cb * 0.68; }
      if (border[i]) { const a = own ? 0.5 : 0.2; r = r * (1 - a) + 255 * a; g = g * (1 - a) + 255 * a; b = b * (1 - a) + 255 * a; }
    }
    d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = 255;
  }
  ctx.putImageData(world.img, 0, 0);
}

// ---------- the shared set of worlds ----------

export async function createWorlds({ dataUrl }) {
  const earth = await (await fetch(dataUrl)).json();
  const worlds = WORLD_DEFS.map((def, idx) => {
    const canvas = document.createElement('canvas');
    canvas.width = def.kind === 'earth' ? EARTH_W : PW;
    canvas.height = def.kind === 'earth' ? EARTH_H : PH;
    return { idx, def, name: def.name, owner: def.owner, noun: def.noun, canvas, ctx: canvas.getContext('2d'),
             version: 0, regions: null, home: -1, capital: { lat: 0, lon: 0 }, claimedCount: 0, regionCount: 0,
             share: 0, tier: 0, progress: 0, color: '#ffffff', sig: '', known: idx === 0 ? 2 : 0, civName: def.owner, locked: idx > 0 };
  });
  let wantSeed = null, builtSeed = null, building = false, ready = false, pending = null;
  const api = { worlds, earth, seed: null, onChange: null, isReady: () => ready };

  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  async function build(seed) {
    const w0 = worlds[0];
    w0.regions = earth.countries.map((c) => ({ c: c.c, a: c.a, claimable: !UNCLAIMABLE.has(c.name), name: c.name }));
    w0.home = pickEarthHome(earth, seed);
    w0.capital = { lat: earth.countries[w0.home].c[1], lon: earth.countries[w0.home].c[0] };
    w0.sig = '';
    for (let i = 1; i < worlds.length; i++) {
      await frame();                                   // keep the page responsive while generating
      const w = worlds[i];
      w.proc = genProcWorld(w.def, seed * 7 + i * 131);
      w.regions = w.proc.regions; w.home = w.proc.home; w.img = null; w.sig = '';
      w.capital = { lat: w.regions[w.home].c[1], lon: w.regions[w.home].c[0] };
    }
    for (const w of worlds) w.regionCount = w.regions.filter((r) => r.claimable).length;
  }

  function apply(view) {
    const civs = civsFromView(view);
    let changed = false;
    worlds.forEach((w, i) => {
      const civ = civs[i];
      const claimed = claimRegions(w.regions, w.home, civ.progress);
      w.tier = civ.tier; w.progress = civ.progress; w.color = civ.color;
      w.known = civ.known; w.civName = civ.name; w.locked = i > 0 && !civ.contact;   // fog of war
      const sig = claimed.join('') + civ.color;
      let claimedArea = 0, totalArea = 0, count = 0;
      w.regions.forEach((r, k) => { if (r.claimable) { totalArea += r.a; if (claimed[k]) { claimedArea += r.a; count++; } } });
      w.claimedCount = Math.max(count, 1); w.share = totalArea ? claimedArea / totalArea : 0;
      if (sig !== w.sig) {
        w.sig = sig;
        if (w.def.kind === 'earth') drawEarth(w.ctx, EARTH_W, EARTH_H, earth, claimed, civ.color);
        else paintProc(w, w.ctx, claimed, civ.color);
        w.version++;
        changed = true;
      }
    });
    return changed;
  }

  async function runBuild() {
    if (building) return;
    building = true;
    while (builtSeed !== wantSeed) { const s = wantSeed; await build(s); builtSeed = s; }
    building = false; ready = true; api.seed = builtSeed;
    if (pending) { apply(pending); if (api.onChange) api.onChange(); }
  }

  api.update = (view, seed) => {
    wantSeed = seed; pending = view;
    if (builtSeed !== wantSeed) { ready = false; runBuild(); return false; }
    return apply(view);
  };
  return api;
}
