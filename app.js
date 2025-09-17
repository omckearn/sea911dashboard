mapboxgl.accessToken = 'pk.eyJ1Ijoib21ja2Vhcm51dyIsImEiOiJjbTFqamRqeWcxMWF6MnJwc2RkdjBqdHoxIn0.E5gopEUreChvdj15aNY6_g';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/dark-v11',
  center: [-122.3321, 47.6062],
  zoom: 11
});

// --- Basemap styles ---
const BASE_STYLES = {
  streets:   'mapbox://styles/mapbox/streets-v12',         
  Dark_Gray:     'mapbox://styles/mapbox/dark-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
};

// Track currently active tract layer id (or 'none')
let activeLayerId = 'none'; // default to none

// Keep a reference to the layer dropdown so we can sync its value
let layerSelectEl = null;

let incidentViewMode = 'dots'; // 'dots' | 'heat'


// Data path
const tract_path = './data/tracts_wgs84.geojson';



// Population density = pop / (acres / 640)
const densityExpr = [
  '/',
  ['coalesce', ['to-number', ['get', 'TOTAL_POPULATION']], 0],
  ['max',
    ['/', ['coalesce', ['to-number', ['get', 'ACRES_LAND']], 0], 640],
    0.0001
  ]
];

// Median Age
const ageExpr = ['coalesce', ['to-number', ['get', 'MEDIAN_AGE']], 0];

// Median HH Income
const incomeExpr = [
  'coalesce',
  ['to-number', ['get', 'MEDIAN_HH_INC_PAST_12MO_DOLLAR']],
  ['to-number', ['get', 'MEDIAN_HH_INCOME']],
  0
];

// Layer configs (include "None" pseudo-layer)
const tractLayers = [
  { id: 'none',            label: 'None',                scheme: 'none'    },
  { id: 'tracts-density',  label: 'Population density',  scheme: 'density' },
  { id: 'tracts-age',      label: 'Median age',          scheme: 'age'     },
  { id: 'tracts-income',   label: 'Median HH income',    scheme: 'income'  }
];

// Real layers only (no "none")
const realLayerIds = tractLayers.filter(l => l.id !== 'none').map(l => l.id);


/* =========================================================
   GLOBALS FOR INCIDENTS COLOR MAPPING
=========================================================*/
let incidentLayerVisible = true;
window.latest911Geojson = null;

// will map crime type categories to colors
window.typeColorMap = {};  

// crime type currently selceted in the table
window.selectedCrimeType = null;
window.selectedLegendRow = null;
// Legend control
let legendCtrl = null;

// Track visible time window in hours from "24h ago" -> "now"
window.currentTimeFilter = { startHour: 0, endHour: 24 };

let basemapSelectEl = null;
let refreshVisibilityToggleUI = null;
let refreshViewModeButtonsUI = null;




// intial load
map.on('load', () => {
  buildTractLayers();
  addMainControlPanel();
  setActiveLayer(activeLayerId);

  // Incidents
  load911CallsPast24h();
  // remove bottom-left legend

  map.addControl(new mapboxgl.NavigationControl(), 'top-left');
  addDataAttributionControl();

});

function buildTractLayers() {
  // source
  if (!map.getSource('tracts')) {
    map.addSource('tracts', { type: 'geojson', data: tract_path });
  }

  // fill layers
  tractLayers.forEach(layer => {
    if (layer.id === 'none') return;
    if (map.getLayer(layer.id)) return;

    let paint;
    if (layer.scheme === 'density') {
      paint = {
        'fill-color': [
          'interpolate', ['linear'], densityExpr,
          0,     '#eff6ff',
          1000,  '#bfdbfe',
          3000,  '#93c5fd',
          6000,  '#60a5fa',
          12000, '#3b82f6',
          20000, '#1d4ed8',
          40000, '#1e40af'
        ],
        'fill-opacity': 0.1
      };
    } else if (layer.scheme === 'age') {
      paint = {
        'fill-color': [
          'interpolate', ['linear'], ageExpr,
          20, '#fff7ed',
          30, '#fed7aa',
          35, '#fdba74',
          40, '#fb923c',
          45, '#f97316',
          50, '#ea580c',
          55, '#9a3412'
        ],
        'fill-opacity': 0.1
      };
    } else if (layer.scheme === 'income') {
      paint = {
        'fill-color': [
          'interpolate', ['linear'], incomeExpr,
          30000,  '#f0fdf4',
          60000,  '#bbf7d0',
          90000,  '#86efac',
          120000, '#4ade80',
          160000, '#22c55e',
          200000, '#16a34a',
          260000, '#166534'
        ],
        'fill-opacity': 0.1
      };
    }

    map.addLayer({
      id: layer.id,
      type: 'fill',
      source: 'tracts',
      layout: { visibility: (activeLayerId === layer.id) ? 'visible' : 'none' },
      paint
    });
  });

  // outlines (respect current selection)
  if (!map.getLayer('tracts-outline')) {
    map.addLayer({
      id: 'tracts-outline',
      type: 'line',
      source: 'tracts',
      layout: { visibility: activeLayerId === 'none' ? 'none' : 'visible' },
      paint: { 'line-color': '#1f2937', 'line-width': 1 }
    });
  }

  // hover outline
  if (!map.getLayer('tracts-hover')) {
    map.addLayer({
      id: 'tracts-hover',
      type: 'line',
      source: 'tracts',
      layout: { visibility: activeLayerId === 'none' ? 'none' : 'visible' },
      paint: { 'line-color': '#111827', 'line-width': 2 },
      filter: ['==', ['get', 'GEOID'], '']
    });
  }

  // (re)attach interactions to real layers
  realLayerIds.forEach(attachTractInteractions);
}

// Bottom-left data source attribution control
function addDataAttributionControl() {
  const url = 'https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj/about_data';
  const label = 'Seattle Open Data Portal — Fire 911 Calls';

  const ctrl = {
    onAdd: () => {
      const el = document.createElement('div');
      el.className = 'mapboxgl-ctrl data-attrib-ctrl';
      el.innerHTML = `Data: <a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      ctrl._el = el;
      return el;
    },
    onRemove: () => { if (ctrl._el) ctrl._el.remove(); }
  };
  map.addControl(ctrl, 'bottom-left');
}
/* When basemap changes, rebuild tracts and restore selection */
function switchBasemap(key) {
  const styleURL = BASE_STYLES[key] || BASE_STYLES.streets;
  const currentActive = activeLayerId;

  if (basemapSelectEl && basemapSelectEl.value !== key) {
    basemapSelectEl.value = key;
  }

  map.setStyle(styleURL);
  map.once('style.load', () => {
    buildTractLayers();
    setActiveLayer(currentActive);
    if (legendCtrl) legendCtrl.update(currentActive === 'none' ? null : currentActive);

    // re-add the incident layer with correct coloring
    restoreIncidentLayerIfMissing();
  });
}


/* =========================================================
   CONTROLS
=========================================================*/
function addMainControlPanel() {
  class MainPanelControl {
    onAdd() {
      const container = document.createElement('div');
      container.className = 'mapboxgl-ctrl main-control-panel';

      const panel = document.createElement('div');
      panel.id = 'control-panel';

      const makeSection = (title) => {
        const section = document.createElement('div');
        section.className = 'control-section';

        const heading = document.createElement('div');
        heading.className = 'control-heading';
        heading.textContent = title;

        section.appendChild(heading);
        return section;
      };

      // Basemap select
      const basemapSection = makeSection('Basemap');
      const basemapRow = document.createElement('div');
      basemapRow.className = 'control-row';
      const basemapSelect = document.createElement('select');
      basemapSelect.className = 'control-select';
      basemapSelect.innerHTML = `
        <option value="Dark_Gray">Dark Gray</option>
        <option value="streets">City Streets</option>
        <option value="satellite">Satellite</option>
      `;
      basemapSelect.value = 'Dark_Gray';
      basemapSelect.onchange = () => switchBasemap(basemapSelect.value);
      basemapRow.appendChild(basemapSelect);
      basemapSection.appendChild(basemapRow);
      panel.appendChild(basemapSection);

      // ACS Data select
      const layerSection = makeSection('ACS Data Layer');
      const layerRow = document.createElement('div');
      layerRow.className = 'control-row';
      const layerSelect = document.createElement('select');
      layerSelect.className = 'control-select';
      layerSelect.innerHTML = tractLayers.map(l => `<option value="${l.id}">${l.label}</option>`).join('');
      layerSelect.value = activeLayerId;
      layerSelect.onchange = () => setActiveLayer(layerSelect.value);
      layerRow.appendChild(layerSelect);
      layerSection.appendChild(layerRow);
      panel.appendChild(layerSection);

      // Incident visibility toggle
      const visibilitySection = makeSection('Dispatches');
      const visibilityRow = document.createElement('div');
      visibilityRow.className = 'control-row';
      const visibilityBtn = document.createElement('button');
      visibilityBtn.className = 'toggle-fill-btn';
      visibilityBtn.onclick = () => {
        setIncidentVisibility(!incidentLayerVisible);
      };
      visibilityRow.appendChild(visibilityBtn);
      visibilitySection.appendChild(visibilityRow);
      panel.appendChild(visibilitySection);

      // View mode toggle
      const viewSection = makeSection('View Mode');
      const viewRow = document.createElement('div');
      viewRow.className = 'control-button-group';
      const btnDots = document.createElement('button');
      btnDots.textContent = 'Dot Density';
      btnDots.onclick = () => {
        incidentViewMode = 'dots';
        applyIncidentLayerVisibility();
      };
      const btnHeat = document.createElement('button');
      btnHeat.textContent = 'Heatmap';
      btnHeat.onclick = () => {
        incidentViewMode = 'heat';
        applyIncidentLayerVisibility();
      };
      viewRow.appendChild(btnDots);
      viewRow.appendChild(btnHeat);
      viewSection.appendChild(viewRow);
      panel.appendChild(viewSection);

      container.appendChild(panel);
      this._container = container;

      basemapSelectEl = basemapSelect;
      layerSelectEl = layerSelect;
      refreshVisibilityToggleUI = () => {
        if (!visibilityBtn) return;
        visibilityBtn.className = `toggle-fill-btn ${incidentLayerVisible ? 'on' : 'off'}`;
        visibilityBtn.textContent = incidentLayerVisible ? 'Hide Dispatches' : 'Show Dispatches';
      };
      refreshViewModeButtonsUI = () => {
        btnDots.className = `toggle-fill-btn ${incidentViewMode === 'dots' ? 'on' : 'off'}`;
        btnHeat.className = `toggle-fill-btn ${incidentViewMode === 'heat' ? 'on' : 'off'}`;
      };

      refreshVisibilityToggleUI();
      refreshViewModeButtonsUI();

      return container;
    }
    onRemove() {
      if (this._container) this._container.remove();
      basemapSelectEl = null;
      layerSelectEl = null;
      refreshVisibilityToggleUI = null;
      refreshViewModeButtonsUI = null;
    }
  }
  map.addControl(new MainPanelControl(), 'top-left');
}


class LegendControl {
  onAdd() {
    const container = document.createElement('div');
    container.className = 'mapboxgl-ctrl legend-ctrl';
    container.innerHTML = `<div class="legend"><div class="legend-title">Legend</div><div class="legend-body"></div></div>`;
    this._container = container;
    return container;
  }
  onRemove() { this._container.remove(); }
  update(activeId) {
    if (!this._container) return;
    const body = this._container.querySelector('.legend-body');
    const titleEl = this._container.querySelector('.legend-title');

    // Hide legend entirely when no layer is active
    if (!activeId) {
      this._container.style.display = 'none';
      body.innerHTML = '';
      return;
    }

    // Ensure it is visible when a layer is active
    this._container.style.display = '';

    body.innerHTML = '';
    if (activeId === 'tracts-density') {
      titleEl.textContent = 'Population density (per sq mi)';
      const stops = [
        { c: '#eff6ff', l: '0'     },
        { c: '#bfdbfe', l: '1k'    },
        { c: '#93c5fd', l: '3k'    },
        { c: '#60a5fa', l: '6k'    },
        { c: '#3b82f6', l: '12k'   },
        { c: '#1d4ed8', l: '20k'   },
        { c: '#1e40af', l: '40k+'  }
      ];
      body.appendChild(makeSwatchRow(stops));
    } else if (activeId === 'tracts-age') {
      titleEl.textContent = 'Median age (years)';
      const stops = [
        { c: '#fff7ed', l: '20' },
        { c: '#fed7aa', l: '30' },
        { c: '#fdba74', l: '35' },
        { c: '#fb923c', l: '40' },
        { c: '#f97316', l: '45' },
        { c: '#ea580c', l: '50' },
        { c: '#9a3412', l: '55+' }
      ];
      body.appendChild(makeSwatchRow(stops));
    } else if (activeId === 'tracts-income') {
      titleEl.textContent = 'Median household income (USD)';
      const stops = [
        { c: '#f0fdf4', l: '$30k'  },
        { c: '#bbf7d0', l: '$60k'  },
        { c: '#86efac', l: '$90k'  },
        { c: '#4ade80', l: '$120k' },
        { c: '#22c55e', l: '$160k' },
        { c: '#16a34a', l: '$200k' },
        { c: '#166534', l: '$260k+' }
      ];
      body.appendChild(makeSwatchRow(stops));
    }
  }
}

function makeSwatchRow(stops) {
  const row = document.createElement('div');
  row.className = 'legend-row';
  stops.forEach(s => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.backgroundColor = s.c;
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = s.l;
    item.appendChild(sw);
    item.appendChild(label);
    row.appendChild(item);
  });
  return row;
}

/* =========================================================
   TIMELINE RANGE CONTROL
========================================================= */
function setupTimeline() {
  const start = document.getElementById("tl-start");
  const end = document.getElementById("tl-end");
  const rangeEl = document.getElementById("tl-range");

  const minGap = 1; // min 1 hour

  function updateRange() {
    let s = parseInt(start.value);
    let e = parseInt(end.value);

    if (e - s < minGap) {
      if (document.activeElement === start) {
        s = e - minGap;
        start.value = s;
      } else {
        e = s + minGap;
        end.value = e;
      }
    }

    filterIncidentsByTime(s, e);

    const pctStart = (s / 24) * 100;
    const pctEnd = (e / 24) * 100;
    rangeEl.style.left = pctStart + "%";
    rangeEl.style.width = (pctEnd - pctStart) + "%";
  }

  start.addEventListener("input", updateRange);
  end.addEventListener("input", updateRange);
  updateRange();
}

window.addEventListener("DOMContentLoaded", setupTimeline);



/* =========================================================
   SHOW/HIDE ACTIVE LAYER
=========================================================*/
function setActiveLayer(showId) {
  activeLayerId = showId;

  if (showId === 'none') {
    // hide all fills
    realLayerIds.forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    // hide hover + outline when none is selected
    if (map.getLayer('tracts-hover'))   map.setLayoutProperty('tracts-hover',   'visibility', 'none');
    if (map.getLayer('tracts-outline')) map.setLayoutProperty('tracts-outline', 'visibility', 'none');
  } else {
    // show only chosen
    realLayerIds.forEach(id => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', id === showId ? 'visible' : 'none');
      }
    });
    // show hover + outline
    if (map.getLayer('tracts-hover'))   map.setLayoutProperty('tracts-hover',   'visibility', 'visible');
    if (map.getLayer('tracts-outline')) map.setLayoutProperty('tracts-outline', 'visibility', 'visible');
  }

  // sync dropdown if present
  if (layerSelectEl && layerSelectEl.value !== showId) {
    layerSelectEl.value = showId;
  }

  // update legend (hidden when none)
  if (legendCtrl) legendCtrl.update(showId === 'none' ? null : showId);
}

// apply dot density vs heatmap vis
function applyIncidentLayerVisibility() {
  const dotsVis = (incidentLayerVisible && incidentViewMode === 'dots') ? 'visible' : 'none';
  const heatVis = (incidentLayerVisible && incidentViewMode === 'heat') ? 'visible' : 'none';

  if (map.getLayer('calls24h-circles')) {
    map.setLayoutProperty('calls24h-circles', 'visibility', dotsVis);
  }
  if (map.getLayer('calls24h-heat')) {
    map.setLayoutProperty('calls24h-heat', 'visibility', heatVis);
  }

  applyIncidentFilters();

  if (typeof refreshViewModeButtonsUI === 'function') {
    refreshViewModeButtonsUI();
  }

}


/* =========================================================
   INTERACTIONS FOR TRACTS
=========================================================*/
const fmtInt = (n) => (Number.isFinite(+n) ? (+n).toLocaleString() : '—');
const fmtPct = (n) => (Number.isFinite(+n) ? `${(+n).toFixed(1)}%` : '—');
const fmtUSD = (n) => (Number.isFinite(+n)
  ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(+n)
  : '—');

function attachTractInteractions(layerId) {
  map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });

  map.on('mousemove', layerId, (e) => {
    const f = e.features && e.features[0];
    map.setFilter('tracts-hover', ['==', ['get', 'GEOID'], f ? f.properties.GEOID : '']);
  });
  map.on('mouseleave', layerId, () => {
    map.setFilter('tracts-hover', ['==', ['get', 'GEOID'], '']);
  });

  map.on('click', layerId, (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties || {};
    const name = p.NAME || `Tract ${p.TRACT_LABEL ?? ''}`;
    const geoid = p.GEOID || '—';
    const pop = +(p.TOTAL_POPULATION ?? NaN);
    const acres = +(p.ACRES_LAND ?? NaN);
    const density = (Number.isFinite(pop) && Number.isFinite(acres) && acres > 0)
      ? pop / (acres / 640) : null;
    const medAge = p.MEDIAN_AGE ?? null;
    const medInc = p.MEDIAN_HH_INC_PAST_12MO_DOLLAR ?? p.MEDIAN_HH_INCOME ?? null;
    const pctBach = p.PCT_BACHELOR_DEGREE_OR_HIGHER ?? null;
    const pctPov = p.PCT_POPULATION_UNDER_POVERTY ?? p.PCT_POP_UNDER_POVERTY ?? null;

    const html = `
      <div style="min-width:240px">
        <div style="font-weight:600;margin-bottom:4px">${name}</div>
        <div style="color:#6b7280;margin-bottom:6px">GEOID: ${geoid}</div>
        <table style="font-size:12px;line-height:1.35">
          <tr><td>Population</td><td style="text-align:right">${fmtInt(pop)}</td></tr>
          <tr><td>Density (per sq mi)</td><td style="text-align:right">${density != null ? fmtInt(Math.round(density)) : '—'}</td></tr>
          <tr><td>Median age</td><td style="text-align:right">${medAge ?? '—'}</td></tr>
          <tr><td>Median HH income</td><td style="text-align:right">${fmtUSD(medInc)}</td></tr>
          <tr><td>% Bachelor’s+</td><td style="text-align:right">${fmtPct(pctBach)}</td></tr>
          <tr><td>% Under poverty</td><td style="text-align:right">${fmtPct(pctPov)}</td></tr>
        </table>
      </div>
    `;
    new mapboxgl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
  });
}


/* =========================================================
   LOAD 911 CALLS - PAST 24 HOURS
=========================================================*/
async function load911CallsPast24h() {
  const now = new Date();
  const past24hISO = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const endpoint = 'https://data.seattle.gov/resource/kzjm-xkqj.json?$limit=1000';

  try {
    const resp = await fetch(endpoint);
    const data = await resp.json();

    // Convert to GeoJSON
    const features = data
      .filter(d => {
        const dt = new Date(d.datetime);
        return d.latitude && d.longitude && dt >= new Date(Date.now() - 24 * 60 * 60 * 1000);
      })

      .map(d => {
        const dt = new Date(d.datetime);
        const ageFraction = (now - dt) / (24 * 60 * 60 * 1000);

        let category = d.type || 'Unknown';
        if (/aid response/i.test(category)) category = 'Aid Response';
        else if (/medic response/i.test(category)) category = 'Medic Response';
        else if (/fire/i.test(category)) category = 'Fire';
        else category = category.trim();

        return {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [parseFloat(d.longitude), parseFloat(d.latitude)]
          },
          properties: {
            address: d.address || 'Unknown address',
            type: d.type || 'Unknown type',
            datetime: d.datetime,
            incident_number: d.incident_number,
            ageFraction: ageFraction,
            category: category
          }
        };
      });

    const geojson = {
      type: 'FeatureCollection',
      features: features
    };

    window.latest911Geojson = geojson;

    // Render chart first, to build window.typeColorMap
    renderIncidentChart(features);

    // Now add or update the incident layer with matching colors
    if (map.getSource('calls24h')) {
      map.getSource('calls24h').setData(geojson);
    } else {
      map.addSource('calls24h', { type: 'geojson', data: geojson });

      // Build match expression for circle color
      const matchExpr = ['match', ['get', 'category']];
      for (const [type, color] of Object.entries(window.typeColorMap)) {
        matchExpr.push(type, color);
      }
      matchExpr.push('#9ca3af'); // fallback (grey) color for any undefined category

      map.addLayer({
        id: 'calls24h-circles',
        type: 'circle',
        source: 'calls24h',
        paint: {
          'circle-radius': 4,
          'circle-opacity': [
            'case',
            ['==', ['get', 'category'], ['get', 'selectedCategory']],
            1,
            ['!', ['has', 'selectedCategory']],
            1,
            0.1 // dim non-matching
          ],
          'circle-color': matchExpr,
          'circle-stroke-color': '#000',
          'circle-stroke-width': 0.5
        }
        
        
      });
      // --- ADD THIS right after map.addLayer({... id: 'calls24h-circles' ...}) ---

    // Only add if it doesn't exist
    if (!map.getLayer('calls24h-heat')) {
      map.addLayer({
        id: 'calls24h-heat',
        type: 'heatmap',
        source: 'calls24h',
        layout: { visibility: 'none' }, // start hidden (dot density is default)
        paint: {
          'heatmap-weight': 1,  // simple, guaranteed to show
          'heatmap-intensity': [
            'interpolate', ['linear'], ['zoom'],
            10, 0.6,
            14, 1.0,
            16, 1.6
          ],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0.00, 'rgba(0,0,0,0)',
            0.10, '#2A9D8F',
            0.30, '#457B9D',
            0.55, '#F4A261',
            0.80, '#F77F00',
            1.00, '#E63946'
          ],
          'heatmap-radius': [
            'interpolate', ['linear'], ['zoom'],
            10, 18,
            13, 28,
            16, 42
          ],
          'heatmap-opacity': 0.9
        }

      });

      // Make sure the dots sit above the heatmap when both are visible (just in case)
      if (map.getLayer('calls24h-circles')) {
        map.moveLayer('calls24h-circles');
      }
    }

    // Apply current mode visibility
    applyIncidentLayerVisibility();

      

      map.on('click', 'calls24h-circles', (e) => {
        const props = e.features[0].properties;
        new mapboxgl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-size:13px">
              <strong>Type:</strong> ${props.type}<br/>
              <strong>Address:</strong> ${props.address}<br/>
              <strong>Time:</strong> ${new Date(props.datetime).toLocaleString()}<br/>
              <strong>Incident #:</strong> ${props.incident_number}
            </div>
          `)
          .addTo(map);
      });

      map.on('mouseenter', 'calls24h-circles', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'calls24h-circles', () => {
        map.getCanvas().style.cursor = '';
      });
    }

  } catch (err) {
    console.error('Failed to load 911 calls:', err);
  }
}

function highlightIncidentsByType(type) {
  if (window.selectedCrimeType === type) {
    setIncidentFilter(null);
  } else {
    setIncidentFilter(type);
  }
}


function renderIncidentChart(features) {
  const typeCounts = {};

  // Group + normalize to our collapsed categories
  features.forEach(f => {
    const type = f.properties.category || 'Unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);

  // Top 9 + Other
  const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const top9 = sorted.slice(0, 9);
  const otherCount = sorted.slice(9).reduce((sum, [, c]) => sum + c, 0);
  if (otherCount > 0) top9.push(['Other', otherCount]);

  const labels = top9.map(([t]) => t);
  const counts = top9.map(([, c]) => c);

  // Remember which categories are in the "top" buckets (excluding the synthetic Other)
  const realTopCategories = top9.filter(([t]) => t !== 'Other').map(([t]) => t);
  window.topCategoriesReal = realTopCategories;

  // ✨ Your palette (10 colors)
  const colors = [
    '#E63946', '#F4A261', '#2A9D8F', '#264653', '#F77F00',
    '#A8DADC', '#6A4C93', '#457B9D', '#FFB703', '#8D99AE'
  ];

  // Build the type → color map (used by map dots)
  window.typeColorMap = {};
  labels.forEach((label, i) => { window.typeColorMap[label] = colors[i]; });

  // Draw pie
  const chart = document.getElementById('chart-content');
  chart.innerHTML = `<canvas id="pieCanvas" width="240" height="240"></canvas><div id="pie-legend"></div>`;
  const canvas = document.getElementById('pieCanvas');
  const ctx = canvas.getContext('2d');
  let start = 0;
  counts.forEach((count, i) => {
    const angle = (count / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(120, 120);
    ctx.arc(120, 120, 100, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    start += angle;
  });

  // Legend as a table with single-line rows
  const legend = document.getElementById('pie-legend');
  legend.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'pie-legend-table';
  table.style.width = '100%';
  table.style.fontSize = '14px';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '10px';

  // Helper to update the row highlight based on global selection
  const syncRowSelectionUI = () => {
    const selected = window.selectedCrimeType || null;
    table.querySelectorAll('tr').forEach(tr => {
      const cat = tr.dataset.category;
      if (selected && cat === selected) tr.classList.add('selected');
      else tr.classList.remove('selected');
    });
  };

  labels.forEach((label, i) => {
    const count = counts[i];
    const percentage = ((count / total) * 100).toFixed(1);
    const bgColor = i % 2 === 0 ? '#ffffff' : '#f3f4f6';

    const row = document.createElement('tr');
    row.style.background = bgColor;
    row.style.height = '32px';
    row.style.cursor = 'pointer';
    row.dataset.category = label;

    const typeCell = document.createElement('td');
    typeCell.style.padding = '6px 8px';
    typeCell.style.whiteSpace = 'nowrap';
    typeCell.style.display = 'flex';
    typeCell.style.alignItems = 'center';
    typeCell.innerHTML = `
      <span class="pie-swatch" style="background:${colors[i]}; margin-right:8px;"></span>
      <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</span>
    `;

    const countCell = document.createElement('td');
    countCell.style.padding = '6px 8px';
    countCell.style.textAlign = 'right';
    countCell.style.whiteSpace = 'nowrap';
    countCell.textContent = `${count} (${percentage}%)`;

    row.appendChild(typeCell);
    row.appendChild(countCell);
    table.appendChild(row);

    // Clean, toggleable click handler that applies to BOTH dots & heat
    row.addEventListener('click', () => {
      const currentlySelected = window.selectedCrimeType || null;
      if (currentlySelected === label) {
        // Clear filter
        setIncidentFilter(null);
      } else {
        // Apply new filter
        setIncidentFilter(label);
      }
      // Update the row highlight to match current selection
      syncRowSelectionUI();
    });
  });

  legend.appendChild(table);

  // If there was a selection already (e.g., after toggle or re-render), reflect it
  syncRowSelectionUI();

  // Keep the color legend in sync once colors are established
  if (typeof window.updateIncidentLegend === 'function') {
    try { window.updateIncidentLegend(); } catch (_) {}
  }
}




/* =========================================================
   INCIDENT UTILITIES + LEGEND + RESHOW ON BASEMAP
=========================================================*/

function setIncidentVisibility(visible) {
  incidentLayerVisible = visible;
  applyIncidentLayerVisibility();
  if (typeof refreshVisibilityToggleUI === 'function') {
    refreshVisibilityToggleUI();
  }
}


function restoreIncidentLayerIfMissing() {
  if (!map.getSource('calls24h') && window.latest911Geojson) {
    map.addSource('calls24h', {
      type: 'geojson',
      data: window.latest911Geojson
    });
  }

  if (!map.getLayer('calls24h-circles') && map.getSource('calls24h')) {
    const matchExpr = ['match', ['get', 'category']];
    for (const [type, color] of Object.entries(window.typeColorMap)) {
      matchExpr.push(type, color);
    }
    matchExpr.push('#9ca3af');

    map.addLayer({
      id: 'calls24h-circles',
      type: 'circle',
      source: 'calls24h',
      paint: {
        'circle-radius': 6,
        'circle-color': matchExpr,
        'circle-opacity': 0.75,
        'circle-stroke-color': '#000',
        'circle-stroke-width': 0.5
      }
    });

    map.on('click', 'calls24h-circles', (e) => {
      const props = e.features[0].properties;
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font-size:13px">
            <strong>Type:</strong> ${props.type}<br/>
            <strong>Address:</strong> ${props.address}<br/>
            <strong>Time:</strong> ${new Date(props.datetime).toLocaleString()}<br/>
            <strong>Incident #:</strong> ${props.incident_number}
          </div>
        `)
        .addTo(map);
    });

    map.on('mouseenter', 'calls24h-circles', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'calls24h-circles', () => {
      map.getCanvas().style.cursor = '';
    });

    setIncidentVisibility(incidentLayerVisible);
  }
  if (!map.getLayer('calls24h-heat') && map.getSource('calls24h')) {
    map.addLayer({
      id: 'calls24h-heat',
      type: 'heatmap',
      source: 'calls24h',
      layout: { visibility: 'none' },
      paint: {
        'heatmap-weight': 1,
        'heatmap-intensity': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.6,
          14, 1.0,
          16, 1.6
        ],
        'heatmap-color': [
          'interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)',
          0.1, '#2A9D8F',
          0.3, '#457B9D',
          0.55, '#F4A261',
          0.8, '#F77F00',
          1, '#E63946'
        ],
        'heatmap-radius': [
          'interpolate', ['linear'], ['zoom'],
          10, 18,
          13, 28,
          16, 42
        ],
        'heatmap-opacity': 0.9
      }
    });
  }
  // Respect current mode + visibility
  applyIncidentLayerVisibility();


}

function addIncidentLegend() {
  // Legend disabled per request; keep function for compatibility but do not add control
  return;
  const container = document.createElement('div');
  container.className = 'mapboxgl-ctrl legend-ctrl';
  container.id = 'incident-legend';

  function updateLegend() {
    if (!window.typeColorMap) return;
    const entries = Object.entries(window.typeColorMap);

    container.innerHTML = `
      <div class="legend">
        <div class="legend-row" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
          ${entries.map(([type, color]) => `
            <div class="legend-item"><span class="legend-swatch" style="background:${color}"></span></div>
          `).join('')}
        </div>
      </div>
    `;
  }

  map.addControl({ 
    onAdd: () => { updateLegend(); return container; }, 
    onRemove: () => container.remove()
  }, 'bottom-left');

  window.updateIncidentLegend = updateLegend;
}

function setIncidentFilter(selectedType) {
  window.selectedCrimeType = selectedType || null;
  applyIncidentFilters();
}

function filterIncidentsByTime(startHour, endHour) {
  const boundedStart = Math.max(0, Math.min(24, Number.isFinite(+startHour) ? +startHour : 0));
  const boundedEnd = Math.max(0, Math.min(24, Number.isFinite(+endHour) ? +endHour : 24));
  const start = Math.min(boundedStart, boundedEnd);
  const end = Math.max(boundedStart, boundedEnd);

  window.currentTimeFilter = { startHour: start, endHour: end };
  // Update the chart subtitle label with the current time window
  try { updateChartRangeLabel(); } catch (_) {}
  applyIncidentFilters();
}

function applyIncidentFilters() {
  const layers = ['calls24h-circles', 'calls24h-heat'];
  const activeFilters = [];

  const selectedType = window.selectedCrimeType || null;
  if (selectedType) {
    if (selectedType === 'Other' && Array.isArray(window.topCategoriesReal) && window.topCategoriesReal.length) {
      const topList = window.topCategoriesReal;
      // Build a conjunction of "!= each top category"
      topList.forEach(cat => {
        activeFilters.push(['!=', ['get', 'category'], cat]);
      });
    } else {
      activeFilters.push(['==', ['get', 'category'], selectedType]);
    }
  }

  const { startHour, endHour } = window.currentTimeFilter || { startHour: 0, endHour: 24 };
  const normalizedStart = Math.max(0, Math.min(24, startHour));
  const normalizedEnd = Math.max(0, Math.min(24, endHour));

  if (normalizedStart > 0 || normalizedEnd < 24) {
    const minAgeFraction = Math.max(0, Math.min(1, 1 - (normalizedEnd / 24)));
    const maxAgeFraction = Math.max(0, Math.min(1, 1 - (normalizedStart / 24)));
    activeFilters.push(['>=', ['get', 'ageFraction'], minAgeFraction]);
    activeFilters.push(['<=', ['get', 'ageFraction'], maxAgeFraction]);
  }

  const filterExpr = activeFilters.length ? ['all', ...activeFilters] : null;

  layers.forEach(layerId => {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, filterExpr);
    }
  });

  // After applying map filters, update the pie chart/legend to reflect
  // the currently selected time range (and category filter, if any).
  try {
    updateIncidentChartForCurrentSelection();
  } catch (e) {
    console.warn('Chart update failed:', e);
  }
}

// Update the text under "Dispatch Breakdown" to reflect the selected time window.
function updateChartRangeLabel() {
  const labelEl = document.getElementById('chart-range');
  if (!labelEl) return;

  const MAX = 24; // hours
  const { startHour, endHour } = window.currentTimeFilter || { startHour: 0, endHour: MAX };
  const now = new Date();
  const endDate = new Date(now.getTime() - ((MAX - endHour) * 60 * 60 * 1000)); // now or earlier
  const startDate = new Date(now.getTime() - ((MAX - startHour) * 60 * 60 * 1000)); // 24h ago or later

  // Build mm/dd h:mm am/pm in Pacific Time, with lowercase am/pm and lowercase 'pst'.
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    day: '2-digit',
    month: '2-digit'
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const fmt = (d) => {
    const date = dateFmt.format(d); // mm/dd
    const parts = Object.fromEntries(timeFmt.formatToParts(d).map(p => [p.type, p.value]));
    const hour = parts.hour; // no leading zero in en-US when hour12
    const minute = parts.minute; // 2-digit
    const ampm = (parts.dayPeriod || '').toLowerCase();
    return `${date} ${hour}:${minute} ${ampm} pst`;
  };

  // Exact phrasing requested: from (now) ... to ... (24 hrs ago)
  const endTag = endHour === MAX ? '(now) ' : '';
  const startTag = startHour === 0 ? ' (24 hrs ago)' : '';

  labelEl.textContent = `from ${endTag}${fmt(endDate)} to ${fmt(startDate)}${startTag}`;
}

// Recompute the pie chart and legend based on current filters without
// mutating the global type→color map used by the map layer.
function updateIncidentChartForCurrentSelection() {
  if (!window.latest911Geojson || !Array.isArray(window.latest911Geojson.features)) return;

  const features = window.latest911Geojson.features;

  // Time window (24h)
  const MAX = 24;
  const { startHour, endHour } = window.currentTimeFilter || { startHour: 0, endHour: MAX };
  const s = Math.max(0, Math.min(MAX, startHour));
  const e = Math.max(0, Math.min(MAX, endHour));
  const minAge = Math.max(0, Math.min(1, 1 - (e / MAX)));
  const maxAge = Math.max(0, Math.min(1, 1 - (s / MAX)));

  // Apply time filter
  let filtered = features.filter(f => {
    const af = f?.properties?.ageFraction;
    return typeof af === 'number' && af >= minAge && af <= maxAge;
  });

  // Optionally apply category filter so chart matches what’s visible
  const selectedType = window.selectedCrimeType || null;
  if (selectedType) {
    if (selectedType === 'Other' && Array.isArray(window.topCategoriesReal) && window.topCategoriesReal.length) {
      const topSet = new Set(window.topCategoriesReal);
      filtered = filtered.filter(f => !topSet.has(f?.properties?.category));
    } else {
      filtered = filtered.filter(f => (f?.properties?.category) === selectedType);
    }
  }

  renderIncidentChartDynamic(filtered);
}

// Draws the chart for the given feature subset using the existing
// window.typeColorMap for color consistency; does not overwrite it.
function renderIncidentChartDynamic(features) {
  const typeCounts = {};
  (features || []).forEach(f => {
    const type = (f?.properties?.category) || 'Unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const top9 = sorted.slice(0, 9);
  const otherCount = sorted.slice(9).reduce((sum, [, c]) => sum + c, 0);
  if (otherCount > 0) top9.push(['Other', otherCount]);

  const labels = top9.map(([t]) => t);
  const counts = top9.map(([, c]) => c);

  // Track real top list for correct "Other" handling on click
  window.topCategoriesReal = top9.filter(([t]) => t !== 'Other').map(([t]) => t);

  const colorMap = window.typeColorMap || {};
  const colors = labels.map(l => colorMap[l] || '#9ca3af');

  const chart = document.getElementById('chart-content');
  if (!chart) return;
  chart.innerHTML = `<canvas id="pieCanvas" width="240" height="240"></canvas><div id="pie-legend"></div>`;
  const canvas = document.getElementById('pieCanvas');
  const ctx = canvas.getContext('2d');

  let start = 0;
  const safeTotal = total || 1; // avoid 0/0 angles
  counts.forEach((count, i) => {
    const angle = (count / safeTotal) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(120, 120);
    ctx.arc(120, 120, 100, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    start += angle;
  });

  const legend = document.getElementById('pie-legend');
  legend.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'pie-legend-table';
  table.style.width = '100%';
  table.style.fontSize = '14px';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '10px';

  const syncRowSelectionUI = () => {
    const selected = window.selectedCrimeType || null;
    table.querySelectorAll('tr').forEach(tr => {
      const cat = tr.dataset.category;
      if (selected && cat === selected) tr.classList.add('selected');
      else tr.classList.remove('selected');
    });
  };

  labels.forEach((label, i) => {
    const count = counts[i];
    const percentage = ((count / (safeTotal || 1)) * 100).toFixed(1);
    const bgColor = i % 2 === 0 ? '#ffffff' : '#f3f4f6';

    const row = document.createElement('tr');
    row.style.background = bgColor;
    row.style.height = '32px';
    row.style.cursor = 'pointer';
    row.dataset.category = label;

    const typeCell = document.createElement('td');
    typeCell.style.padding = '6px 8px';
    typeCell.style.whiteSpace = 'nowrap';
    typeCell.style.display = 'flex';
    typeCell.style.alignItems = 'center';
    typeCell.innerHTML = `
      <span class="pie-swatch" style="background:${colors[i]}; margin-right:8px;"></span>
      <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</span>
    `;

    const countCell = document.createElement('td');
    countCell.style.padding = '6px 8px';
    countCell.style.textAlign = 'right';
    countCell.style.whiteSpace = 'nowrap';
    countCell.textContent = `${count} (${percentage}%)`;

    row.appendChild(typeCell);
    row.appendChild(countCell);
    table.appendChild(row);

    row.addEventListener('click', () => {
      const currentlySelected = window.selectedCrimeType || null;
      if (currentlySelected === label) setIncidentFilter(null);
      else setIncidentFilter(label);
      syncRowSelectionUI();
    });
  });
  legend.appendChild(table);
  syncRowSelectionUI();
}
