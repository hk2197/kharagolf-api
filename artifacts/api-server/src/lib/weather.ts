/**
 * Weather service with 15-minute in-memory cache.
 * Uses OpenWeatherMap API if OPENWEATHERMAP_API_KEY is set,
 * otherwise falls back to the free Open-Meteo API.
 */

export interface WeatherData {
  temperature: number;
  windSpeed: number;
  windDirection: number;
  precipitation: number;
  weatherCode: number;
  description: string;
  humidity: number;
  feelsLike: number;
  alerts: string[];
  source: "owm" | "open-meteo";
}

interface CacheEntry {
  data: WeatherData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

// WMO weather codes 51–82 indicate drizzle, rain, or showers.
// Codes 95–99 indicate thunderstorms with rain.
function isRainyCode(code: number): boolean {
  return (code >= 51 && code <= 82) || (code >= 95 && code <= 99);
}

function buildAlerts(data: WeatherData): string[] {
  const alerts: string[] = [];
  if (data.windSpeed >= 30) alerts.push(`Strong wind: ${Math.round(data.windSpeed)} km/h`);
  if (isRainyCode(data.weatherCode)) alerts.push("Rain conditions — carry rain gear");
  return alerts;
}

async function fetchFromOWM(lat: number, lng: number, apiKey: string): Promise<WeatherData> {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OWM returned ${res.status}`);
  interface OWMResponse {
    main: { temp: number; feels_like: number; humidity: number };
    wind: { speed: number; deg: number };
    rain?: { "1h"?: number };
    weather: { id: number; description: string }[];
  }
  const d = await res.json() as OWMResponse;

  const windSpeedKmh = (d.wind?.speed ?? 0) * 3.6;
  const rainMm = d.rain?.["1h"] ?? 0;

  const owmCodeToWmo = (id: number): number => {
    if (id === 800) return 0;
    if (id >= 801 && id <= 802) return 2;
    if (id >= 803 && id <= 804) return 3;
    if (id >= 300 && id <= 321) return 53;
    if (id >= 500 && id <= 504) return 63;
    if (id >= 511) return 66;
    if (id >= 520 && id <= 531) return 80;
    if (id >= 200 && id <= 232) return 95;
    if (id >= 600 && id <= 622) return 71;
    return 45;
  };

  const partial: WeatherData = {
    temperature: d.main.temp,
    feelsLike: d.main.feels_like,
    humidity: d.main.humidity,
    windSpeed: windSpeedKmh,
    windDirection: d.wind?.deg ?? 0,
    precipitation: rainMm,
    weatherCode: owmCodeToWmo(d.weather?.[0]?.id ?? 800),
    description: d.weather?.[0]?.description ?? "",
    alerts: [],
    source: "owm",
  };
  partial.alerts = buildAlerts(partial);
  return partial;
}

async function fetchFromOpenMeteo(lat: number, lng: number): Promise<WeatherData> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code,apparent_temperature,relative_humidity_2m&wind_speed_unit=kmh&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  interface OpenMeteoResponse {
    current: {
      temperature_2m: number;
      wind_speed_10m: number;
      wind_direction_10m: number;
      precipitation: number;
      weather_code: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
    };
  }
  const d = await res.json() as OpenMeteoResponse;
  const c = d.current;

  const wmoCodeToDescription = (code: number): string => {
    if (code === 0) return "Clear sky";
    if (code <= 2) return "Partly cloudy";
    if (code <= 48) return "Foggy";
    if (code <= 67) return "Rainy";
    if (code <= 77) return "Snowy";
    if (code <= 82) return "Rain showers";
    return "Thunderstorm";
  };

  const partial: WeatherData = {
    temperature: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    windSpeed: c.wind_speed_10m,
    windDirection: c.wind_direction_10m,
    precipitation: c.precipitation,
    weatherCode: c.weather_code,
    description: wmoCodeToDescription(c.weather_code),
    alerts: [],
    source: "open-meteo",
  };
  partial.alerts = buildAlerts(partial);
  return partial;
}

export interface DailyWeatherObservation {
  /** YYYY-MM-DD in the course's local time. */
  date: string;
  /** Mean temperature in °C, null when unavailable. */
  temperatureMean: number | null;
  /** Max wind speed at 10 m in km/h, null when unavailable. */
  windSpeedMax: number | null;
}

const HIST_TTL_MS = 24 * 60 * 60 * 1000;
const histCache = new Map<string, { data: DailyWeatherObservation; fetchedAt: number }>();

function histKey(lat: number, lng: number, date: string): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${date}`;
}

/**
 * Fetch a single day's historical weather summary for a course location from
 * Open-Meteo's free archive API. Cached for 24h per (lat, lng, date) since
 * historical observations don't change. Returns null fields when the API
 * has no record (e.g. future date or unsupported location).
 */
export async function getHistoricalWeather(
  lat: number,
  lng: number,
  date: string,
): Promise<DailyWeatherObservation> {
  const key = histKey(lat, lng, date);
  const cached = histCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HIST_TTL_MS) return cached.data;

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${date}&end_date=${date}&daily=temperature_2m_mean,wind_speed_10m_max&wind_speed_unit=kmh&timezone=auto`;
  let observation: DailyWeatherObservation = { date, temperatureMean: null, windSpeedMax: null };
  try {
    const res = await fetch(url);
    if (res.ok) {
      interface ArchiveResponse {
        daily?: {
          time?: string[];
          temperature_2m_mean?: (number | null)[];
          wind_speed_10m_max?: (number | null)[];
        };
      }
      const d = await res.json() as ArchiveResponse;
      const t = d.daily?.temperature_2m_mean?.[0];
      const w = d.daily?.wind_speed_10m_max?.[0];
      observation = {
        date,
        temperatureMean: typeof t === "number" && Number.isFinite(t) ? t : null,
        windSpeedMax:    typeof w === "number" && Number.isFinite(w) ? w : null,
      };
    }
  } catch {
    // Swallow — the empty observation will simply be excluded from buckets.
  }
  histCache.set(key, { data: observation, fetchedAt: Date.now() });
  return observation;
}

/**
 * Hourly historical observation pulled from Open-Meteo's archive. Used by
 * the Task #1608 backfill to fill humidity & precipitation on caddie
 * recommendations made before Task #1347 started capturing those columns
 * live. The daily endpoint we use for `getHistoricalWeather` doesn't expose
 * either field — humidity has no daily aggregate at all and precipitation
 * is only available as a daily sum, which would mis-represent a per-shot
 * snapshot — so we fetch hourly values and pick the matching hour.
 */
export interface HourlyWeatherObservation {
  /** % relative humidity at the requested hour, null when unavailable. */
  humidity: number | null;
  /** Precipitation in mm during the requested hour, null when unavailable. */
  precipitation: number | null;
}

interface HourlyDayCacheEntry {
  fetchedAt: number;
  /** Map from UTC hour-of-day (0-23) to the observation. */
  hourly: Map<number, HourlyWeatherObservation>;
}

const hourlyHistCache = new Map<string, HourlyDayCacheEntry>();

function hourlyHistKey(lat: number, lng: number, date: string): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${date}`;
}

/**
 * Fetch the per-hour historical humidity & precipitation at a course location
 * for the UTC hour of `at`. One archive call covers all 24 hours of the date
 * and is cached for 24h per (lat, lng, date), so repeated lookups for
 * different recommendations on the same day at the same course only hit
 * Open-Meteo once. Returns nulls when the API has no record (e.g. the date
 * is too recent — Open-Meteo's archive lags ~5 days — or the location is
 * unsupported).
 */
export async function getHistoricalHourlyWeather(
  lat: number,
  lng: number,
  at: Date,
): Promise<HourlyWeatherObservation> {
  const date = at.toISOString().slice(0, 10);
  const hour = at.getUTCHours();
  const key = hourlyHistKey(lat, lng, date);

  let cached = hourlyHistCache.get(key);
  if (!cached || Date.now() - cached.fetchedAt >= HIST_TTL_MS) {
    cached = { fetchedAt: Date.now(), hourly: new Map() };
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${date}&end_date=${date}&hourly=relative_humidity_2m,precipitation&timezone=UTC`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        interface ArchiveHourlyResponse {
          hourly?: {
            time?: string[];
            relative_humidity_2m?: (number | null)[];
            precipitation?: (number | null)[];
          };
        }
        const d = await res.json() as ArchiveHourlyResponse;
        const times = d.hourly?.time ?? [];
        const hums  = d.hourly?.relative_humidity_2m ?? [];
        const precs = d.hourly?.precipitation ?? [];
        for (let i = 0; i < times.length; i++) {
          const t = times[i];
          // Open-Meteo returns ISO8601 hour stamps like "2025-04-12T14:00".
          const m = /T(\d{2}):/.exec(t);
          if (!m) continue;
          const h = parseInt(m[1], 10);
          if (!Number.isFinite(h)) continue;
          const hum  = hums[i];
          const prec = precs[i];
          cached.hourly.set(h, {
            humidity:      typeof hum  === "number" && Number.isFinite(hum)  ? hum  : null,
            precipitation: typeof prec === "number" && Number.isFinite(prec) ? prec : null,
          });
        }
      }
    } catch {
      // Swallow — the empty cache entry will yield null observations and
      // the caller treats them the same as a "no archive data" response.
    }
    hourlyHistCache.set(key, cached);
  }
  return cached.hourly.get(hour) ?? { humidity: null, precipitation: null };
}

// ─── DAILY FORECAST ─────────────────────────────────────────────────────────
//
// Task #1994 — modifier preview pre-fills its simulated weather from the
// live multi-day forecast so admins can see whether a "rain discount" is
// actually likely to fire in the next week. We use Open-Meteo's free daily
// forecast endpoint (no API key required) and cache per (lat, lng, days)
// for an hour — well below Open-Meteo's update cadence and enough to keep
// repeat preview opens off the wire.

/**
 * Canonical, lower-cased weather condition string used by demand modifiers.
 * Modifiers compare case-insensitively against the slot's stored condition
 * (`dynamicPricing.evaluateModifier`), so pre-filling with one of these
 * values lets a "rain discount" modifier whose `weatherCondition: "rain"`
 * fire on rainy forecast days out of the box.
 */
export type WeatherConditionKey =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "thunderstorm";

/**
 * Map a WMO weather interpretation code (Open-Meteo's `weather_code`) to a
 * coarse condition bucket. Returns `null` when the code is missing or
 * outside the documented range so the caller can degrade gracefully.
 *
 * Buckets follow the Open-Meteo WMO docs:
 *   0          → clear
 *   1–2        → partly cloudy
 *   3          → cloudy
 *   45, 48     → fog
 *   51–67, 80–82 → rain (drizzle, rain, showers, freezing rain)
 *   71–77, 85–86 → snow (snowfall, snow grains, snow showers)
 *   95–99      → thunderstorm
 */
export function conditionFromWmoCode(code: number | null | undefined): WeatherConditionKey | null {
  if (code == null || !Number.isFinite(code)) return null;
  if (code === 0) return "clear";
  if (code <= 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code <= 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return "snow";
  if (code >= 95 && code <= 99) return "thunderstorm";
  return null;
}

export interface DailyForecast {
  /** YYYY-MM-DD in the course's local time. */
  date: string;
  /** Raw WMO weather code, null when missing. */
  weatherCode: number | null;
  /** Condition bucket derived from `weatherCode`, null when unknown. */
  condition: WeatherConditionKey | null;
  /** Daily precipitation total in mm, null when unavailable. */
  precipitationSum: number | null;
  /** Daily max wind speed at 10 m in km/h, null when unavailable. */
  windSpeedMax: number | null;
  /** Daily max temperature in °C, null when unavailable. */
  temperatureMax: number | null;
  /** Daily min temperature in °C, null when unavailable. */
  temperatureMin: number | null;
}

const FORECAST_TTL_MS = 60 * 60 * 1000;
const forecastCache = new Map<string, { data: DailyForecast[]; fetchedAt: number }>();

function forecastKey(lat: number, lng: number, days: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${days}`;
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Fetch the next `days` of daily forecast at a course location from
 * Open-Meteo. Cached for 1h per (lat, lng, days). Returns an empty array
 * when the API is unreachable or returns no data — callers should treat
 * that as "forecast unavailable" and degrade accordingly. `days` is
 * clamped to Open-Meteo's documented 1–16 range.
 */
export async function getDailyForecast(
  lat: number,
  lng: number,
  days: number,
): Promise<DailyForecast[]> {
  const requested = Math.max(1, Math.min(16, Math.floor(Number(days) || 1)));
  const key = forecastKey(lat, lng, requested);
  const cached = forecastCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FORECAST_TTL_MS) return cached.data;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weather_code,precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min` +
    `&wind_speed_unit=kmh&forecast_days=${requested}&timezone=auto`;

  let result: DailyForecast[] = [];
  try {
    const res = await fetch(url);
    if (res.ok) {
      interface ForecastResponse {
        daily?: {
          time?: string[];
          weather_code?: (number | null)[];
          precipitation_sum?: (number | null)[];
          wind_speed_10m_max?: (number | null)[];
          temperature_2m_max?: (number | null)[];
          temperature_2m_min?: (number | null)[];
        };
      }
      const j = await res.json() as ForecastResponse;
      const times = j.daily?.time ?? [];
      const codes = j.daily?.weather_code ?? [];
      const precs = j.daily?.precipitation_sum ?? [];
      const winds = j.daily?.wind_speed_10m_max ?? [];
      const tmaxs = j.daily?.temperature_2m_max ?? [];
      const tmins = j.daily?.temperature_2m_min ?? [];
      for (let i = 0; i < times.length; i++) {
        const code = numOrNull(codes[i] ?? null);
        result.push({
          date: times[i],
          weatherCode: code,
          condition: conditionFromWmoCode(code),
          precipitationSum: numOrNull(precs[i] ?? null),
          windSpeedMax: numOrNull(winds[i] ?? null),
          temperatureMax: numOrNull(tmaxs[i] ?? null),
          temperatureMin: numOrNull(tmins[i] ?? null),
        });
      }
    }
  } catch {
    // Swallow — empty array means "forecast unavailable" to the caller.
  }
  forecastCache.set(key, { data: result, fetchedAt: Date.now() });
  return result;
}

export async function getWeather(lat: number, lng: number): Promise<WeatherData> {
  const key = cacheKey(lat, lng);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  let data: WeatherData;
  if (apiKey) {
    data = await fetchFromOWM(lat, lng, apiKey);
  } else {
    data = await fetchFromOpenMeteo(lat, lng);
  }

  cache.set(key, { data, fetchedAt: Date.now() });
  return data;
}
