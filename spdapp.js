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
  Dark_Gray: 'mapbox://styles/mapbox/dark-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
};

let activeLayerId = 'none';
let layerSelectEl = null;
let basemapSelectEl = null;
let incidentViewMode = 'dots'; // 'dots' | 'heat'
let incidentLayerVisible = true;

// Incident state
window.latestSPDGeojson = null;
window.typeColorMap = {};
window.selectedCrimeType = null;
// Default to full 7-day window so data shows even if last 24h is empty
window.currentTimeFilter = { startHour: 0, endHour: 168 };

let refreshVisibilityToggleUI = null;
let refreshViewModeButtonsUI = null;
let legendCtrl = null;

// Data path for ACS tracts
const tract_path = './data/tracts_wgs84.geojson';

// Population density = pop / (acres / 640)
const densityExpr = [
  '/',
  ['coalesce', ['to-number', ['get', 'TOTAL_POPULATION']], 0],
  ['max', ['/', ['coalesce', ['to-number', ['get', 'ACRES_LAND']], 0], 640], 0.0001]
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

const tractLayers = [
  { id: 'none',            label: 'None',                scheme: 'none'    },
  { id: 'tracts-density',  label: 'Population density',  scheme: 'density' },
  { id: 'tracts-age',      label: 'Median age',          scheme: 'age'     },
  { id: 'tracts-income',   label: 'Median HH income',    scheme: 'income'  }
];
const realLayerIds = tractLayers.filter(l => l.id !== 'none').map(l => l.id);

// Init
map.on('load', () => {
  buildTractLayers();
  addMainControlPanel();
  setActiveLayer(activeLayerId);

  // Incidents
  loadSPDCrimesPast24h();
  addIncidentLegend();

  // Nav control goes under our panel
  map.addControl(new mapboxgl.NavigationControl(), 'top-left');
});

function buildTractLayers() {
  if (!map.getSource('tracts')) {
    map.addSource('tracts', { type: 'geojson', data: tract_path });
  }

  tractLayers.forEach(layer => {
    if (layer.id === 'none') return;
    if (map.getLayer(layer.id)) return;

    let paint;
    if (layer.scheme === 'density') {
      paint = { 'fill-color': [ 'interpolate', ['linear'], densityExpr,
        0,'#eff6ff', 1000,'#bfdbfe', 3000,'#93c5fd', 6000,'#60a5fa', 12000,'#3b82f6', 20000,'#1d4ed8', 40000,'#1e40af' ], 'fill-opacity': 0.1 };
    } else if (layer.scheme === 'age') {
      paint = { 'fill-color': [ 'interpolate', ['linear'], ageExpr,
        20,'#fff7ed', 30,'#fed7aa', 35,'#fdba74', 40,'#fb923c', 45,'#f97316', 50,'#ea580c', 55,'#9a3412' ], 'fill-opacity': 0.1 };
    } else if (layer.scheme === 'income') {
      paint = { 'fill-color': [ 'interpolate', ['linear'], incomeExpr,
        30000,'#f0fdf4', 60000,'#bbf7d0', 90000,'#86efac', 120000,'#4ade80', 160000,'#22c55e', 200000,'#16a34a', 260000,'#166534' ], 'fill-opacity': 0.1 };
    }

    map.addLayer({ id: layer.id, type: 'fill', source: 'tracts', layout: { visibility: (activeLayerId === layer.id) ? 'visible' : 'none' }, paint });
  });

  if (!map.getLayer('tracts-outline')) {
    map.addLayer({ id: 'tracts-outline', type: 'line', source: 'tracts', layout: { visibility: activeLayerId === 'none' ? 'none' : 'visible' }, paint: { 'line-color': '#1f2937', 'line-width': 1 } });
  }
  if (!map.getLayer('tracts-hover')) {
    map.addLayer({ id: 'tracts-hover', type: 'line', source: 'tracts', layout: { visibility: activeLayerId === 'none' ? 'none' : 'visible' }, paint: { 'line-color': '#111827', 'line-width': 2 }, filter: ['==', ['get', 'GEOID'], ''] });
  }
  realLayerIds.forEach(attachTractInteractions);
}

function switchBasemap(key) {
  const styleURL = BASE_STYLES[key] || BASE_STYLES.streets;
  const currentActive = activeLayerId;
  if (basemapSelectEl && basemapSelectEl.value !== key) basemapSelectEl.value = key;
  map.setStyle(styleURL);
  map.once('style.load', () => {
    buildTractLayers();
    setActiveLayer(currentActive);
    restoreIncidentLayerIfMissing();
  });
}

// Controls: unified panel
function addMainControlPanel() {
  class MainPanelControl {
    onAdd() {
      const container = document.createElement('div');
      container.className = 'mapboxgl-ctrl main-control-panel';
      const panel = document.createElement('div');
      panel.id = 'control-panel';

      const makeSection = (title) => {
        const s = document.createElement('div');
        s.className = 'control-section';
        const h = document.createElement('div');
        h.className = 'control-heading';
        h.textContent = title;
        s.appendChild(h);
        return s;
      };

      // Basemap
      const bs = makeSection('Basemap');
      const br = document.createElement('div'); br.className = 'control-row';
      const bsel = document.createElement('select'); bsel.className = 'control-select';
      bsel.innerHTML = `<option value="Dark_Gray">Dark Gray</option><option value="streets">City Streets</option><option value="satellite">Satellite</option>`;
      bsel.value = 'Dark_Gray';
      bsel.onchange = () => switchBasemap(bsel.value);
      br.appendChild(bsel); bs.appendChild(br); panel.appendChild(bs);

      // ACS Data layer
      const ls = makeSection('ACS Data Layer');
      const lr = document.createElement('div'); lr.className = 'control-row';
      const lsel = document.createElement('select'); lsel.className = 'control-select';
      lsel.innerHTML = tractLayers.map(l => `<option value="${l.id}">${l.label}</option>`).join('');
      lsel.value = activeLayerId; lsel.onchange = () => setActiveLayer(lsel.value);
      lr.appendChild(lsel); ls.appendChild(lr); panel.appendChild(ls);

      // Dispatch visibility
      const vs = makeSection('Crimes');
      const vr = document.createElement('div'); vr.className = 'control-row';
      const vbtn = document.createElement('button'); vbtn.className = 'toggle-fill-btn';
      vbtn.onclick = () => setIncidentVisibility(!incidentLayerVisible);
      vr.appendChild(vbtn); vs.appendChild(vr); panel.appendChild(vs);

      // View mode
      const vm = makeSection('View Mode');
      const vrow = document.createElement('div'); vrow.className = 'control-button-group';
      const btnDots = document.createElement('button'); btnDots.textContent = 'Dot Density';
      btnDots.onclick = () => { incidentViewMode = 'dots'; applyIncidentLayerVisibility(); };
      const btnHeat = document.createElement('button'); btnHeat.textContent = 'Heatmap';
      btnHeat.onclick = () => { incidentViewMode = 'heat'; applyIncidentLayerVisibility(); };
      vrow.appendChild(btnDots); vrow.appendChild(btnHeat); vm.appendChild(vrow); panel.appendChild(vm);

      container.appendChild(panel);
      this._container = container;

      basemapSelectEl = bsel; layerSelectEl = lsel;
      refreshVisibilityToggleUI = () => {
        vbtn.className = `toggle-fill-btn ${incidentLayerVisible ? 'on' : 'off'}`;
        vbtn.textContent = incidentLayerVisible ? 'Hide Crimes' : 'Show Crimes';
      };
      refreshViewModeButtonsUI = () => {
        btnDots.className = `toggle-fill-btn ${incidentViewMode === 'dots' ? 'on' : 'off'}`;
        btnHeat.className = `toggle-fill-btn ${incidentViewMode === 'heat' ? 'on' : 'off'}`;
      };
      refreshVisibilityToggleUI();
      refreshViewModeButtonsUI();
      return container;
    }
    onRemove() { if (this._container) this._container.remove(); }
  }
  map.addControl(new MainPanelControl(), 'top-left');
}

function setActiveLayer(showId) {
  activeLayerId = showId;
  if (showId === 'none') {
    realLayerIds.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
    if (map.getLayer('tracts-hover'))   map.setLayoutProperty('tracts-hover',   'visibility', 'none');
    if (map.getLayer('tracts-outline')) map.setLayoutProperty('tracts-outline', 'visibility', 'none');
  } else {
    realLayerIds.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', id === showId ? 'visible' : 'none'); });
    if (map.getLayer('tracts-hover'))   map.setLayoutProperty('tracts-hover',   'visibility', 'visible');
    if (map.getLayer('tracts-outline')) map.setLayoutProperty('tracts-outline', 'visibility', 'visible');
  }
  if (layerSelectEl && layerSelectEl.value !== showId) layerSelectEl.value = showId;
}

function applyIncidentLayerVisibility() {
  const dotsVis = (incidentLayerVisible && incidentViewMode === 'dots') ? 'visible' : 'none';
  const heatVis = (incidentLayerVisible && incidentViewMode === 'heat') ? 'visible' : 'none';
  if (map.getLayer('spd-circles')) map.setLayoutProperty('spd-circles', 'visibility', dotsVis);
  if (map.getLayer('spd-heat'))    map.setLayoutProperty('spd-heat',    'visibility', heatVis);
  applyIncidentFilters();
  if (typeof refreshViewModeButtonsUI === 'function') refreshViewModeButtonsUI();
}

// Timeline (past 7 days)
function setupTimeline() {
  const start = document.getElementById('tl-start');
  const end = document.getElementById('tl-end');
  const rangeEl = document.getElementById('tl-range');
  const minGap = 1;
  const MAX = 168; // hours in 7 days

  // Ensure inputs match our expected max
  start.max = String(MAX);
  end.max = String(MAX);

  function updateRange() {
    let s = parseInt(start.value); let e = parseInt(end.value);
    if (e - s < minGap) {
      if (document.activeElement === start) { s = e - minGap; start.value = s; }
      else { e = s + minGap; end.value = e; }
    }
    filterIncidentsByTime(s, e);
    const pctStart = (s / MAX) * 100; const pctEnd = (e / MAX) * 100;
    rangeEl.style.left = pctStart + '%'; rangeEl.style.width = (pctEnd - pctStart) + '%';
  }
  start.addEventListener('input', updateRange);
  end.addEventListener('input', updateRange);
  // Initialize to full range
  start.value = '0';
  end.value = String(MAX);
  updateRange();
}
window.addEventListener('DOMContentLoaded', setupTimeline);

// Tract interactions (hover, popup)
const fmtInt = (n) => (Number.isFinite(+n) ? (+n).toLocaleString() : '—');
const fmtPct = (n) => (Number.isFinite(+n) ? `${(+n).toFixed(1)}%` : '—');
const fmtUSD = (n) => (Number.isFinite(+n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(+n) : '—');
function attachTractInteractions(layerId) {
  map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  map.on('mousemove', layerId, (e) => {
    const f = e.features && e.features[0];
    map.setFilter('tracts-hover', ['==', ['get', 'GEOID'], f ? f.properties.GEOID : '']);
  });
  map.on('mouseleave', layerId, () => { map.setFilter('tracts-hover', ['==', ['get', 'GEOID'], '']); });
  map.on('click', layerId, (e) => {
    const f = e.features && e.features[0]; if (!f) return;
    const p = f.properties || {};
    const name = p.NAME || `Tract ${p.TRACT_LABEL ?? ''}`;
    const geoid = p.GEOID || '—';
    const pop = +(p.TOTAL_POPULATION ?? NaN);
    const acres = +(p.ACRES_LAND ?? NaN);
    const density = (Number.isFinite(pop) && Number.isFinite(acres) && acres > 0) ? pop / (acres / 640) : null;
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
      </div>`;
    new mapboxgl.Popup({ closeButton: true, closeOnClick: true }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
}

// Load SPD crimes
async function loadSPDCrimesPast24h() {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // past week
  // Use a properly encoded $where clause so Socrata filters server-side.
  const sinceISO = since.toISOString();
  const where = encodeURIComponent(`(offense_start_datetime >= '${sinceISO}' OR report_datetime >= '${sinceISO}') AND latitude IS NOT NULL AND longitude IS NOT NULL`);
  const select = encodeURIComponent('offense_parent_group,offense,offense_start_datetime,report_datetime,latitude,longitude,hundred_block_location,rms_cdw_id');
  const endpoint = `https://data.seattle.gov/resource/tazs-3rd5.json?$select=${select}&$where=${where}&$order=offense_start_datetime DESC&$limit=50000`;
  try {
    console.info('[SPD] Fetching:', endpoint);
    const resp = await fetch(endpoint);
    const data = await resp.json();
    console.info('[SPD] Rows returned:', Array.isArray(data) ? data.length : 'non-array');

    let rows = Array.isArray(data) ? data : [];

    // Fallback: if server-side filter returned nothing, fetch recent rows and filter client-side
    if (!rows.length) {
      const fbUrl = `https://data.seattle.gov/resource/tazs-3rd5.json?$limit=10000&$order=offense_start_datetime DESC`;
      console.warn('[SPD] 0 rows from server-side filter, trying fallback:', fbUrl);
      const fbResp = await fetch(fbUrl);
      const fbData = await fbResp.json();
      rows = Array.isArray(fbData) ? fbData : [];
    }

    let candidateRows = rows.filter(d => d && d.latitude != null && d.longitude != null);
    // Keep last 7 days
    let filteredRows = candidateRows.filter(d => {
      const dtStr = d.offense_start_datetime || d.report_datetime;
      if (!dtStr) return false;
      const dt = new Date(dtStr);
      return isFinite(dt) && dt >= since;
    });
    // If still empty, widen to 30 days to ensure visibility (logged for debugging)
    if (!filteredRows.length && candidateRows.length) {
      const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      console.warn('[SPD] No rows in last 7d; widening to 30d window');
      filteredRows = candidateRows.filter(d => {
        const dtStr = d.offense_start_datetime || d.report_datetime;
        const dt = dtStr ? new Date(dtStr) : null;
        return dt && isFinite(dt) && dt >= since30;
      });
    }
    // If still empty, use whatever we got (up to 3000) so the page isn't blank
    if (!filteredRows.length) {
      console.warn('[SPD] Still no rows after 30d; using recent rows without date filter');
      filteredRows = candidateRows.slice(0, 3000);
    }

    const features = filteredRows
      .map(d => {
        const dtStr = d.offense_start_datetime || d.report_datetime;
        const dt = dtStr ? new Date(dtStr) : null;
        // Age as fraction of a week (0 = now, 1 = 7 days ago)
        const ageFraction = dt ? Math.min(1, Math.max(0, (now - dt) / (7 * 24 * 60 * 60 * 1000))) : 0.999;
        let category = d.offense_parent_group || d.offense || 'Other';
        category = String(category).trim();

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [parseFloat(d.longitude), parseFloat(d.latitude)] },
          properties: {
            address: d.hundred_block_location || 'Unknown block',
            type: d.offense || category,
            datetime: dtStr,
            incident_number: d.rms_cdw_id || '',
            ageFraction: ageFraction,
            category: category
          }
        };
      });

    const geojson = { type: 'FeatureCollection', features };
    window.latestSPDGeojson = geojson;
    console.info('[SPD] Features after mapping:', features.length);

    renderIncidentChart(features);

    if (map.getSource('spd')) {
      map.getSource('spd').setData(geojson);
    } else {
      map.addSource('spd', { type: 'geojson', data: geojson });

      const matchExpr = ['match', ['get', 'category']];
      for (const [type, color] of Object.entries(window.typeColorMap)) matchExpr.push(type, color);
      matchExpr.push('#9ca3af');

      map.addLayer({
        id: 'spd-circles', type: 'circle', source: 'spd',
        paint: {
          'circle-radius': 4,
          'circle-opacity': 0.85,
          'circle-color': matchExpr,
          'circle-stroke-color': '#000',
          'circle-stroke-width': 0.5
        }
      });

      if (!map.getLayer('spd-heat')) {
        map.addLayer({ id: 'spd-heat', type: 'heatmap', source: 'spd', layout: { visibility: 'none' }, paint: {
          'heatmap-weight': 1,
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.0, 16, 1.6],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.1, '#2A9D8F', 0.3, '#457B9D', 0.55, '#F4A261', 0.8, '#F77F00', 1, '#E63946'],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 18, 13, 28, 16, 42],
          'heatmap-opacity': 0.9
        }});
        if (map.getLayer('spd-circles')) map.moveLayer('spd-circles');
      }

      map.on('click', 'spd-circles', (e) => {
        const p = e.features[0].properties;
        new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(`
          <div style="font-size:13px">
            <strong>Offense:</strong> ${p.type}<br/>
            <strong>Category:</strong> ${p.category}<br/>
            <strong>Address:</strong> ${p.address}<br/>
            <strong>Time:</strong> ${p.datetime ? new Date(p.datetime).toLocaleString() : '—'}<br/>
            <strong>Record ID:</strong> ${p.incident_number || '—'}
          </div>`).addTo(map);
      });
      map.on('mouseenter', 'spd-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'spd-circles', () => { map.getCanvas().style.cursor = ''; });
    }

    // Apply current visibility/mode
    applyIncidentLayerVisibility();
  } catch (err) { console.error('Failed to load SPD crimes:', err); }
}

function addIncidentLegend() {
  const container = document.createElement('div');
  container.className = 'mapboxgl-ctrl legend-ctrl';
  container.id = 'incident-legend';
  function updateLegend() {
    if (!window.typeColorMap) return;
    const entries = Object.entries(window.typeColorMap);
    container.innerHTML = `
      <div class="legend">
        <div class="legend-row" style="grid-template-columns: repeat(2, 1fr); gap: 6px;">
          ${entries.map(([type, color]) => `
            <div class="legend-item">
              <span class="legend-swatch" style="background:${color}"></span>
              <span class="legend-label">${type}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }
  map.addControl({ onAdd: () => { updateLegend(); return container; }, onRemove: () => container.remove() }, 'bottom-left');
  window.updateIncidentLegend = updateLegend;
}

function renderIncidentChart(features) {
  const typeCounts = {};
  features.forEach(f => {
    const type = f.properties.category || 'Other';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });
  const total = Object.values(typeCounts).reduce((a,b) => a+b, 0) || 1;
  const sorted = Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]);
  const top9 = sorted.slice(0,9);
  const otherCount = sorted.slice(9).reduce((s, [,c]) => s + c, 0);
  if (otherCount > 0) top9.push(['Other', otherCount]);
  const labels = top9.map(([t]) => t);
  const counts = top9.map(([,c]) => c);

  // Track the real top categories (exclude synthetic Other)
  const realTopCategories = top9.filter(([t]) => t !== 'Other').map(([t]) => t);
  window.topCategoriesReal = realTopCategories;

  const colors = ['#E63946','#F4A261','#2A9D8F','#264653','#F77F00','#A8DADC','#6A4C93','#457B9D','#FFB703','#8D99AE'];
  window.typeColorMap = {}; labels.forEach((l,i)=>{ window.typeColorMap[l]=colors[i]; });

  const chart = document.getElementById('chart-content');
  chart.innerHTML = `<canvas id="pieCanvas" width="240" height="240"></canvas><div id="pie-legend"></div>`;
  const ctx = document.getElementById('pieCanvas').getContext('2d');
  let start = 0; counts.forEach((count,i)=>{ const angle=(count/total)*2*Math.PI; ctx.beginPath(); ctx.moveTo(120,120); ctx.arc(120,120,100,start,start+angle); ctx.closePath(); ctx.fillStyle=colors[i]; ctx.fill(); start+=angle; });

  const legend = document.getElementById('pie-legend'); legend.innerHTML = '';
  const table = document.createElement('table'); table.className='pie-legend-table'; table.style.width='100%'; table.style.fontSize='14px'; table.style.borderCollapse='collapse'; table.style.marginTop='10px';
  const syncRowSelectionUI = () => {
    const selected = window.selectedCrimeType || null;
    table.querySelectorAll('tr').forEach(tr => { const cat = tr.dataset.category; if (selected && cat === selected) tr.classList.add('selected'); else tr.classList.remove('selected'); });
  };
  labels.forEach((label,i)=>{
    const count = counts[i]; const percentage = ((count/total)*100).toFixed(1);
    const row = document.createElement('tr'); row.style.background = i%2===0 ? '#ffffff' : '#f3f4f6'; row.style.height='32px'; row.style.cursor='pointer'; row.dataset.category=label;
    const typeCell = document.createElement('td'); typeCell.style.padding='6px 8px'; typeCell.style.whiteSpace='nowrap'; typeCell.style.display='flex'; typeCell.style.alignItems='center'; typeCell.innerHTML = `<span class="pie-swatch" style="background:${colors[i]}; margin-right:8px;"></span><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</span>`;
    const countCell = document.createElement('td'); countCell.style.padding='6px 8px'; countCell.style.textAlign='right'; countCell.style.whiteSpace='nowrap'; countCell.textContent = `${count} (${percentage}%)`;
    row.appendChild(typeCell); row.appendChild(countCell); table.appendChild(row);
    row.addEventListener('click', ()=>{ const curr = window.selectedCrimeType||null; setIncidentFilter(curr===label?null:label); syncRowSelectionUI(); });
  });
  legend.appendChild(table); syncRowSelectionUI();
  if (typeof window.updateIncidentLegend === 'function') window.updateIncidentLegend();
}

function setIncidentVisibility(visible) {
  incidentLayerVisible = visible; applyIncidentLayerVisibility(); if (typeof refreshVisibilityToggleUI==='function') refreshVisibilityToggleUI();
}

function restoreIncidentLayerIfMissing() {
  if (!map.getSource('spd') && window.latestSPDGeojson) {
    map.addSource('spd', { type: 'geojson', data: window.latestSPDGeojson });
  }
  if (!map.getLayer('spd-circles') && map.getSource('spd')) {
    const matchExpr = ['match', ['get', 'category']]; for (const [t,c] of Object.entries(window.typeColorMap)) matchExpr.push(t,c); matchExpr.push('#9ca3af');
    map.addLayer({ id: 'spd-circles', type: 'circle', source: 'spd', paint: { 'circle-radius': 4, 'circle-opacity': 0.85, 'circle-color': matchExpr, 'circle-stroke-color':'#000', 'circle-stroke-width':0.5 } });
  }
  if (!map.getLayer('spd-heat') && map.getSource('spd')) {
    map.addLayer({ id: 'spd-heat', type: 'heatmap', source: 'spd', layout: { visibility: 'none' }, paint: { 'heatmap-weight':1, 'heatmap-intensity':['interpolate',['linear'],['zoom'],10,0.6,14,1.0,16,1.6], 'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(0,0,0,0)',0.1,'#2A9D8F',0.3,'#457B9D',0.55,'#F4A261',0.8,'#F77F00',1,'#E63946'], 'heatmap-radius':['interpolate',['linear'],['zoom'],10,18,13,28,16,42], 'heatmap-opacity':0.9 } });
  }
  applyIncidentLayerVisibility();
}

function setIncidentFilter(selectedType) { window.selectedCrimeType = selectedType || null; applyIncidentFilters(); }

function filterIncidentsByTime(startHour, endHour) {
  const MAX = 168;
  const boundedStart = Math.max(0, Math.min(MAX, Number.isFinite(+startHour) ? +startHour : 0));
  const boundedEnd = Math.max(0, Math.min(MAX, Number.isFinite(+endHour) ? +endHour : MAX));
  const start = Math.min(boundedStart, boundedEnd); const end = Math.max(boundedStart, boundedEnd);
  window.currentTimeFilter = { startHour: start, endHour: end };
  try { updateSPDChartRangeLabel(); } catch (_) {}
  applyIncidentFilters();
}

function applyIncidentFilters() {
  const layers = ['spd-circles','spd-heat'];
  const f = [];
  const selectedType = window.selectedCrimeType || null;
  if (selectedType) {
    if (selectedType === 'Other' && Array.isArray(window.topCategoriesReal) && window.topCategoriesReal.length) {
      const topList = window.topCategoriesReal;
      topList.forEach(cat => { f.push(['!=', ['get', 'category'], cat]); });
    } else {
      f.push(['==', ['get', 'category'], selectedType]);
    }
  }
  const MAX = 168; // hours in week
  const { startHour, endHour } = window.currentTimeFilter || { startHour: 0, endHour: MAX };
  const s = Math.max(0, Math.min(MAX, startHour)); const e = Math.max(0, Math.min(MAX, endHour));
  if (s>0 || e<MAX) {
    const minAge = Math.max(0, Math.min(1, 1 - (e / MAX)));
    const maxAge = Math.max(0, Math.min(1, 1 - (s / MAX)));
    f.push(['>=', ['get', 'ageFraction'], minAge]);
    f.push(['<=', ['get', 'ageFraction'], maxAge]);
  }
  const expr = f.length ? ['all', ...f] : null;
  layers.forEach(id => { if (map.getLayer(id)) map.setFilter(id, expr); });

  // Update the pie chart/legend to reflect the current filters
  try { updateSPDChartForCurrentSelection(); } catch (e) { console.warn('[SPD] Chart update failed:', e); }
}

// Update the text under "Crime Breakdown" to reflect the selected time window (past 7 days)
function updateSPDChartRangeLabel() {
  const el = document.getElementById('chart-range');
  if (!el) return;
  const MAX = 168; // hours in 7 days
  const { startHour, endHour } = window.currentTimeFilter || { startHour: 0, endHour: MAX };
  const now = new Date();
  const endDate = new Date(now.getTime() - ((MAX - endHour) * 60 * 60 * 1000));
  const startDate = new Date(now.getTime() - ((MAX - startHour) * 60 * 60 * 1000));
  const fmt = (d) => d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).replace(' AM', 'am').replace(' PM', 'pm');
  const endTag = endHour === MAX ? ' (current time)' : '';
  const startTag = startHour === 0 ? ' (7 days ago)' : '';
  el.textContent = `from ${fmt(endDate)} PST${endTag} to ${fmt(startDate)} PST${startTag}`;
}

// Recompute the chart for the current time window (and category filter) without
// modifying the global type→color map used by the map layer.
function updateSPDChartForCurrentSelection() {
  if (!window.latestSPDGeojson || !Array.isArray(window.latestSPDGeojson.features)) return;

  const features = window.latestSPDGeojson.features;
  const MAX = 168;
  const { startHour, endHour } = window.currentTimeFilter || { startHour: 0, endHour: MAX };
  const s = Math.max(0, Math.min(MAX, startHour));
  const e = Math.max(0, Math.min(MAX, endHour));
  const minAge = Math.max(0, Math.min(1, 1 - (e / MAX)));
  const maxAge = Math.max(0, Math.min(1, 1 - (s / MAX)));

  let filtered = features.filter(f => {
    const af = f?.properties?.ageFraction;
    return typeof af === 'number' && af >= minAge && af <= maxAge;
  });

  const selectedType = window.selectedCrimeType || null;
  if (selectedType) {
    if (selectedType === 'Other' && Array.isArray(window.topCategoriesReal) && window.topCategoriesReal.length) {
      const topSet = new Set(window.topCategoriesReal);
      filtered = filtered.filter(f => !topSet.has(f?.properties?.category));
    } else {
      filtered = filtered.filter(f => (f?.properties?.category) === selectedType);
    }
  }

  renderSPDIncidentChartDynamic(filtered);
}

function renderSPDIncidentChartDynamic(features) {
  const typeCounts = {};
  (features || []).forEach(f => {
    const type = (f?.properties?.category) || 'Other';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  const total = Object.values(typeCounts).reduce((a,b)=>a+b,0);
  const sorted = Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]);
  const top9 = sorted.slice(0,9);
  const otherCount = sorted.slice(9).reduce((s, [,c]) => s + c, 0);
  if (otherCount > 0) top9.push(['Other', otherCount]);

  const labels = top9.map(([t])=>t);
  const counts = top9.map(([,c])=>c);

  // Keep "Other" mapping correct for click handling
  window.topCategoriesReal = top9.filter(([t]) => t !== 'Other').map(([t]) => t);

  const colorMap = window.typeColorMap || {};
  const colors = labels.map(l => colorMap[l] || '#9ca3af');

  const chart = document.getElementById('chart-content');
  if (!chart) return;
  chart.innerHTML = `<canvas id="pieCanvas" width="240" height="240"></canvas><div id="pie-legend"></div>`;
  const ctx = document.getElementById('pieCanvas').getContext('2d');

  let start = 0; const safeTotal = total || 1;
  counts.forEach((count,i)=>{
    const angle=(count/safeTotal)*2*Math.PI;
    ctx.beginPath(); ctx.moveTo(120,120);
    ctx.arc(120,120,100,start,start+angle);
    ctx.closePath(); ctx.fillStyle=colors[i]; ctx.fill();
    start+=angle;
  });

  const legend = document.getElementById('pie-legend'); legend.innerHTML='';
  const table = document.createElement('table');
  table.className='pie-legend-table'; table.style.width='100%'; table.style.fontSize='14px';
  table.style.borderCollapse='collapse'; table.style.marginTop='10px';

  const syncRowSelectionUI = () => {
    const selected = window.selectedCrimeType || null;
    table.querySelectorAll('tr').forEach(tr => {
      const cat = tr.dataset.category;
      if (selected && cat === selected) tr.classList.add('selected'); else tr.classList.remove('selected');
    });
  };

  labels.forEach((label,i)=>{
    const count = counts[i]; const percentage = ((count/(safeTotal||1))*100).toFixed(1);
    const row = document.createElement('tr');
    row.style.background = i%2===0 ? '#ffffff' : '#f3f4f6';
    row.style.height='32px'; row.style.cursor='pointer'; row.dataset.category=label;

    const typeCell = document.createElement('td');
    typeCell.style.padding='6px 8px'; typeCell.style.whiteSpace='nowrap';
    typeCell.style.display='flex'; typeCell.style.alignItems='center';
    typeCell.innerHTML = `<span class="pie-swatch" style="background:${colors[i]}; margin-right:8px;"></span><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</span>`;

    const countCell = document.createElement('td');
    countCell.style.padding='6px 8px'; countCell.style.textAlign='right';
    countCell.style.whiteSpace='nowrap'; countCell.textContent = `${count} (${percentage}%)`;

    row.appendChild(typeCell); row.appendChild(countCell); table.appendChild(row);

    row.addEventListener('click', ()=>{
      const curr = window.selectedCrimeType || null;
      setIncidentFilter(curr===label?null:label);
      syncRowSelectionUI();
    });
  });
  legend.appendChild(table); syncRowSelectionUI();
}
