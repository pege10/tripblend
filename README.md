# TripBlend

P+R útvonaltervező és elérhetőségi térkép Magyarországra. Autó, saját bicikli vagy MOL Bubi az út elején vagy végén, közte vonat, HÉV, busz, villamos, metró.

**Élő oldal:** https://pege10.github.io/tripblend/

## Mit tud

**Útvonal**
- Tisztán tömegközlekedés, tisztán autó / bicikli / MOL Bubi, és ezek kombinációi.
- P+R: autóval egy állomásig, onnan tömegközlekedéssel (vagy fordítva, az érkezésnél). Több autós kerettel keres, így a "majdnem végig autó" és a "csak a sarokig autó" mellett a köztes P+R állomások is megjelennek.
- A Transitous csak ott parkoltat, ahol ismeri a parkolót (Bicskén pl. nem), és ugyanarra a vonatra mindig a legtöbb autózással elérhető állomást adja. Ezért az app maga is keres: az autóval elérhető vasútállomások közül a két legígéretesebbre külön tervez (autó az állomásig, parkolás, vonat).
- A "Max. autózás" az autóban töltött idő (a parkolótól az állomásig tartó séta nem számít bele).
- Saját átszállási pont: megadhatod, hol teszed le az autót vagy a biciklit (pl. "Bicske vasútállomás"). A használt pontokat a böngésző megjegyzi.
- Javaslatlista minden cím- és állomásmezőben: gépelés közben címet, települést, megállót, vasútállomást ajánl (a Transitous címkeresője); kattintásra a mező a pontos nevet kapja.
- Időpont: Most indulok, Indulás időpontja vagy Érkezés időpontja (vagy-vagy, mint a Google Térképen), illetve az utolsó járat.

**Elérhetőség (izokron térkép)**
- Egy helyből (vagy egy helyre érkezve) mi érhető el X perc utazással, színes sávokban. Az időpont itt is Most indulok / Indulás / Érkezés, bármelyik iránnyal.
- Az idő az utazás ideje: egy 60 perces indulási (vagy érkezési) ablakban a leggyorsabb út számít, így a ritkán járó, de gyors busz sem esik ki.
- Gyalog + tömegközlekedéssel, és az út bármelyik végén autóval (P+R) vagy biciklivel. A túlsó végi jármű a térképen légvonalbeli becslés (a sebesség valódi autós időkből).
- Kattintásra kiírja a leggyorsabb utat: mivel, honnan, meddig, aztán hogyan tovább. Egy gombbal útvonalat is tervez oda.

Telefonon is használható: a panel alulra kerül, fölötte a térkép.

## Adatok és forrásmegjelölés

- **Útvonaltervezés, menetrend, MOL Bubi:** [Transitous](https://transitous.org) ([adatforrások](https://transitous.org/sources/)). Közösségi, nem kereskedelmi szolgáltatás; ez az app a [használati feltételei](https://transitous.org/api/) szerint működik (nyílt forrás, forrásmegjelölés, mérsékelt terhelés).
- **Térkép:** [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap](https://www.openstreetmap.org/copyright) közreműködők.
- **Címkeresés:** [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap), állomásnevekhez a Transitous címkeresője.

## Futtatás helyben

Statikus oldal, build nem kell:

```bash
python3 -m http.server 8095
```

Böngészőben: http://localhost:8095

## Felépítés

- `index.html`, `style.css`: felület (MapLibre GL JS).
- `app.js`: térkép, útvonal-kártyák, címkék (Leggyorsabb, Legkevesebb autózás stb.).
- `transitous.js`: útvonaltervezés a Transitous `/plan` végpontjával; P+R, bicikli, bérbicikli, saját átszállási pont.
- `isochrone.js`: Elérhetőség nézet a Transitous `/one-to-all` végpontjával.
- `suggest.js`: javaslatlista a cím- és állomásmezőkhöz (Transitous `/geocode`).

Egy útvonaltervezés kb. 4 kérés, autóval kb. 10 (P+R-keretek + vasútállomás-keresés), saját átszállási ponttal még 2-3; egy izokron 6, egy kattintás az izokronon 1, a javaslatlista gépelésenként legfeljebb 1 (300 ms várakozással). Minden kérés egy közös soron megy (`tsFetchJson`): a Transitous egyszerre 3 kérést enged, a negyedikre 429-et ad.

### Helyi OpenTripPlanner (opcionális)

Az app eredetileg egy helyben futó OpenTripPlanner 2.6 szerverrel készült (`localhost:8080`, BKK + MÁV + Volánbusz GTFS, OSM Magyarország). Ez a változat `?backend=otp` paraméterrel érhető el; a gráf és a GTFS-fájlok nincsenek a repóban, az `otp/data` konfigurációs fájljai igen.

## Licenc

MIT, lásd [LICENSE](LICENSE).
