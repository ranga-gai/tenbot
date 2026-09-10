/**
 * Weather forecasts via Open-Meteo (https://open-meteo.com) -- free, no API
 * key required. Two calls: geocode the place name, then fetch the forecast.
 */

const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm'
};

async function geocode(location) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    throw new Error(`Couldn't find a location matching "${location}"`);
  }
  const { latitude, longitude, name, admin1, country } = data.results[0];
  return {
    latitude,
    longitude,
    label: [name, admin1, country].filter(Boolean).join(', ')
  };
}

/**
 * Returns a 3-day forecast for the given location name.
 */
async function getForecast(location) {
  const { latitude, longitude, label } = await geocode(location);

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&timezone=auto&forecast_days=3`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast request failed: ${res.status}`);
  const data = await res.json();

  const days = data.daily.time.map((date, i) => ({
    date,
    maxTemp: data.daily.temperature_2m_max[i],
    minTemp: data.daily.temperature_2m_min[i],
    rainChance: data.daily.precipitation_probability_max[i],
    condition: WEATHER_CODES[data.daily.weathercode[i]] || 'Unknown'
  }));

  return { label, days };
}

/** Format a forecast into a short WhatsApp-friendly message. */
function formatForecast(forecast) {
  const dayLabels = ['Today', 'Tomorrow', 'Day after'];
  const lines = forecast.days.map((d, i) => {
    const label = dayLabels[i] || d.date;
    return `${label}: ${d.condition}, ${Math.round(d.minTemp)}–${Math.round(d.maxTemp)}°C, ${d.rainChance}% chance of rain`;
  });
  return `🎾 Weather for ${forecast.label}:\n${lines.join('\n')}`;
}

module.exports = { getForecast, formatForecast };
