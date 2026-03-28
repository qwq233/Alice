#!/usr/bin/env npx tsx
/**
 * weather CLI — 天气查询。
 *
 * 用法: npx tsx weather.ts <city>
 * 输出: JSON to stdout
 *
 * 接入 Open-Meteo API（免费、无 API key、全球覆盖）。
 * 两步流程：Geocoding → Forecast。
 *
 * @see https://open-meteo.com/en/docs
 */

// ── WMO Weather Code → emoji + 中文描述 ──

const WMO_CODES: Record<number, { emoji: string; desc: string }> = {
  0: { emoji: "☀️", desc: "晴" },
  1: { emoji: "🌤️", desc: "大部分晴" },
  2: { emoji: "⛅", desc: "多云" },
  3: { emoji: "☁️", desc: "阴" },
  45: { emoji: "🌫️", desc: "雾" },
  48: { emoji: "🌫️", desc: "冻雾" },
  51: { emoji: "🌦️", desc: "小毛毛雨" },
  53: { emoji: "🌦️", desc: "毛毛雨" },
  55: { emoji: "🌦️", desc: "大毛毛雨" },
  56: { emoji: "🌧️", desc: "冻毛毛雨" },
  57: { emoji: "🌧️", desc: "冻雨" },
  61: { emoji: "🌧️", desc: "小雨" },
  63: { emoji: "🌧️", desc: "中雨" },
  65: { emoji: "🌧️", desc: "大雨" },
  66: { emoji: "🌧️", desc: "冻雨" },
  67: { emoji: "🌧️", desc: "冻大雨" },
  71: { emoji: "🌨️", desc: "小雪" },
  73: { emoji: "🌨️", desc: "中雪" },
  75: { emoji: "❄️", desc: "大雪" },
  77: { emoji: "❄️", desc: "雪粒" },
  80: { emoji: "🌦️", desc: "阵雨" },
  81: { emoji: "🌧️", desc: "中阵雨" },
  82: { emoji: "⛈️", desc: "暴雨" },
  85: { emoji: "🌨️", desc: "阵雪" },
  86: { emoji: "❄️", desc: "暴雪" },
  95: { emoji: "⛈️", desc: "雷暴" },
  96: { emoji: "⛈️", desc: "雷暴+小冰雹" },
  99: { emoji: "⛈️", desc: "雷暴+大冰雹" },
};

function decodeWMO(code: number): { emoji: string; desc: string } {
  return WMO_CODES[code] ?? { emoji: "🌡️", desc: `天气代码 ${code}` };
}

function windDirection(degrees: number): string {
  const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  const idx = Math.round(degrees / 45) % 8;
  return dirs[idx];
}

// ── main ──

const city = process.argv[2];
if (!city) {
  console.error("Usage: weather.ts <city>");
  process.exit(1);
}

const signal = AbortSignal.timeout(10_000);

// Step 1: Geocode
const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
const geoRes = await fetch(geoUrl, { signal });
if (!geoRes.ok) {
  console.error(`Geocoding failed: ${geoRes.status}`);
  process.exit(1);
}
const geoData = (await geoRes.json()) as {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
  }[];
};
const geo = geoData.results?.[0];
if (!geo) {
  console.error(`City not found: ${city}`);
  process.exit(1);
}

// Step 2: Forecast
const forecastParams = new URLSearchParams({
  latitude: String(geo.latitude),
  longitude: String(geo.longitude),
  current:
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day",
  daily: "temperature_2m_max,temperature_2m_min",
  timezone: "auto",
  forecast_days: "1",
});
const forecastRes = await fetch(`https://api.open-meteo.com/v1/forecast?${forecastParams}`, {
  signal,
});
if (!forecastRes.ok) {
  console.error(`Forecast failed: ${forecastRes.status}`);
  process.exit(1);
}
const forecast = (await forecastRes.json()) as {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    is_day: number;
  };
  daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
};

const { current, daily } = forecast;
const wmo = decodeWMO(current.weather_code);
const locationName = geo.admin1
  ? `${geo.name}, ${geo.admin1}, ${geo.country}`
  : `${geo.name}, ${geo.country}`;

// 程序自己 print 格式化输出——LLM 直接读 stdout
const temp = Math.round(current.temperature_2m);
const feels = Math.round(current.apparent_temperature);
const hi = Math.round(daily.temperature_2m_max[0]);
const lo = Math.round(daily.temperature_2m_min[0]);
const wind = `${current.wind_speed_10m} km/h ${windDirection(current.wind_direction_10m)}风`;

console.log(`${wmo.emoji} Weather — ${locationName}`);
console.log(`${wmo.desc} ${temp}°C (体感 ${feels}°C)`);
console.log(`${lo}°C ~ ${hi}°C | 湿度 ${current.relative_humidity_2m}% | ${wind}`);
