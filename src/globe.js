// World viewer for Ascension: Type Omega.
// Shows one civilization's 3D planet at a time (Earth for you, a procedural alien world for
// each rival). Click a legend row to hop between worlds. Bundled with three.js into public/map.bundle.js.

import {
  Scene, PerspectiveCamera, WebGLRenderer, Mesh, SphereGeometry, MeshPhongMaterial, MeshBasicMaterial,
  CanvasTexture, SRGBColorSpace, AmbientLight, DirectionalLight, BackSide, DoubleSide, AdditiveBlending,
  Vector3, Group, TorusGeometry, RingGeometry, IcosahedronGeometry, Sprite, SpriteMaterial, Color,
  BufferGeometry, BufferAttribute, Points, PointsMaterial, Line, LineBasicMaterial,
} from 'three';
import { CIV_COLORS, mulberry32 } from './map.js';
import { latLonToXYZ } from './worlds.js';

const R = 50;                                 // globe radius in scene units
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DIST_MIN = R * 1.45, DIST_MAX = R * 5, DIST_START = R * 2.7;

function radialTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, a]) => gr.addColorStop(o, 'rgba(255,255,255,' + a + ')'));
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return new CanvasTexture(c);
}

export function createGlobeMap({ container, labelsEl, legendEl, worlds }) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 1, 3000);
  const glow = radialTexture(64, [[0, 1], [0.25, 0.55], [1, 0]]);
  const dot = radialTexture(32, [[0, 1], [0.45, 0.9], [1, 0]]);

  const globeMat = new MeshPhongMaterial({ shininess: 6, specular: 0x223344 });
  const globe = new Mesh(new SphereGeometry(R, 96, 64), globeMat);
  scene.add(globe);
  const atmoMat = new MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.16, side: BackSide, blending: AdditiveBlending, depthWrite: false });
  scene.add(new Mesh(new SphereGeometry(R * 1.035, 64, 48), atmoMat));
  scene.add(new AmbientLight(0xffffff, 1.15));
  const sun = new DirectionalLight(0xffffff, 1.1);
  scene.add(sun);

  const rng = mulberry32(7);
  const sp = new Float32Array(1400 * 3);
  for (let i = 0; i < 1400; i++) {
    const u = rng() * 2 - 1, t = rng() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    sp[i * 3] = 900 * s * Math.cos(t); sp[i * 3 + 1] = 900 * u; sp[i * 3 + 2] = 900 * s * Math.sin(t);
  }
  const sg = new BufferGeometry();
  sg.setAttribute('position', new BufferAttribute(sp, 3));
  scene.add(new Points(sg, new PointsMaterial({ size: 3, map: dot, color: 0xaec4ff, transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: false })));

  let yaw = 0, pitch = 1.2, dist = DIST_START, desiredDist = DIST_START;
  let desiredYaw = null, desiredPitch = null;
  let auto = true, dragging = false;
  let sel = 0, seed = null;
  let texs = [], texVersion = [], structs = [], marker = null, labelEl = null, top = new Vector3(0, R * 1.14, 0);
  const pulses = [];

  function faceVector(v, instant) {
    const len = Math.hypot(v[0], v[1], v[2]);
    const ty = Math.atan2(v[2], v[0]), tp = clamp(Math.acos(v[1] / len), 0.25, Math.PI - 0.25);
    if (instant) { yaw = ty; pitch = tp; desiredYaw = desiredPitch = null; return; }
    const dy = ((ty - yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    desiredYaw = yaw + dy; desiredPitch = tp;
  }

  function clearAll() {
    if (marker) scene.remove(marker);
    marker = null;
    for (const s of structs) scene.remove(s.orbit);
    structs = [];
    for (const t of texs) t.dispose();
    texs = []; texVersion = [];
    for (const p of pulses.splice(0)) { scene.remove(p.line); scene.remove(p.ball); }
  }

  /** Orbital structures (per civilization, shown only for the selected world). */
  function makeStruct(idx, colorHex) {
    const col = new Color(colorHex);
    const orbit = new Group();
    const rr = R * (1.17 + 0.05 * idx), tiltX = 0.5 + idx * 0.62, tiltZ = idx * 0.9;
    const basic = (geo, opts) => new Mesh(geo, new MeshBasicMaterial({ color: col, ...opts }));
    const ring = basic(new TorusGeometry(rr, 0.12, 8, 160), {});
    ring.rotation.set(tiltX, 0, tiltZ);
    const disk = basic(new RingGeometry(rr * 1.04, rr * 1.16, 128), { transparent: true, opacity: 0.14, side: DoubleSide, depthWrite: false, blending: AdditiveBlending });
    disk.rotation.set(tiltX, 0, tiltZ);
    const r2 = mulberry32(idx + 11), pts = new Float32Array(240 * 3);
    for (let k = 0; k < 240; k++) {
      const u = r2() * 2 - 1, t = r2() * Math.PI * 2, s = Math.sqrt(1 - u * u), rad = rr * (0.98 + r2() * 0.05);
      pts[k * 3] = rad * s * Math.cos(t); pts[k * 3 + 1] = rad * u; pts[k * 3 + 2] = rad * s * Math.sin(t);
    }
    const swGeo = new BufferGeometry();
    swGeo.setAttribute('position', new BufferAttribute(pts, 3));
    const swarm = new Points(swGeo, new PointsMaterial({ color: col, size: 1.5, map: dot, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    const shell = basic(new IcosahedronGeometry(R * (1.8 + 0.06 * idx), 2), { wireframe: true, transparent: true, opacity: 0.08 });
    const lat1 = basic(new TorusGeometry(R * (2.2 + 0.06 * idx), 0.12, 6, 128), { transparent: true, opacity: 0.8 });
    const lat2 = basic(new TorusGeometry(R * (2.2 + 0.06 * idx), 0.12, 6, 128), { transparent: true, opacity: 0.8 });
    lat1.rotation.x = Math.PI / 2 + idx * 0.2; lat2.rotation.y = Math.PI / 2 + idx * 0.2;
    orbit.add(ring, disk, swarm, shell, lat1, lat2);
    orbit.visible = false;
    scene.add(orbit);
    return { orbit, ring, disk, swarm, shell, lat1, lat2 };
  }

  function makeMarker(w) {
    if (marker) scene.remove(marker);
    const col = new Color(w.color);
    const cap = latLonToXYZ(w.capital.lat, w.capital.lon, R * 1.004);
    top = new Vector3(...latLonToXYZ(w.capital.lat, w.capital.lon, R * 1.14));
    marker = new Group();
    const halo = new Sprite(new SpriteMaterial({ map: glow, color: col, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending }));
    halo.scale.set(9, 9, 1);
    halo.position.set(...cap);
    const pin = new Mesh(new SphereGeometry(0.9, 12, 10), new MeshBasicMaterial({ color: col }));
    pin.position.set(...cap);
    const beam = new Line(new BufferGeometry().setFromPoints([new Vector3(...cap), top.clone()]), new LineBasicMaterial({ color: col }));
    marker.add(halo, pin, beam);
    scene.add(marker);
    marker.userData.cap = new Vector3(...cap);
  }

  function build() {
    clearAll();
    seed = worlds.seed;
    texs = worlds.worlds.map((w) => {
      const t = new CanvasTexture(w.canvas);
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return t;
    });
    texVersion = worlds.worlds.map(() => -1);
    structs = worlds.worlds.map((w, i) => makeStruct(i, CIV_COLORS[w.owner === 'You' ? 'You' : w.owner] || '#ffffff'));
    labelsEl.innerHTML = '';
    labelEl = document.createElement('div');
    labelEl.className = 'maplabel';
    labelsEl.appendChild(labelEl);
    select(sel, true);
  }

  function select(i, instant) {
    sel = clamp(i, 0, worlds.worlds.length - 1);
    if (worlds.worlds[sel].locked) sel = 0;
    const w = worlds.worlds[sel];
    globeMat.map = texs[sel];
    globeMat.needsUpdate = true;
    atmoMat.color.setHex(w.def.atmos);
    structs.forEach((s, k) => { s.orbit.visible = k === sel && w.tier >= 1; });
    makeMarker(w);
    faceVector(latLonToXYZ(w.capital.lat, w.capital.lon), !!instant);
    desiredDist = DIST_START;
    if (instant) dist = DIST_START;
    renderLegend();
  }

  function renderLegend() {
    legendEl.innerHTML = '';
    worlds.worlds.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'lg' + (i === sel ? ' sel' : '') + (w.locked ? ' locked' : '');
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = w.locked ? '#556' : w.color;
      const txt = document.createElement('span');
      if (w.locked) {
        txt.textContent = w.known >= 1 ? '🔒 ' + w.civName + ' — detected, but their world is out of reach (send an expedition)' : '🔒 Unknown world — undetected';
      } else {
        txt.textContent = w.name + ' (' + w.civName + ') — T' + w.tier + ' · ' + w.claimedCount + '/' + w.regionCount + ' ' + w.noun + ' (' + (w.share * 100).toFixed(0) + '% of land)';
        row.addEventListener('click', () => select(i, false));
      }
      row.append(sw, txt);
      legendEl.appendChild(row);
    });
  }

  function update() {
    if (!worlds.isReady()) return;
    if (seed !== worlds.seed || !texs.length) { build(); return; }
    let sig = '';
    worlds.worlds.forEach((w, i) => {
      if (texVersion[i] !== w.version) { texVersion[i] = w.version; texs[i].needsUpdate = true; }
      sig += w.tier + ':' + w.claimedCount + ':' + w.color + ':' + w.locked + ':' + w.known + ';';
    });
    if (worlds.worlds[sel].locked) { select(0, false); return; }
    const w = worlds.worlds[sel];
    structs.forEach((s, k) => {
      s.orbit.visible = k === sel && w.tier >= 1;
      if (k === sel) {
        s.ring.visible = w.tier >= 1; s.swarm.visible = w.tier >= 2; s.disk.visible = w.tier >= 3;
        s.shell.visible = w.tier >= 4; s.lat1.visible = s.lat2.visible = w.tier >= 5;
      }
    });
    if (update.sig !== sig) { update.sig = sig; renderLegend(); }
  }

  function focus(i) { select(i < 0 ? 0 : i, false); }

  // Incoming attacks only make sense on your own world: beam arrives from the rival's direction.
  const RIVAL_DIR = {
    'Vael Collective': [0.6, 0.5, 0.62], 'Orion Hegemony': [-0.7, 0.3, 0.64],
    'Nyx Syndicate': [0.1, -0.6, -0.79], 'Aurelian Concord': [-0.5, 0.6, -0.62],
  };
  function pulse(fromName, toName, colorHex) {
    if (sel !== 0 || !marker || pulses.length >= 6) return;
    const d = RIVAL_DIR[fromName];
    if (!d || toName !== 'You') return;
    const A = new Vector3(...d).normalize().multiplyScalar(R * 4.5), B = marker.userData.cap.clone();
    const pts = [];
    for (let k = 0; k <= 40; k++) pts.push(A.clone().lerp(B, k / 40));
    const col = new Color(colorHex);
    const line = new Line(new BufferGeometry().setFromPoints(pts), new LineBasicMaterial({ color: col, transparent: true, opacity: 0.7 }));
    const ball = new Mesh(new SphereGeometry(1.1, 10, 8), new MeshBasicMaterial({ color: col }));
    scene.add(line, ball);
    pulses.push({ line, ball, pts, t: 0, dur: 1.6 });
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

  // ---- controls ----
  const el = renderer.domElement;
  const pointers = new Map();
  let pinch = 0;
  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    dragging = true; desiredYaw = desiredPitch = null;
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
      if (pinch) desiredDist = clamp(desiredDist * (pinch / d), DIST_MIN, DIST_MAX);
      pinch = d;
    } else {
      const k = 0.0045 * (dist / (R * 3));
      yaw -= (e.clientX - prev[0]) * k;
      pitch = clamp(pitch - (e.clientY - prev[1]) * k, 0.15, Math.PI - 0.15);
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId); pinch = 0;
    if (pointers.size === 0) { dragging = false; el.style.cursor = 'grab'; }
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    desiredDist = clamp(desiredDist * Math.exp(e.deltaY * 0.001), DIST_MIN, DIST_MAX);
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

  const tmp = new Vector3(), camDir = new Vector3();
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = 1 - Math.exp(-dt * 4);
    if (desiredYaw !== null) {
      yaw += (desiredYaw - yaw) * k; pitch += (desiredPitch - pitch) * k;
      if (Math.abs(desiredYaw - yaw) < 0.005 && Math.abs(desiredPitch - pitch) < 0.005) desiredYaw = desiredPitch = null;
    } else if (auto && !dragging) {
      yaw += dt * 0.07;
    }
    dist += (desiredDist - dist) * k;

    const s = structs[sel];
    if (s) {
      s.orbit.rotation.y += dt * 0.05;
      s.ring.rotation.z += dt * 0.1;
      s.swarm.rotation.y += dt * 0.35;
      s.lat1.rotation.z += dt * 0.12;
      s.lat2.rotation.x += dt * 0.12;
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.t += dt;
      const u = p.t / p.dur;
      if (u >= 1) { scene.remove(p.line); scene.remove(p.ball); p.line.geometry.dispose(); pulses.splice(i, 1); continue; }
      p.ball.position.copy(p.pts[Math.min(40, Math.floor(u * 40))]);
      p.line.material.opacity = 0.7 * (1 - u);
    }

    camera.position.set(dist * Math.sin(pitch) * Math.cos(yaw), dist * Math.cos(pitch), dist * Math.sin(pitch) * Math.sin(yaw));
    camera.lookAt(0, 0, 0);
    sun.position.copy(camera.position).add(new Vector3(60, 80, 40));
    if (container.offsetParent !== null && texs.length) renderer.render(scene, camera);

    if (labelEl && texs.length) {
      const w = worlds.worlds[sel];
      camDir.copy(camera.position).normalize();
      const facing = top.clone().normalize().dot(camDir) > 0.12;
      tmp.copy(top).project(camera);
      const cw = container.clientWidth, ch = container.clientHeight;
      labelEl.textContent = w.owner + ' · ' + w.name + ' · T' + w.tier;
      labelEl.style.color = w.color;
      labelEl.style.borderColor = w.color;
      labelEl.style.display = facing ? 'block' : 'none';
      labelEl.style.left = ((tmp.x * 0.5 + 0.5) * cw) + 'px';
      labelEl.style.top = ((-tmp.y * 0.5 + 0.5) * ch) + 'px';
    }
  }
  requestAnimationFrame(frame);

  return {
    update, handleLog, pulse, focus,
    toggleAuto() { auto = !auto; return auto; },
    stats() { return { seed, selected: sel, worlds: worlds.worlds.map((w) => w.name) }; },
  };
}
