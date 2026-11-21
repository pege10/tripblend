/* ================================================================
   TripBlend – javaslatlista a cím- és állomásmezőkhöz
   Indulás, érkezés és a két saját átszállási pont: gépelés közben a Transitous címkeresője
   (/api/v1/geocode) ad javaslatokat: címet, települést, megállót, vasútállomást. A Nominatim
   szabályai a gépelés közbeni keresést tiltják, ezért nem az. A saját pontoknál a korábban
   használt pontok is megjelennek. Kattintásra (vagy Enterre a kijelöltön) a mező a pontos nevet
   kapja, és a koordináta is rögzül, mintha a térképen jelölted volna ki.

   A lista a <body>-ban van, fix pozícióval: az autós / biciklis alpanel (motor-expand) levágná.
   ================================================================ */

const SUGGEST_MIN_CHARS = 3;
const SUGGEST_DELAY_MS = 300;
const SUGGEST_MAX = 7;
const suggestCache = new Map();

function suggestEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Egy címkereső-találat a listába: a mezőbe kerülő név, alatta a típus és a hely, ikon. */
function suggestItem(m) {
  const areas = m.areas || [];
  const city = areas.find((a) => a.default)?.name || "";
  const district = areas.find((a) => a.adminLevel === 9)?.name || "";
  const county = areas.find((a) => a.adminLevel === 7 || a.adminLevel === 6)?.name || "";
  const modes = m.modes || [];
  const rail = modes.some((x) => TS_RAIL_LIKE.has(x));
  let main = `${m.name || ""}${m.houseNumber ? ` ${m.houseNumber}` : ""}`.trim();
  /** A csak településnévvel jelölt vasútállomás ("Bicske") ne tűnjön a településnek. */
  if (m.type === "STOP" && rail && city && main.toLowerCase() === city.toLowerCase()) main += " vasútállomás";
  const value = m.type !== "PLACE" && city && !main.toLowerCase().startsWith(city.toLowerCase())
    ? `${city}, ${main}`
    : main;
  let kind, icon;
  if (m.type === "STOP") {
    if (rail) { kind = "Vasútállomás"; icon = "train"; }
    else if (modes.includes("SUBWAY")) { kind = "Metrómegálló"; icon = "subway"; }
    else if (modes.includes("TRAM")) { kind = "Villamosmegálló"; icon = "tram"; }
    else { kind = "Megálló"; icon = "directions_bus"; }
  } else if (m.type === "PLACE") {
    kind = "Település"; icon = "location_city";
  } else {
    kind = "Cím"; icon = "home_pin";
  }
  return { value, sub: [kind, district || county].filter(Boolean).join(" | "), icon, lat: m.lat, lon: m.lon };
}

async function suggestFetch(text) {
  const key = text.toLowerCase();
  if (suggestCache.has(key)) return suggestCache.get(key);
  const c = map.getCenter();
  const q = new URLSearchParams({
    text, language: "hu", place: `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`, numResults: "8",
  });
  let list = [];
  try {
    list = await tsFetchJson(`${TS_GEOCODE_URL}?${q}`);
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!Number.isFinite(m.lat)) continue;
    const it = suggestItem(m);
    const k = `${it.value.toLowerCase()}|${it.sub}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  suggestCache.set(key, out);
  return out;
}

/**
 * Javaslatlista egy mezőhöz.
 * @param {HTMLInputElement} input
 * @param {(p: {lat:number, lon:number, name:string}) => void} onPick
 * @param {{ saved?: boolean }} opts  saved: a korábban használt saját pontok is (elöl)
 */
function attachSuggest(input, onPick, { saved = false } = {}) {
  if (!input) return;
  input.setAttribute("autocomplete", "off");
  const list = document.createElement("div");
  list.className = "suggest-list hidden";
  list.setAttribute("role", "listbox");
  document.body.appendChild(list);
  let items = [];
  let active = -1;
  let timer = null;
  let token = 0;

  const isOpen = () => !list.classList.contains("hidden");
  const close = () => {
    list.classList.add("hidden");
    active = -1;
  };
  /** A mező alá (ha alul nincs hely, fölé), a mező szélességében. */
  const place = () => {
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    if (below < 220 && r.top > below) {
      list.style.top = "";
      list.style.bottom = `${window.innerHeight - r.top + 4}px`;
    } else {
      list.style.bottom = "";
      list.style.top = `${r.bottom + 4}px`;
    }
  };
  const render = () => {
    if (!items.length || document.activeElement !== input) { close(); return; }
    list.innerHTML = items.map((it, i) =>
      `<div class="suggest-item${i === active ? " active" : ""}" role="option" data-i="${i}">${mi(it.icon)}`
      + `<span><b>${suggestEsc(it.value)}</b>${it.sub ? `<small>${suggestEsc(it.sub)}</small>` : ""}</span></div>`,
    ).join("");
    list.classList.remove("hidden");
    place();
  };
  const pick = (it) => {
    input.value = it.value;
    close();
    onPick({ lat: it.lat, lon: it.lon, name: it.value });
  };
  const savedHits = (text) => {
    if (!saved) return [];
    const t = text.toLowerCase();
    return loadSavedPoints()
      .filter((p) => !t || p.name.toLowerCase().includes(t))
      .slice(0, 4)
      .map((p) => ({ value: p.name, sub: "Korábban használt", icon: "history", lat: p.lat, lon: p.lon }));
  };
  const refresh = () => {
    clearTimeout(timer);
    const text = input.value.trim();
    const mine = savedHits(text);
    items = mine;
    active = -1;
    render();
    if (text.length < SUGGEST_MIN_CHARS) return;
    const my = ++token;
    timer = setTimeout(async () => {
      const found = await suggestFetch(text);
      if (my !== token) return;
      const seen = new Set(mine.map((s) => s.value.toLowerCase()));
      items = [...mine, ...found.filter((f) => !seen.has(f.value.toLowerCase()))].slice(0, SUGGEST_MAX);
      active = -1;
      render();
    }, SUGGEST_DELAY_MS);
  };

  input.addEventListener("input", refresh);
  input.addEventListener("focus", () => { if (saved && !input.value.trim()) refresh(); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  /** Rögzítő fázisban: az Enter a kijelölt javaslatot választja, és nem indít tervezést (app.js). */
  input.addEventListener("keydown", (e) => {
    if (!isOpen() || !items.length) return;
    if (e.key === "ArrowDown") {
      active = (active + 1) % items.length;
      render();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      active = (active - 1 + items.length) % items.length;
      render();
      e.preventDefault();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(items[active]);
    } else if (e.key === "Escape") {
      close();
    }
  }, true);
  /** mousedown: a mező ne veszítse el a fókuszt, mielőtt a választás megtörténik. */
  list.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".suggest-item");
    if (!el) return;
    e.preventDefault();
    pick(items[+el.dataset.i]);
  });
  document.getElementById("sidebar")?.addEventListener("scroll", () => { if (isOpen()) place(); }, { passive: true });
  window.addEventListener("resize", () => { if (isOpen()) place(); });
}

attachSuggest(originInput, (p) => {
  originCoord = { lat: p.lat, lon: p.lon };
  updatePickMarkers();
});
attachSuggest(destinationInput, (p) => {
  destCoord = { lat: p.lat, lon: p.lon };
  updatePickMarkers();
});
for (const kind of ["car", "bike"]) {
  attachSuggest(tpInput(kind), (p) => {
    transferPoints[kind] = p;
    updateTransferMarkers();
  }, { saved: true });
}
