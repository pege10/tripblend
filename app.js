/* ================================================================
   P+R Útvonaltervező – app.js
   Optimális átszállási pont keresése: 0-tól max N percig
   mintavételezés 3 percenként, legkisebb összidő kiválasztása.
   MapLibre GL JS + OpenFreeMap + Nominatim + OTP
   ================================================================ */

/**
 * Útvonal-háttér: "transitous" (alap, online, api.transitous.org) vagy "otp" (helyi OpenTripPlanner,
 * localhost:8080). A régi OTP-s változat: index.html?backend=otp
 */
const BACKEND =
  new URLSearchParams(location.search).get("backend") === "otp" ? "otp" : "transitous";

/**
 * Bicikli funkció (UI + útvonallogika): false = rejtett és kikapcsolt.
 * OTP-vel ki volt kapcsolva; a Transitous natívan tervez biciklivel, ott be van kapcsolva.
 */
const ENABLE_BIKE_FEATURES = BACKEND === "transitous";

(function initBackendUi() {
  function apply() {
    document.body?.classList.toggle("backend-otp", BACKEND === "otp");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  else apply();
})();

(function initBikeUiFlag() {
  function apply() {
    if (typeof document === "undefined" || !document.body) return;
    document.body.classList.toggle("no-bike-ui", !ENABLE_BIKE_FEATURES);
    if (!ENABLE_BIKE_FEATURES) {
      const cb = document.getElementById("use-bike");
      if (cb) cb.checked = false;
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();

// ── DOM ─────────────────────────────────────────────────────────

const originInput = document.getElementById("origin");
const destinationInput = document.getElementById("destination");
const planBtn = document.getElementById("plan-btn");
const resultsDiv = document.getElementById("results");
const errorDiv = document.getElementById("error");
const carSlider = document.getElementById("max-car-minutes");
const sliderBubble = document.getElementById("slider-bubble");
const bikeKmSlider = document.getElementById("max-bike-km");
const sliderBubbleBike = document.getElementById("slider-bubble-bike");

/** OTP: aktuális biciklis utcai láb max. hossza (m); a csúszka alapján állítjuk. */
let activeBikeLimitM = 15000;

/** „Indulás időpontja” módban: ha a tényleges indulás később, mint a megadott idő — rövid tájékoztató szöveg. */
let departScheduleNote = null;

/**
 * Csúszka-buborék a fogantyú fölött. A helyét a CSS számolja a --p arányból (.slider-bubble):
 * a csúszka két végén a buborék nem lóg ki a panelből, a nyila a fogantyún marad.
 */
function placeSliderBubble(slider, bubble, text) {
  const min = +slider.min, max = +slider.max;
  const pct = max > min ? (slider.value - min) / (max - min) : 0;
  bubble.textContent = text;
  bubble.style.setProperty("--p", String(pct));
}

function updateSliderBubble() {
  placeSliderBubble(carSlider, sliderBubble, `${carSlider.value} perc`);
}
carSlider.addEventListener("input", updateSliderBubble);
updateSliderBubble();

function updateBikeSliderBubble() {
  placeSliderBubble(bikeKmSlider, sliderBubbleBike, `${bikeKmSlider.value} km`);
}
bikeKmSlider?.addEventListener("input", updateBikeSliderBubble);
updateBikeSliderBubble();

/** @returns {{ first: 'none'|'car'|'bike', last: 'none'|'car'|'bike' }} */
function getLegProfile() {
  const useBike = ENABLE_BIKE_FEATURES && document.getElementById("use-bike")?.checked;
  const useCar = document.getElementById("use-car")?.checked;
  const bikePos = document.querySelector('input[name="bike-motor-pos"]:checked')?.value;
  const carPos = document.querySelector('input[name="car-motor-pos"]:checked')?.value;

  let first = "none";
  let last = "none";

  if (useCar) {
    if (carPos === "first") first = "car";
    else if (carPos === "last") last = "car";
  }

  if (useBike) {
    if (bikePos === "first" && first === "none") first = "bike";
    else if (bikePos === "last" && last === "none") last = "bike";
  }

  return { first, last };
}

/** Járműszakasz-beállítások ellenőrzése (bicikli/autó ütközés). */
function validateMotorProfile() {
  const useBike = ENABLE_BIKE_FEATURES && document.getElementById("use-bike")?.checked;
  const useCar = document.getElementById("use-car")?.checked;
  const bikePos = document.querySelector('input[name="bike-motor-pos"]:checked')?.value;
  const carPos = document.querySelector('input[name="car-motor-pos"]:checked')?.value;

  if (useBike && !bikePos) {
    return "Válaszd ki, hol használod a biciklit (indulásnál vagy érkezésnél).";
  }
  if (useCar && !carPos) {
    return "Válaszd ki, hol használod az autót (indulásnál vagy érkezésnél).";
  }
  if (useBike && useCar) {
    if (bikePos === "first" && carPos === "first") {
      return "Az autó és a bicikli nem lehet egyszerre az indulásnál — módosítsd az egyik végpontra.";
    }
    if (bikePos === "last" && carPos === "last") {
      return "Az autó és a bicikli nem lehet egyszerre az érkezésnél — módosítsd az egyik végpontra.";
    }
  }
  return null;
}

const maxCarGroup = document.getElementById("max-car-group");
const maxBikeGroup = document.getElementById("max-bike-group");

function updateMotorSliderGroupsVisibility() {
  const useBike = ENABLE_BIKE_FEATURES && document.getElementById("use-bike")?.checked;
  const useCar = document.getElementById("use-car")?.checked;
  maxBikeGroup?.classList.toggle("hidden", !useBike);
  maxCarGroup?.classList.toggle("hidden", !useCar);
}

function syncMotorSubpanels() {
  const ub = ENABLE_BIKE_FEATURES ? document.getElementById("use-bike") : null;
  const uc = document.getElementById("use-car");
  const bikeWrap = document.getElementById("bike-expand-wrap");
  const carWrap = document.getElementById("car-expand-wrap");
  bikeWrap?.classList.toggle("is-open", !!ub?.checked);
  carWrap?.classList.toggle("is-open", !!uc?.checked);
  bikeWrap?.setAttribute("aria-hidden", ub?.checked ? "false" : "true");
  carWrap?.setAttribute("aria-hidden", uc?.checked ? "false" : "true");
  if (ub?.checked && !document.querySelector('input[name="bike-motor-pos"]:checked')) {
    const r = document.querySelector('input[name="bike-motor-pos"][value="first"]');
    if (r) r.checked = true;
  }
  if (uc?.checked && !document.querySelector('input[name="car-motor-pos"]:checked')) {
    const r = document.querySelector('input[name="car-motor-pos"][value="first"]');
    if (r) r.checked = true;
  }
  updateMotorSliderGroupsVisibility();
}

["use-bike", "use-car"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", syncMotorSubpanels);
});
document.querySelectorAll('input[name="bike-motor-pos"]').forEach((el) => {
  el.addEventListener("change", syncMotorSubpanels);
});
document.querySelectorAll('input[name="car-motor-pos"]').forEach((el) => {
  el.addEventListener("change", updateMotorSliderGroupsVisibility);
});
syncMotorSubpanels();

// ── Time picker ─────────────────────────────────────────────────

const timeModeSelect = document.getElementById("time-mode");
const timeInputsDiv = document.getElementById("time-inputs");
const datePick = document.getElementById("date-pick");
const timePick = document.getElementById("time-pick");

// Flatpickr date picker (glassmorphism styled via CSS)
flatpickr.localize(flatpickr.l10ns.hu);
const datePickr = flatpickr(datePick, {
  dateFormat: "Y-m-d",
  defaultDate: new Date(),
  disableMobile: true,
  locale: { ...flatpickr.l10ns.hu, firstDayOfWeek: 1 },
});

// Default time = now (rounded to 5 min)
(function initTime() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, "0");
  timePick.value = `${hh}:${mm}`;
})();

timeModeSelect.addEventListener("change", () => {
  const mode = timeModeSelect.value;
  if (mode === "now") {
    timeInputsDiv.classList.add("hidden");
  } else {
    timeInputsDiv.classList.remove("hidden");
    timePick.style.display = mode === "last" ? "none" : "";
  }
  // Refresh defaults when switching
  const now = new Date();
  datePick.value = datePick.value || now.toISOString().slice(0, 10);
});

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localTimeStr(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

/** Választott naptári nap (üres flatpickr → ma, lokális). */
function planningDateStr() {
  const v = datePick?.value?.trim();
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return localDateStr(new Date());
}

/**
 * Utolsó járat: OTP arriveBy; a célba érkezés legkésőbb ide (éjszakai járatok is).
 * A választott menetrendi nap utáni nap hajnala — így beleférnek a hajnal előtt érkező éjszakai járatok is.
 */
function lastTripTransitParams(serviceDateStr) {
  const base = serviceDateStr && /^\d{4}-\d{2}-\d{2}$/.test(serviceDateStr)
    ? serviceDateStr
    : planningDateStr();
  const arrive = new Date(`${base}T12:00:00`);
  arrive.setDate(arrive.getDate() + 1);
  arrive.setHours(5, 59, 0, 0);
  return { date: localDateStr(arrive), time: localTimeStr(arrive), arriveBy: true };
}

/** Ugyanazon napon 23:59-ig kell odaérni — ha a fenti túl szűk OTP-ablakkal üres lenne a válasz. */
function lastTripTransitParamsSameDay(serviceDateStr) {
  const base = serviceDateStr && /^\d{4}-\d{2}-\d{2}$/.test(serviceDateStr)
    ? serviceDateStr
    : planningDateStr();
  return { date: base, time: "23:59", arriveBy: true };
}

/** Rugalmas referencia: indulás a menetrendi nap délén (segít, ha az arriveBy keresés nem ad eredményt). */
function lastTripDepartNoonFallback(serviceDateStr) {
  const base = serviceDateStr && /^\d{4}-\d{2}-\d{2}$/.test(serviceDateStr)
    ? serviceDateStr
    : planningDateStr();
  return { date: base, time: "12:00", arriveBy: false };
}

function isLastTripMode() {
  return timeModeSelect.value === "last";
}

function isDepartScheduleMode() {
  return timeModeSelect.value === "depart";
}

/** „Indulás időpontja” módban a kért indulás epoch ms (helyi idő). */
function requestedDepartMs() {
  if (!isDepartScheduleMode()) return null;
  const d = planningDateStr();
  const t = timePick?.value?.trim();
  if (!d || !t || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [hh, mm] = t.split(":").map((x) => parseInt(x, 10));
  const dt = new Date(`${d}T00:00:00`);
  dt.setHours(hh, mm, 0, 0);
  return dt.getTime();
}

/** Naptári nap + HH:mm + perc hozzáadása (átfordulással). */
function addCalendarMinutes(dateStr, timeStr, addMin) {
  const [hh, mm] = timeStr.split(":").map((x) => parseInt(x, 10));
  const dt = new Date(`${dateStr}T00:00:00`);
  dt.setHours(hh, mm, 0, 0);
  dt.setMinutes(dt.getMinutes() + addMin);
  return { date: localDateStr(dt), time: localTimeStr(dt) };
}

function getTimeParams() {
  const mode = timeModeSelect.value;
  if (mode === "now") return {};

  const date = planningDateStr();
  if (mode === "depart") {
    return { date, time: timePick.value, arriveBy: false };
  }
  if (mode === "arrive") {
    return { date, time: timePick.value, arriveBy: true };
  }
  if (mode === "last") {
    return lastTripTransitParams(datePick.value || date);
  }
  return {};
}

/**
 * Tömegközlekedéses lánc időparaméterei – hosszú járműves „elő-” vagy „utó-” szakasz szerint.
 * @param {number} accessSec – indulás előtti szakasz (autó/bicikli) másodperc
 * @param {number} egressSec – leszállás utáni szakasz másodperc
 */
function getTransitTimeParams(accessSec, egressSec, legProfile) {
  const first = legProfile.first;
  const last = legProfile.last;
  const mode = timeModeSelect.value;

  if (first !== "none" && last !== "none") return {};
  if (first === "none" && last === "none") return {};

  if (first !== "none") {
    const carSec = accessSec;
    if (mode === "now") {
      const future = new Date(Date.now() + carSec * 1000);
      return {
        date: future.toISOString().slice(0, 10),
        time: future.toTimeString().slice(0, 5),
        arriveBy: false,
      };
    }
    if (mode === "depart") {
      const base = new Date(`${datePick.value}T${timePick.value}`);
      const future = new Date(base.getTime() + carSec * 1000);
      return {
        date: future.toISOString().slice(0, 10),
        time: future.toTimeString().slice(0, 5),
        arriveBy: false,
      };
    }
    if (mode === "last") {
      return lastTripTransitParams(planningDateStr());
    }
  }

  if (last !== "none") {
    const carSec = egressSec;
    if (mode === "arrive") {
      const base = new Date(`${datePick.value}T${timePick.value}`);
      const earlier = new Date(base.getTime() - carSec * 1000);
      return {
        date: localDateStr(earlier),
        time: localTimeStr(earlier),
        arriveBy: true,
      };
    }
    if (mode === "last") {
      const s = planningDateStr();
      const arrive = new Date(`${s}T12:00:00`);
      arrive.setDate(arrive.getDate() + 1);
      arrive.setHours(5, 59, 0, 0);
      const earlier = new Date(arrive.getTime() - carSec * 1000);
      return { date: localDateStr(earlier), time: localTimeStr(earlier), arriveBy: true };
    }
  }

  return {};
}

// ── Mode chips ──────────────────────────────────────────────────

const modeChips = document.querySelectorAll(".mode-chip:not(.segment-motor-chip)");
modeChips.forEach((chip) => {
  chip.addEventListener("click", () => chip.classList.toggle("active"));
});

function getActiveModes() {
  const active = new Set();
  modeChips.forEach((chip) => {
    if (chip.classList.contains("active")) active.add(chip.dataset.mode);
  });
  return active;
}

function buildTransitMode(modes) {
  const transitParts = [];
  if (modes.has("BUS")) transitParts.push("BUS");
  /** OTP-ben a HÉV is RAIL gráf — a „Vonat” és „HÉV” chip külön szűrővel (itineraryMatchesUserModes). */
  if (modes.has("RAIL") || modes.has("HEV")) transitParts.push("RAIL");
  if (modes.has("TRAM")) transitParts.push("TRAM");
  if (modes.has("SUBWAY")) transitParts.push("SUBWAY");
  if (!transitParts.length) return null;
  return [...new Set(transitParts)].join(",") + ",WALK";
}

/** Tömegközlekedés + bicikli az utca szakaszokon (A és/vagy B között). */
function buildTransitModeWithBicycle(modes) {
  const base = buildTransitMode(modes);
  if (!base) return "BICYCLE,WALK";
  const inner = base.replace(/,WALK$/, "");
  return `BICYCLE,${inner},WALK`;
}

/**
 * OTP mód: utcai bicikli a tömegközlekedési láncban (pl. csak záró biciklis P+R).
 * Érkezésnél bicikli/autó: a fő kérésben ne legyen utcai BICYCLE/CAR — záró szakasz stitch-csel;
 * a radiális egress P+R viszont más állomást választana, és hosszan bevonatozna a városban.
 */
function planTransitModeString(modes, leg) {
  if (leg.first === "none" && (leg.last === "bike" || leg.last === "car")) {
    return buildTransitMode(modes);
  }
  const streetBike = leg.last === "bike" && leg.first !== "bike";
  if (streetBike) return buildTransitModeWithBicycle(modes);
  return buildTransitMode(modes);
}

function isCarEnabled() {
  return !!document.getElementById("use-car")?.checked;
}

// ── Map ─────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [19.04, 47.497],
  zoom: 11,
  attributionControl: false,
});
const IS_NARROW = window.matchMedia("(max-width: 700px)").matches;
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      BACKEND === "transitous"
        ? 'Útvonal: <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>'
        : undefined,
  }),
  /** Telefonon alul a panel van: a forrásmegjelölés felülre kerül, hogy látszódjon. */
  IS_NARROW ? "top-left" : "bottom-right",
);

/**
 * Telefonon a forrásmegjelölés legyen összecsukva (az "i" ikonnal nyitható, a panel alján is ott van).
 * A MapLibre betöltés után magától kinyitja, ezért az első "idle"-nél és útvonalrajzoláskor csukjuk.
 */
function collapseAttribOnNarrow() {
  if (!window.matchMedia("(max-width: 700px)").matches) return;
  document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
}
map.once("idle", collapseAttribOnNarrow);

/** A térkép-igazítás hagyjon helyet a panelnek (asztalon bal oldalt, telefonon alul). */
function mapPadding() {
  const sb = document.getElementById("sidebar");
  if (!sb) return 60;
  if (window.matchMedia("(max-width: 700px)").matches) {
    return { top: 60, left: 30, right: 50, bottom: sb.offsetHeight + 30 };
  }
  return { top: 60, right: 60, bottom: 60, left: sb.offsetWidth + 50 };
}
map.addControl(new maplibregl.NavigationControl(), "top-right");

let activeMarkers = [];
let layerCounter = 0;
const ROUTE_PREFIX = "route-leg-";

// Stored coordinates from map clicks (bypass geocoding)
let originCoord = null;
let destCoord = null;
let mapClickTarget = null; // "origin" | "destination" | null

// ── Nominatim ───────────────────────────────────────────────────

const NOM = "https://nominatim.openstreetmap.org";
const NOM_HEADERS = { "Accept-Language": "hu" };

async function nomSearch(params) {
  const url = `${NOM}/search?` + new URLSearchParams({ format: "json", countrycodes: "hu", limit: 5, addressdetails: 1, ...params });
  const res = await fetch(url, { headers: NOM_HEADERS });
  if (!res.ok) return [];
  return res.json();
}

async function geocode(address) {
  // Strategy 1: exact query
  let results = await nomSearch({ q: address });
  if (results.length) return pickResult(results);

  // Strategy 2: try structured – split on comma or first space-group as city
  const commaSplit = address.split(",").map((s) => s.trim());
  if (commaSplit.length >= 2) {
    results = await nomSearch({ city: commaSplit[0], street: commaSplit.slice(1).join(" ") });
    if (results.length) return pickResult(results);
  }

  // Strategy 3: remove house number (last number in string) and retry
  const noNum = address.replace(/\s+\d+[\/\-]?\d*\.?\s*$/, "").trim();
  if (noNum !== address) {
    results = await nomSearch({ q: noNum });
    if (results.length) return pickResult(results);
  }

  // Strategy 4: try first word as city, rest as street
  const parts = address.split(/\s+/);
  if (parts.length >= 2) {
    const city = parts[0];
    const street = parts.slice(1).join(" ");
    results = await nomSearch({ city, street });
    if (results.length) return pickResult(results);

    // Without house number in street
    const streetNoNum = street.replace(/\s+\d+[\/\-]?\d*\.?\s*$/, "").trim();
    if (streetNoNum !== street) {
      results = await nomSearch({ city, street: streetNoNum });
      if (results.length) return pickResult(results);
    }
  }

  throw new Error(`Nem található cím: „${address}"`);
}

function pickResult(results) {
  const r = results[0];
  const a = r.address || {};
  const city = a.city || a.town || a.village || a.municipality || "";
  const road = a.road || "";
  const num = a.house_number || "";
  let displayName;
  if (city && road) {
    displayName = `${city}, ${road}${num ? " " + num : ""}`;
  } else if (city) {
    displayName = city;
  } else {
    const parts = (r.display_name || "").split(",").map((s) => s.trim());
    displayName = parts.slice(0, 2).join(", ");
  }
  return {
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    displayName,
  };
}

async function reverseGeocode(lat, lon) {
  const url = `${NOM}/reverse?` + new URLSearchParams({ lat, lon, format: "json", zoom: 18 });
  try {
    const res = await fetch(url, { headers: NOM_HEADERS });
    if (!res.ok) return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const data = await res.json();
    const a = data.address || {};
    const parts = [a.road, a.house_number, a.village || a.city || a.town, a.county].filter(Boolean);
    return parts.join(", ") || data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  } catch {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
}

// ── Map click to set origin / destination ───────────────────────

let pickMarkers = [];

function clearPickMarkers() {
  pickMarkers.forEach((m) => m.remove());
  pickMarkers = [];
}

function updatePickMarkers() {
  clearPickMarkers();
  if (originCoord) {
    const el = document.createElement("div");
    el.style.cssText = "width:16px;height:16px;border-radius:50%;background:#22c55e;border:2px solid rgba(255,255,255,0.9);box-shadow:0 1px 4px rgba(0,0,0,.3), 0 0 10px rgba(34,197,94,0.4);";
    const m = new maplibregl.Marker({ element: el }).setLngLat([originCoord.lon, originCoord.lat]).addTo(map);
    pickMarkers.push(m);
  }
  if (destCoord && !document.body.classList.contains("view-iso")) {
    const el = document.createElement("div");
    el.style.cssText = "width:16px;height:16px;border-radius:50%;background:#6366f1;border:2px solid rgba(255,255,255,0.9);box-shadow:0 1px 4px rgba(0,0,0,.3), 0 0 10px rgba(99,102,241,0.4);";
    const m = new maplibregl.Marker({ element: el }).setLngLat([destCoord.lon, destCoord.lat]).addTo(map);
    pickMarkers.push(m);
  }
}

map.on("click", async (e) => {
  if (!mapClickTarget) return;

  const { lng, lat } = e.lngLat;
  const coord = { lat, lon: lng };
  const name = await reverseGeocode(lat, lng);

  if (mapClickTarget === "origin") {
    originCoord = coord;
    originInput.value = name;
  } else if (mapClickTarget === "destination") {
    destCoord = coord;
    destinationInput.value = name;
  } else if (typeof onTransferPointPicked === "function") {
    /** Saját átszállási pont (transitous.js): "car-point" / "bike-point". */
    onTransferPointPicked(mapClickTarget, coord, name);
  }

  updatePickMarkers();
  setPickMode(null);
});

function swapOriginDestination() {
  const t = originInput.value;
  originInput.value = destinationInput.value;
  destinationInput.value = t;
  const c = originCoord;
  originCoord = destCoord;
  destCoord = c;
  updatePickMarkers();
}

function setPickMode(target) {
  mapClickTarget = target;
  map.getCanvas().style.cursor = target ? "crosshair" : "";
  document.getElementById("pick-origin")?.classList.toggle("active", target === "origin");
  document.getElementById("pick-dest")?.classList.toggle("active", target === "destination");
  document.getElementById("pick-car-point")?.classList.toggle("active", target === "car-point");
  document.getElementById("pick-bike-point")?.classList.toggle("active", target === "bike-point");
}

// Clear stored coords AND pick markers when user types manually
originInput.addEventListener("input", () => {
  originCoord = null;
  updatePickMarkers();
});
destinationInput.addEventListener("input", () => {
  destCoord = null;
  updatePickMarkers();
});

// ── OTP ─────────────────────────────────────────────────────────

const OTP_BASE = "http://localhost:8080/otp/routers/default/plan";

/** Ennél rövidebb OTP „BICYCLE” lábat WALK-ká írunk (OTP néha ad 10–50 m biciklit is). */
const MIN_USEFUL_BIKE_M = 1000;
/**
 * Utcai motor-bicikli (P+R, záró stitch): ennél rövidebb OTP-táv = elvetjük / gyalog.
 * A gyalogzáró gyakran hosszabb (pl. 1,4 km járdán), mint a bicikliút (pl. 800 m); 1000 m nem jó felső küszöb.
 */
const MIN_MOTOR_BIKE_ROUTE_M = 350;

/**
 * P+R „utcai bringa”: az OTP BICYCLE gráf gyakran üres / csak bringaút — ezért a vonalvezetést a CAR
 * gráfról kérjük, a menetidőt pedig távolság / effektív bringasebesség alapján számoljuk (~15 km/h).
 * Megjegyzés: a CAR routing autópályát is választhat; kivételhez OTP router-config / OSM szabály kell.
 */
const STREET_BIKE_SPEED_MPS = 4.2;

/** Gyaloglás max. távolság tömegközlekedéshez (m): állomás-megközelítés; túl szűk = kimaradhat a vonat */
const DEFAULT_TRANSIT_MAX_WALK_M = 8000;

/** Csak utcai bicikli (BICYCLE [+ WALK]), tömegközlekedés nélkül — így biztonságosan állítható az optimize. */
function isBicycleOnlyStreetMode(modeStr) {
  const parts = String(modeStr)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  const allowed = new Set(["BICYCLE", "WALK"]);
  return parts.every((p) => allowed.has(p)) && parts.includes("BICYCLE");
}

async function otpFetch(from, to, mode, extra = {}) {
  const { __carNoSchedule, __timeParams, maxWalkDistance: maxWalkOverride, __modesFilter: _mf, ...restExtra } = extra;
  const timeParams = __carNoSchedule ? {} : (__timeParams ?? getTimeParams());
  const mStr = String(mode);
  const walkCap =
    maxWalkOverride
    ?? (mStr.includes("BICYCLE") ? activeBikeLimitM : DEFAULT_TRANSIT_MAX_WALK_M);
  const baseReq = {
    fromPlace: `${from.lat},${from.lon}`,
    toPlace: `${to.lat},${to.lon}`,
    mode,
    numItineraries: 3,
    maxWalkDistance: walkCap,
    /**
     * OTP alapból gyakran „safe” = bringaút / alacsony forgalom előnyben.
     * quick = idő és gyorsabb utcák (autópálya továbbra is tiltva az OSM-ben biciklire).
     */
    ...(isBicycleOnlyStreetMode(mStr) && restExtra.optimize === undefined ? { optimize: "quick" } : {}),
    ...timeParams,
    ...restExtra,
  };
  /**
   * Bicikli + tömegközlekedés: a gyaloglás relatív költségét emeljük, hogy az OTP inkább utcai
   * BICYCLE lábat válasszon megközelítéshez/leejtéshez (ha van megfelelő biciklis hálózat).
   * Alapból a gyalog gyakran „nyer” a költségfüggvény szerint rövid szakaszokon is.
   */
  const bikeWithTransit =
    mStr.includes("BICYCLE") && /RAIL|BUS|TRAM|SUBWAY|FERRY|TROLLEY|COACH/i.test(mStr);
  if (
    bikeWithTransit
    && baseReq.walkReluctance === undefined
    && maxWalkOverride === undefined
  ) {
    baseReq.walkReluctance = 6;
  }
  /**
   * Ne kényszerítsünk fix searchWindow-t: az OTP 2 dinamikusan számolja, és arriveBy esetén
   * egy rosszul megválasztott ablak (főleg éjszakai járatok) üres választ adhat.
   * Csökkentett ablakot csak explicit extra-ból (pl. 172800) engedünk.
   */
  const params = new URLSearchParams(baseReq);
  let res;
  try {
    res = await fetch(`${OTP_BASE}?${params}`);
  } catch {
    throw new Error("Nem sikerült kapcsolódni az OTP szerverhez (localhost:8080).");
  }
  if (!res.ok) throw new Error(`OTP szerver hiba: ${res.status}`);
  return res.json();
}

/** OTP indulás-idő (arriveBy: false) epoch ms, egyébként null. */
function tpDepartRequestMs(tp) {
  if (!tp || tp.arriveBy !== false || !tp.date || !tp.time) return null;
  const dt = new Date(`${tp.date}T00:00:00`);
  const [hh, mm] = tp.time.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  dt.setHours(hh, mm, 0, 0);
  return dt.getTime();
}

function ensureDepartSearchWindow(modeStr, extra) {
  if (!String(modeStr).includes("TRANSIT")) return extra;
  if (extra.searchWindow != null) return extra;
  const tp = extra.__timeParams ?? getTimeParams();
  if (tpDepartRequestMs(tp) == null) return extra;
  return { ...extra, searchWindow: 28800 };
}

/**
 * Sorrend: alapból legrövidebb összidő (duration).
 * „Indulás időpontja” módban: csak a kért indulás utáni járatok, és közülük is **leggyorsabb** előre
 * (korábban tévesen a legkorábbi indulást részesítettük elő, ezért maradhatott lassú busz a gyorsabb vonat helyett).
 */
function orderDepartItineraries(list, orderingTp) {
  if (!list.length) return list;
  const req = tpDepartRequestMs(orderingTp);
  if (req == null) {
    return [...list].sort((a, b) => a.duration - b.duration);
  }
  const slack = 120000;
  const after = list.filter((it) => it.startTime >= req - slack);
  const pool = after.length ? after : list;
  return [...pool].sort((a, b) => {
    if (a.duration !== b.duration) return a.duration - b.duration;
    return a.startTime - b.startTime;
  });
}

function pickTransitItineraryPreferDepart(withTransit, tp) {
  const reqMs = tpDepartRequestMs(tp);
  if (reqMs == null) {
    withTransit.sort((a, b) => a.duration - b.duration);
    return withTransit[0];
  }
  const slack = 120000;
  const after = withTransit.filter((it) => it.startTime >= reqMs - slack);
  const pool = after.length ? after : withTransit;
  pool.sort((a, b) => {
    if (a.duration !== b.duration) return a.duration - b.duration;
    return a.startTime - b.startTime;
  });
  return pool[0];
}

/**
 * Ugyanaz a választás, mint a „tisztán tömegközlekedés” kártyán: OTP duration / indulás szerint.
 * Érkezésnél biciklis stitch csak erre szabad, különben másik járat „nyerhet” a (gyalog↔bicikli)
 * cserével a várt vonatnál (pl. 48 helyett 37).
 */
function pickBestRawItineraryForDepart(pureAll) {
  if (!pureAll?.length) return null;
  let best = null;
  const reqDep = requestedDepartMs();
  const withinReq =
    !isDepartScheduleMode()
    || reqDep == null;
  for (const it of pureAll) {
    const afterOk = withinReq || it.startTime >= reqDep - 120000;
    if (!afterOk) continue;
    if (
      !best
      || it.duration < best.duration
      || (it.duration === best.duration && it.startTime < best.startTime)
    ) {
      best = it;
    }
  }
  return best || pureAll[0];
}

// Fast probe: single best result, no intermediate stops (for scanning)
async function otpTransitFast(from, to, transitMode, timeExtra = {}) {
  const { __modesFilter, ...timeExtraRest } = timeExtra;
  const mode = transitMode ?? "TRANSIT,WALK";
  const tp = timeExtraRest.__timeParams ?? getTimeParams();
  let extra = ensureDepartSearchWindow(mode, { numItineraries: 3, ...timeExtraRest });
  const data = await otpFetch(from, to, mode, extra);
  if (data.error || !data.plan?.itineraries?.length) return null;
  let withTransit = data.plan.itineraries.filter((it) =>
    it.legs.some((l) => l.mode !== "WALK")
  );
  if (__modesFilter) {
    withTransit = withTransit.filter((it) => itineraryMatchesUserModes(it, __modesFilter));
  }
  if (!withTransit.length) {
    if (tpDepartRequestMs(tp) != null && (extra.searchWindow == null || extra.searchWindow < 86400)) {
      extra = { ...extra, searchWindow: 86400 };
      const data2 = await otpFetch(from, to, mode, extra);
      if (!data2.error && data2.plan?.itineraries?.length) {
        let w2 = data2.plan.itineraries.filter((it) => it.legs.some((l) => l.mode !== "WALK"));
        if (__modesFilter) w2 = w2.filter((it) => itineraryMatchesUserModes(it, __modesFilter));
        if (w2.length) return pickTransitItineraryPreferDepart(w2, tp);
      }
    }
    return null;
  }
  return pickTransitItineraryPreferDepart(withTransit, tp);
}

// Full query: multiple results with intermediate stops (for display)
async function otpTransit(from, to, transitMode, timeExtra) {
  const { __modesFilter, ...timeExtraRest } = timeExtra || {};
  const mode = transitMode ?? "TRANSIT,WALK";
  const data = await otpFetch(from, to, mode, { numItineraries: 5, showIntermediateStops: true, ...timeExtraRest });
  if (data.error || !data.plan?.itineraries?.length) return null;
  let withTransit = data.plan.itineraries.filter((it) =>
    it.legs.some((l) => l.mode !== "WALK")
  );
  if (__modesFilter) {
    withTransit = withTransit.filter((it) => itineraryMatchesUserModes(it, __modesFilter));
  }
  if (!withTransit.length) return null;
  withTransit.sort((a, b) => a.duration - b.duration);
  return withTransit[0];
}

function collectTransitItineraries(data) {
  if (data.error || !data.plan?.itineraries?.length) return [];
  return data.plan.itineraries.filter((it) => it.legs.some((l) => l.mode !== "WALK"));
}

async function otpTransitAll(from, to, transitMode, timeExtra = {}) {
  const { __modesFilter, ...timeExtraRest } = timeExtra;
  const mode = transitMode ?? "TRANSIT,WALK";
  const parts = mode.replace(",WALK", "").split(",").filter(Boolean);
  const orderingTp = timeExtraRest.__timeParams ?? getTimeParams();

  function baseExtra(over = {}) {
    return ensureDepartSearchWindow(mode, {
      numItineraries: 12,
      showIntermediateStops: true,
      ...timeExtraRest,
      ...over,
    });
  }

  let fetchExtra = baseExtra();
  let data = await otpFetch(from, to, mode, fetchExtra);
  let combined = collectTransitItineraries(data);

  const reqMs = tpDepartRequestMs(fetchExtra.__timeParams ?? orderingTp);
  if (!combined.length && reqMs != null && (fetchExtra.searchWindow == null || fetchExtra.searchWindow < 86400)) {
    fetchExtra = baseExtra({ searchWindow: 86400 });
    data = await otpFetch(from, to, mode, fetchExtra);
    combined = collectTransitItineraries(data);
  }

  if (!combined.length && reqMs != null) {
    const baseTp = timeExtraRest.__timeParams ?? getTimeParams();
    if (baseTp.arriveBy === false && baseTp.date && baseTp.time) {
      const steps = [15, 30, 45, 60, 90, 120];
      for (const addMin of steps) {
        const { date, time } = addCalendarMinutes(baseTp.date, baseTp.time, addMin);
        fetchExtra = baseExtra({
          __timeParams: { date, time, arriveBy: false },
          searchWindow: 28800,
        });
        data = await otpFetch(from, to, mode, fetchExtra);
        combined = collectTransitItineraries(data);
        if (combined.length) break;
      }
    }
  }

  if (parts.length > 1) {
    const perExtra = baseExtra({ numItineraries: 5 });
    const perMode = await Promise.allSettled(
      parts.map((m) => otpFetch(from, to, `${m},WALK`, { ...perExtra, numItineraries: 5 }))
    );
    for (const r of perMode) {
      if (r.status !== "fulfilled") continue;
      const d = r.value;
      for (const it of collectTransitItineraries(d)) combined.push(it);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const it of combined) {
    const sig = it.legs
      .filter((l) => l.mode !== "WALK")
      .map((l) => `${l.mode}:${l.from?.name}:${l.to?.name}`)
      .join("|");
    if (!seen.has(sig)) { seen.add(sig); unique.push(it); }
  }
  let ordered = orderDepartItineraries(unique, orderingTp);
  if (__modesFilter) {
    ordered = ordered.filter((it) => itineraryMatchesUserModes(it, __modesFilter));
  }
  return ordered;
}

/**
 * Utolsó járat módban: ha az első arriveBy (másnap hajnal) üres eredményt ad, próbáljuk
 * ugyanarra a napra 23:59 „odaérkezésig”, majd déli indulás referenciát — így több esetben
 * megegyezik a „ma még van járathoz hasonló” kereséssel.
 */
async function otpTransitAllWithLastTripFallback(from, to, transitMode, timeExtra = {}) {
  if (!isLastTripMode()) return otpTransitAll(from, to, transitMode, timeExtra);
  const base = planningDateStr();
  let list = await otpTransitAll(from, to, transitMode, timeExtra);
  if (list.length) return list;
  list = await otpTransitAll(from, to, transitMode, {
    ...timeExtra,
    __timeParams: lastTripTransitParamsSameDay(base),
  });
  if (list.length) return list;
  return otpTransitAll(from, to, transitMode, {
    ...timeExtra,
    __timeParams: lastTripDepartNoonFallback(base),
  });
}

async function otpCar(from, to) {
  const data = await otpFetch(from, to, "CAR", { numItineraries: 3, __carNoSchedule: isLastTripMode() });
  if (data.error || !data.plan?.itineraries?.length) {
    throw new Error("Nem található autós útvonal.");
  }
  return data.plan.itineraries[0];
}

/** CAR útvonal menetidejét bringa menetidőre cseréli (távolság arányosan); a koordináták változatlanok. */
function scaleItineraryToStreetBikeTime(it) {
  const legs = it.legs;
  if (!legs?.length) return it;
  const totalDist = legs.reduce((s, l) => s + (l.distance || 0), 0);
  const carDurSec = legs.reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);
  let totalBikeSec;
  if (totalDist >= 1) {
    totalBikeSec = totalDist / STREET_BIKE_SPEED_MPS;
  } else if (carDurSec > 0) {
    totalBikeSec = carDurSec * 0.35;
  } else {
    return it;
  }
  let cursor = legs[0].startTime;
  const newLegs = legs.map((leg) => {
    const ld = leg.distance || 0;
    let frac;
    if (totalDist >= 1) {
      frac = ld / totalDist;
    } else if (carDurSec > 0) {
      frac = ((leg.endTime - leg.startTime) / 1000) / carDurSec;
    } else {
      frac = 1 / legs.length;
    }
    const legBikeSec = totalBikeSec * frac;
    const ns = cursor;
    const ne = cursor + Math.round(legBikeSec * 1000);
    cursor = ne;
    return { ...leg, startTime: ns, endTime: ne };
  });
  return {
    ...it,
    legs: newLegs,
    duration: totalBikeSec,
    endTime: cursor,
  };
}

/** @param {'car'|'bike'} kind */
async function otpMotor(from, to, kind) {
  if (kind === "car") return otpCar(from, to);
  const data = await otpFetch(from, to, "CAR", {
    numItineraries: 3,
    __carNoSchedule: isLastTripMode(),
  });
  if (data.error || !data.plan?.itineraries?.length) {
    throw new Error("Nem található autós útvonal a bringa becsléshez.");
  }
  return scaleItineraryToStreetBikeTime(data.plan.itineraries[0]);
}

/** @param {'car'|'bike'} kind – szűrés max autó idő / max bicikli távolság szerint a hívóban */
async function motorRouteTo(from, to, kind) {
  try {
    const extra = { numItineraries: 1, __carNoSchedule: isLastTripMode() };
    const data = await otpFetch(from, to, "CAR", extra);
    if (data.error || !data.plan?.itineraries?.length) return null;
    const itRaw = data.plan.itineraries[0];
    const it = kind === "bike" ? scaleItineraryToStreetBikeTime(itRaw) : itRaw;
    const tl = buildTimeline(it);
    const last = tl[tl.length - 1];
    if (kind === "bike" && last.d > activeBikeLimitM) return null;
    if (kind === "bike" && last.d < MIN_MOTOR_BIKE_ROUTE_M) return null;
    return {
      coords: tl.map((p) => p.coord),
      sec: last.t,
      dist: last.d,
    };
  } catch {
    return null;
  }
}

/**
 * Csak érkezésnél bicikli: az OTP tömegközlekedéses válaszában gyakran marad utolsó lábnak gyalog.
 * Lekérünk külön útvonalat (CAR gráf, bringa menetidő — lásd scaleItineraryToStreetBikeTime), és a gyalogot ezzel helyettesítjük.
 * @returns {{ transit: object, motorEgress: { kind: 'bike', sec: number, dist: number, coords: any[] } } | null}
 */
async function stitchEgressBikeOverWalk(itinerary, destCoord) {
  const legs = itinerary.legs;
  if (!legs?.length) return null;
  const last = legs[legs.length - 1];
  if (last.mode !== "WALK") return null;
  const fromLat = last.from?.lat;
  const fromLon = last.from?.lon;
  if (fromLat == null || fromLon == null) return null;
  const bike = await motorRouteTo({ lat: fromLat, lon: fromLon }, destCoord, "bike");
  if (!bike || bike.dist < MIN_MOTOR_BIKE_ROUTE_M) return null;
  const walkSec = (last.endTime - last.startTime) / 1000;
  const newLegs = legs.slice(0, -1);
  const newDuration = itinerary.duration - walkSec + bike.sec;
  return {
    transit: {
      ...itinerary,
      legs: newLegs,
      duration: newDuration,
    },
    motorEgress: {
      kind: "bike",
      sec: bike.sec,
      dist: bike.dist,
      coords: bike.coords,
    },
  };
}

/**
 * Érkezésnél bicikli: az OTP gyakran „megvárja a következő napi helyijáratot” hosszú átszállással.
 * Ha valamely leszállás után bringával hamarabb és értelmesen oda lehet érni (max km), a maradék
 * tömegközlekedést + várakozást elhagyjuk.
 */
async function truncateTailForEgressBike(itinerary, destCoord) {
  const legs = itinerary.legs;
  if (!legs?.length) return null;

  const startMs = itinerary.startTime ?? legs[0].startTime;
  let best = null;

  for (let i = 0; i < legs.length; i++) {
    const alight = legs[i].to;
    if (alight?.lat == null || alight?.lon == null) continue;

    const remainingSec = (legs[legs.length - 1].endTime - legs[i].endTime) / 1000;
    if (remainingSec < 45 * 60) continue;

    const bike = await motorRouteTo({ lat: alight.lat, lon: alight.lon }, destCoord, "bike");
    if (!bike || bike.dist > activeBikeLimitM || bike.dist < MIN_MOTOR_BIKE_ROUTE_M) continue;

    const saved = remainingSec - bike.sec;
    if (saved < 600 && remainingSec < 3600) continue;

    if (!best || saved > best.saved) {
      best = { i, bike, saved };
    }
  }

  if (!best) return null;

  const kept = legs.slice(0, best.i + 1);
  const bikeEndMs = legs[best.i].endTime + best.bike.sec * 1000;
  const newDuration = (bikeEndMs - startMs) / 1000;

  return {
    transit: {
      ...itinerary,
      legs: kept,
      duration: newDuration,
    },
    motorEgress: {
      kind: "bike",
      sec: best.bike.sec,
      dist: best.bike.dist,
      coords: best.bike.coords,
    },
  };
}


/** Volán/helyközi busz, nem villamos/metró/vonat. */
function isBusLikeConnectorLeg(leg) {
  if (!leg) return false;
  if (leg.mode === "BUS" || leg.mode === "COACH") return true;
  return effectiveMode(leg) === "VOLAN_BUS";
}

/**
 * Érkezésnél autó: rövid csatlakozó busz (+ opcionális gyalog) helyett autó a busz indulási pontjától, max autóidőn belül.
 */
async function stitchEgressCarOverShortTailBus(itinerary, destCoord, maxCarSec) {
  const legs = itinerary.legs;
  if (!legs?.length || legs.length < 2) return null;

  const SHORT_BUS_MAX_SEC = 20 * 60;
  const SHORT_BUS_MAX_M = 8000;

  const last = legs[legs.length - 1];
  const prev = legs[legs.length - 2];

  let busLeg = null;
  let walkLeg = null;
  let keepUntilIdx = -1;

  if (last.mode === "WALK" && isBusLikeConnectorLeg(prev)) {
    const bd = (prev.endTime - prev.startTime) / 1000;
    const dist = prev.distance ?? 0;
    if (bd > SHORT_BUS_MAX_SEC || dist > SHORT_BUS_MAX_M) return null;
    busLeg = prev;
    walkLeg = last;
    keepUntilIdx = legs.length - 3;
  } else if (isBusLikeConnectorLeg(last)) {
    const bd = (last.endTime - last.startTime) / 1000;
    const dist = last.distance ?? 0;
    if (bd > SHORT_BUS_MAX_SEC || dist > SHORT_BUS_MAX_M) return null;
    busLeg = last;
    walkLeg = null;
    keepUntilIdx = legs.length - 2;
  } else {
    return null;
  }

  if (keepUntilIdx < 0) return null;

  const fromLat = busLeg.from?.lat;
  const fromLon = busLeg.from?.lon;
  if (fromLat == null || fromLon == null) return null;

  const car = await motorRouteTo({ lat: fromLat, lon: fromLon }, destCoord, "car");
  if (!car || car.sec > maxCarSec) return null;

  const tailSec =
    (busLeg.endTime - busLeg.startTime) / 1000
    + (walkLeg ? (walkLeg.endTime - walkLeg.startTime) / 1000 : 0);
  const newDuration = itinerary.duration - tailSec + car.sec;
  const newLegs = legs.slice(0, keepUntilIdx + 1);

  return {
    transit: {
      ...itinerary,
      legs: newLegs,
      duration: newDuration,
    },
    motorEgress: {
      kind: "car",
      sec: car.sec,
      dist: car.dist,
      coords: car.coords,
    },
  };
}

/**
 * Érkezésnél autó: ugyanaz a minta mint a biciklinél — az OTP záró WALK helyett külön CAR útvonal.
 * @param {number} maxCarSec — felhasználói max. autóidő (mp)
 */
async function stitchEgressCarOverWalk(itinerary, destCoord, maxCarSec) {
  const legs = itinerary.legs;
  if (!legs?.length) return null;
  const last = legs[legs.length - 1];
  if (last.mode !== "WALK") return null;
  const fromLat = last.from?.lat;
  const fromLon = last.from?.lon;
  if (fromLat == null || fromLon == null) return null;
  const car = await motorRouteTo({ lat: fromLat, lon: fromLon }, destCoord, "car");
  if (!car || car.sec > maxCarSec) return null;
  const walkSec = (last.endTime - last.startTime) / 1000;
  const newLegs = legs.slice(0, -1);
  const newDuration = itinerary.duration - walkSec + car.sec;
  return {
    transit: {
      ...itinerary,
      legs: newLegs,
      duration: newDuration,
    },
    motorEgress: {
      kind: "car",
      sec: car.sec,
      dist: car.dist,
      coords: car.coords,
    },
  };
}

/**
 * Indulásnál bicikli (P+R „mixed”): a motorút a szűrt megálló-csúcsig megy, az OTP viszont gyakran
 * hosszú WALK-ot ad onnan a járat tényleges felszállási pontjáig. Újratervezünk egybiciklit
 * induláspont → felszállás, és elhagyjuk a vezető gyaloglást.
 */
async function stitchAccessBikeAbsorbLeadingWalk(originCoord, candidate, baselineSec) {
  const ma = candidate.motorAccess;
  if (!ma || ma.kind !== "bike" || candidate.tag !== "mixed" || !candidate.transit?.legs?.length) {
    return null;
  }
  const legs = candidate.transit.legs;
  if (legs[0].mode !== "WALK") return null;
  const w = legs[0];
  const walkDist = w.distance ?? 0;
  if (walkDist < 250) return null;
  const toLat = w.to?.lat;
  const toLon = w.to?.lon;
  if (toLat == null || toLon == null) return null;
  const fullBike = await motorRouteTo(originCoord, { lat: toLat, lon: toLon }, "bike");
  if (!fullBike || fullBike.dist < MIN_MOTOR_BIKE_ROUTE_M || fullBike.dist > activeBikeLimitM) {
    return null;
  }
  const rest = legs.slice(1);
  if (!rest.length) return null;
  const walkSec = (w.endTime - w.startTime) / 1000;
  const newTransitDuration = candidate.transit.duration - walkSec;
  const newTransit = {
    ...candidate.transit,
    legs: rest,
    duration: newTransitDuration,
    startTime: rest[0].startTime,
  };
  const newTotalSec = fullBike.sec + newTransit.duration;
  return {
    ...candidate,
    motorAccess: {
      kind: "bike",
      sec: fullBike.sec,
      dist: fullBike.dist,
      coords: fullBike.coords,
    },
    transit: newTransit,
    switchBoard:
      toLat != null && toLon != null
        ? { lat: toLat, lon: toLon, name: w.to?.name || candidate.switchBoard?.name }
        : candidate.switchBoard,
    totalSec: newTotalSec,
    savedSec: baselineSec != null ? baselineSec - newTotalSec : candidate.savedSec,
  };
}

/**
 * Indulásnál autó (P+R): ha a max. autóidőbe még belefér, a vezető tömegközlekedési (és gyalog) lábakat
 * egy folyamatos autóúttal váltjuk ki (kevesebb átszállás, nincs felesleges rövid busz a parkolás után).
 */
async function stitchAccessCarAbsorbLeadingTransit(originCoord, candidate, maxCarSec, baselineSec) {
  const ma = candidate.motorAccess;
  if (!ma || ma.kind !== "car" || candidate.tag !== "mixed" || !candidate.transit?.legs?.length) {
    return null;
  }

  let legs = candidate.transit.legs;
  let dur = candidate.transit.duration;
  let motorAccess = { ...ma };
  let changed = false;

  while (legs.length > 1) {
    const first = legs[0];
    if (first.mode === "FERRY") break;

    const toLat = first.to?.lat;
    const toLon = first.to?.lon;
    if (toLat == null || toLon == null) break;

    const car = await motorRouteTo(originCoord, { lat: toLat, lon: toLon }, "car");
    if (!car || car.sec > maxCarSec) break;

    const nextStart = legs[1].startTime;
    const removedWallSec = (nextStart - first.startTime) / 1000;
    legs = legs.slice(1);
    dur -= removedWallSec;
    changed = true;
    motorAccess = {
      kind: "car",
      sec: car.sec,
      dist: car.dist,
      coords: car.coords,
    };
  }

  if (!changed) return null;

  const newTotalSec = motorAccess.sec + dur;
  const rest = legs;
  const from0 = rest[0]?.from;
  return {
    ...candidate,
    motorAccess,
    transit: {
      ...candidate.transit,
      legs: rest,
      duration: dur,
      startTime: rest[0]?.startTime ?? candidate.transit.startTime,
    },
    switchBoard:
      from0?.lat != null && from0?.lon != null
        ? { lat: from0.lat, lon: from0.lon, name: from0.name || candidate.switchBoard?.name }
        : candidate.switchBoard,
    totalSec: newTotalSec,
    savedSec: baselineSec != null ? baselineSec - newTotalSec : candidate.savedSec,
  };
}

/** OTP-láb: értelmetlenül rövid BICYCLE → WALK a megjelenítésben. */
function downgradeTrivialBikeLegs(itinerary) {
  if (!itinerary?.legs?.length) return itinerary;
  let changed = false;
  const legs = itinerary.legs.map((leg) => {
    if (leg.mode === "BICYCLE" && leg.distance != null && leg.distance < MIN_USEFUL_BIKE_M) {
      changed = true;
      return { ...leg, mode: "WALK" };
    }
    return leg;
  });
  return changed ? { ...itinerary, legs } : itinerary;
}

function normalizeShortBikeMotorSegOnCandidate(c) {
  const m = MIN_MOTOR_BIKE_ROUTE_M;
  if (c.motorAccess?.kind === "bike" && c.motorAccess.dist < m) {
    c.motorAccess = { ...c.motorAccess, kind: "walk" };
  }
  if (c.motorEgress?.kind === "bike" && c.motorEgress.dist < m) {
    c.motorEgress = { ...c.motorEgress, kind: "walk" };
  }
}

/** motorAccess / motorEgress: bike | walk (rövid „bicikli”) | car */
function motorSegUi(kind) {
  if (kind === "bike") return { dot: "bike", ic: "pedal_bike", lb: "Bicikli" };
  if (kind === "walk") return { dot: "walk", ic: "directions_walk", lb: "Gyaloglás" };
  return { dot: "car", ic: "directions_car", lb: "Autó" };
}

// ── Polyline decode → [lng, lat] ────────────────────────────────

function decodePolyline(encoded, precision = 5) {
  const f = 10 ** precision;
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    pts.push([lng / f, lat / f]);
  }
  return pts;
}

function simplifyCoords(coords, tolerance) {
  if (coords.length <= 2) return coords;
  let maxDist = 0, maxIdx = 0;
  const [sx, sy] = coords[0], [ex, ey] = coords[coords.length - 1];
  const dx = ex - sx, dy = ey - sy;
  const lenSq = dx * dx + dy * dy;
  for (let i = 1; i < coords.length - 1; i++) {
    const [px, py] = coords[i];
    let dist;
    if (lenSq === 0) {
      dist = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
    } else {
      const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lenSq));
      dist = Math.sqrt((px - sx - t * dx) ** 2 + (py - sy - t * dy) ** 2);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = simplifyCoords(coords.slice(0, maxIdx + 1), tolerance);
    const right = simplifyCoords(coords.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [coords[0], coords[coords.length - 1]];
}

function legCoords(leg) {
  /** Transitous: a lábat már dekódolt koordinátákkal kapjuk (_coords), más polyline-pontossággal. */
  const raw = leg._coords?.length
    ? leg._coords
    : leg.legGeometry
      ? decodePolyline(leg.legGeometry.points)
      : [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]];
  if (leg.mode === "WALK") return simplifyCoords(raw, 0.0001);
  return raw;
}

// ── Car timeline ────────────────────────────────────────────────

function buildTimeline(carIt) {
  const tl = [];
  let cumT = 0, cumD = 0;
  for (const leg of carIt.legs) {
    const pts = legCoords(leg);
    const dur = (leg.endTime - leg.startTime) / 1000;
    const dist = leg.distance || 0;
    for (let i = 0; i < pts.length; i++) {
      const f = pts.length > 1 ? i / (pts.length - 1) : 0;
      tl.push({ coord: pts[i], t: cumT + f * dur, d: cumD + f * dist });
    }
    cumT += dur;
    cumD += dist;
  }
  return tl;
}

function cutAt(tl, sec) {
  let ci = tl.length - 1;
  for (let i = 0; i < tl.length; i++) { if (tl[i].t >= sec) { ci = i; break; } }
  ci = Math.max(1, ci);
  const sl = tl.slice(0, ci + 1);
  const last = sl[sl.length - 1];
  return {
    coords: sl.map((s) => s.coord),
    point: { lat: last.coord[1], lon: last.coord[0] },
    sec: last.t,
    dist: last.d,
  };
}

// ── Mode helpers ────────────────────────────────────────────────

function detectAgency(leg) {
  const rid = (leg.routeId || "").toUpperCase();
  const aid = (leg.agencyId || "").toUpperCase();
  if (rid.startsWith("VOLAN") || aid.includes("VOLAN")) return "VOLAN";
  if (rid.startsWith("MAV") || aid.includes("MAV")) return "MAV";
  return "BKK";
}

function effectiveMode(leg) {
  if (leg.mode === "RAIL" && /^H\d/.test(leg.routeShortName || "")) return "HEV";
  if (leg.mode === "BUS" && detectAgency(leg) === "VOLAN") return "VOLAN_BUS";
  /** Transitous: a helyközi (volt Volán) buszok COACH módként jönnek. */
  if (leg.mode === "COACH") return "VOLAN_BUS";
  return leg.mode;
}

/**
 * A közlekedési chip-ekhez igazítja az útvonalat. OTP-ben RAIL = vasút (MÁV + HÉV); a két chipet
 * effectiveMode alapján választjuk szét (HÉV: routeShortName H…).
 */
function itineraryMatchesUserModes(it, modes) {
  if (!it?.legs?.length || !modes) return true;
  for (const leg of it.legs) {
    if (leg.mode === "WALK" || leg.mode === "BICYCLE") continue;
    if (leg.mode === "RAIL") {
      const isHev = effectiveMode(leg) === "HEV";
      if (isHev) {
        if (!modes.has("HEV")) return false;
      } else if (!modes.has("RAIL")) {
        return false;
      }
      continue;
    }
    if (leg.mode === "BUS" || leg.mode === "COACH" || leg.mode === "TROLLEY") {
      if (!modes.has("BUS")) return false;
      continue;
    }
    if (leg.mode === "TRAM") {
      if (!modes.has("TRAM")) return false;
      continue;
    }
    if (leg.mode === "SUBWAY") {
      if (!modes.has("SUBWAY")) return false;
      continue;
    }
  }
  return true;
}

function modeCat(m) {
  if (m === "CAR") return "car";
  /** Transitous saját pontnál: parkolás + várakozás (nem gyaloglás, nem jármű). */
  if (m === "WAIT") return "walk";
  if (m === "BICYCLE" || m === "RENTAL") return "bike";
  if (m === "WALK") return "walk";
  return "transit";
}

// Google Maps Hungary color scheme
function modeColor(mode) {
  const colors = {
    CAR: "#ef4444",
    BUS: "#009CE0",            // BKK helyi busz – kék
    VOLAN_BUS: "#F4811F",      // Volánbusz – narancs
    RAIL: "#00897B",           // MÁV vonat – türkiz/teal
    HEV: "#1565C0",            // HÉV – fallback, ha nincs vonalszám
    TRAM: "#D4A017",           // Villamos – sárga/arany
    SUBWAY: "#00A651",         // Metró – fallback (M4 zöldhöz közel)
    WALK: "#9ca3af",
    BICYCLE: "#0ea5e9",
    RENTAL: "#7cb518",         // MOL Bubi – zöld
    FERRY: "#0e7490",
    FUNICULAR: "#8d6e63",
    AERIAL_LIFT: "#8d6e63",
    car: "#ef4444", transit: "#3b82f6", walk: "#9ca3af", bike: "#0ea5e9",
  };
  return colors[mode] || "#3b82f6";
}

function budapestMetroLineColor(leg) {
  const pool = [leg.routeShortName, leg.routeLongName, leg.routeId].filter(Boolean).join(" ");
  const s = pool.toUpperCase();
  const byLine = { "1": "#E4C400", "2": "#E30613", "3": "#0066CC", "4": "#00A651" };
  const m = s.match(/\bM\s*([1-4])\b/) || s.match(/\bMETRO\s*([1-4])\b/);
  if (m) return byLine[m[1]];
  if (leg.mode === "SUBWAY") {
    const rs = (leg.routeShortName || "").trim();
    if (/^[1-4]$/.test(rs)) return byLine[rs];
  }
  return null;
}

function budapestHevLineColor(leg) {
  const pool = [leg.routeShortName, leg.routeLongName, leg.routeId].filter(Boolean).join(" ");
  const s = pool.toUpperCase();
  const m = s.match(/\bH\s*([5-9])\b/);
  if (!m) return null;
  const map = {
    "5": "#5D9731",
    "6": "#0066B3",
    "7": "#6B2D86",
    "8": "#E87722",
    "9": "#C62828",
  };
  return map[m[1]] || null;
}

function transitLegColor(leg) {
  const eMode = effectiveMode(leg);
  if (eMode === "SUBWAY") {
    const c = budapestMetroLineColor(leg);
    if (c) return c;
  }
  if (eMode === "HEV") {
    const c = budapestHevLineColor(leg);
    if (c) return c;
  }
  return modeColor(eMode);
}

function hexGlow(hex, alpha = 0.4) {
  if (!hex || hex[0] !== "#" || hex.length < 7) return `rgba(59,130,246,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function modeGlow(mode) {
  const c = modeColor(mode);
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.4)`;
}

function mi(name) {
  return `<span class="mi">${name}</span>`;
}

function modeIcon(mode) {
  const icons = {
    BUS: "directions_bus", VOLAN_BUS: "directions_bus", RAIL: "train",
    HEV: "directions_railway", TRAM: "tram", SUBWAY: "subway",
    FERRY: "directions_boat", WALK: "directions_walk", CAR: "directions_car",
    BICYCLE: "pedal_bike", RENTAL: "pedal_bike",
    FUNICULAR: "funicular", AERIAL_LIFT: "landscape",
  };
  return mi(icons[mode] || "departure_board");
}

function modeLabel(mode) {
  const l = {
    CAR: "Autó", WALK: "Gyaloglás", BICYCLE: "Bicikli",
    BUS: "Busz", VOLAN_BUS: "Távolsági busz",
    RAIL: "Vonat", HEV: "HÉV",
    TRAM: "Villamos", SUBWAY: "Metró", FERRY: "Hajó",
    RENTAL: "Bérbicikli", FUNICULAR: "Sikló", AERIAL_LIFT: "Libegő",
  };
  return l[mode] || mode;
}

function legName(leg) {
  if (leg.mode === "RENTAL") return leg.rental?.systemName || "Bérbicikli";
  const eMode = effectiveMode(leg);
  const short = leg.routeShortName || "";
  const label = modeLabel(eMode);
  return short ? `${label} ${short}` : label;
}

function legDetail(leg) {
  const from = leg.from?.name || "?";
  const to = leg.to?.name || "?";
  return `${from} → ${to}`;
}

function fmt(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} perc`;
  return `${Math.floor(m / 60)} óra ${m % 60} perc`;
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
}

/** Lábak összideje egy adott módra (Transitous: az autó/Bubi szakasz is a lábak között van). */
function legsSec(c, mode) {
  if (!c.transit?.legs?.length) return 0;
  return c.transit.legs
    .filter((l) => l.mode === mode)
    .reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);
}

function totalCarMotorSec(c) {
  let s = 0;
  if (c.motorAccess?.kind === "car") s += c.motorAccess.sec;
  if (c.motorEgress?.kind === "car") s += c.motorEgress.sec;
  return s + legsSec(c, "CAR");
}

function totalRentalSec(c) {
  return legsSec(c, "RENTAL");
}

function totalBikeMotorSec(c) {
  let s = 0;
  if (c.motorAccess?.kind === "bike") s += c.motorAccess.sec;
  if (c.motorEgress?.kind === "bike") s += c.motorEgress.sec;
  return s;
}

/** OTP-lábak: BICYCLE (utcai), nem gyalog. */
function totalTransitBicycleSec(c) {
  if (!c.transit?.legs?.length) return 0;
  return c.transit.legs
    .filter((l) => l.mode === "BICYCLE")
    .reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);
}

/** Összes biciklis idő (P+R motor + OTP BICYCLE láb) — összefoglaló sorhoz. */
function totalBikeTimeSec(c) {
  return totalBikeMotorSec(c) + totalTransitBicycleSec(c);
}

function totalMotorSec(c) {
  return (c.motorAccess?.sec || 0) + (c.motorEgress?.sec || 0);
}

// ── Map drawing ─────────────────────────────────────────────────

let hoverPopup = null;
let routeLayerIds = [];

function clearRoute() {
  routeLayerIds.forEach((id) => {
    try { map.removeLayer(id); } catch {}
    try { map.removeSource(id); } catch {}
  });
  routeLayerIds = [];
  activeMarkers.forEach((m) => m.remove());
  activeMarkers = [];
  if (hoverPopup) { hoverPopup.remove(); hoverPopup = null; }
}

function mkEl(color, size, glow) {
  const el = document.createElement("div");
  const glowCSS = glow ? `, 0 0 12px ${glow}` : "";
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid rgba(255,255,255,0.9);box-shadow:0 2px 8px rgba(0,0,0,.35)${glowCSS};cursor:pointer;transition:box-shadow .2s;`;
  el.addEventListener("mouseenter", () => {
    el.style.boxShadow = `0 2px 8px rgba(0,0,0,.35), 0 0 18px ${glow || "rgba(255,255,255,0.3)"}`;
  });
  el.addEventListener("mouseleave", () => {
    el.style.boxShadow = `0 2px 8px rgba(0,0,0,.35)${glowCSS}`;
  });
  return el;
}

function addLine(coords, cat, tooltipHtml, color) {
  const id = `${ROUTE_PREFIX}${layerCounter++}`;
  map.addSource(id, {
    type: "geojson",
    data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } },
  });
  const paint = {
    "line-color": color || modeColor(cat),
    "line-width": cat === "walk" ? 4 : cat === "bike" ? 5 : 7,
    "line-opacity": cat === "walk" ? 0.55 : 0.88,
  };
  if (cat === "walk") paint["line-dasharray"] = [2, 2.5];
  map.addLayer({
    id, type: "line", source: id,
    layout: { "line-join": "round", "line-cap": "round" },
    paint,
  });
  routeLayerIds.push(id);

  if (tooltipHtml) {
    map.on("mouseenter", id, (e) => {
      map.getCanvas().style.cursor = "pointer";
      if (hoverPopup) hoverPopup.remove();
      hoverPopup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false,
        offset: 14, className: "hover-popup", maxWidth: "300px",
      })
        .setLngLat(e.lngLat)
        .setHTML(tooltipHtml)
        .addTo(map);
    });
    map.on("mousemove", id, (e) => {
      if (hoverPopup) hoverPopup.setLngLat(e.lngLat);
    });
    map.on("mouseleave", id, () => {
      map.getCanvas().style.cursor = mapClickTarget ? "crosshair" : "";
      if (hoverPopup) { hoverPopup.remove(); hoverPopup = null; }
    });
  }
}

function addMarker(lngLat, color, size, popupHtml, glow) {
  const popup = new maplibregl.Popup({ offset: 16, closeButton: false, maxWidth: "300px" }).setHTML(popupHtml);
  const m = new maplibregl.Marker({ element: mkEl(color, size, glow) })
    .setLngLat(lngLat).setPopup(popup).addTo(map);
  activeMarkers.push(m);
}

function drawMotorLine(bounds, seg) {
  if (!seg || seg.coords.length < 2) return;
  const cat = seg.kind === "bike" ? "bike" : seg.kind === "walk" ? "walk" : "car";
  const label = seg.kind === "bike" ? "Bicikli" : seg.kind === "walk" ? "Gyaloglás" : "Autó";
  const icon = seg.kind === "bike" ? "pedal_bike" : seg.kind === "walk" ? "directions_walk" : "directions_car";
  const colorMode = seg.kind === "bike" ? "BICYCLE" : seg.kind === "walk" ? "WALK" : "CAR";
  seg.coords.forEach((c) => bounds.extend(c));
  addLine(
    seg.coords,
    cat,
    `${mi(icon)} <b>${label}</b><br>${fmtDist(seg.dist)} · ${fmt(seg.sec)}`,
    modeColor(colorMode),
  );
}

function drawRoute(candidate) {
  clearRoute();
  layerCounter = 0;
  const bounds = new maplibregl.LngLatBounds();

  if (candidate.motorAccess) drawMotorLine(bounds, candidate.motorAccess);
  if (candidate.motorEgress) drawMotorLine(bounds, candidate.motorEgress);

  if (candidate.transit.legs.length) {
    candidate.transit.legs.forEach((leg) => {
      const eMode = effectiveMode(leg);
      const cat = modeCat(leg.mode);
      const coords = legCoords(leg);
      coords.forEach((c) => bounds.extend(c));
      const dur = (leg.endTime - leg.startTime) / 1000;

      let tooltip;
      if (cat === "transit") {
        tooltip = `${modeIcon(eMode)} <b>${legName(leg)}</b><br>` +
          `${leg.from.name || "?"} → ${leg.to.name || "?"}<br>` +
          `<small>${fmt(dur)}</small>`;
      } else if (leg.mode === "RENTAL") {
        tooltip = `${mi("pedal_bike")} <b>${legName(leg)}</b><br>` +
          `${leg.from.name || "?"} → ${leg.to.name || "?"}<br>` +
          `<small>${fmtDist(leg.distance || 0)} · ${fmt(dur)}</small>`;
      } else if (cat === "car") {
        tooltip = `${mi("directions_car")} <b>Autó</b><br>${fmtDist(leg.distance || 0)} · ${fmt(dur)}`;
      } else if (cat === "bike") {
        tooltip = `${mi("pedal_bike")} <b>Bicikli</b><br>${fmtDist(leg.distance || 0)} · ${fmt(dur)}`;
      } else {
        tooltip = `${mi("directions_walk")} <b>${leg._label || "Gyaloglás"}</b><br>${fmtDist(leg.distance || 0)} · ${fmt(dur)}`;
      }
      const legLineColor =
        cat === "transit" ? transitLegColor(leg) : leg.mode === "RENTAL" ? modeColor("RENTAL") : null;
      addLine(coords, cat, tooltip, legLineColor);

      if (leg.mode === "RENTAL") {
        const g = hexGlow(legLineColor, 0.4);
        addMarker(
          [leg.from.lon, leg.from.lat], legLineColor, 14,
          `<b>${mi("pedal_bike")} ${legName(leg)}</b><br><b>Kölcsönzés</b><br>${leg.from.name || "?"}`,
          g,
        );
        addMarker(
          [leg.to.lon, leg.to.lat], legLineColor, 14,
          `<b>${mi("pedal_bike")} ${legName(leg)}</b><br><b>Leadás</b><br>${leg.to.name || "?"}`,
          g,
        );
      }

      if (cat === "transit") {
        const g = hexGlow(legLineColor, 0.4);
        addMarker(
          [leg.from.lon, leg.from.lat], legLineColor, 14,
          `<b>${modeIcon(eMode)} ${legName(leg)}</b><br>` +
          `<b>${mi("trip_origin")} Felszállás</b><br>${leg.from.name || "?"}<br>` +
          `<small>${fmtTime(leg.startTime)}</small>`,
          g,
        );
        addMarker(
          [leg.to.lon, leg.to.lat], legLineColor, 14,
          `<b>${modeIcon(eMode)} ${legName(leg)}</b><br>` +
          `<b>${mi("location_on")} Leszállás</b><br>${leg.to.name || "?"}<br>` +
          `<small>${fmtTime(leg.endTime)}</small>`,
          g,
        );
      }
    });

    /** Transitous: az autó/saját bicikli láb a lábak között van — átszállási jelölő a P+R ponton. */
    const legs = candidate.transit.legs;
    const isTransitLeg = (l) => modeCat(l.mode) === "transit";
    legs.forEach((leg, i) => {
      if (leg.mode !== "CAR" && leg.mode !== "BICYCLE") return;
      const ui = motorSegUi(leg.mode === "CAR" ? "car" : "bike");
      const dur = (leg.endTime - leg.startTime) / 1000;
      if (legs.slice(i + 1).some(isTransitLeg)) {
        addMarker(
          [leg.to.lon, leg.to.lat], "#f59e0b", 20,
          `<b>${mi("swap_horiz")} Átszállás</b><br>${mi(ui.ic)} ${ui.lb} → ${mi("departure_board")} Tömegközlekedés<br>` +
            `${leg.to.name ? `${leg.to.name}<br>` : ""}<small>${mi("schedule")} ${fmt(dur)}</small>`,
          "rgba(245,158,11,0.4)",
        );
      } else if (legs.slice(0, i).some(isTransitLeg)) {
        addMarker(
          [leg.from.lon, leg.from.lat], "#f59e0b", 20,
          `<b>${mi("swap_horiz")} Átszállás</b><br>${mi("departure_board")} Tömegközlekedés → ${mi(ui.ic)} ${ui.lb}<br>` +
            `${leg.from.name ? `${leg.from.name}<br>` : ""}<small>${mi("schedule")} ${fmt(dur)}</small>`,
          "rgba(245,158,11,0.4)",
        );
      }
    });
  }

  if (candidate.switchBoard && candidate.motorAccess && candidate.transit.legs.length) {
    const accUi = motorSegUi(candidate.motorAccess.kind);
    const k = accUi.lb;
    const ic = accUi.ic;
    addMarker(
      [candidate.switchBoard.lon, candidate.switchBoard.lat],
      "#f59e0b",
      20,
      `<b>${mi("swap_horiz")} Átszállás</b><br>${mi(ic)} ${k} → ${mi("departure_board")} Tömegközlekedés<br>` +
        `<small>${mi("schedule")} ${fmt(candidate.motorAccess.sec)}</small>`,
      "rgba(245,158,11,0.4)",
    );
  }
  if (candidate.switchAlight && candidate.motorEgress && candidate.transit.legs.length) {
    const egrUi = motorSegUi(candidate.motorEgress.kind);
    const k = egrUi.lb;
    const ic = egrUi.ic;
    addMarker(
      [candidate.switchAlight.lon, candidate.switchAlight.lat],
      "#f59e0b",
      20,
      `<b>${mi("swap_horiz")} Átszállás</b><br>${mi("departure_board")} Tömegközlekedés → ${mi(ic)} ${k}<br>` +
        `<small>${mi("schedule")} ${fmt(candidate.motorEgress.sec)}</small>`,
      "rgba(245,158,11,0.4)",
    );
  }

  let startLL = null;
  if (candidate.motorAccess?.coords?.length > 1) {
    startLL = candidate.motorAccess.coords[0];
  } else if (candidate.transit.legs.length) {
    startLL = [candidate.transit.legs[0].from.lon, candidate.transit.legs[0].from.lat];
  }
  if (startLL) {
    addMarker(startLL, "#22c55e", 18, `<b>${mi("flag")} Indulás</b>`, "rgba(34,197,94,0.4)");
  }

  let endLL = null;
  if (candidate.motorEgress?.coords?.length > 1) {
    endLL = candidate.motorEgress.coords[candidate.motorEgress.coords.length - 1];
  } else if (candidate.transit.legs.length) {
    const lastLeg = candidate.transit.legs[candidate.transit.legs.length - 1];
    endLL = [lastLeg.to.lon, lastLeg.to.lat];
  } else if (candidate.motorAccess?.coords?.length > 1) {
    endLL = candidate.motorAccess.coords[candidate.motorAccess.coords.length - 1];
  }
  if (endLL) {
    addMarker(endLL, "#6366f1", 18, `<b>${mi("sports_score")} Érkezés</b>`, "rgba(99,102,241,0.4)");
  }

  collapseAttribOnNarrow();
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: mapPadding(), maxZoom: 14 });
}

// ── Render results panel ────────────────────────────────────────

function renderAlternatives(candidates, selectedIdx) {
  resultsDiv.innerHTML = "";
  if (departScheduleNote) {
    const bar = document.createElement("div");
    bar.className = "schedule-note";
    bar.setAttribute("role", "status");
    bar.textContent = departScheduleNote;
    resultsDiv.appendChild(bar);
  }

  // ── Compute badges (each badge goes to exactly one route) ────
  candidates.forEach((c) => { c.badges = []; });

  const nonPureCar = candidates.filter((c) => c.tag !== "pureCar");
  const withTransit = nonPureCar.filter(
    (c) => c.transit.legs.some((l) => l.mode !== "WALK")
  );

  function pickBest(pool, valueFn) {
    if (!pool.length) return null;
    const minVal = Math.min(...pool.map(valueFn));
    const tied = pool.filter((c) => valueFn(c) === minVal);
    tied.sort((a, b) => a.totalSec - b.totalSec);
    return tied[0];
  }

  // ⚡ Fastest
  const fastest = pickBest(nonPureCar, (c) => c.totalSec);
  if (fastest) {
    fastest.badges.push({ label: `${mi("bolt")} Leggyorsabb`, cls: "badge-fastest" });
  }

  // 🔄 Fewest transfers
  if (withTransit.length > 0) {
    withTransit.forEach((c) => {
      c._transfers = Math.max(
        0,
        c.transit.legs.filter((l) => modeCat(l.mode) === "transit").length - 1,
      );
    });
    const best = pickBest(withTransit, (c) => c._transfers);
    if (best) {
      best.badges.push({ label: `${mi("sync_alt")} Legkevesebb átszállás`, cls: "badge-transfers" });
    }
  }

  // 🚶 Least walking
  if (nonPureCar.length > 0) {
    nonPureCar.forEach((c) => {
      c._walkSec = c.transit.legs
        .filter((l) => l.mode === "WALK")
        .reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);
    });
    const best = pickBest(nonPureCar, (c) => c._walkSec);
    if (best) {
      best.badges.push({ label: `${mi("directions_walk")} Legkevesebb gyaloglás`, cls: "badge-walk" });
    }
  }

  // 🌿 Least car time (among P+R mixed routes)
  const prRoutes = candidates.filter(
    (c) => totalCarMotorSec(c) > 0 && c.transit.legs.length > 0 && c.tag !== "pureCar"
  );
  if (prRoutes.length > 0) {
    const best = pickBest(prRoutes, (c) => totalCarMotorSec(c));
    if (best) {
      best.badges.push({ label: `${mi("eco")} Legkevesebb autózás`, cls: "badge-green" });
    }
  }

  // 🕐 Earliest arrival (absolute time, not duration)
  const withTimes = nonPureCar.filter(
    (c) => c.transit.legs.length > 0 && c.transit.legs[c.transit.legs.length - 1].endTime
  );
  if (withTimes.length > 0) {
    withTimes.forEach((c) => {
      const lastLeg = c.transit.legs[c.transit.legs.length - 1];
      c._arriveMs = lastLeg.endTime + (c.motorEgress ? c.motorEgress.sec * 1000 : 0);
    });
    const best = pickBest(withTimes, (c) => c._arriveMs);
    if (best && best !== fastest) {
      best.badges.push({ label: `${mi("schedule")} Legkorábbi érkezés`, cls: "badge-earliest" });
    }
  }

  // ⭐ Best overall (route with most badges = best in most categories)
  const maxBadges = Math.max(...nonPureCar.map((c) => c.badges.length), 0);
  if (maxBadges >= 2) {
    const best = pickBest(
      nonPureCar.filter((c) => c.badges.length === maxBadges),
      (c) => c.totalSec
    );
    if (best) {
      best.badges.unshift({
        label: `${mi("star")} Legjobbra`,
        cls: "badge-best",
      });
    }
  }

  // ── Filter: only keep candidates with badges or special tags ─
  const allCandidates = candidates;
  const filtered = allCandidates.filter((c) =>
    c.badges.length > 0
    || c.tag === "pureCar"
    || c.tag === "pureStreetBike"
    || c.tag === "pureTransit"
    || c.tag === "bikeTransit"
    || c.tag === "bikeModeNoBike"
    || c.tag === "pureRental"
    || c.showAlways
  );

  // Resolve selected candidate
  let sel = typeof selectedIdx === "number" ? allCandidates[selectedIdx] : selectedIdx;
  if (!filtered.includes(sel) && filtered.length) {
    /** A kijelölt (kirajzolt) útvonalat a szűrő kiejtette: a térkép kövesse a listában elsőt. */
    sel = filtered[0];
    drawRoute(sel);
  }

  // ── Render cards ────────────────────────────────────────────
  filtered.forEach((c, idx) => {
    const card = document.createElement("div");
    const pureMod =
      c.tag === "pureCar"
        ? " alt-card--pure-car"
        : c.tag === "pureTransit"
          ? " alt-card--pure-transit"
          : "";
    card.className = "alt-card" + pureMod + (c === sel ? " selected" : "");
    card.onclick = () => {
      drawRoute(c);
      renderAlternatives(allCandidates, c);
    };

    const isPureCar = c.tag === "pureCar";
    const isPureStreetBike = c.tag === "pureStreetBike";
    const isPureTransit = c.tag === "pureTransit";
    const totalSec = c.totalSec;

    const transitSec = c.transit.legs
      .filter((l) => modeCat(l.mode) === "transit")
      .reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);
    const walkSec = c.transit.legs
      .filter((l) => l.mode === "WALK")
      .reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);

    // Compute departure / arrival times
    let departTimeStr = "", arriveTimeStr = "";
    if (c.transit.legs.length) {
      const firstLeg = c.transit.legs[0];
      const lastLeg = c.transit.legs[c.transit.legs.length - 1];
      const transitDepartMs = firstLeg.startTime;
      const transitArriveMs = lastLeg.endTime;
      const overallDepartMs = transitDepartMs - (c.motorAccess ? c.motorAccess.sec * 1000 : 0);
      const overallArriveMs = transitArriveMs + (c.motorEgress ? c.motorEgress.sec * 1000 : 0);
      departTimeStr = fmtTime(overallDepartMs);
      arriveTimeStr = fmtTime(overallArriveMs);
    }

    let legsHtml = "";

    if (c.motorAccess) {
      const a = motorSegUi(c.motorAccess.kind);
      const dot = a.dot;
      const ic = a.ic;
      const lb = a.lb;
      legsHtml += `<div class="leg-item"><span class="leg-dot ${dot}"></span>
        <span>${mi(ic)} ${lb} (${fmtDist(c.motorAccess.dist)})</span>
        <span class="leg-right">${fmt(c.motorAccess.sec)}</span></div>`;
    }

    let prevEndTime = null;
    c.transit.legs.forEach((leg) => {
      const eMode = effectiveMode(leg);
      const cat = modeCat(leg.mode);
      const dur = (leg.endTime - leg.startTime) / 1000;

      // Waiting time between legs
      if (prevEndTime !== null && cat === "transit") {
        const waitSec = (leg.startTime - prevEndTime) / 1000;
        if (waitSec > 60) {
          legsHtml += `<div class="leg-item leg-wait"><span class="leg-dot wait"></span>
            <span>${mi("hourglass_empty")} Várakozás</span>
            <span class="leg-right">${fmt(waitSec)}</span></div>`;
        }
      }

      if (cat === "transit") {
        const lc = transitLegColor(leg);
        legsHtml += `<div class="leg-item"><span class="leg-dot" style="background:${lc};box-shadow:0 0 4px ${hexGlow(lc, 0.28)}"></span>
          <span>${modeIcon(eMode)} <b>${legName(leg)}</b></span>
          <span class="leg-right">${fmtTime(leg.startTime)} – ${fmtTime(leg.endTime)}</span></div>
          <div class="leg-stops">${leg.from.name || "?"} → ${leg.to.name || "?"}</div>`;
        prevEndTime = leg.endTime;
      } else if (leg.mode === "WAIT") {
        legsHtml += `<div class="leg-item leg-wait"><span class="leg-dot wait"></span>
          <span>${mi(leg._icon || "hourglass_empty")} ${leg._label || "Várakozás"}</span>
          <span class="leg-right">${fmt(dur)}</span></div>`;
        prevEndTime = leg.endTime;
      } else if (leg.mode === "CAR") {
        legsHtml += `<div class="leg-item"><span class="leg-dot car"></span>
          <span>${mi("directions_car")} Autó (${fmtDist(leg.distance || 0)})</span>
          <span class="leg-right">${fmt(dur)}</span></div>`;
        prevEndTime = leg.endTime;
      } else if (leg.mode === "RENTAL") {
        const rc = modeColor("RENTAL");
        legsHtml += `<div class="leg-item"><span class="leg-dot" style="background:${rc};box-shadow:0 0 4px ${hexGlow(rc, 0.28)}"></span>
          <span>${mi("pedal_bike")} <b>${legName(leg)}</b> (${fmtDist(leg.distance || 0)})</span>
          <span class="leg-right">${fmt(dur)}</span></div>
          <div class="leg-stops">${leg.from.name || "?"} → ${leg.to.name || "?"}</div>`;
        prevEndTime = leg.endTime;
      } else if (leg.mode === "BICYCLE") {
        legsHtml += `<div class="leg-item"><span class="leg-dot bike"></span>
          <span>${mi("pedal_bike")} Bicikli (${fmtDist(leg.distance || 0)})</span>
          <span class="leg-right">${fmt(dur)}</span></div>`;
        prevEndTime = leg.endTime;
      } else if (
        leg.mode === "WALK" &&
        (dur > 120 || (leg.distance || 0) >= 20)
      ) {
        legsHtml += `<div class="leg-item"><span class="leg-dot walk"></span>
          <span>${mi(leg._icon || "directions_walk")} ${leg._label || "Gyaloglás"}${leg._noDist ? "" : ` (${fmtDist(leg.distance || 0)})`}</span>
          <span class="leg-right">${fmt(dur)}</span></div>`;
        prevEndTime = leg.endTime;
      } else {
        prevEndTime = leg.endTime;
      }
    });

    if (c.motorEgress) {
      const e = motorSegUi(c.motorEgress.kind);
      const dot = e.dot;
      const ic = e.ic;
      const lb = e.lb;
      legsHtml += `<div class="leg-item"><span class="leg-dot ${dot}"></span>
        <span>${mi(ic)} ${lb} (${fmtDist(c.motorEgress.dist)})</span>
        <span class="leg-right">${fmt(c.motorEgress.sec)}</span></div>`;
    }

    // Rank labels (only for special categories, no numbering)
    let rankLabel = "";
    /** Autós / biciklis / saját pontos változatban MOL Bubi is van (pl. vonat a Keletiig, onnan Bubi). */
    const withBubi = c.tag !== "rentalTransit" && c.tag !== "pureRental"
      && c.transit?.legs?.some((l) => l.mode === "RENTAL") ? " + MOL Bubi" : "";
    if (isPureCar) {
      rankLabel = `${mi("directions_car")} Tisztán autó`;
    } else if (isPureStreetBike) {
      rankLabel = BACKEND === "transitous"
        ? `${mi("pedal_bike")} Tisztán biciklivel`
        : `${mi("pedal_bike")} Tisztán bringa (utcai, max km)`;
    } else if (c.customPoint) {
      rankLabel = `${mi("push_pin")} Saját pont: ${c.customPoint}${withBubi}`;
    } else if (c.tag === "mixed" && c.transit.legs.some((l) => l.mode === "CAR")) {
      /** Transitous P+R: az autóláb a lábak között; az első nem gyalogos láb dönti el az irányt. */
      const firstVeh = c.transit.legs.find((l) => l.mode !== "WALK");
      rankLabel = firstVeh?.mode === "CAR"
        ? `${mi("directions_car")} Autó + tömegközlekedés${withBubi}`
        : `${mi("departure_board")} Tömegközlekedés + autó${withBubi}`;
    } else if (c.tag === "pureRental") {
      rankLabel = `${mi("pedal_bike")} Bérbiciklivel`;
    } else if (c.tag === "rentalTransit") {
      rankLabel = `${mi("pedal_bike")} Bérbicikli + tömegközlekedés`;
    } else if (c.tag === "bikeTransit") {
      rankLabel = `${mi("pedal_bike")} Bicikli + tömegközlekedés${withBubi}`;
    } else if (c.tag === "bikeModeNoBike") {
      rankLabel = `${mi("directions_walk")} Tömegközlekedés + gyalog`;
    } else if (isPureTransit) {
      rankLabel = c.motorEgress?.kind === "bike"
        ? `${mi("pedal_bike")} Tömegközlekedés + bicikli (érkezés)`
        : c.motorEgress?.kind === "walk"
          ? `${mi("directions_walk")} Tömegközlekedés + gyalog (érkezés)`
          : c.motorEgress?.kind === "car"
            ? `${mi("directions_car")} Tömegközlekedés + autó (érkezés)`
            : `${mi("departure_board")} Tisztán tömegközlekedés`;
    }

    // Badges HTML
    const badgesHtml = c.badges.length
      ? `<div class="badge-pills">${c.badges.map((b) => `<span class="badge-pill ${b.cls}">${b.label}</span>`).join("")}</div>`
      : "";

    let tagHtml = "";
    if (isPureCar) {
      tagHtml = `<span class="alt-saved car-tag">Csak autó, tömegközlekedés nélkül</span>`;
    } else if (isPureStreetBike) {
      tagHtml = BACKEND === "transitous"
        ? `<span class="alt-saved best-tag">Saját biciklivel, tömegközlekedés nélkül</span>`
        : `<span class="alt-saved best-tag">Autóút-hálózat, bringa menetidő (~15 km/h) — rövid helyi járat helyett</span>`;
    } else if (c.tag === "pureRental") {
      tagHtml = `<span class="alt-saved best-tag">Gyalog + bérbicikli</span>`;
    } else if (isPureTransit) {
      tagHtml = c.motorEgress?.kind === "car"
        ? `<span class="alt-saved best-tag">Tömegközlekedés + záró autó</span>`
        : `<span class="alt-saved best-tag">Autó nélkül</span>`;
    } else if (c.tag === "bikeModeNoBike") {
      tagHtml =
        `<span class="alt-saved bike-mode-note">Az OTP nem adott biciklis (BICYCLE) szakaszt — a megállókat `
        + `gyalog közelíti meg. A többmodális optimalizálás gyakran a gyaloglást választja (rövid táv, költségmodell, OSM biciklihálózat). `
        + `A kérésben növeljük a gyaloglás relatív költségét (walkReluctance), hogy jobban esélyes legyen a bicikli.</span>`;
    } else if (c.savedSec > 60) {
      tagHtml = `<span class="alt-saved">-${fmt(c.savedSec)} a tisztán tömegközlekedéshez képest</span>`;
    }

    // Summary line
    let summaryHtml;
    if (isPureCar && c.motorAccess) {
      summaryHtml = `<span>${mi("directions_car")} ${fmt(c.motorAccess.sec)}</span><span>${fmtDist(c.motorAccess.dist)}</span>`;
    } else if (isPureStreetBike && c.motorAccess) {
      summaryHtml = `<span>${mi("pedal_bike")} ${fmt(c.motorAccess.sec)}</span><span>${fmtDist(c.motorAccess.dist)}</span>`;
    } else {
      summaryHtml = `
        ${totalCarMotorSec(c) > 0 ? `<span>${mi("directions_car")} ${fmt(totalCarMotorSec(c))}</span>` : ""}
        ${totalBikeTimeSec(c) > 0 ? `<span>${mi("pedal_bike")} ${fmt(totalBikeTimeSec(c))}</span>` : ""}
        ${totalRentalSec(c) > 0 ? `<span style="color:${modeColor("RENTAL")}">${mi("pedal_bike")} ${fmt(totalRentalSec(c))}</span>` : ""}
        ${transitSec > 0 ? `<span>${mi("departure_board")} ${fmt(transitSec)}</span>` : ""}
        ${walkSec > 60 ? `<span>${mi("directions_walk")} ${fmt(walkSec)}</span>` : ""}
      `;
    }

    const timeRangeHtml = departTimeStr && arriveTimeStr
      ? `<div class="alt-time-range">${departTimeStr} → ${arriveTimeStr}</div>`
      : "";

    card.innerHTML = `
      <div class="alt-header">
        <span class="alt-rank">${rankLabel}</span>
        <span class="alt-total">${fmt(totalSec)}</span>
      </div>
      ${timeRangeHtml}
      ${badgesHtml}
      <div class="alt-summary">${summaryHtml}</div>
      ${tagHtml}
      <div class="legs-list">${legsHtml}</div>
    `;
    resultsDiv.appendChild(card);
  });

  resultsDiv.classList.remove("hidden");
}

// ── UI ──────────────────────────────────────────────────────────

function showError(msg) { errorDiv.textContent = msg; errorDiv.classList.remove("hidden"); }
function clearUI() { resultsDiv.classList.add("hidden"); errorDiv.classList.add("hidden"); }

/** A fő gomb felirata a nézettől függ (Útvonal / Elérhetőség). */
function planBtnLabel() {
  return document.body.classList.contains("view-iso") ? "Elérhetőség mutatása" : "Útvonaltervezés";
}

function setLoading(on, progress) {
  planBtn.disabled = on;
  planBtn.textContent = on ? (progress || "Tervezés…") : planBtnLabel();
  planBtn.classList.toggle("loading", on);
}

// ── Smart scoring ───────────────────────────────────────────────
// 1 min of driving must save at least (1+PENALTY) = 3 min total
// to be "worth it". Prefers transit-only when it's close.

const CAR_PENALTY_FACTOR = 2;

/**
 * „Rövid városi” tömegközlekedés: helyi járatok, kevés fedélzeti idő, nincs távolsági vasút/komppálya.
 * Ilyenkor, ha teljes OD bringa belefér a max km-be, a rendezésben büntetjük a tömegközlekedést (lásd bias).
 */
const SHORT_URBAN_TRANSIT_MAX_IN_VEHICLE_SEC = 16 * 60;
/** Virtuális plusz idő a tömegközlekedéses választásnak — így a teljes bringa OD előrébb kerül. */
const SHORT_URBAN_TRANSIT_BIAS_SEC = 7 * 60;

function isShortUrbanTransit(transit) {
  if (!transit?.legs?.length) return false;
  const nonWalk = transit.legs.filter((l) => l.mode !== "WALK" && l.mode !== "BICYCLE");
  if (!nonWalk.length) return false;
  const hasLongHaul = nonWalk.some(
    (l) => l.mode === "RAIL" || l.mode === "COACH" || l.mode === "FERRY",
  );
  if (hasLongHaul) return false;
  const vehSec = nonWalk.reduce((s, l) => s + (l.endTime - l.startTime) / 1000, 0);
  return vehSec <= SHORT_URBAN_TRANSIT_MAX_IN_VEHICLE_SEC;
}

/** Teljes OD bringa elérhető → rövid városi tömegközlekedéses opciók hátrasorolása. */
function urbanTransitSortPenalty(c, fullOdBikeOk) {
  if (!fullOdBikeOk) return 0;
  if (c.tag === "pureStreetBike") return 0;
  if (c.tag === "pureTransit" && isShortUrbanTransit(c.transit)) return SHORT_URBAN_TRANSIT_BIAS_SEC;
  if (c.tag === "mixed" && c.motorAccess?.kind === "bike" && isShortUrbanTransit(c.transit)) {
    return SHORT_URBAN_TRANSIT_BIAS_SEC;
  }
  return 0;
}

function smartScore(c) {
  return c.totalSec + totalCarMotorSec(c) * CAR_PENALTY_FACTOR;
}

// ── Generate radial probe points around a location ──────────────

function radialPoints(center, radiusKm) {
  const pts = [];
  const DIRECTIONS = 8;
  for (let i = 0; i < DIRECTIONS; i++) {
    const angle = (i / DIRECTIONS) * 2 * Math.PI;
    const dLat = (radiusKm / 111) * Math.cos(angle);
    const dLon = (radiusKm / (111 * Math.cos(center.lat * Math.PI / 180))) * Math.sin(angle);
    pts.push({ lat: center.lat + dLat, lon: center.lon + dLon });
  }
  return pts;
}

// ── Run promises in batches ─────────────────────────────────────

async function batchRun(tasks, batchSize) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

// ── Extract ALL transit boarding stops from an itinerary ─────────

function allTransitStops(itinerary) {
  const stops = [];
  for (const leg of itinerary.legs) {
    if (leg.mode !== "WALK" && leg.mode !== "BICYCLE") {
      stops.push({ lat: leg.from.lat, lon: leg.from.lon, name: leg.from.name });
    }
  }
  return stops;
}

function buildTransitModeWithCar(modes) {
  const base = buildTransitMode(modes);
  if (!base) return "CAR,WALK";
  const inner = base.replace(/,WALK$/, "");
  return `CAR,${inner},WALK`;
}

/** P+R / radiális szűrés: ugyanaz a mód-string, mint a fő tervezésnél. */
function transitModeForSegment(leg, modes) {
  return planTransitModeString(modes, leg);
}

// ── Main planning ───────────────────────────────────────────────

async function handlePlan() {
  if (BACKEND === "transitous" && document.body.classList.contains("view-iso")) return handleIsochrone();
  if (BACKEND === "transitous") return handlePlanTransitous();
  const originText = originInput.value.trim();
  const destText = destinationInput.value.trim();
  if (!originText || !destText) { showError("Add meg mindkét címet!"); return; }

  const motorErr = validateMotorProfile();
  if (motorErr) { showError(motorErr); return; }

  const leg = getLegProfile();
  const maxCarSec = parseInt(carSlider.value, 10) * 60;
  const maxBikeKm = parseFloat(bikeKmSlider?.value) || 15;
  activeBikeLimitM = maxBikeKm * 1000;
  const modes = getActiveModes();
  const transitModeStr = planTransitModeString(modes, leg);
  const carEnabled = isCarEnabled();

  if (!transitModeStr && !carEnabled) {
    showError("Válassz legalább egy közlekedési módot!"); return;
  }

  const dualMotor = leg.first !== "none" && leg.last !== "none";
  const dualCarBike = leg.first === "car" && leg.last === "bike";
  const dualBikeCar = leg.first === "bike" && leg.last === "car";

  if (dualMotor && !dualCarBike && !dualBikeCar) {
    showError(
      "Egyszerre csak két jármű: autó az egyik végén és bicikli a másikon, vagy fordítva.",
    );
    return;
  }

  clearUI();
  departScheduleNote = null;
  setLoading(true);

  try {
    const [origin, dest] = await Promise.all([
      originCoord ? Promise.resolve(originCoord) : geocode(originText),
      destCoord ? Promise.resolve(destCoord) : geocode(destText),
    ]);

    if (origin.displayName && !originCoord) {
      originInput.value = origin.displayName;
      originCoord = { lat: origin.lat, lon: origin.lon };
    }
    if (dest.displayName && !destCoord) {
      destinationInput.value = dest.displayName;
      destCoord = { lat: dest.lat, lon: dest.lon };
    }

    const vehicleAnchor =
      leg.first !== "none" && leg.last === "none"
        ? origin
        : leg.first === "none" && leg.last !== "none"
          ? dest
          : origin;
    /**
     * Tömegközlekedés mindig indulás → érkezés (OD). Korábban egress biciklinél fel volt cserélve
     * origin/dest, és visszafelé (pl. Budapest → Székesfehérvár) kértünk vonatot.
     */
    const transitStart = origin;
    const transitDest = dest;

    const motorKind =
      leg.first !== "none" && leg.last === "none"
        ? leg.first
        : leg.first === "none" && leg.last !== "none"
          ? leg.last
          : "car";

    const mk = (k) => (k === "bike" ? "bike" : "car");

    const candidates = [];

    let pureCar = null;
    if (carEnabled) {
      setLoading(true, "Keresés… (tisztán autó)");
      try {
        const fullCar = await otpCar(origin, dest);
        const tl = buildTimeline(fullCar);
        const last = tl[tl.length - 1];
        pureCar = {
          tag: "pureCar",
          motorAccess: { kind: "car", sec: last.t, dist: last.d, coords: tl.map((p) => p.coord) },
          motorEgress: null,
          switchBoard: null,
          switchAlight: null,
          transit: { duration: 0, legs: [] },
          totalSec: last.t,
          savedSec: 0,
        };
      } catch { /* no car route */ }
    }

    let bestPureTransit = null;
    /** Érkezésnél motor (bicikli/autó): stitch alapja — nyers OTP út, nem a radiális P+R „másik megállója”. */
    let rawBestForEgressMotor = null;
    if (transitModeStr) {
      setLoading(true, "Keresés… (tömegközlekedés jármű nélkül)");
      const pureAll = await otpTransitAllWithLastTripFallback(transitStart, transitDest, transitModeStr, {
        __modesFilter: modes,
      });
      if (leg.first === "none" && (leg.last === "bike" || leg.last === "car")) {
        rawBestForEgressMotor = pickBestRawItineraryForDepart(pureAll);
      }
      for (const it of pureAll) {
        let transitUse = it;
        let motorEg = null;
        if (
          leg.first === "none"
          && leg.last === "bike"
          && rawBestForEgressMotor
          && it === rawBestForEgressMotor
        ) {
          const truncated = await truncateTailForEgressBike(it, dest);
          if (truncated) {
            transitUse = truncated.transit;
            motorEg = truncated.motorEgress;
          } else {
            const lastLeg = it.legs?.[it.legs.length - 1];
            if (lastLeg?.mode === "WALK") {
              const stitched = await stitchEgressBikeOverWalk(it, dest);
              if (stitched) {
                transitUse = stitched.transit;
                motorEg = stitched.motorEgress;
              }
            }
          }
        }
        if (
          leg.first === "none"
          && leg.last === "car"
          && rawBestForEgressMotor
          && it === rawBestForEgressMotor
        ) {
          let stitched = await stitchEgressCarOverShortTailBus(it, dest, maxCarSec);
          if (!stitched) stitched = await stitchEgressCarOverWalk(it, dest, maxCarSec);
          if (stitched) {
            transitUse = stitched.transit;
            motorEg = stitched.motorEgress;
          }
        }
        const c = {
          tag: "pureTransit",
          motorAccess: null,
          motorEgress: motorEg,
          switchBoard: null,
          switchAlight: null,
          transit: transitUse,
          totalSec: transitUse.duration,
          savedSec: 0,
          /** Érkezésnél záró motor: ugyanaz a tömegközlekedési gerinc, mint bicikli/autó nélkül + stitch. */
          primaryEgressMotor:
            !!(
              leg.first === "none"
              && (leg.last === "bike" || leg.last === "car")
              && it === rawBestForEgressMotor
              && motorEg
            ),
        };
        candidates.push(c);
        const reqDep = requestedDepartMs();
        const withinRequestedDepart =
          !isDepartScheduleMode()
          || reqDep == null
          || transitUse.startTime >= reqDep - 120000;
        if (!withinRequestedDepart) continue;

        if (leg.first === "none" && (leg.last === "bike" || leg.last === "car")) {
          if (it === rawBestForEgressMotor) bestPureTransit = c;
        } else if (
          !bestPureTransit
          || transitUse.duration < bestPureTransit.transit.duration
          || (transitUse.duration === bestPureTransit.transit.duration
            && transitUse.startTime < bestPureTransit.transit.startTime)
        ) {
          bestPureTransit = c;
        }
      }
    }

    const baselineSec =
      leg.first === "none"
      && (leg.last === "bike" || leg.last === "car")
      && rawBestForEgressMotor
        ? rawBestForEgressMotor.duration
        : bestPureTransit
          ? bestPureTransit.transit.duration
          : null;

    function motorTimeExtra(motorSec) {
      if (leg.first !== "none" && leg.last !== "none") return {};
      if (leg.first !== "none" && leg.last === "none") return getTransitTimeParams(motorSec, 0, leg);
      if (leg.first === "none" && leg.last !== "none") return getTransitTimeParams(0, motorSec, leg);
      return {};
    }

    async function runRadialPnrScan(transitForStop, opts) {
      const {
        anchor,
        tDest,
        screenMotorKind,
        maxCarSeconds,
        radiusKm: radKm,
        detail: detailKind,
      } = opts;
      const isEgress = detailKind === "egress";

      const radiusKm =
        radKm
        ?? (screenMotorKind === "car" ? (maxCarSeconds / 3600) * 40 : maxBikeKm * 0.95);
      const probePoints = [];
      for (const r of [radiusKm * 0.5, radiusKm]) {
        probePoints.push(...radialPoints(anchor, r));
      }

      /*
       * Access: mintavételezés a jármű útján origin → dest. Egress: a záró bicikliszakasz rövid,
       * nem a teljes dest→origin motorutat kérjük (az hibás irányú lett).
       */
      if (!isEgress) {
        try {
          const direct = await otpMotor(anchor, tDest, screenMotorKind);
          const timeline = buildTimeline(direct);
          const maxSeg = screenMotorKind === "car" ? maxCarSeconds : timeline[timeline.length - 1].t;
          const STEP = 450;
          const maxT = Math.min(maxSeg, timeline[timeline.length - 1].t);
          for (let t = STEP; t <= maxT; t += STEP) {
            probePoints.push(cutAt(timeline, t).point);
          }
        } catch { /* */ }
      }

      const totalProbes = probePoints.length;
      let probesDone = 0;
      const probeExtra = { __modesFilter: modes };
      const transitTasks = probePoints.map((p) => async () => {
        probesDone++;
        setLoading(true, `Keresés… (${probesDone}/${totalProbes} pont)`);
        const tr = isEgress
          ? await otpTransitFast(origin, p, transitForStop, probeExtra)
          : await otpTransitFast(p, tDest, transitForStop, probeExtra);
        return tr ? { point: p, transit: tr } : null;
      });
      const transitSettled = await batchRun(transitTasks, 8);
      const transitResults = transitSettled
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value);

      const stopMap = new Map();
      for (const { transit } of transitResults) {
        for (const stop of allTransitStops(transit)) {
          const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
          if (!stopMap.has(key)) stopMap.set(key, stop);
        }
      }
      const uniqueStops = [...stopMap.values()].slice(0, 14);

      let done = 0;
      setLoading(true, `Megállók szűrése… (${uniqueStops.length} megálló)`);
      const screenTasks = uniqueStops.map((stop) => async () => {
        done++;
        setLoading(true, `Megállók szűrése… (${done}/${uniqueStops.length})`);
        const motor = isEgress
          ? await motorRouteTo(stop, dest, screenMotorKind)
          : await motorRouteTo(anchor, stop, screenMotorKind);
        if (!motor) return null;
        if (screenMotorKind === "car" && motor.sec > maxCarSeconds) return null;
        const extra = { ...motorTimeExtra(motor.sec), __modesFilter: modes };
        const tr = isEgress
          ? await otpTransitFast(origin, stop, transitForStop, extra)
          : await otpTransitFast(stop, tDest, transitForStop, extra);
        if (!tr) return null;
        return { stop, motor, transit: tr, totalSec: motor.sec + tr.duration };
      });

      const screened = (await batchRun(screenTasks, 8))
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value);
      screened.sort((a, b) => a.totalSec - b.totalSec);
      const topStops = screened.slice(0, 5);

      let detailDone = 0;
      const detailTasks = topStops.map((s) => async () => {
        detailDone++;
        setLoading(true, `Részletes útvonalak… (${detailDone}/${topStops.length})`);
        const extra = { ...motorTimeExtra(s.motor.sec), __modesFilter: modes };
        const options = isEgress
          ? await otpTransitAll(origin, s.stop, transitForStop, extra)
          : await otpTransitAll(s.stop, tDest, transitForStop, extra);
        if (!options.length) return null;
        /** Motorút: access = origin→állomás, egress = állomás→dest — mindkét esetben előrefelé. */
        const coords = s.motor.coords;
        const kind = mk(screenMotorKind);
        const seg = { kind, sec: s.motor.sec, dist: s.motor.dist, coords };
        const dk = detailKind || (leg.first !== "none" ? "access" : "egress");
        if (dk === "carAccessBikeInTransit" || dk === "bikeAccessCarInTransit") {
          return options.map((transit) => ({
            tag: "mixed",
            motorAccess: seg,
            motorEgress: null,
            switchBoard: s.stop,
            switchAlight: null,
            transit,
            totalSec: s.motor.sec + transit.duration,
            savedSec: baselineSec ? baselineSec - (s.motor.sec + transit.duration) : 0,
          }));
        }
        if (dk === "access") {
          return options.map((transit) => ({
            tag: "mixed",
            motorAccess: seg,
            motorEgress: null,
            switchBoard: s.stop,
            switchAlight: null,
            transit,
            totalSec: s.motor.sec + transit.duration,
            savedSec: baselineSec ? baselineSec - (s.motor.sec + transit.duration) : 0,
          }));
        }
        return options.map((transit) => ({
          tag: "mixed",
          motorAccess: null,
          motorEgress: seg,
          switchBoard: null,
          switchAlight: s.stop,
          transit,
          totalSec: s.motor.sec + transit.duration,
          savedSec: baselineSec ? baselineSec - (s.motor.sec + transit.duration) : 0,
        }));
      });
      const detailSettled = await batchRun(detailTasks, 4);
      for (const r of detailSettled) {
        if (r.status === "fulfilled" && r.value) {
          for (const c of r.value) candidates.push(c);
        }
      }
    }

    /**
     * Park & Ride / „hol szállj fel” szken: csak indulásnál jármű esetén (motor → állomás → tömegközlekedés).
     * Érkezésnél záró bicikli/autó: a radiális egress szken MÁS megállót választana (gyakran hosszú vonat
     * Budapesten belül + rövid motor), ezért csak ugyanazt a OTP-utat használjuk, mint motor nélkül + stitch.
     */
    const needMotorPnr =
      transitModeStr
      && leg.first !== "none"
      && leg.last === "none";

    if (needMotorPnr) {
      const tMode = transitModeForSegment(leg, modes) || transitModeStr;
      setLoading(true, "Keresés… (átszállási pontok)");
      await runRadialPnrScan(tMode, {
        anchor: vehicleAnchor,
        tDest: transitDest,
        screenMotorKind: mk(motorKind),
        maxCarSeconds: maxCarSec,
        detail: leg.first !== "none" ? "access" : "egress",
      });
    }

    if (transitModeStr && dualCarBike) {
      setLoading(true, "Keresés… (autó → tömegközlekedés → bicikli)");
      const tMode = buildTransitModeWithBicycle(modes);
      await runRadialPnrScan(tMode, {
        anchor: origin,
        tDest: dest,
        screenMotorKind: "car",
        maxCarSeconds: maxCarSec,
        detail: "carAccessBikeInTransit",
      });
    }

    if (transitModeStr && dualBikeCar) {
      setLoading(true, "Keresés… (bicikli → tömegközlekedés → autó)");
      const tMode = buildTransitModeWithCar(modes);
      await runRadialPnrScan(tMode, {
        anchor: origin,
        tDest: dest,
        screenMotorKind: "bike",
        maxCarSeconds: maxCarSec,
        detail: "bikeAccessCarInTransit",
      });
    }

    for (let i = 0; i < candidates.length; i++) {
      const absorbed = await stitchAccessBikeAbsorbLeadingWalk(
        { lat: origin.lat, lon: origin.lon },
        candidates[i],
        baselineSec,
      );
      if (absorbed) candidates[i] = absorbed;
    }

    for (let i = 0; i < candidates.length; i++) {
      const absorbedCar = await stitchAccessCarAbsorbLeadingTransit(
        { lat: origin.lat, lon: origin.lon },
        candidates[i],
        maxCarSec,
        baselineSec,
      );
      if (absorbedCar) candidates[i] = absorbedCar;
    }

    for (const c of candidates) {
      if (c.transit?.legs?.length) c.transit = downgradeTrivialBikeLegs(c.transit);
      normalizeShortBikeMotorSegOnCandidate(c);
    }

    /** Teljes OD bringa (max km): rövid helyi járat helyett előnyben; a rendezéshez lásd urbanTransitSortPenalty. */
    let fullStreetBikeCandidate = null;
    if (ENABLE_BIKE_FEATURES && document.getElementById("use-bike")?.checked) {
      setLoading(true, "Keresés… (teljes bringa OD)");
      const fb = await motorRouteTo(
        { lat: origin.lat, lon: origin.lon },
        { lat: dest.lat, lon: dest.lon },
        "bike",
      );
      if (fb) {
        fullStreetBikeCandidate = {
          tag: "pureStreetBike",
          motorAccess: { kind: "bike", sec: fb.sec, dist: fb.dist, coords: fb.coords },
          motorEgress: null,
          switchBoard: null,
          switchAlight: null,
          transit: { duration: 0, legs: [] },
          totalSec: fb.sec,
          savedSec: baselineSec != null ? baselineSec - fb.sec : 0,
        };
        candidates.push(fullStreetBikeCandidate);
      }
    }

    if (!candidates.length && !pureCar) {
      throw new Error("Nem található útvonal.");
    }

    const fullOdBikeOk = !!fullStreetBikeCandidate;

    candidates.sort((a, b) => {
      const pa = a.primaryEgressMotor ? 0 : 1;
      const pb = b.primaryEgressMotor ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const sa = a.totalSec + urbanTransitSortPenalty(a, fullOdBikeOk);
      const sb = b.totalSec + urbanTransitSortPenalty(b, fullOdBikeOk);
      if (sa !== sb) return sa - sb;
      return a.totalSec - b.totalSec;
    });

    const unique = [];
    const seen = new Set();
    for (const c of candidates) {
      const sig = c.transit.legs
        .filter((l) => l.mode !== "WALK")
        .map((l) => `${l.mode}:${l.routeShortName || l.route || ""}:${l.from?.name || ""}`)
        .join("|");
      /** Kötelező: indulás/érkezés gyalog vs. bicikli eltér — korábban WALK és BICYCLE ugyanazzal a vonattal egy kulcsra esett, és a biciklis változat kiesett. */
      const modeChain = c.transit.legs.map((l) => l.mode).join("→");
      const key = `${c.tag}|${modeChain}|${Math.round(totalMotorSec(c) / 120)}|${sig}`;
      if (!seen.has(key)) { unique.push(c); seen.add(key); }
      if (unique.length >= 8) break;
    }

    if (bestPureTransit && !unique.includes(bestPureTransit)) {
      bestPureTransit.tag = "pureTransit";
      unique.push(bestPureTransit);
    }

    if (fullStreetBikeCandidate && !unique.includes(fullStreetBikeCandidate)) {
      unique.push(fullStreetBikeCandidate);
    }

    if (pureCar) {
      unique.push(pureCar);
    }

    let finalList = unique;
    if (isLastTripMode()) {
      finalList = unique.filter((c) => {
        if (c.tag === "pureStreetBike") return false;
        if (leg.last !== "none" && totalMotorSec(c) > 0) return false;
        return true;
      });
    }

    if (!finalList.length) {
      throw new Error(
        isLastTripMode()
          ? "Nem található tömegközlekedési útvonal erre a napra (utolsó járat). Próbálj másik dátumot, vagy ellenőrizd a GTFS menetrendet."
          : "Nem található útvonal.",
      );
    }

    departScheduleNote = null;
    if (
      isDepartScheduleMode()
      && finalList[0].transit?.legs?.length
      && finalList[0].transit.startTime != null
    ) {
      const req = requestedDepartMs();
      const st = finalList[0].transit.startTime;
      if (req != null && st > req + 90 * 1000) {
        departScheduleNote =
          `A megadott időponthoz képest ez a legkorábbi elérhető útvonal (valós indulás: ${fmtTime(st)}).`;
      }
    }

    drawRoute(finalList[0]);
    renderAlternatives(finalList, 0);
  } catch (err) {
    console.error(err);
    showError(err.message);
    clearRoute();
  } finally {
    setLoading(false);
  }
}

// ── Events ──────────────────────────────────────────────────────

planBtn.addEventListener("click", handlePlan);
originInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handlePlan(); });
destinationInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handlePlan(); });

document.getElementById("pick-origin")?.addEventListener("click", () => {
  setPickMode(mapClickTarget === "origin" ? null : "origin");
});
document.getElementById("pick-dest")?.addEventListener("click", () => {
  setPickMode(mapClickTarget === "destination" ? null : "destination");
});
document.getElementById("swap-od-btn")?.addEventListener("click", swapOriginDestination);
