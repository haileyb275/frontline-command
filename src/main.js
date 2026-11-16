// Entry point: the first JavaScript that runs. Its only job is to start the
// other modules and connect them to each other.

import './style.css';
import { createMap, formatLatLng } from './map.js';
import { initPanel } from './ui/panel.js';

const coordsEl = document.getElementById('coords');

const map = createMap(document.getElementById('map'), {
  // Phase 1: clicking just reports the position. In Phase 3 this same click
  // becomes "place a base here".
  onClick: (latlng) => {
    coordsEl.textContent = formatLatLng(latlng);
  },
});

initPanel();

// Handy while developing: type `fcMap` in the browser console to poke at the
// Leaflet map. Vite strips this branch out of the production build.
if (import.meta.env.DEV) {
  window.fcMap = map;
}
