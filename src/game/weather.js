// Weather and day/night.
//
// Nothing is stored or fetched: both are worked out from position and time
// with the same whole-number arithmetic the server uses (fc_weather and
// fc_is_night in 012_places_weather.sql), so every player and the server
// always agree. If you change one side, change the other to match.

import { settings } from './content.js';

export const WEATHER = {
  clear: { label: 'Clear', icon: '☀' },
  overcast: { label: 'Overcast', icon: '☁' },
  rain: { label: 'Rain', icon: '🌧' },
  storm: { label: 'Storm', icon: '⛈' },
};

/** 'clear' | 'overcast' | 'rain' | 'storm' over a point at a time (ms since 1970). */
export function weatherAt(lat, lng, ms) {
  const n =
    (Math.floor((lat + 90) / 2) * 7919 +
      Math.floor((lng + 180) / 2) * 104729 +
      Math.floor(ms / 1000 / 10800) * 1299709) % 1000;
  const roll = (n * n * 31 + n * 17 + 7) % 100;
  if (roll < 55) return 'clear';
  if (roll < 75) return 'overcast';
  if (roll < 92) return 'rain';
  return 'storm';
}

/** Is it night at this longitude? Local solar time: 15 degrees per hour. */
export function isNight(lng, ms) {
  const hour = (((ms / 3600000 + lng / 15) % 24) + 24) % 24;
  return hour >= settings.night_start_hour || hour < settings.night_end_hour;
}

/** How much longer a trip takes in this weather for a unit of this domain (1 = no effect). */
export function travelSlowdown(weather, domain) {
  if (domain === 'air') return 1;
  if (weather === 'storm') return settings.weather_storm_slow;
  if (weather === 'rain') return settings.weather_rain_slow;
  return 1;
}

/** A short line such as "🌧 Rain · night" for a place. */
export function conditionsText(lat, lng, ms) {
  const w = WEATHER[weatherAt(lat, lng, ms)];
  return `${w.icon} ${w.label}${isNight(lng, ms) ? ' · night' : ''}`;
}
