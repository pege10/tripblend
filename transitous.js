/* ================================================================
   TripBlend – Transitous (MOTIS 2) útvonal-réteg
   Egy tervezés több kérés az api.transitous.org-ra (közös soron, egyszerre legfeljebb 3). A válaszokat
   ugyanarra a "jelölt" formára alakítjuk, amit az app.js térkép- és kártyarajzolója vár
   (drawRoute, renderAlternatives). Az autó, a saját bicikli és a bérbicikli (MOL Bubi)
   szakasz a lábak között marad, sorrendben.

   Használati feltételek: https://transitous.org/api/
   - nyílt forrású, nem kereskedelmi app; napi kb. 720 /plan kérés felett egyeztetni kell
   - látható forrásmegjelölés: https://transitous.org/sources/ + OpenStreetMap
   ================================================================ */

const TS_PLAN_URL = "https://api.transitous.org/api/v6/plan";
const TS_TIMEOUT_MS = 25000;
/**
 * A Transitous egy gépről egyszerre 3 kérést enged: a negyedikre azonnal 429-et ad, ami a
 * böngészőben CORS-hibaként látszik (a hibaválaszban nincs CORS-fejléc), és sok kérés után lassít.
 * Ezért minden kérés (tervezés, izokron, címkeresés) egy közös soron megy át.
 */
const TS_MAX_PARALLEL = 3;
let tsActive = 0;
const tsWaiting = [];

function tsAcquire() {
  return new Promise((resolve) => {
    const go = () => {
      tsActive++;
      resolve(() => {
        tsActive--;
        tsWaiting.shift()?.();
      });
    };
    if (tsActive < TS_MAX_PARALLEL) go();
    else tsWaiting.push(go);
  });
}

/**
 * GET a Transitousra a közös soron át, JSON-t ad vissza. Hálózati hiba vagy 429 esetén
 * (ez a böngészőben ugyanúgy hálózati hibának látszik) egyszer újrapróbálja kis szünet után.
 */
async function tsFetchJson(url) {
  for (let attempt = 0; ; attempt++) {
    const release = await tsAcquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TS_TIMEOUT_MS);
    let res = null;
    let data = null;
    let netErr = null;
    try {
      res = await fetch(url, { signal: ctrl.signal });
      try { data = await res.json(); } catch { /* nem JSON */ }
    } catch (e) {
      netErr = e;
    } finally {
      clearTimeout(timer);
      release();
    }
    const retryable = (netErr && netErr.name !== "AbortError") || res?.status === 429;
    if (retryable && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (netErr) {
      throw new Error(
        netErr.name === "AbortError"
          ? "A Transitous nem válaszolt időben, próbáld újra."
          : "Nem sikerült elérni a Transitous szervert (nincs internet, vagy most túl sok a kérés).",
      );
    }
    if (!res.ok || data?.error) throw new Error(`Transitous hiba: ${data?.error || res.status}`);
    return data;
  }
}
/** Saját bicikli átlagsebessége a km-csúszka → idő átváltáshoz (m/s, kb. 15 km/h). */
const TS_BIKE_MPS = 4.2;
/** Tisztán autós / biciklis / bérbiciklis út felső korlátja (s). */
const TS_MAX_DIRECT_SEC = 4 * 3600;
/** MOL Bubi (és séta) az út egyik végén, ahol nincs saját jármű: legfeljebb ennyi (s). */
const TS_RENTAL_END_SEC = 1800;
/**
 * A Transitous autós kerete (maxPre/PostTransitTime) a parkolótól a megállóig tartó sétát is
 * tartalmazza (Székesfehérváron pl. 7 perc). A csúszka az autózás ideje, ezért ennyivel többet
 * kérünk, és utána az autós lábat szűrjük a csúszkára.
 */
const TS_PARK_WALK_SEC = 600;
/** Vasúti / HÉV-megálló (a one-to-all és a címkereső `modes` mezője alapján). */
const TS_RAIL_LIKE = new Set(["RAIL", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "LONG_DISTANCE", "HIGHSPEED_RAIL", "NIGHT_RAIL", "SUBURBAN"]);
/** Ennyi saját keresésű P+R-állomást próbálunk ki tervezésenként (lásd tsPickScanStations). */
const TS_SCAN_MAX = 2;

/**
 * Átszállási idő minden kérésben (tervezés, izokron). A Transitous alapból 0 perces minimummal és
 * a légvonalas sétával számol: Kelenföldön vonatról M4-re 2 perc, a Kálvin téren M4-ről M3-ra
 * 2 perc. A Google Térkép ugyanazon a vonaton 5-7 percet hagy (2026-11-21-i összevetés, 11 pont).
 * 1,5-szeres átszállási idő + átszállásonként 2 perc: Bicske, Szentendre pontosan a Google ideje,
 * a többi 3-5 percen belül (korábban 2-13 perccel optimistább volt).
 */
const TS_TRANSFER_PARAMS = { transferTimeFactor: "1.5", additionalTransferTime: "2" };

/** Két pont távolsága méterben (kis távolságra elég a síkbeli közelítés). */
function tsDistM(a, b) {
  const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * 111320 * cosLat, (a.lat - b.lat) * 110540);
}

const TS_RAIL_MODES = [
  "RAIL", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "LONG_DISTANCE", "HIGHSPEED_RAIL", "NIGHT_RAIL",
];

/** Transitous mód → az app.js-ben használt mód (OTP-s elnevezések). A HÉV SUBURBAN, H5 stb. vonalszámmal. */
const TS_MODE_MAP = {
  WALK: "WALK", BIKE: "BICYCLE", RENTAL: "RENTAL", CAR: "CAR",
  SUBWAY: "SUBWAY", TRAM: "TRAM", BUS: "BUS", COACH: "COACH", FERRY: "FERRY",
  SUBURBAN: "RAIL", FUNICULAR: "FUNICULAR", AERIAL_LIFT: "AERIAL_LIFT",
};
for (const m of TS_RAIL_MODES) TS_MODE_MAP[m] = "RAIL";

/** A mód-chipekből Transitous transitModes lista (null = egyik sincs bekapcsolva). */
function tsTransitModes(modes) {
  const out = [];
  if (modes.has("BUS")) out.push("BUS", "COACH");
  if (modes.has("RAIL")) out.push(...TS_RAIL_MODES);
  if (modes.has("HEV")) out.push("SUBURBAN");
  if (modes.has("TRAM")) out.push("TRAM", "FUNICULAR", "AERIAL_LIFT");
  if (modes.has("SUBWAY")) out.push("SUBWAY");
  if (!out.length) return null;
  out.push("FERRY");
  return out;
}

function tsIso(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}

/** UI időmód → Transitous time / arriveBy. */
function tsTimeParams() {
  const mode = timeModeSelect.value;
  if (mode === "now") return {};
  const date = planningDateStr();
  const t = /^\d{2}:\d{2}$/.test(timePick.value || "") ? timePick.value : "08:00";
  if (mode === "depart") return { time: tsIso(date, t), arriveBy: "false" };
  if (mode === "arrive") return { time: tsIso(date, t), arriveBy: "true" };
  /** Utolsó járat: a nap végéig (23:59) beérkező legkésőbbi indulás. */
  if (mode === "last") return { time: tsIso(date, "23:59"), arriveBy: "true" };
  return {};
}

async function tsFetchPlan(from, to, params) {
  const q = new URLSearchParams({
    fromPlace: `${from.lat},${from.lon}`,
    toPlace: `${to.lat},${to.lon}`,
    numItineraries: "4",
    language: "hu",
    ...TS_TRANSFER_PARAMS,
    ...tsTimeParams(),
  });
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return tsFetchJson(`${TS_PLAN_URL}?${q}`);
}

function tsPlaceName(p) {
  const n = (p?.name || "").trim();
  return !n || n === "START" || n === "END" ? "" : n;
}

/** Egy Transitous láb → app.js-láb (ms-os időkkel, dekódolt geometriával). */
function tsConvertLeg(l) {
  const mode = TS_MODE_MAP[l.mode] || l.mode;
  let short = l.routeShortName || "";
  if (mode === "RAIL" && !short) {
    /** MÁV: a routeShortName üres, a vonal a routeLongName-ben (S80), a vonatszám a displayName-ben. */
    const long = (l.routeLongName || "").trim();
    short = long && long.length <= 8 ? long : (l.displayName || l.tripShortName || "");
  }
  const g = l.legGeometry;
  const start = Date.parse(l.startTime);
  const schedStart = Date.parse(l.scheduledStartTime);
  return {
    mode,
    tsMode: l.mode,
    startTime: start,
    endTime: Date.parse(l.endTime),
    realTime: !!l.realTime,
    delaySec: l.realTime && Number.isFinite(schedStart) ? Math.round((start - schedStart) / 1000) : 0,
    from: { name: tsPlaceName(l.from), lat: l.from.lat, lon: l.from.lon },
    to: { name: tsPlaceName(l.to), lat: l.to.lat, lon: l.to.lon },
    distance: l.distance,
    routeShortName: short,
    routeLongName: l.routeLongName || "",
    routeId: l.routeId || "",
    agencyName: l.agencyName || "",
    agencyId: l.agencyId || "",
    routeColor: l.routeColor ? `#${String(l.routeColor).replace(/^#/, "")}` : null,
    headsign: l.headsign || "",
    tripShortName: l.tripShortName || "",
    rental: l.rental || null,
    _coords: g?.points ? decodePolyline(g.points, g.precision ?? 6) : null,
  };
}

function tsMotorSeg(kind, legs, sec) {
  return {
    kind,
    sec,
    dist: legs.reduce((s, l) => s + (l.distance || 0), 0),
    coords: legs.flatMap((l) => legCoords(l)),
  };
}

/** Transitous itinerary → jelölt. null, ha nem mutatjuk (pl. tisztán gyalog). */
function tsCandidate(it, baselineSec) {
  const legs = it.legs
    .map(tsConvertLeg)
    .filter((l) => !(l.mode === "WALK" && l.endTime - l.startTime < 30 && (l.distance || 0) < 15));

  legs.forEach((l, i) => {
    /** A Transitous a parkolás idejét a P+R utáni gyalogláb idejébe számolja. */
    if (l.mode === "WALK" && legs[i - 1]?.mode === "CAR") l._label = "Parkolás + séta";
    if (l.mode === "WALK" && legs[i + 1]?.mode === "CAR" && i > 0) l._label = "Séta az autóhoz";
    if (l.mode === "CAR") {
      if (!l.to.name && i < legs.length - 1) l.to.name = "P+R parkoló";
      if (!l.from.name && i > 0) l.from.name = "P+R parkoló";
    }
    if (l.mode === "RENTAL") {
      const onlyWalkAfter = legs.slice(i + 1).every((x) => x.mode === "WALK");
      const onlyWalkBefore = legs.slice(0, i).every((x) => x.mode === "WALK");
      l.from.name = l.from.name || l.rental?.fromStationName
        || (onlyWalkBefore ? "állomás az indulás közelében" : "bérbicikli-állomás");
      l.to.name = l.to.name || l.rental?.toStationName
        || (onlyWalkAfter ? "állomás a cél közelében" : "bérbicikli-állomás");
    }
  });

  const base = {
    motorAccess: null,
    motorEgress: null,
    switchBoard: null,
    switchAlight: null,
    totalSec: it.duration,
    savedSec: 0,
  };
  const empty = { duration: 0, legs: [] };
  const nonWalk = legs.filter((l) => l.mode !== "WALK");
  const hasTransit = legs.some((l) => modeCat(l.mode) === "transit");

  if (!hasTransit) {
    if (nonWalk.length === 1 && nonWalk[0].mode === "CAR") {
      return { ...base, tag: "pureCar", motorAccess: tsMotorSeg("car", legs, it.duration), transit: empty };
    }
    if (nonWalk.length && nonWalk.every((l) => l.mode === "BICYCLE")) {
      return {
        ...base,
        tag: "pureStreetBike",
        motorAccess: tsMotorSeg("bike", legs, it.duration),
        transit: empty,
        savedSec: baselineSec != null ? baselineSec - it.duration : 0,
      };
    }
    if (nonWalk.some((l) => l.mode === "RENTAL")) {
      return {
        ...base,
        tag: "pureRental",
        transit: { duration: it.duration, startTime: Date.parse(it.startTime), endTime: Date.parse(it.endTime), legs },
        savedSec: baselineSec != null ? baselineSec - it.duration : 0,
      };
    }
    return null;
  }

  const vehDist = (mode) => legs.filter((l) => l.mode === mode).reduce((s, l) => s + (l.distance || 0), 0);
  /** Néhány száz méteres "autózás" vagy "biciklizés" a megállóig nem külön változat (a gyalogos út lefedi). */
  if (legs.some((l) => l.mode === "CAR") && vehDist("CAR") < 800) return null;
  if (!legs.some((l) => l.mode === "CAR") && legs.some((l) => l.mode === "BICYCLE") && vehDist("BICYCLE") < 600) {
    return null;
  }

  const tag = legs.some((l) => l.mode === "CAR")
    ? "mixed"
    : legs.some((l) => l.mode === "BICYCLE")
      ? "bikeTransit"
      : legs.some((l) => l.mode === "RENTAL")
        ? "rentalTransit"
        : "pureTransit";
  return {
    ...base,
    tag,
    transit: { duration: it.duration, startTime: Date.parse(it.startTime), endTime: Date.parse(it.endTime), legs },
    savedSec: tag !== "pureTransit" && baselineSec != null ? baselineSec - it.duration : 0,
  };
}

/**
 * Azonosító a duplikációszűréshez. withTime=false: ugyanaz a vonalsor más indulással egynek számít
 * (járműves változatoknál csak a legjobb kell, a tisztán tömegközlekedésnél a következő indulások is).
 */
function tsCandidateKey(c, withTime = true) {
  const sig = c.transit.legs
    .filter((l) => l.mode !== "WALK")
    .map((l) => `${l.mode}:${l.routeShortName || ""}:${l.from?.name || ""}`
      + (withTime ? `:${Math.round(l.startTime / 60000)}` : ""))
    .join("|");
  return `${c.tag}|${Math.round(totalCarMotorSec(c) / 120)}|${sig}`;
}

/** Időrend: indulás-időpontos keresésnél a korábbi érkezés, érkezésinél a későbbi indulás előrébb. */
function tsByTime(a, b) {
  if (timeModeSelect.value === "arrive" || timeModeSelect.value === "last") {
    return (b.transit.startTime || 0) - (a.transit.startTime || 0);
  }
  return (a.transit.endTime || 0) - (b.transit.endTime || 0);
}

// ── Saját átszállási pont (ahol leteszed az autót / a biciklit) ──────

const TS_GEOCODE_URL = "https://api.transitous.org/api/v1/geocode";
const TS_SAVED_POINTS_KEY = "tripblend.savedPoints";
/** Parkolásra / bicikli lezárására számolt idő a jármű és a tömegközlekedés között (s). */
const TS_PARK_BUFFER_SEC = { car: 300, bike: 120 };

const transferPoints = { car: null, bike: null };
let transferMarkers = [];
const tpInput = (kind) => document.getElementById(kind === "car" ? "car-point" : "bike-point");

function loadSavedPoints() {
  try {
    const v = JSON.parse(localStorage.getItem(TS_SAVED_POINTS_KEY) || "[]");
    return Array.isArray(v)
      ? v.filter((p) => p && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];
  } catch {
    return [];
  }
}

/** A használt pontokat megjegyezzük (böngészőnként); a javaslatlista felajánlja őket (suggest.js). */
function savePoint(p) {
  const list = loadSavedPoints().filter((x) => x.name !== p.name);
  list.unshift({ name: p.name, lat: p.lat, lon: p.lon });
  try { localStorage.setItem(TS_SAVED_POINTS_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* */ }
}

function updateTransferMarkers() {
  transferMarkers.forEach((m) => m.remove());
  transferMarkers = [];
  for (const kind of ["car", "bike"]) {
    const p = transferPoints[kind];
    if (!p) continue;
    const el = document.createElement("div");
    el.style.cssText = "width:16px;height:16px;border-radius:4px;background:#f59e0b;"
      + "border:2px solid rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(0,0,0,.3);";
    el.title = p.name;
    transferMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
  }
}

for (const kind of ["car", "bike"]) {
  const input = tpInput(kind);
  input?.addEventListener("input", () => {
    const v = input.value.trim();
    const saved = loadSavedPoints().find((p) => p.name === v);
    transferPoints[kind] = saved ? { ...saved } : null;
    updateTransferMarkers();
  });
  document.getElementById(kind === "car" ? "pick-car-point" : "pick-bike-point")?.addEventListener("click", () => {
    const target = `${kind}-point`;
    setPickMode(mapClickTarget === target ? null : target);
  });
}

/** app.js térképkattintás hívja, ha a "Válaszd ki a térképen" gomb egy átszállási pontra van állítva. */
function onTransferPointPicked(target, coord, name) {
  const kind = target === "car-point" ? "car" : target === "bike-point" ? "bike" : null;
  if (!kind) return;
  transferPoints[kind] = { lat: coord.lat, lon: coord.lon, name };
  const input = tpInput(kind);
  if (input) input.value = name;
  updateTransferMarkers();
}

/** Megállónév keresése a Transitous címkeresőjével (állomásokat jobban ismer, mint a Nominatim). */
async function tsGeocodeStop(text) {
  try {
    const q = new URLSearchParams({ text, language: "hu", place: "47.5,19.0", numResults: "5" });
    const list = await tsFetchJson(`${TS_GEOCODE_URL}?${q}`);
    if (!Array.isArray(list) || !list.length) return null;
    const m = list.slice(0, 3).find((x) => x.type === "STOP") || list[0];
    return Number.isFinite(m.lat) ? { lat: m.lat, lon: m.lon, name: text } : null;
  } catch {
    return null;
  }
}

/**
 * Idő a P+R-állomáskereső one-to-all kéréséhez (az Útvonal nézet időbeállításából).
 * first (autó az indulásnál): a cél felől, érkezési határral. last: az indulástól, indulási idővel.
 */
function tsScanTimeParams(position) {
  const mode = timeModeSelect.value;
  const hm = /^\d{2}:\d{2}$/.test(timePick.value || "") ? timePick.value : "08:00";
  const t0 = mode === "now" ? Date.now() : Date.parse(tsIso(planningDateStr(), mode === "last" ? "23:59" : hm));
  const arriveMode = mode === "arrive" || mode === "last";
  const H2 = 120 * 60000;
  if (position === "first") {
    return { time: new Date(arriveMode ? t0 : t0 + H2).toISOString(), arriveBy: "true" };
  }
  return { time: new Date(arriveMode ? t0 - H2 : t0).toISOString(), arriveBy: "false" };
}

/**
 * Saját P+R-keresés vasútállomásokra. A Transitous csak ott parkoltat, ahol a parkolót ismeri
 * (Bicskén pl. nem), és ugyanarra a vonatra mindig a legtöbb autózással elérhető állomást adja
 * (a későbbi indulás nyer). Ezért a másik vég felőli one-to-all megállóiból kiválasztjuk az autóval
 * elérhető vasútállomásokat, becsült összidő szerint (légvonalas autóidő + parkolás + menetidő),
 * és azokból, amelyek nincsenek 2 km-en belül a már megtalált felszállóhelyekhez, a legjobb kettőt.
 * Ezekre a hívó saját ponttal tervez (tsViaPointCandidate: autó közvetlenül az állomásig).
 * @param {object|null} data  one-to-all válasz
 * @param {{lat:number, lon:number}} anchor  az autós vég (indulás vagy cél)
 * @param {{lat:number, lon:number}[]} skip  ezek közelében már van ajánlat
 */
function tsPickScanStations(data, anchor, maxCarSec, skip) {
  const cands = [];
  for (const x of data?.all || []) {
    const p = x.place;
    if (!p || !Number.isFinite(p.lat) || !(p.modes || []).some((m) => TS_RAIL_LIKE.has(m))) continue;
    const dist = tsDistM(anchor, p);
    /**
     * A sarokig autózás nem P+R. A légvonalas becslés vidéken sokat ráhagy (Csákberény -> Bicske:
     * 34 perc, valójában 27), ezért itt a keret 1,3-szorosáig engedünk; a pontos autóidőt a terv
     * adja, és a csúszkánál hosszabb autózású ajánlat utána kiesik.
     */
    if (dist < 1500 || isoVehMin("car", dist) > (maxCarSec / 60) * 1.3) continue;
    if (skip.some((s) => tsDistM(s, p) < 2000)) continue;
    const carMin = isoVehMin("car", dist);
    cands.push({ lat: p.lat, lon: p.lon, name: p.name, carMin, est: carMin + TS_PARK_BUFFER_SEC.car / 60 + x.duration });
  }
  cands.sort((a, b) => a.est - b.est);
  /**
   * 2 km-en belül egy állomás. Ha a becsült összidő legfeljebb 3 percben tér el, a kevesebb
   * autózással elérhető marad (pl. Bicske és Bicske alsó: ugyanaz az S10, a főállomás közelebb van).
   */
  const out = [];
  for (const c of cands) {
    const i = out.findIndex((o) => o.name === c.name || tsDistM(o, c) < 2000);
    if (i >= 0) {
      if (c.est - out[i].est <= 3 && c.carMin < out[i].carMin) out[i] = c;
      continue;
    }
    if (out.length < TS_SCAN_MAX) out.push(c);
    else if (c.est > out[out.length - 1].est + 3) break;
  }
  return out;
}

/** A beírt vagy kijelölt saját pont koordinátái; null, ha a mező üres. */
async function resolveTransferPoint(kind) {
  const text = tpInput(kind)?.value.trim();
  if (!text) {
    transferPoints[kind] = null;
    updateTransferMarkers();
    return null;
  }
  if (transferPoints[kind]) return transferPoints[kind];
  let p = await tsGeocodeStop(text);
  if (!p) {
    const g = await geocode(text);
    p = { lat: g.lat, lon: g.lon, name: text };
  }
  transferPoints[kind] = p;
  updateTransferMarkers();
  return p;
}

function tsPickEarliestArrival(its) {
  return (its || []).reduce((b, it) => (!b || Date.parse(it.endTime) < Date.parse(b.endTime) ? it : b), null);
}
function tsPickLatestDeparture(its) {
  return (its || []).reduce((b, it) => (!b || Date.parse(it.startTime) > Date.parse(b.startTime) ? it : b), null);
}

/**
 * Útvonal a megadott átszállási ponton át: jármű a pontig (vagy a ponttól), a másik szakasz
 * tömegközlekedéssel, köztük parkolási idővel. Két egymás utáni kérés (az időzítés a másikból jön).
 * @param {"car"|"bike"} kind
 * @param {"first"|"last"} position  first: jármű az indulásnál, last: az érkezésnél
 */
async function tsViaPointCandidate(origin, dest, point, kind, position, ctx) {
  const vMode = kind === "car" ? "CAR" : "BIKE";
  const bufferMs = TS_PARK_BUFFER_SEC[kind] * 1000;
  const arrive = timeModeSelect.value === "arrive" || timeModeSelect.value === "last";
  const iso = (ms) => new Date(ms).toISOString();
  const vehicleWord = kind === "car" ? "autós" : "biciklis";

  const directReq = (from, to, timeOpts = {}) =>
    tsFetchPlan(from, to, { transitModes: [], directModes: [vMode], maxDirectTime: TS_MAX_DIRECT_SEC, ...timeOpts });
  /** Tömegközlekedés a saját ponttól / pontig; a másik vég (otherSide) módja, kerete, Bubi-szűrője a ctx-ből. */
  const transitReq = (from, to, otherSide, timeOpts = {}) => {
    const ends = otherSide === "pre"
      ? {
        preTransitModes: ctx.otherEnd,
        maxPreTransitTime: ctx.otherLimit,
        preTransitRentalFormFactors: ctx.otherFF,
        postTransitModes: ["WALK"],
      }
      : {
        preTransitModes: ["WALK"],
        postTransitModes: ctx.otherEnd,
        maxPostTransitTime: ctx.otherLimit,
        postTransitRentalFormFactors: ctx.otherFF,
      };
    return tsFetchPlan(from, to, { transitModes: ctx.transitModes, ...ends, numItineraries: 5, ...timeOpts });
  };
  const firstDirect = (d) => {
    const it = d?.direct?.[0];
    if (!it) throw new Error(`nem található ${vehicleWord} út.`);
    return it;
  };

  let first;
  let second;
  if (position === "first") {
    let veh;
    let tr;
    if (!arrive) {
      veh = firstDirect(await directReq(origin, point));
      const d = await transitReq(point, dest, "post", {
        time: iso(Date.parse(veh.endTime) + bufferMs), arriveBy: "false",
      });
      tr = tsPickEarliestArrival(d.itineraries);
      /**
       * Ne a peronon várj: az autó/bicikli induljon annyival később, hogy épp elérje a járatot
       * (így a saját pont ugyanúgy számol, mint a Transitous saját P+R-jei).
       */
      if (tr && Date.parse(tr.startTime) - Date.parse(veh.endTime) > bufferMs + 60000) {
        try {
          const later = firstDirect(await directReq(origin, point, {
            time: iso(Date.parse(tr.startTime) - bufferMs), arriveBy: "true",
          }));
          if (Date.parse(later.startTime) >= Date.parse(veh.startTime)) veh = later;
        } catch { /* marad az azonnali indulás */ }
      }
    } else {
      const d = await transitReq(point, dest, "post");
      tr = tsPickLatestDeparture(d.itineraries);
      if (tr) {
        veh = firstDirect(await directReq(origin, point, {
          time: iso(Date.parse(tr.startTime) - bufferMs), arriveBy: "true",
        }));
      }
    }
    if (!tr) throw new Error("innen ebben az időben nem találtunk tömegközlekedést.");
    first = veh;
    second = tr;
  } else {
    let veh;
    let tr;
    if (!arrive) {
      const d = await transitReq(origin, point, "pre");
      tr = tsPickEarliestArrival(d.itineraries);
      if (tr) {
        veh = firstDirect(await directReq(point, dest, {
          time: iso(Date.parse(tr.endTime) + bufferMs), arriveBy: "false",
        }));
      }
    } else {
      veh = firstDirect(await directReq(point, dest));
      const d = await transitReq(origin, point, "pre", {
        time: iso(Date.parse(veh.startTime) - bufferMs), arriveBy: "true",
      });
      tr = tsPickLatestDeparture(d.itineraries);
    }
    if (!tr) throw new Error("ide ebben az időben nem találtunk tömegközlekedést.");
    first = tr;
    second = veh;
  }

  const legs1 = first.legs.map(tsConvertLeg);
  const legs2 = second.legs.map(tsConvertLeg);
  for (const l of [...legs1, ...legs2]) {
    if (l.mode !== "CAR" && l.mode !== "BICYCLE") continue;
    if (position === "first" && !l.to.name) l.to.name = point.name;
    if (position === "last" && !l.from.name) l.from.name = point.name;
  }
  const firstEnd = Date.parse(first.endTime);
  const secondStart = Date.parse(second.startTime);
  const waitLeg = secondStart - firstEnd >= 60000
    ? {
      mode: "WAIT",
      startTime: firstEnd,
      endTime: secondStart,
      distance: 0,
      _noDist: true,
      _label: kind === "car" ? "Parkolás, várakozás" : "Bicikli lezárása, várakozás",
      _icon: kind === "car" ? "local_parking" : "lock",
      from: { name: point.name, lat: point.lat, lon: point.lon },
      to: { name: point.name, lat: point.lat, lon: point.lon },
      _coords: [[point.lon, point.lat], [point.lon, point.lat]],
    }
    : null;
  const legs = [...legs1, waitLeg, ...legs2]
    .filter(Boolean)
    .filter((l) => !(l.mode === "WALK" && l.endTime - l.startTime < 30 && (l.distance || 0) < 15));

  const start = Date.parse(first.startTime);
  const end = Date.parse(second.endTime);
  const totalSec = Math.round((end - start) / 1000);
  return {
    tag: kind === "car" ? "mixed" : "bikeTransit",
    customPoint: point.name,
    showAlways: true,
    motorAccess: null,
    motorEgress: null,
    switchBoard: null,
    switchAlight: null,
    transit: { duration: totalSec, startTime: start, endTime: end, legs },
    totalSec,
    savedSec: 0,
  };
}

async function handlePlanTransitous() {
  const originText = originInput.value.trim();
  const destText = destinationInput.value.trim();
  if (!originText || !destText) { showError("Add meg mindkét címet!"); return; }

  const motorErr = validateMotorProfile();
  if (motorErr) { showError(motorErr); return; }

  const leg = getLegProfile();
  const modes = getActiveModes();
  const useRental = modes.has("RENTAL");
  const transitModes = tsTransitModes(modes);
  const carEnabled = isCarEnabled();
  const bikeEnabled = ENABLE_BIKE_FEATURES && !!document.getElementById("use-bike")?.checked;

  if (!transitModes && !carEnabled && !bikeEnabled && !useRental) {
    showError("Válassz legalább egy közlekedési módot!");
    return;
  }

  clearUI();
  departScheduleNote = null;
  setLoading(true, "Tervezés…");

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

    const maxCarSec = parseInt(carSlider.value, 10) * 60;
    const maxBikeSec = Math.round(((parseFloat(bikeKmSlider?.value) || 15) * 1000) / TS_BIKE_MPS);
    const endModes = (kind) =>
      kind === "car" ? ["CAR_PARKING"] : kind === "bike" ? ["BIKE"] : useRental ? ["WALK", "RENTAL"] : ["WALK"];
    /**
     * Az út egyik végének kerete (s). Ahol nincs saját jármű, de a MOL Bubi be van kapcsolva, ott 30 perc:
     * a Transitous alapból 15 percet enged a végre, abba a séta az állomásig + a tekerés + a séta a célig
     * nem fér bele (pl. Keleti -> Angyalföld: 3 + 14 + 5 perc), így Bubis utat sosem adott.
     */
    const endLimit = (kind, carSec = maxCarSec) =>
      kind === "car" ? carSec + TS_PARK_WALK_SEC : kind === "bike" ? maxBikeSec : useRental ? TS_RENTAL_END_SEC : undefined;
    const rentalFF = useRental ? ["BICYCLE"] : undefined;

    const directModes = [];
    if (carEnabled) directModes.push("CAR");
    if (bikeEnabled) directModes.push("BIKE");
    if (useRental) directModes.push("RENTAL");

    /** 1) Tisztán tömegközlekedés (viszonyítási alap) + tisztán autó / bicikli / Bubi a direct listában. */
    const requests = [{
      kind: "pure",
      params: {
        transitModes: transitModes || undefined,
        preTransitModes: ["WALK"],
        postTransitModes: ["WALK"],
        directModes: directModes.length ? directModes : ["WALK"],
        maxDirectTime: directModes.length ? TS_MAX_DIRECT_SEC : undefined,
        directRentalFormFactors: rentalFF,
      },
    }];

    /** 2) Járművel az egyik / mindkét végén (P+R, saját bicikli, Bubi). */
    const hasVehicleEnd = leg.first !== "none" || leg.last !== "none" || useRental;
    const vehicleParams = (carSec) => ({
      transitModes,
      preTransitModes: endModes(leg.first),
      postTransitModes: endModes(leg.last),
      maxPreTransitTime: endLimit(leg.first, carSec),
      maxPostTransitTime: endLimit(leg.last, carSec),
      preTransitRentalFormFactors: leg.first === "none" ? rentalFF : undefined,
      postTransitRentalFormFactors: leg.last === "none" ? rentalFF : undefined,
      directModes: ["WALK"],
      maxDirectTime: 60,
    });
    if (transitModes && hasVehicleEnd) {
      requests.push({ kind: "vehicle", params: vehicleParams(maxCarSec) });
      /**
       * 3) Kisebb autós keretekkel is: a Transitous kérésenként a leggyorsabbat adja, így egy keret
       * mellett a köztes P+R állomások kimaradnak (pl. Csákberény -> Budapest: 45 percnél Biatorbágy,
       * a felénél Székesfehérvár). 65 és 35 százaléknál is kérünk; a Transitous által nem ismert
       * P+R-eket (pl. Bicske) a vasútállomás-keresés pótolja (5).
       */
      if (leg.first === "car" || leg.last === "car") {
        const limits = [0.65, 0.35]
          .map((f) => Math.round((maxCarSec * f) / 60) * 60)
          .filter((s, i, a) => s >= 300 && a.indexOf(s) === i);
        for (const s of limits) requests.push({ kind: "lessCar", params: vehicleParams(s) });
      }
    }

    /** Saját ponton át tervezésnél a másik vég beállításai (mód, keret, Bubi-szűrő). */
    const viaCtx = (pos) => {
      const otherKind = pos === "first" ? leg.last : leg.first;
      return {
        transitModes,
        otherEnd: endModes(otherKind),
        otherLimit: endLimit(otherKind),
        otherFF: otherKind === "none" ? rentalFF : undefined,
      };
    };

    /** 4) Saját átszállási pont(ok): azon a végen, ahol az autó / a bicikli be van kapcsolva. */
    const viaJobs = [];
    const viaNotes = [];
    if (transitModes) {
      for (const kind of ["car", "bike"]) {
        const pos = leg.first === kind ? "first" : leg.last === kind ? "last" : null;
        if (!pos) continue;
        let point = null;
        try {
          point = await resolveTransferPoint(kind);
        } catch (e) {
          viaNotes.push(`A saját ${kind === "car" ? "P+R" : "átszállási"} pont nem található (${e.message}).`);
        }
        if (!point) continue;
        viaJobs.push({
          kind,
          point,
          result: tsViaPointCandidate(origin, dest, point, kind, pos, viaCtx(pos))
            .then((c) => ({ c }), (err) => ({ err })),
        });
      }
    }

    /** 5) Vasútállomás-keresés az autós végen (tsPickScanStations): a one-to-all már most indul. */
    const carPos = leg.first === "car" ? "first" : leg.last === "car" ? "last" : null;
    const scanData = transitModes && carPos
      ? tsFetchOneToAll(carPos === "first" ? dest : origin, { maxTravelTime: 120, transitModes }, tsScanTimeParams(carPos))
        .catch(() => null)
      : Promise.resolve(null);

    setLoading(true, "Tervezés… (Transitous)");
    const settled = await Promise.allSettled(requests.map((r) => tsFetchPlan(origin, dest, r.params)));
    const ok = settled.map((s, i) => ({ req: requests[i], data: s.status === "fulfilled" ? s.value : null }));
    if (ok.every((r) => !r.data)) throw settled[0].reason || new Error("Nem található útvonal.");

    const pureData = ok.find((r) => r.req.kind === "pure")?.data;
    const pureIts = transitModes ? pureData?.itineraries || [] : [];
    const baselineSec = pureIts.length ? Math.min(...pureIts.map((it) => it.duration)) : null;

    const seen = new Set();
    const add = (list, c, withTime = true) => {
      if (!c) return;
      const k = tsCandidateKey(c, withTime);
      if (seen.has(k)) return;
      seen.add(k);
      list.push(c);
    };

    const pureTransit = [];
    for (const it of pureIts) add(pureTransit, tsCandidate(it, baselineSec));

    /** Járműves változatok: előbb rendezünk (idő, majd érkezés), és vonalsoronként csak a legjobb marad. */
    const vehicleAll = [];
    for (const r of ok) {
      if (!r.data || r.req.kind === "pure") continue;
      for (const it of r.data.itineraries || []) {
        const c = tsCandidate(it, baselineSec);
        if (c && c.tag !== "pureTransit") vehicleAll.push(c);
      }
    }

    /**
     * 5) folytatás: a megtalált P+R-ek felszállóhelyei (és a saját pont) mellett nem keresünk újat;
     * a többi autóval elérhető vasútállomás közül a legjobb kettőn át saját ponttal tervezünk.
     */
    if (carPos) {
      const skip = [];
      for (const c of vehicleAll) {
        if (c.tag !== "mixed") continue;
        const tr = c.transit.legs.filter((l) => modeCat(l.mode) === "transit");
        const stop = carPos === "first" ? tr[0]?.from : tr[tr.length - 1]?.to;
        if (Number.isFinite(stop?.lat)) skip.push({ lat: stop.lat, lon: stop.lon });
      }
      for (const job of viaJobs) if (job.kind === "car") skip.push(job.point);
      const picks = tsPickScanStations(await scanData, carPos === "first" ? origin : dest, maxCarSec, skip);
      const found = await Promise.all(picks.map((p) =>
        tsViaPointCandidate(origin, dest, p, "car", carPos, viaCtx(carPos)).catch(() => null)));
      for (const c of found) {
        if (!c) continue;
        c.customPoint = null;
        c.showAlways = false;
        c.savedSec = baselineSec != null ? baselineSec - c.totalSec : 0;
        vehicleAll.push(c);
      }
    }

    vehicleAll.sort((a, b) => a.totalSec - b.totalSec || tsByTime(a, b));
    const vehicle = [];
    for (const c of vehicleAll) {
      /** A csúszka az autózás ideje (a kérés kerete a parkolótól tartó sétát is tartalmazza). */
      if (totalCarMotorSec(c) > maxCarSec + 30) continue;
      add(vehicle, c, false);
    }

    const direct = [];
    for (const it of pureData?.direct || []) add(direct, tsCandidate(it, baselineSec));
    const directOrder = { pureRental: 0, pureStreetBike: 1, pureCar: 2 };
    direct.sort((a, b) => (directOrder[a.tag] ?? 9) - (directOrder[b.tag] ?? 9) || a.totalSec - b.totalSec);
    /** Típusonként csak a leggyorsabb közvetlen út. */
    const directBest = direct.filter((c, i) => direct.findIndex((d) => d.tag === c.tag) === i);

    pureTransit.sort(tsByTime);

    /**
     * Mit mutatunk a járműves változatokból: járműtípusonként a "nem rosszabb" változatokat (Pareto-front
     * az összidő és a járműben töltött idő szerint). Egy P+R akkor kerül be, ha nincs másik, ami egyszerre
     * gyorsabb ÉS kevesebb autózással (biciklizéssel) jár. Így a "majdnem végig autó" és a
     * "csak a sarokig autó" között a köztes P+R-ek is látszanak. Típusonként legfeljebb 4.
     */
    const vehicleSec = (c) =>
      c.tag === "mixed" ? totalCarMotorSec(c) : c.tag === "bikeTransit" ? totalBikeTimeSec(c) : totalRentalSec(c);
    /**
     * Csoportok: járműtípus, és külön az, amelyikben MOL Bubi is van (pl. autó Székesfehérvárig, IC a
     * Keletiig, onnan Bubi). Ez ugyanannyi autózással jár, mint a metrós párja, ezért egy csoportban
     * közeli másolatnak számítana és kimaradna. A Bubis csoportból legfeljebb 2 kerül ki.
     */
    const groupOf = (c) =>
      c.tag + (c.tag !== "rentalTransit" && c.transit.legs.some((l) => l.mode === "RENTAL") ? "+bubi" : "");
    const groups = ["mixed", "bikeTransit", "rentalTransit", "mixed+bubi", "bikeTransit+bubi"];
    const vehicleShown = [];
    for (const group of groups) {
      let bestVehicleSec = Infinity;
      let n = 0;
      const maxN = group.endsWith("+bubi") ? 2 : 4;
      for (const c of vehicle.filter((x) => groupOf(x) === group)) {
        const vs = vehicleSec(c);
        /** Legalább 5 perccel (és 15%-kal) kevesebb járműidő kell, különben csak egy közeli másolat. */
        if (vs <= Math.min(bestVehicleSec - 300, bestVehicleSec * 0.85) && n < maxN) {
          c.showAlways = true;
          vehicleShown.push(c);
          bestVehicleSec = vs;
          n++;
        }
      }
    }
    vehicleShown.sort((a, b) => a.totalSec - b.totalSec);

    const custom = [];
    for (const job of viaJobs) {
      const r = await job.result;
      if (r.c) {
        r.c.savedSec = baselineSec != null ? baselineSec - r.c.totalSec : 0;
        custom.push(r.c);
        savePoint(job.point);
      } else {
        viaNotes.push(`A saját pontnál (${job.point.name}): ${r.err?.message || "hiba"}`);
      }
    }

    const finalList = [...custom, ...vehicleShown, ...pureTransit.slice(0, 3), ...directBest];
    if (!finalList.length) throw new Error("Nem található útvonal ezekkel a beállításokkal.");

    departScheduleNote = null;
    const first = finalList.find((c) => c.transit?.legs?.length);
    const req = requestedDepartMs();
    if (first && req != null && first.transit.startTime > req + 90 * 1000) {
      departScheduleNote =
        `A megadott időponthoz képest ez a legkorábbi elérhető útvonal (indulás: ${fmtTime(first.transit.startTime)}).`;
    }
    if (viaNotes.length) departScheduleNote = [departScheduleNote, ...viaNotes].filter(Boolean).join(" ");

    drawRoute(finalList[0]);
    renderAlternatives(finalList, 0);
    if (window.matchMedia("(max-width: 700px)").matches) {
      /** Telefonon a panel görgessen az eredményekhez (kis késéssel, hogy a lenyíló alpanelek beálljanak). */
      const sb = document.getElementById("sidebar");
      setTimeout(() => sb?.scrollTo({ top: resultsDiv.offsetTop - 12, behavior: "smooth" }), 350);
    }
  } catch (err) {
    console.error(err);
    showError(err.message);
    clearRoute();
  } finally {
    setLoading(false);
  }
}
