/* ================================================================
   TripBlend – Elérhetőség (izokron térkép)
   Egy kiindulópontból (vagy egy célpontba érkezve) mi érhető el X perc utazással.

   Adat: Transitous one-to-all (api.transitous.org/api/v6/one-to-all): az elért megállók
   és a hozzájuk tartozó menetidő (perc). Egy kérés egy rögzített időponthoz méri az időt
   (a várakozás is beleszámít), ezért egy 60 perces időablakban 10 percenként kérdezünk, és
   megállónként a legkisebb értéket vesszük: így a menetidő legfeljebb kb. 10 perccel több a
   valódi utazási időnél, és egy ritkán járó, de gyors busz sem esik ki.

   Rajz: minden megálló körül egy kör, amekkorát a maradék időből meg lehet tenni: gyalog
   (legfeljebb ISO_MAX_WALK_MIN perc), vagy ha a túlsó végen autó / bicikli van, azzal
   (parkolással, a járműkerettel). A one-to-all a túlsó végi járművet nem tudja, ezt
   légvonalban becsüljük (a sebesség a Transitous valódi autós idejeiből). A kattintás a
   pontos útvonalat kéri le (/plan), ott mindkét végen a valódi jármű számít.

   A sávokat egy vásznon (canvas) rajzoljuk Web Mercator koordinátákban, a legtávolabbitól a
   legközelebbi felé, így minden pont a legkisebb sávja színét kapja; a vászon raszterrétegként
   kerül a térképre a feliratok alá.
   ================================================================ */

const TS_ONE_TO_ALL_URL = "https://api.transitous.org/api/v6/one-to-all";
const ISO_WALK_MPS = 1.2;        // kb. 4,3 km/h
const ISO_MAX_WALK_MIN = 15;     // egy megállótól legfeljebb ennyi perc séta
const ISO_WINDOW_MIN = 60;       // indulási (vagy érkezési) időablak
const ISO_STEP_MIN = 10;         // ennyi percenként kérdezünk az ablakon belül (6 kérés)
const ISO_SLACK_MIN = ISO_STEP_MIN / 2; // a lépésközből adódó várható fölösleges várakozás (lásd handleIsochrone)
const ISO_BIKE_CROW_MPS = 3.3;   // 15 km/h úton, légvonalban kb. 12 km/h
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
  placeSliderBubble(isoMinutesSlider, isoBubble, `${isoMinutesSlider.value} perc`);
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

function updateIsoLabels() {
  const lbl = document.getElementById("origin-label");
  if (!lbl) return;
  lbl.textContent = !isIsoView() ? "Indulás" : isIsoArrive() ? "Hová érkezel" : "Honnan indulsz";
}
document.querySelectorAll('input[name="iso-direction"]').forEach((r) => {
  r.addEventListener("change", updateIsoLabels);
});

/**
 * Időpont mindkét nézetben: "Most indulok" / "Indulás időpontja" / "Érkezés időpontja", vagy-vagy
 * (mint a Google Térképen). Az "Utolsó járat" csak az Útvonal nézetben van: az Elérhetőségből
 * kivesszük, visszaváltáskor visszatesszük. A választás nézetváltáskor megmarad.
 */
let lastTimeOption = null;
function applyIsoTimeOptions(iso) {
  const sel = timeModeSelect;
  if (iso) {
    const opt = sel.querySelector('option[value="last"]');
    if (opt) {
      if (sel.value === "last") sel.value = "now";
      lastTimeOption = opt;
      opt.remove();
    }
  } else if (lastTimeOption && !sel.querySelector('option[value="last"]')) {
    sel.appendChild(lastTimeOption);
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
 * Időablak. "Most indulok" és "Indulás időpontja": indulás t és t + 60 perc között. "Érkezés
 * időpontja": érkezés t - 60 perc és t között. Mindkét irányban (Innen indulok / Ide érkezem)
 * ugyanígy értendő; az utazási idő az indulástól az érkezésig tart.
 * refs: one-to-all kérések, az indulásuk (dep) ISO_STEP_MIN percenként: indulási ablakban t-től később,
 * érkezésiben a határ előtt T perccel, onnan korábban. Innen indulok: a kérés ideje az indulás.
 * Ide érkezem: a kérés ideje az érkezési határ (dep + T), így a megtalált utak dep után indulnak.
 * Mindkét esetben maxTravelTime = T, tehát az érkezés legkésőbb dep + T.
 * @returns {{ kind: "depart"|"arrive", t: number, atTime: boolean, refs: object[] }}
 */
function isoWindow(T) {
  const toHere = isIsoArrive();
  const mode = timeModeSelect.value;
  const atTime = mode === "depart" || mode === "arrive";
  let t = Date.now();
  if (atTime) {
    const hm = /^\d{2}:\d{2}$/.test(timePick.value || "") ? timePick.value : "08:00";
    t = Date.parse(tsIso(planningDateStr(), hm));
  }
  const kind = mode === "arrive" ? "arrive" : "depart";
  const iso = (ms) => new Date(ms).toISOString();
  const refs = [];
  /** 0, 10, ... 50 perc: az utolsó kérés a 60. percig induló utakat is megtalálja (várakozással). */
  for (let k = 0; k * ISO_STEP_MIN < ISO_WINDOW_MIN; k++) {
    const off = k * ISO_STEP_MIN * 60000;
    const dep = kind === "arrive" ? t - T * 60000 - off : t + off;
    refs.push(toHere ? { time: iso(dep + T * 60000), arriveBy: "true" } : { time: iso(dep), arriveBy: "false" });
  }
  return { kind, t, atTime, refs };
}

async function tsFetchOneToAll(place, params, timeParams) {
  const q = new URLSearchParams({ one: `${place.lat},${place.lon}`, ...TS_TRANSFER_PARAMS, ...timeParams });
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return tsFetchJson(`${TS_ONE_TO_ALL_URL}?${q}`);
}

const ISO_R = 6378137;
const isoMx = (lon) => (ISO_R * lon * Math.PI) / 180;
const isoMy = (lat) => ISO_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const isoLon = (x) => ((x / ISO_R) * 180) / Math.PI;
const isoLat = (y) => ((2 * Math.atan(Math.exp(y / ISO_R)) - Math.PI / 2) * 180) / Math.PI;
const isoWalkM = (min) => Math.min(min, ISO_MAX_WALK_MIN) * 60 * ISO_WALK_MPS;

/**
 * Autóval t perc alatt légvonalban kb. hány méter, a Transitous valódi autós idejeiből (falu,
 * kisváros, Budapest belső része, 3-60 km, 200 út). A medián helyett a felső harmad határa
 * (65. percentilis): rövid úton kb. 41 km/h, 55 perc fölött kb. 54 km/h. A medián a határon lévő
 * helyeket rendre kihagyta (pl. Csákberény -> Székesfehérvár: becslés 28 perc, valójában 22);
 * a pontos időt úgyis a kattintás adja.
 */
function isoCarM(t) {
  if (t <= 0) return 0;
  const kmh = 41 + 13 * Math.min(1, Math.max(0, (t - 15) / 40));
  return (kmh * 1000 * t) / 60;
}
function isoVehM(kind, t) {
  if (kind === "car") return isoCarM(t);
  if (kind === "bike") return Math.max(0, t) * 60 * ISO_BIKE_CROW_MPS;
  return 0;
}
/** Hány perc a jármű légvonalban m méterre (az isoVehM inverze). */
function isoVehMin(kind, m) {
  if (kind === "bike") return m / ISO_BIKE_CROW_MPS / 60;
  let lo = 0, hi = 400;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (isoCarM(mid) < m) lo = mid; else hi = mid;
  }
  return hi;
}
const isoParkMin = (kind) => (TS_PARK_BUFFER_SEC[kind] || 0) / 60;

/**
 * Egy megállóból (vagy a kiindulópontból) rem perc alatt légvonalban elérhető távolság, méterben.
 * Megálló: séta, vagy a túlsó végi jármű parkolással. Kiindulópont: séta, vagy jármű végig.
 */
function isoReachM(s, rem, d = isoData) {
  if (rem <= 0) return 0;
  let r = isoWalkM(rem);
  const veh = (k, park) => {
    if (k === "none" || rem <= park) return;
    r = Math.max(r, isoVehM(k, Math.min(rem - park, d.limMin[k])));
  };
  if (s.isOrigin) {
    veh(d.nearKind, 0);
    veh(d.farKind, 0);
  } else if (d.farKind !== "none") {
    veh(d.farKind, isoParkMin(d.farKind));
  }
  return r;
}

/** Becsült utazási idő egy pontig (perc), ugyanazzal a szabállyal, amivel a térkép rajzol. */
function isoEstimate(lat, lng, d = isoData) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const s of d.stops) {
    const dist = Math.hypot((s.lon - lng) * 111320 * cosLat, (s.lat - lat) * 110540);
    const walkMin = dist / ISO_WALK_MPS / 60;
    if (walkMin <= ISO_MAX_WALK_MIN) best = Math.min(best, s.d + walkMin);
    const kinds = s.isOrigin ? [d.nearKind, d.farKind] : [d.farKind];
    for (const k of kinds) {
      if (k === "none" || dist > isoVehM(k, d.limMin[k])) continue;
      const park = s.isOrigin ? 0 : isoParkMin(k);
      best = Math.min(best, s.d + isoVehMin(k, dist) + park);
    }
  }
  return best;
}

function drawIso() {
  const { stops, T, bands, origin, arriveBy } = isoData;
  try { if (map.getLayer(ISO_LAYER)) map.removeLayer(ISO_LAYER); } catch { /* */ }
  try { if (map.getSource(ISO_SOURCE)) map.removeSource(ISO_SOURCE); } catch { /* */ }

  /** Befoglaló téglalap Mercatorban, a legnagyobb körökkel együtt. */
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of stops) {
    const r = isoReachM(s, T - s.d) / Math.cos((s.lat * Math.PI) / 180);
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
      const rp = (isoReachM(s, B - s.d) / Math.cos((s.lat * Math.PI) / 180)) * scale;
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

/** Az időablak szövegesen, a jelmagyarázatba. */
function isoWindowText(w) {
  const W = ISO_WINDOW_MIN * 60000;
  const d = new Date(w.t);
  const day = localDateStr(d) === localDateStr(new Date())
    ? ""
    : `${d.toLocaleDateString("hu-HU", { month: "short", day: "numeric", weekday: "short" })} `;
  if (w.kind === "arrive") return `Érkezés ${day}${fmtTime(w.t - W)} és ${fmtTime(w.t)} között`;
  if (w.atTime) return `Indulás ${day}${fmtTime(w.t)} és ${fmtTime(w.t + W)} között`;
  return `Indulás most vagy a következő ${ISO_WINDOW_MIN} percben`;
}

function renderIsoLegend(notes) {
  const { stops, T, bands, arriveBy, win, farKind } = isoData;
  const nStops = stops.length - 1; // a kiindulópont nem megálló
  const items = bands.map((b, i) => {
    const from = i === 0 ? 0 : bands[i - 1];
    return `<span class="iso-band"><span class="iso-swatch" style="background:${isoColor(i, bands.length)}"></span>${from}-${b} perc</span>`;
  }).join("");
  const farTxt = farKind === "car"
    ? ", vagy autóval a megállóig (légvonalban becsülve)"
    : farKind === "bike" ? ", vagy biciklivel a megállóig (légvonalban becsülve)" : "";
  resultsDiv.innerHTML = `
    <div class="iso-legend">
      <h3>${arriveBy ? `Innen érsz ide ${T} percen belül` : `${T} percen belül elérhető`}: ${nStops.toLocaleString("hu-HU")} megálló</h3>
      <p class="iso-note">${isoWindowText(win)}. Az idő az indulástól az érkezésig tart (kb. 5 perc pontossággal).</p>
      <div class="iso-bands">${items}</div>
      <p class="iso-note">
        A színes terület: az elért megállók, onnan legfeljebb ${ISO_MAX_WALK_MIN} perc séta${farTxt}.
        Kattints a térképre: megmutatja a leggyorsabb utat lépésenként.
      </p>
      ${notes.map((n) => `<p class="iso-note">${n}</p>`).join("")}
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
   * A one-to-all a kiindulópont (one) oldali járművet tudja: indulás innen -> az indulási
   * (first), érkezés ide -> az érkezési (last) jármű. A túlsó végit mi becsüljük (isoReachM).
   */
  const nearKind = arriveBy ? leg.last : leg.first;
  const farKind = arriveBy ? leg.first : leg.last;
  const maxCarMin = parseInt(carSlider.value, 10);
  const maxBikeKm = parseFloat(bikeKmSlider?.value) || 15;
  const limMin = {
    car: Math.min(maxCarMin, T),
    bike: Math.min(Math.round((maxBikeKm * 1000) / TS_BIKE_MPS / 60), T),
  };
  const modesFor = (k) => (k === "car" ? ["CAR_PARKING"] : k === "bike" ? ["BIKE"] : ["WALK"]);
  /** Autónál a Transitous kerete a parkolótól tartó sétát is tartalmazza (TS_PARK_WALK_SEC). */
  const limSecFor = (k) => (k === "car" ? limMin.car * 60 + TS_PARK_WALK_SEC : k === "bike" ? limMin.bike * 60 : undefined);

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
      /** A határon lévő megállók is jöjjenek (a levonás után még beleférhetnek); a szerver legfeljebb 120-at enged. */
      maxTravelTime: Math.min(120, T + ISO_SLACK_MIN),
      transitModes,
      [arriveBy ? "postTransitModes" : "preTransitModes"]: modesFor(nearKind),
      [arriveBy ? "maxPostTransitTime" : "maxPreTransitTime"]: limSecFor(nearKind),
    };
    const win = isoWindow(T);
    /** A kérések a közös soron mennek (tsFetchJson): egyszerre legfeljebb 3, hibánál egyszer újra. */
    const results = await Promise.allSettled(win.refs.map((r) => tsFetchOneToAll(originCoord, params, r)));
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!ok.length) throw results[0].reason;

    /**
     * Megállók: a kérések és a duplikátumok (több forrás ugyanarra a pontra) közül a legrövidebb idő
     * marad, mínusz ISO_SLACK_MIN. Egy kérés a saját időpontjához mér, így a legjobb érték is 0-10 perc
     * fölösleges várakozást tartalmaz (átlagosan 5-öt); a Google-összevetésben a térkép emiatt 0-8
     * perccel a pontos idő fölött volt, és a határon lévő helyek kiestek.
     */
    const byKey = new Map();
    for (const data of ok) {
      for (const x of data.all || []) {
        const p = x.place;
        const d = Math.max(0, x.duration - ISO_SLACK_MIN);
        if (!p || !Number.isFinite(p.lat) || d > T) continue;
        const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        const prev = byKey.get(key);
        if (!prev || d < prev.d) byKey.set(key, { lat: p.lat, lon: p.lon, d, name: p.name || "" });
      }
    }
    const stops = [{ lat: originCoord.lat, lon: originCoord.lon, d: 0, name: "", isOrigin: true }, ...byKey.values()];
    if (stops.length === 1 && nearKind === "none" && farKind === "none") {
      throw new Error("Ennyi idő alatt egy megálló sem érhető el innen.");
    }

    const usesCar = leg.first === "car" || leg.last === "car";
    const usesBike = leg.first === "bike" || leg.last === "bike";
    isoData = {
      origin: { ...originCoord }, stops, T, bands: isoBands(T), arriveBy, win,
      nearKind, farKind, limMin,
      /**
       * A kattintásos útvonal-kéréshez: ugyanazok a módok és járművek. Itt mindkét végen a valódi
       * jármű számít (first = az út eleje, last = a vége, iránytól függetlenül).
       */
      planParams: {
        transitModes,
        preTransitModes: modesFor(leg.first),
        maxPreTransitTime: limSecFor(leg.first),
        postTransitModes: modesFor(leg.last),
        maxPostTransitTime: limSecFor(leg.last),
        directModes: ["WALK", ...(usesCar ? ["CAR"] : []), ...(usesBike ? ["BIKE"] : [])],
        maxDirectTime: Math.max(ISO_MAX_WALK_MIN * 120, usesCar ? limMin.car * 60 : 0, usesBike ? limMin.bike * 60 : 0),
        numItineraries: 5,
      },
    };
    drawIso();

    const notes = [];
    const vt = (k) => (k === "car" ? `autóval (legfeljebb ${maxCarMin} perc)` : `biciklivel (legfeljebb ${maxBikeKm} km)`);
    const parts = [];
    if (leg.first !== "none") parts.push(`indulásnál ${vt(leg.first)}`);
    if (leg.last !== "none") parts.push(`érkezésnél ${vt(leg.last)}`);
    if (parts.length) {
      const s = parts.join(", ");
      notes.push(`Jármű: ${s}; a tömegközlekedés mellett a végig autózás / biciklizés is számít.`);
    }
    if (ok.length < results.length) {
      notes.push("A Transitous nem minden kérésre válaszolt, a térkép hiányos lehet.");
    }
    renderIsoLegend(notes);
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

/** Ennyi percen belül két út egyformán gyors: a kevesebb átszállásos nyer (a Google is így választ). */
const ISO_TIE_MIN = 3;

/**
 * A leggyorsabb út az időablakban (a térképpel azonos szabály): legrövidebb utazási idő; a
 * leggyorsabbnál legfeljebb ISO_TIE_MIN perccel hosszabbak közül a kevesebb átszállásos. A
 * jármű-szakasz nem lehet hosszabb a keretnél (a végig autózásra a maxDirectTime miatt kell). Ha
 * az ablakban nincs út, a leggyorsabb ablakon kívüli jön.
 *
 * alt: amit a Google ajánlana. Érkezésnél a legkésőbb induló, még időben érkező út, indulásnál a
 * leghamarabb érkező. A leggyorsabb út az ablak elején is lehet (9:00-ás érkezésnél 8:00-kor ér
 * oda), ezért ha az alt legalább 10 perccel közelebb van a megadott időhöz, azt is megmutatjuk.
 */
function isoPickBest(its, d0, startMs) {
  const W = ISO_WINDOW_MIN * 60000;
  const slack = 2 * 60000;
  const okLeg = (l) => {
    const sec = (Date.parse(l.endTime) - Date.parse(l.startTime)) / 1000;
    if (l.mode === "CAR") return sec <= d0.limMin.car * 60 + 30;
    if (l.mode === "BIKE") return sec <= d0.limMin.bike * 60 + 30;
    return true;
  };
  const valid = (its || []).filter((it) => it.legs.every(okLeg));
  const inWin = valid.filter((it) => {
    const s = Date.parse(it.startTime), e = Date.parse(it.endTime);
    return d0.win.kind === "arrive"
      ? e <= d0.win.t + slack && e >= d0.win.t - W - slack
      : s >= startMs - slack && s <= startMs + W + slack;
  });
  const pool = inWin.length ? inWin : valid;
  if (!pool.length) return null;
  const dur = (it) => Date.parse(it.endTime) - Date.parse(it.startTime);
  const arrive = d0.win.kind === "arrive";
  const later = arrive ? -1 : 1;
  pool.sort((a, b) => dur(a) - dur(b)
    || (a.transfers || 0) - (b.transfers || 0)
    || later * (Date.parse(a.startTime) - Date.parse(b.startTime)));
  /** Döntetlen: a leggyorsabbhoz közeli, kevesebb átszállásos, ha ugyanúgy belefér a keretbe. */
  const fastest = dur(pool[0]);
  const limit = d0.T * 60000 + 30000;
  const tie = pool.filter((it) => dur(it) <= fastest + ISO_TIE_MIN * 60000 && (fastest > limit || dur(it) <= limit));
  tie.sort((a, b) => (a.transfers || 0) - (b.transfers || 0) || dur(a) - dur(b));
  const it = tie[0] || pool[0];

  let alt = null;
  if (inWin.length) {
    const near = [...inWin].sort((a, b) => (arrive
      ? Date.parse(b.startTime) - Date.parse(a.startTime)
      : Date.parse(a.endTime) - Date.parse(b.endTime)) || dur(a) - dur(b));
    const gain = arrive
      ? Date.parse(near[0].startTime) - Date.parse(it.startTime)
      : Date.parse(it.endTime) - Date.parse(near[0].endTime);
    if (gain >= 10 * 60000) alt = near[0];
  }
  return { it, inWindow: inWin.length > 0, alt };
}

/** Az alternatíva egy sorban: mikor indul, mikor ér oda, mennyi idő, melyik járatokkal. */
function isoAltHtml(alt, arriveBy, atMs) {
  const start = Date.parse(alt.startTime);
  const end = Date.parse(alt.endTime);
  const chain = alt.legs.map(tsConvertLeg).filter((l) => l.mode !== "WALK").map(legName).join(" > ");
  const lead = arriveBy
    ? `Ha ${fmtTime(atMs)}-ra kell odaérned, a legkésőbbi indulás:`
    : "Leghamarabb így érsz oda:";
  return `<div class="ip-alt"><div class="ip-dim">${lead}</div>`
    + `<b>${fmtTime(start)} → ${fmtTime(end)}</b> | ${fmt((end - start) / 1000)}${chain ? `<br>${chain}` : ""}</div>`;
}

/** Kattintás az izokron térképen: becsült idő azonnal, aztán a leggyorsabb útvonal lépésenként. */
map.on("click", (e) => {
  if (!isIsoView() || mapClickTarget || !isoData) return;
  const { lng, lat } = e.lngLat;
  const { arriveBy, T } = isoData;
  const best = isoEstimate(lat, lng);

  const box = document.createElement("div");
  box.className = "iso-popup";
  const est = document.createElement("div");
  est.className = "ip-est";
  est.textContent = best <= T ? `Kb. ${Math.round(best)} perc ${arriveBy ? "innen" : "ide"}` : `${T} perc alatt nem érhető el`;
  box.appendChild(est);
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
    /** Az Útvonal nézet ugyanazt az időt kapja (most / indulás / érkezés), lásd applyIsoTimeOptions. */
    setView("route");
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

  /** A konkrét útvonal: ugyanaz az időablak, módok és járművek, mint az izokronnál. */
  const token = ++isoClickToken;
  const d0 = isoData;
  const here = { lat, lon: lng };
  const from = arriveBy ? here : d0.origin;
  const to = arriveBy ? d0.origin : here;
  const popupRef = isoPopup;
  /** "Most": az ablak a kattintás pillanatától indul (a már elment járat nem jó). */
  const startMs = d0.win.atTime ? d0.win.t : Date.now();
  const timeParams = d0.win.kind === "arrive"
    ? { time: new Date(d0.win.t).toISOString(), arriveBy: "true" }
    : { time: new Date(startMs).toISOString(), arriveBy: "false" };
  tsFetchPlan(from, to, { ...d0.planParams, ...timeParams, searchWindow: ISO_WINDOW_MIN * 60 })
    .then((d) => {
      if (token !== isoClickToken) return;
      const picked = isoPickBest([...(d.itineraries || []), ...(d.direct || [])], d0, startMs);
      if (!picked) {
        steps.innerHTML = '<span class="ip-dim">Ebben az időben nem találtunk útvonalat.</span>';
      } else {
        const { it, inWindow, alt } = picked;
        const sec = (Date.parse(it.endTime) - Date.parse(it.startTime)) / 1000;
        const fits = inWindow && sec <= T * 60 + 30;
        est.textContent = fits ? `${fmt(sec)} ${arriveBy ? "innen" : "ide"}` : `${T} perc alatt nem érhető el`;
        let note = "";
        if (!inWindow) {
          note = `Az időablakban nincs útvonal; ez ${fmtTime(Date.parse(it.startTime))}-kor indul.`;
        } else if (!fits) {
          note = `A leggyorsabb út ${fmt(sec)}.`;
        }
        steps.innerHTML = `${note ? `<div class="ip-dim">${note}</div>` : ""}${isoPopupLegsHtml(it)}`;
        /** A lépések alatt, a görgetett részen kívül, hogy mindig látsszon. */
        if (alt) steps.insertAdjacentHTML("afterend", isoAltHtml(alt, arriveBy, d0.win.t));
      }
      popupRef.setDOMContent(box);
      fitPopupOnNarrow(popupRef);
    })
    .catch((err) => {
      if (token !== isoClickToken) return;
      steps.innerHTML = `<span class="ip-dim">${err.message}</span>`;
      popupRef.setDOMContent(box);
    });
});
