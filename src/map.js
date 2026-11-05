// 3D galaxy map for Ascension: Type Omega.
// Source file; `tools/build-map.sh` bundles it with three.js into public/map.bundle.js
// so the deployed site needs no CDN (school web filters often block them).

import {
  Scene, PerspectiveCamera, WebGLRenderer, BufferGeometry, BufferAttribute, Points, PointsMaterial,
  AdditiveBlending, Vector3, Group, Mesh, SphereGeometry, MeshBasicMaterial, BackSide, DoubleSide,
  LineLoop, Line, LineBasicMaterial, TorusGeometry, IcosahedronGeometry, RingGeometry, Sprite,
  SpriteMaterial, CanvasTexture, Color, SRGBColorSpace, MeshPhongMaterial, AmbientLight, PointLight,
} from 'three';

export const CIV_COLORS = {
  'You': '#4cc9f0',
  'Vael Collective': '#9b7bff',
  'Orion Hegemony': '#ff8c42',
  'Nyx Syndicate': '#ff4d8d',
  'Aurelian Concord': '#5be37d',
};
const STAR_COUNT = 2600;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- pure helpers (testable without WebGL) ----------

export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic spiral galaxy plus one home position per civilization. */
export function genGalaxy(seed, civCount = 5) {
  const rng = mulberry32((seed >>> 0) || 1);
  const homes = [];
  const base = rng() * Math.PI * 2;
  for (let i = 0; i < civCount; i++) {
    const ang = base + i * (Math.PI * 2 / civCount) + (rng() - 0.5) * 0.5;
    const r = 52 + rng() * 34;
    homes.push([Math.cos(ang) * r, (rng() - 0.5) * 14, Math.sin(ang) * r]);
  }
  const pts = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    if (i < STAR_COUNT * 0.14) {                       // central bulge
      const r = Math.pow(rng(), 0.8) * 22, th = rng() * Math.PI * 2, ph = Math.acos(2 * rng() - 1);
      pts.push(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.55, r * Math.sin(ph) * Math.sin(th));
    } else {                                           // three spiral arms
      const r = 8 + Math.pow(rng(), 0.75) * 135, arm = i % 3;
      const a = arm * 2 * Math.PI / 3 + r * 0.042 + gauss(rng) * 0.32;
      pts.push(Math.cos(a) * r, gauss(rng) * (1.5 + r * 0.025), Math.sin(a) * r);
    }
  }
  for (const h of homes) {                             // local cluster so early territory has systems
    for (let k = 0; k < 70; k++) {
      const r = Math.pow(rng(), 0.7) * 16, th = rng() * Math.PI * 2, ph = Math.acos(2 * rng() - 1);
      pts.push(h[0] + r * Math.sin(ph) * Math.cos(th), h[1] + r * Math.cos(ph) * 0.6, h[2] + r * Math.sin(ph) * Math.sin(th));
    }
  }
  const positions = new Float32Array(pts);
  const shade = new Float32Array(positions.length / 3);
  for (let i = 0; i < shade.length; i++) shade[i] = 0.6 + rng() * 0.4;
  return { positions, homes, shade };
}

export const territoryRadius = (progress) => 9 + 70 * clamp(progress, 0, 1);

/** Each star belongs to the civilization whose territory covers it most deeply. */
export function assignOwners(galaxy, civs) {
  const p = galaxy.positions, n = p.length / 3;
  const owner = new Int8Array(n).fill(-1);
  const counts = new Array(civs.length).fill(0);
  const radii = civs.map((c) => (c.known >= 1 ? territoryRadius(c.progress) : 0));
  for (let i = 0; i < n; i++) {
    let best = -1, bestScore = Infinity;
    for (let c = 0; c < civs.length; c++) {
      const h = galaxy.homes[c];
      const dx = p[i * 3] - h[0], dy = p[i * 3 + 1] - h[1], dz = p[i * 3 + 2] - h[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < radii[c] && d / radii[c] < bestScore) { bestScore = d / radii[c]; best = c; }
    }
    owner[i] = best;
    if (best >= 0) counts[best]++;
  }
  return { owner, counts, radii };
}

/** Fog of war: rivals arrive pre-redacted from the server (known 0 = unseen, 1 = detected, 2 = full intel). */
export function civsFromView(view) {
  const colors = Object.values(CIV_COLORS);
  const list = [{ name: 'You', tier: view.tier.level, progress: view.progress, wps: view.wps, known: 2, contact: true }];
  for (const r of view.rivals) {
    list.push({ name: r.name, tier: r.tier || 0, progress: r.progress || 0, wps: r.wps || 0,
                known: r.known || 0, contact: !!r.contact, ascended: !!r.ascended });
  }
  return list.map((c, i) => ({ ...c, color: colors[i] || '#ffffff' }));
}

// ---------- WebGL map ----------

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(c);
}

export function createGalaxyMap({ container, labelsEl, legendEl, worlds }) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 1, 0.5, 2000);
  const glow = glowTexture();
  const dot = dotTexture();
  const target = new Vector3(), desired = new Vector3();
  let yaw = 0.6, pitch = 1.1, dist = 200, desiredDist = 200;
  let auto = true, dragging = false;

  let seed = null, galaxy = null, civs = [], stars = null, starColors = null;
  let civObjs = [];                       // per-civilization scene objects
  let builtWorldSeed = null, texVersions = [];
  const pulses = [];

  const core = new Sprite(new SpriteMaterial({ map: glow, color: 0xffd9a0, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }));
  core.scale.set(46, 46, 1);
  scene.add(core);
  if (worlds) {                                   // planets are lit by the galactic core
    scene.add(new AmbientLight(0xffffff, 1.2));
    const coreLight = new PointLight(0xffffff, 9000, 0, 2);
    scene.add(coreLight);
  }

  function makeCiv(color, home, world) {
    const col = new Color(color);
    const group = new Group();
    group.position.set(home[0], home[1], home[2]);
    scene.add(group);

    // with worlds: a textured planet + atmosphere; otherwise a plain glowing star
    let star, planet = null, tex = null, atmos = null;
    if (world) {
      tex = new CanvasTexture(world.canvas);
      tex.colorSpace = SRGBColorSpace;
      planet = new Mesh(new SphereGeometry(4.6, 48, 32), new MeshPhongMaterial({ map: tex, shininess: 8, specular: 0x222233 }));
      atmos = new Mesh(new SphereGeometry(5.1, 32, 20), new MeshBasicMaterial({ color: world.def.atmos, transparent: true, opacity: 0.22, side: BackSide, blending: AdditiveBlending, depthWrite: false }));
      star = planet;
    } else {
      star = new Mesh(new SphereGeometry(1.2, 16, 12), new MeshBasicMaterial({ color: col }));
    }
    const halo = new Sprite(new SpriteMaterial({ map: glow, color: col, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending }));
    halo.scale.set(world ? 22 : 16, world ? 22 : 16, 1);
    if (world) halo.material.opacity = 0.5;
    const bubble = new Mesh(new SphereGeometry(1, 32, 20), new MeshBasicMaterial({ color: col, transparent: true, opacity: 0.045, depthWrite: false, side: BackSide }));
    const circlePts = [];
    for (let i = 0; i < 96; i++) { const a = i / 96 * Math.PI * 2; circlePts.push(new Vector3(Math.cos(a), 0, Math.sin(a))); }
    const boundary = new LineLoop(new BufferGeometry().setFromPoints(circlePts), new LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 }));

    const mk = (geo, opts) => new Mesh(geo, new MeshBasicMaterial({ color: col, ...opts }));
    const ring = mk(new TorusGeometry(2.8, 0.07, 8, 64), {});
    ring.rotation.x = Math.PI / 2.4;
    const dyson = mk(new IcosahedronGeometry(4.6, 1), { wireframe: true, transparent: true, opacity: world ? 0.3 : 0.6 });
    const disk = mk(new RingGeometry(6, 10.5, 64), { transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
    disk.rotation.x = -Math.PI / 2 + 0.25;
    const shell = mk(new SphereGeometry(15, 24, 16), { wireframe: true, transparent: true, opacity: 0.1 });
    const lat1 = mk(new TorusGeometry(19, 0.14, 6, 96), { transparent: true, opacity: 0.8 });
    const lat2 = mk(new TorusGeometry(19, 0.14, 6, 96), { transparent: true, opacity: 0.8 });
    lat2.rotation.x = Math.PI / 2;
    const decor = new Group();
    decor.add(ring, dyson, disk, shell, lat1, lat2);
    if (world) decor.scale.setScalar(1.7);
    // an unreached rival is only a glowing beacon; its planet appears once you have been there
    const beacon = world ? new Mesh(new SphereGeometry(1.2, 16, 12), new MeshBasicMaterial({ color: col })) : null;
    group.add(star, halo, decor);
    if (atmos) group.add(atmos);
    if (beacon) group.add(beacon);

    bubble.position.copy(group.position);
    boundary.position.copy(group.position);
    scene.add(bubble, boundary);
    bubble.scale.setScalar(1); boundary.scale.setScalar(1);
    return { group, bubble, boundary, ring, dyson, disk, shell, lat1, lat2, planet, atmos, beacon, decor, halo, tex, world, shown: false, radius: 9, targetRadius: 9, tier: 0, color: col };
  }

  function clearWorld() {
    for (const o of civObjs) {
      for (const obj of [o.group, o.bubble, o.boundary]) scene.remove(obj);
    }
    civObjs = [];
    if (stars) { scene.remove(stars); stars.geometry.dispose(); stars = null; }
    for (const p of pulses.splice(0)) { scene.remove(p.line); scene.remove(p.ball); }
  }

  function build(newSeed) {
    clearWorld();
    seed = newSeed;
    galaxy = genGalaxy(seed, 5);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(galaxy.positions, 3));
    starColors = new Float32Array(galaxy.positions.length);
    geo.setAttribute('color', new BufferAttribute(starColors, 3));
    stars = new Points(geo, new PointsMaterial({ size: 2.4, map: dot, alphaTest: 0.02, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }));
    scene.add(stars);
    civObjs = galaxy.homes.map((h, i) => makeCiv(Object.values(CIV_COLORS)[i], h, worlds ? worlds.worlds[i] : null));
    builtWorldSeed = worlds ? worlds.seed : null;
    texVersions = civObjs.map(() => -1);
    labelsEl.innerHTML = '';
    civObjs.forEach((o, i) => {
      const el = document.createElement('div');
      el.className = 'maplabel';
      o.label = el;
      labelsEl.appendChild(el);
    });
    desired.set(0, 0, 0); target.set(0, 0, 0);
    dist = desiredDist = 200;
  }

  function update(view, newSeed) {
    if (!view) return;
    if (worlds && !worlds.isReady()) return;
    if (galaxy === null || seed !== newSeed || (worlds && builtWorldSeed !== worlds.seed)) build(newSeed);
    civObjs.forEach((o, i) => {
      if (o.tex && texVersions[i] !== o.world.version) { texVersions[i] = o.world.version; o.tex.needsUpdate = true; }
    });
    civs = civsFromView(view);
    const { owner, counts, radii } = assignOwners(galaxy, civs);
    const dim = [0.28, 0.34, 0.5];
    for (let i = 0; i < owner.length; i++) {
      const s = galaxy.shade[i];
      const c = owner[i] >= 0 ? civObjs[owner[i]].color : null;
      starColors[i * 3] = c ? c.r * (0.6 + 0.5 * s) : dim[0] * s;
      starColors[i * 3 + 1] = c ? c.g * (0.6 + 0.5 * s) : dim[1] * s;
      starColors[i * 3 + 2] = c ? c.b * (0.6 + 0.5 * s) : dim[2] * s;
    }
    stars.geometry.attributes.color.needsUpdate = true;

    civs.forEach((civ, i) => {
      const o = civObjs[i];
      o.targetRadius = radii[i];
      o.tier = civ.tier;
      o.shown = civ.known >= 1;
      o.group.visible = o.bubble.visible = o.boundary.visible = o.shown;
      const reached = !o.world || civ.contact;
      if (o.planet) {
        o.planet.visible = o.atmos.visible = reached;
        o.beacon.visible = !reached;
        o.decor.scale.setScalar(reached ? 1.7 : 1);
      }
      o.ring.visible = civ.tier >= 1;
      o.dyson.visible = civ.tier >= 2;
      o.disk.visible = civ.tier >= 3;
      o.shell.visible = civ.tier >= 4;
      o.lat1.visible = o.lat2.visible = civ.tier >= 5;
      o.label.textContent = (o.world && civ.contact ? o.world.name + ' · ' : '') + civ.name + ' · T' + civ.tier + (civ.contact ? '' : ' · unreached');
      o.label.style.color = civ.color;
      o.label.style.borderColor = civ.color;
    });

    const total = owner.length;
    legendEl.innerHTML = '';
    civs.forEach((civ, i) => {
      const row = document.createElement('div');
      row.className = 'lg';
      row.dataset.idx = String(i);
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = civ.known >= 1 ? civ.color : '#556';
      const txt = document.createElement('span');
      if (civ.known < 1) {
        row.classList.add('locked');
        txt.textContent = 'Unknown signal — undetected';
      } else {
        const nm = civObjs[i].world && civ.contact ? civObjs[i].world.name + ' (' + civ.name + ')' : civ.name;
        txt.textContent = nm + ' — Tier ' + civ.tier + ' · ' + counts[i] + ' systems (' + (counts[i] / total * 100).toFixed(0) + '%)' + (civ.contact ? '' : ' · unreached');
        row.addEventListener('click', () => focus(i));
      }
      row.append(sw, txt);
      legendEl.appendChild(row);
    });
    return counts;
  }

  function focus(i) {
    if (i < 0 || !galaxy) { desired.set(0, 0, 0); desiredDist = 200; return; }
    if (civs[i] && civs[i].known < 1) return;
    const h = galaxy.homes[i];
    desired.set(h[0], h[1], h[2]);
    desiredDist = worlds ? 42 : 95;
  }

  function pulse(fromName, toName, colorHex) {
    if (!galaxy || pulses.length >= 6) return;
    const a = civs.findIndex((c) => c.name === fromName), b = civs.findIndex((c) => c.name === toName);
    if (a < 0 || b < 0) return;
    const A = new Vector3(...galaxy.homes[a]), B = new Vector3(...galaxy.homes[b]);
    const col = new Color(colorHex);
    const line = new Line(new BufferGeometry().setFromPoints([A, B]), new LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 }));
    const ball = new Mesh(new SphereGeometry(1.3, 10, 8), new MeshBasicMaterial({ color: col }));
    scene.add(line, ball);
    pulses.push({ line, ball, A, B, t: 0, dur: 1.5 });
  }

  function handleLog(raw) {
    const text = raw.replace(/^\[t\d+\]\s*/, '');
    const m = text.match(/(Vael Collective|Orion Hegemony|Nyx Syndicate|Aurelian Concord)/);
    if (!m) return;
    const rival = m[1];
    if (/ESPIONAGE|CYBER ATTACK|BLOCKADE/.test(text)) pulse(rival, 'You', CIV_COLORS[rival]);
    else if (/trade pact/.test(text)) pulse(rival, 'You', '#5be37d');
    else if (/foiled/.test(text)) pulse(rival, 'You', '#8899aa');
  }

  // ---- controls: drag to orbit, wheel/pinch to zoom ----
  const el = renderer.domElement;
  const pointers = new Map();
  let pinch = 0;
  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
      if (pinch) desiredDist = clamp(desiredDist * (pinch / d), 35, 420);
      pinch = d;
    } else {
      yaw -= (e.clientX - prev[0]) * 0.006;
      pitch = clamp(pitch + (e.clientY - prev[1]) * 0.006, 0.2, Math.PI - 0.2);
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (pointers.size === 0) { dragging = false; el.style.cursor = 'grab'; }
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    desiredDist = clamp(desiredDist * Math.exp(e.deltaY * 0.001), 35, 420);
  }, { passive: false });
  el.style.cursor = 'grab';

  function resize() {
    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const tmp = new Vector3();
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (auto && !dragging) yaw += dt * 0.05;
    const k = 1 - Math.exp(-dt * 4);
    target.lerp(desired, k);
    dist += (desiredDist - dist) * k;

    for (const o of civObjs) {
      o.radius += (o.targetRadius - o.radius) * (1 - Math.exp(-dt * 2));
      o.bubble.scale.setScalar(o.radius);
      o.boundary.scale.setScalar(o.radius);
      if (o.planet) o.planet.rotation.y += dt * 0.25;
      o.dyson.rotation.y += dt * 0.5;
      o.dyson.rotation.x += dt * 0.2;
      o.disk.rotation.z += dt * 0.4;
      o.ring.rotation.z += dt * 0.8;
      o.lat1.rotation.z += dt * 0.15;
      o.lat2.rotation.y += dt * 0.15;
      if (o.tier >= 5) o.shell.rotation.y -= dt * 0.1;
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.t += dt;
      const u = p.t / p.dur;
      if (u >= 1) {
        scene.remove(p.line); scene.remove(p.ball);
        p.line.geometry.dispose();
        pulses.splice(i, 1);
        continue;
      }
      p.ball.position.lerpVectors(p.A, p.B, u);
      p.ball.position.y += Math.sin(Math.PI * u) * 10;
      p.line.material.opacity = 0.6 * (1 - u);
    }

    camera.position.set(
      target.x + dist * Math.sin(pitch) * Math.cos(yaw),
      target.y + dist * Math.cos(pitch),
      target.z + dist * Math.sin(pitch) * Math.sin(yaw));
    camera.lookAt(target);
    if (container.offsetParent !== null) renderer.render(scene, camera);

    const w = container.clientWidth, h = container.clientHeight;
    civObjs.forEach((o) => {
      if (!o.label) return;
      tmp.copy(o.group.position).project(camera);
      const visible = tmp.z < 1 && o.shown;
      o.label.style.display = visible ? 'block' : 'none';
      o.label.style.left = ((tmp.x * 0.5 + 0.5) * w) + 'px';
      o.label.style.top = ((-tmp.y * 0.5 + 0.5) * h) + 'px';
    });
  }
  requestAnimationFrame(frame);

  return {
    update, handleLog, pulse, focus,
    toggleAuto() { auto = !auto; return auto; },
    stats() { return { seed, civs: civs.map((c) => c.name), stars: galaxy ? galaxy.positions.length / 3 : 0 }; },
  };
}
