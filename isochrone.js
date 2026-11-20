/* ================================================================
   TripBlend – Elérhetőség (izokron térkép)
   Egy kiindulópontból (vagy egy célpontba érkezve) mi érhető el X perc alatt.

   Adat: Transitous one-to-all (api.transitous.org/api/v6/one-to-all): az elért megállók
   és a hozzájuk tartozó menetidő (perc). Rajz: minden megálló körül egy kör, amekkorát a
   maradék időből (legfeljebb ISO_MAX_WALK_MIN perc) gyalog meg lehet tenni. A sávokat egy
   vásznon (canvas) rajzoljuk Web Mercator koordinátákban, a legtávolabbitól a legközelebbi
   felé, így minden pont a legkisebb sávja színét kapja; a vászon raszterrétegként kerül a
   térképre a feliratok alá.
   ================================================================ */

const TS_ONE_TO_ALL_URL = "https://api.transitous.org/api/v6/one-to-all";
const ISO_WALK_MPS = 1.2;        // kb. 4,3 km/h
const ISO_MAX_WALK_MIN = 15;     // egy megállótól legfeljebb ennyi perc séta
const ISO_CANVAS_MAX_PX = 2048;
const ISO_SOURCE = "iso-source";
const ISO_LAYER = "iso-layer";
/** Közeli (zöld) -> távoli (piros) sávszínek. */
const ISO_COLORS = ["#1a9850", "#66bd63", "#a6d96a", "#d9ef8b", "#fee08b", "#fdae61", "#f46d43", "#d73027"];

let isoData = null;
let isoOriginMarker = null;
let isoPopup = null;

const isoMinutesSlider = document.getElementById("iso-minutes");
const isoBubble = document.getElementById("slider-bubble-iso");

function updateIsoBubble() {
  if (!isoMinutesSlider || !isoBubble) return;
  const val = +isoMinutesSlider.value;
  const min = +isoMinutesSlider.min, max = +isoMinutesSlider.max;
  const pct = (val - min) / (max - min);
  isoBubble.textContent = `${val} perc`;
  isoBubble.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * 16}px)`;
}
isoMinutesSlider?.addEventListener("input", updateIsoBubble);
updateIsoBubble();

function isIsoView() {
  return document.body.classList.contains("view-iso");
}

/** Irány az Elérhetőség nézetben: "Innen indulok" (depart) vagy "Ide érkezem" (arrive). */
function isIsoArrive() {
  return document.querySelector('input[name="iso-direction"]:checked')?.value === "arrive";
}

function setIsoDirection(dir) {
  const r = document.querySelector(`input[name="iso-direction"][value="${dir}"]`);
  if (r) r.checked = true;
  updateIsoLabels();
}

function updateIsoLabels() {
  const lbl = document.getElementById("origin-label");
  if (!lbl) return;
  lbl.textContent = !isIsoView() ? "Indulás" : isIsoArrive() ? "Hová érkezel" : "Honnan indulsz";
  if (isIsoView()) {
    const now = timeModeSelect.querySelector('option[value="now"]');
    const at = timeModeSelect.querySelector('option[value="depart"]');
    if (now) now.textContent = "Most";
    if (at) at.textContent = isIsoArrive() ? "Érkezés időpontja" : "Indulás időpontja";
  }
}
document.querySelectorAll('input[name="iso-direction"]').forEach((r) => {
  r.addEventListener("change", updateIsoLabels);
});

/**
 * Az időpont-választó az Elérhetőség nézetben csak két lehetőséget ad ("most" / megadott időpont);
 * az irányt a fenti kapcsoló adja. Az Útvonal nézet eredeti listáját visszaállítjuk.
 */
let routeTimeOptionsHtml = null;
function applyIsoTimeOptions(iso) {
  const sel = timeModeSelect;
  const prev = sel.value;
  if (iso) {
    if (routeTimeOptionsHtml == null) routeTimeOptionsHtml = sel.innerHTML;
    sel.innerHTML = '<option value="now">Most</option><option value="depart">Időpont</option>';
    if (prev === "arrive") setIsoDirection("arrive");
    else if (prev === "depart") setIsoDirection("depart");
    sel.value = prev === "depart" || prev === "arrive" ? "depart" : "now";
  } else if (routeTimeOptionsHtml != null) {
    const wasArrive = isIsoArrive();
    sel.innerHTML = routeTimeOptionsHtml;
    sel.value = prev === "depart" ? (wasArrive ? "arrive" : "depart") : "now";
  }
  sel.dispatchEvent(new Event("change"));
}

function setView(view) {
  if (isIsoView() !== (view === "iso")) {
    document.body.classList.toggle("view-iso", view === "iso");
    applyIsoTimeOptions(view === "iso");
  }
  document.querySelectorAll(".view-tab").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  updateIsoLabels();
  planBtn.textContent = planBtnLabel();
  clearUI();
  if (view === "iso") clearRoute();
  else clearIso();
  updatePickMarkers();
}

document.querySelectorAll(".view-tab").forEach((b) => {
  b.addEventListener("click", () => setView(b.dataset.view));
});

function clearIso() {
  try { if (map.getLayer(ISO_LAYER)) map.removeLayer(ISO_LAYER); } catch { /* */ }
  try { if (map.getSource(ISO_SOURCE)) map.removeSource(ISO_SOURCE); } catch { /* */ }
  isoOriginMarker?.remove();
  isoOriginMarker = null;
  isoPopup?.remove();
  isoPopup = null;
  isoData = null;
}

/** Sávhatárok percben, pl. 45 -> [10, 20, 30, 40, 45]. */
function isoBands(T) {
  const step = T <= 20 ? 5 : T <= 60 ? 10 : T <= 90 ? 15 : 20;
  const out = [];
  for (let b = step; b < T; b += step) out.push(b);
  out.push(T);
  return out;
}

function isoColor(i, n) {
  if (n <= 1) return ISO_COLORS[0];
  return ISO_COLORS[Math.round((i * (ISO_COLORS.length - 1)) / (n - 1))];
}

/**
 * Idő a one-to-all kéréshez. Megadott időpont: indulás (Innen indulok) vagy érkezés (Ide érkezem).
 * "Most" + Ide érkezem: érkezés legkésőbb most + a max. utazási idő (vagyis ha most elindulnál).
 * @returns {{ params: object, refMs: number }}  refMs: az indulás / érkezés időpontja (jelmagyarázathoz)
 */
function isoTimeParams(T) {
  const arrive = isIsoArrive();
  if (timeModeSelect.value === "depart") {
    const date = planningDateStr();
    const t = /^\d{2}:\d{2}$/.test(timePick.value || "") ? timePick.value : "08:00";
    const iso = tsIso(date, t);
    return { params: { time: iso, arriveBy: arrive ? "true" : "false" }, refMs: Date.parse(iso) };
  }
  if (!arrive) return { params: {}, refMs: Date.now() };
  const refMs = Date.now() + T * 60000;
  return { params: { time: new Date(refMs).toISOString(), arriveBy: "true" }, refMs };
}

async function tsFetchOneToAll(place, params, timeParams) {
  const q = new URLSearchParams({ one: `${place.lat},${place.lon}`, ...timeParams });
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TS_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${TS_ONE_TO_ALL_URL}?${q}`, { signal: ctrl.signal });
  } catch (e) {
    throw new Error(
      e.name === "AbortError"
        ? "A Transitous nem válaszolt időben, próbáld újra."
        : "Nem sikerült elérni a Transitous szervert (nincs internet?).",
    );
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* nem JSON */ }
  if (!res.ok || data?.error) throw new Error(`Transitous hiba: ${data?.error || res.status}`);
  return data;
}

const ISO_R = 6378137;
const isoMx = (lon) => (ISO_R * lon * Math.PI) / 180;
const isoMy = (lat) => ISO_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const isoLon = (x) => ((x / ISO_R) * 180) / Math.PI;
const isoLat = (y) => ((2 * Math.atan(Math.exp(y / ISO_R)) - Math.PI / 2) * 180) / Math.PI;
const isoWalkM = (min) => Math.min(min, ISO_MAX_WALK_MIN) * 60 * ISO_WALK_MPS;

function drawIso() {
  const { stops, T, bands, origin, arriveBy } = isoData;
  try { if (map.getLayer(ISO_LAYER)) map.removeLayer(ISO_LAYER); } catch { /* */ }
  try { if (map.getSource(ISO_SOURCE)) map.removeSource(ISO_SOURCE); } catch { /* */ }

  /** Befoglaló téglalap Mercatorban, a legnagyobb sétakörrel együtt. */
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of stops) {
    const r = isoWalkM(T - s.d) / Math.cos((s.lat * Math.PI) / 180);
    const x = isoMx(s.lon), y = isoMy(s.lat);
    x1 = Math.min(x1, x - r); x2 = Math.max(x2, x + r);
    y1 = Math.min(y1, y - r); y2 = Math.max(y2, y + r);
  }
  const scale = ISO_CANVAS_MAX_PX / Math.max(x2 - x1, y2 - y1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil((x2 - x1) * scale));
  canvas.height = Math.max(1, Math.ceil((y2 - y1) * scale));
  const ctx = canvas.getContext("2d");

  for (let bi = bands.length - 1; bi >= 0; bi--) {
    const B = bands[bi];
    ctx.fillStyle = isoColor(bi, bands.length);
    ctx.beginPath();
    for (const s of stops) {
      if (s.d >= B) continue;
      const rp = (isoWalkM(B - s.d) / Math.cos((s.lat * Math.PI) / 180)) * scale;
      if (rp < 0.6) continue;
      const px = (isoMx(s.lon) - x1) * scale;
      const py = (y2 - isoMy(s.lat)) * scale;
      ctx.moveTo(px + rp, py);
      ctx.arc(px, py, rp, 0, 2 * Math.PI);
    }
    ctx.fill();
  }

  const coordinates = [
    [isoLon(x1), isoLat(y2)],
    [isoLon(x2), isoLat(y2)],
    [isoLon(x2), isoLat(y1)],
    [isoLon(x1), isoLat(y1)],
  ];
  map.addSource(ISO_SOURCE, { type: "canvas", canvas, coordinates, animate: false });
  const beforeId = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: ISO_LAYER,
      type: "raster",
      source: ISO_SOURCE,
      paint: { "raster-opacity": 0.5, "raster-fade-duration": 0 },
    },
    beforeId,
  );

  isoOriginMarker?.remove();
  const el = mkEl(arriveBy ? "#6366f1" : "#22c55e", 18, arriveBy ? "rgba(99,102,241,0.4)" : "rgba(34,197,94,0.4)");
  isoOriginMarker = new maplibregl.Marker({ element: el })
    .setLngLat([origin.lon, origin.lat])
    .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(
      `<b>${mi(arriveBy ? "sports_score" : "flag")} ${arriveBy ? "Ide érkezel" : "Innen indulsz"}</b>`,
    ))
    .addTo(map);

  collapseAttribOnNarrow();
  map.fitBounds(
    [[isoLon(x1), isoLat(y1)], [isoLon(x2), isoLat(y2)]],
    { padding: mapPadding(), maxZoom: 14 },
  );
}

function renderIsoLegend(note) {
  const { stops, T, bands, arriveBy, refMs, atTime } = isoData;
  const nStops = stops.length - 1; // a kiindulópont nem megálló
  const ref = new Date(refMs);
  const sameDay = localDateStr(ref) === localDateStr(new Date());
  const when = `${sameDay ? "" : `${ref.toLocaleDateString("hu-HU", { month: "short", day: "numeric", weekday: "short" })} `}${fmtTime(refMs)}`;
  const timeLine = arriveBy
    ? `Érkezés legkésőbb ${when}${atTime ? "" : ` (ha most indulnál)`}`
    : `Indulás ${atTime ? when : "most"}`;
  const items = bands.map((b, i) => {
    const from = i === 0 ? 0 : bands[i - 1];
    return `<span class="iso-band"><span class="iso-swatch" style="background:${isoColor(i, bands.length)}"></span>${from}-${b} perc</span>`;
  }).join("");
  resultsDiv.innerHTML = `
    <div class="iso-legend">
      <h3>${arriveBy ? `Innen érsz ide ${T} percen belül` : `${T} percen belül elérhető`}: ${nStops.toLocaleString("hu-HU")} megálló</h3>
      <p class="iso-note">${timeLine}</p>
      <div class="iso-bands">${items}</div>
      <p class="iso-note">
        A színes terület: az elért megállók, és onnan legfeljebb ${ISO_MAX_WALK_MIN} perc séta.
        Kattints a térképre: megmutatja, kb. hány perc alatt ${arriveBy ? "érsz onnan ide" : "érsz oda"}.
      </p>
      ${note ? `<p class="iso-note">${note}</p>` : ""}
    </div>`;
  resultsDiv.classList.remove("hidden");
}

async function handleIsochrone() {
  const originText = originInput.value.trim();
  if (!originText && !originCoord) { showError("Add meg a kiindulópontot!"); return; }

  const modes = getActiveModes();
  const transitModes = tsTransitModes(modes);
  if (!transitModes) { showError("Válassz legalább egy tömegközlekedési módot!"); return; }

  const motorErr = validateMotorProfile();
  if (motorErr) { showError(motorErr); return; }

  const T = parseInt(isoMinutesSlider.value, 10) || 45;
  const arriveBy = isIsoArrive();
  const leg = getLegProfile();
  /**
   * Indulás innen: a jármű az indulási oldalon számít (preTransit). Érkezés ide: a célnál
   * (postTransit). A másik oldali járművet a one-to-all nem tudja (a Transitous nem használja).
   */
  const kind = arriveBy ? leg.last : leg.first;
  const otherKind = arriveBy ? leg.first : leg.last;
  const maxCarSec = parseInt(carSlider.value, 10) * 60;
  const maxBikeSec = Math.round(((parseFloat(bikeKmSlider?.value) || 15) * 1000) / TS_BIKE_MPS);
  const endModes = kind === "car" ? ["CAR_PARKING"] : kind === "bike" ? ["BIKE"] : ["WALK"];
  const endLimit = kind === "car" ? Math.min(maxCarSec, T * 60) : kind === "bike" ? Math.min(maxBikeSec, T * 60) : undefined;

  clearUI();
  clearRoute();
  isoPopup?.remove();
  setLoading(true, "Számolás…");

  try {
    const origin = originCoord || (await geocode(originText));
    if (origin.displayName && !originCoord) {
      originInput.value = origin.displayName;
    }
    if (!originCoord) originCoord = { lat: origin.lat, lon: origin.lon };
    updatePickMarkers();

    const params = {
      maxTravelTime: T,
      transitModes,
      [arriveBy ? "postTransitModes" : "preTransitModes"]: endModes,
      [arriveBy ? "maxPostTransitTime" : "maxPreTransitTime"]: endLimit,
    };
    const tp = isoTimeParams(T);
    const data = await tsFetchOneToAll(originCoord, params, tp.params);

    /** Megállók: duplikátumok (több forrás ugyanarra a pontra) közül a legrövidebb idő marad. */
    const byKey = new Map();
    for (const x of data.all || []) {
      const p = x.place;
      if (!p || !Number.isFinite(p.lat) || x.duration > T) continue;
      const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      const prev = byKey.get(key);
      if (!prev || x.duration < prev.d) byKey.set(key, { lat: p.lat, lon: p.lon, d: x.duration, name: p.name || "" });
    }
    const stops = [{ lat: originCoord.lat, lon: originCoord.lon, d: 0, name: "", isOrigin: true }, ...byKey.values()];
    if (stops.length === 1) throw new Error("Ennyi idő alatt egy megálló sem érhető el innen.");

    isoData = {
      origin: { ...originCoord }, stops, T, bands: isoBands(T), arriveBy, kind,
      refMs: tp.refMs, atTime: timeModeSelect.value === "depart",
      /** A kattintásos útvonal-kéréshez: ugyanaz az idő, módok és jármű, mint az izokronnál. */
      timeParams: tp.params,
      planParams: {
        transitModes,
        [arriveBy ? "postTransitModes" : "preTransitModes"]: endModes,
        [arriveBy ? "maxPostTransitTime" : "maxPreTransitTime"]: endLimit,
        directModes: ["WALK"],
        maxDirectTime: ISO_MAX_WALK_MIN * 60 * 2,
        numItineraries: 3,
      },
    };
    drawIso();

    let note = "";
    if (kind === "car") note = `Autóval indulsz (legfeljebb ${Math.round(endLimit / 60)} perc), parkolás után tömegközlekedéssel.`;
    else if (kind === "bike") note = "Biciklivel indulsz a megállóig.";
    if (otherKind !== "none") {
      note += ` A ${otherKind === "car" ? "autót" : "biciklit"} ${arriveBy ? "az indulási" : "az érkezési"} oldalon ez a nézet nem számolja.`;
    }
    renderIsoLegend(note.trim());
    if (window.matchMedia("(max-width: 700px)").matches) {
      const sb = document.getElementById("sidebar");
      setTimeout(() => sb?.scrollTo({ top: resultsDiv.offsetTop - 12, behavior: "smooth" }), 350);
    }
  } catch (err) {
    console.error(err);
    showError(err.message);
    clearIso();
  } finally {
    setLoading(false);
  }
}

let isoClickToken = 0;

/** Egy útvonal lépései a kis ablakba: mivel, honnan, meddig, aztán tovább. */
function isoPopupLegsHtml(it) {
  const legs = it.legs.map(tsConvertLeg);
  const start = Date.parse(it.startTime);
  const end = Date.parse(it.endTime);
  const rows = [];
  legs.forEach((l, i) => {
    const dur = (l.endTime - l.startTime) / 1000;
    if (l.mode === "WALK") {
      if (dur < 60 && (l.distance || 0) < 80) return;
      const after = legs[i - 1]?.mode === "CAR" ? "Parkolás + séta" : "Séta";
      rows.push(`<div class="ip-row">${mi("directions_walk")}<span>${after} ${fmt(dur)}${l.to.name && i < legs.length - 1 ? ` <span class="ip-dim">→ ${l.to.name}</span>` : ""}</span></div>`);
      return;
    }
    if (l.mode === "CAR" || l.mode === "BICYCLE") {
      const lb = l.mode === "CAR" ? "Autó" : "Bicikli";
      const to = l.to.name || (i < legs.length - 1 ? "P+R parkoló" : "");
      rows.push(`<div class="ip-row">${mi(l.mode === "CAR" ? "directions_car" : "pedal_bike")}<span><b>${lb}</b> ${fmt(dur)} (${fmtDist(l.distance || 0)})${to ? ` <span class="ip-dim">→ ${to}</span>` : ""}</span></div>`);
      return;
    }
    const color = transitLegColor(l);
    rows.push(
      `<div class="ip-row">${modeIcon(effectiveMode(l))}<span><b style="color:${color}">${legName(l)}</b>`
      + `${l.headsign ? ` <span class="ip-dim">(${l.headsign} felé)</span>` : ""}<br>`
      + `${fmtTime(l.startTime)} ${l.from.name || "?"}<br>${fmtTime(l.endTime)} ${l.to.name || "?"}</span></div>`,
    );
  });
  return `<div class="ip-head">${fmtTime(start)} → ${fmtTime(end)} | ${fmt((end - start) / 1000)}</div>${rows.join("")}`;
}

/** Kattintás az izokron térképen: becsült idő azonnal, aztán a konkrét útvonal lépésenként. */
map.on("click", (e) => {
  if (!isIsoView() || mapClickTarget || !isoData) return;
  const { lng, lat } = e.lngLat;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let via = null;
  for (const s of isoData.stops) {
    const dist = Math.hypot((s.lon - lng) * 111320 * cosLat, (s.lat - lat) * 110540);
    const walkMin = dist / ISO_WALK_MPS / 60;
    if (walkMin > ISO_MAX_WALK_MIN) continue;
    const t = s.d + walkMin;
    if (t < best) { best = t; via = { ...s, walkMin }; }
  }

  const { arriveBy, T } = isoData;
  const box = document.createElement("div");
  box.className = "iso-popup";
  if (best <= T) {
    box.innerHTML = `<div class="ip-est">Kb. ${Math.round(best)} perc ${arriveBy ? "innen" : "ide"}</div>`;
  } else {
    box.innerHTML = `<div class="ip-est">${T} perc alatt nem érhető el</div>`;
  }
  const steps = document.createElement("div");
  steps.className = "ip-steps";
  steps.innerHTML = '<span class="ip-dim">Útvonal keresése…</span>';
  box.appendChild(steps);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "iso-popup-btn";
  btn.textContent = arriveBy ? "Útvonal innen" : "Útvonal ide";
  btn.addEventListener("click", async () => {
    const point = { lat, lon: lng };
    const center = { ...isoData.origin };
    const centerName = originInput.value;
    const refMs = isoData.refMs;
    setView("route");
    if (arriveBy) {
      /** Az útvonal ugyanarra az érkezési időre készüljön, amire az izokron. */
      const ref = new Date(refMs);
      timeModeSelect.value = "arrive";
      timeModeSelect.dispatchEvent(new Event("change"));
      datePickr.setDate(localDateStr(ref), true);
      timePick.value = localTimeStr(ref);
    }
    if (arriveBy) {
      destCoord = center;
      destinationInput.value = centerName;
      originCoord = point;
      originInput.value = "Kijelölt pont";
    } else {
      originCoord = center;
      originInput.value = centerName;
      destCoord = point;
      destinationInput.value = "Kijelölt pont";
    }
    updatePickMarkers();
    handlePlan();
    const name = await reverseGeocode(lat, lng);
    if (arriveBy) originInput.value = name;
    else destinationInput.value = name;
  });
  box.appendChild(btn);

  isoPopup?.remove();
  const narrow = window.matchMedia("(max-width: 700px)").matches;
  isoPopup = new maplibregl.Popup({
    offset: 10,
    closeButton: true,
    maxWidth: "300px",
    className: "iso-popup-wrap",
    /** Telefonon alul a panel van: az ablak a pont fölé nyíljon. */
    anchor: narrow ? "bottom" : undefined,
  })
    .setLngLat([lng, lat])
    .setDOMContent(box)
    .addTo(map);

  /** Telefonon csússzon a térkép, hogy az egész ablak a panel fölötti részen látsszon. */
  const fitPopupOnNarrow = (popup) => {
    if (!narrow || !popup.isOpen()) return;
    const sb = document.getElementById("sidebar");
    const visH = window.innerHeight - (sb?.offsetHeight || 0);
    const ph = popup.getElement()?.offsetHeight || 0;
    const targetY = Math.max(ph + 24, 40);
    const y = map.project([lng, lat]).y;
    const wantY = Math.min(visH - 16, targetY);
    if (Math.abs(y - wantY) > 8) map.panBy([0, y - wantY], { duration: 250 });
  };
  fitPopupOnNarrow(isoPopup);

  /** A konkrét útvonal (ugyanaz az idő, módok, jármű, mint az izokronnál), lépésenként. */
  const token = ++isoClickToken;
  const d0 = isoData;
  const here = { lat, lon: lng };
  const from = arriveBy ? here : d0.origin;
  const to = arriveBy ? d0.origin : here;
  const popupRef = isoPopup;
  tsFetchPlan(from, to, { ...d0.planParams, ...d0.timeParams })
    .then((d) => {
      if (token !== isoClickToken) return;
      const all = [...(d.itineraries || []), ...(d.direct || [])];
      const it = arriveBy ? tsPickLatestDeparture(all) : tsPickEarliestArrival(all);
      steps.innerHTML = it
        ? isoPopupLegsHtml(it)
        : '<span class="ip-dim">Ebben az időben nem találtunk útvonalat.</span>';
      popupRef.setDOMContent(box);
      fitPopupOnNarrow(popupRef);
    })
    .catch((err) => {
      if (token !== isoClickToken) return;
      steps.innerHTML = `<span class="ip-dim">${err.message}</span>`;
      popupRef.setDOMContent(box);
    });
});
