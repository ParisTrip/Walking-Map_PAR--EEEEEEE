/* ════════════════════════════════════════════════
   Paris Trip Companion — app.js
   ════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Category config (add new ones here and in data) ──
  const CATEGORY_META = {
    'sights':       { label: 'Sights',       icon: '🏛️' },
    'museums':      { label: 'Museums',      icon: '🎨' },
    'bakeries':     { label: 'Bakeries',     icon: '🥐' },
    'cafes':        { label: 'Cafés',        icon: '☕' },
    'restaurants':  { label: 'Restaurants',  icon: '🍽️' },
    'dessert':      { label: 'Dessert',      icon: '🍰' },
    'shopping':     { label: 'Shopping',     icon: '🛍️' },
    'rooftops':     { label: 'Rooftops',     icon: '🌆' },
    'wander-areas': { label: 'Wander Areas', icon: '🚶' },
    'family':       { label: 'Family',       icon: '👨‍👩‍👧‍👦' },
    'views':        { label: 'Views',        icon: '👀' },
  };

  // ── State ──
  let places = [];
  let activeFilters = new Set();
  let searchQuery = '';
  let currentSort = 'walking-time';
  let currentView = 'list';
  let userLat = null;
  let userLng = null;
  let locationWatchId = null;
  let locationGranted = false;
  let routingCache = {};        // id -> { duration, distance, timestamp }
  let lastRoutingPos = null;
  let routingInFlight = false;
  let routingTimer = null;
  let map = null;
  let mapReady = false;
  let userMarker = null;
  let userPulse = null;
  let placeMarkers = [];
  let mapFollowUser = true;
  let headerHeight = 0;

  // ── OSRM Config ──
  const OSRM_ROUTE_BASE = 'https://router.project-osrm.org/route/v1/foot';
  const ROUTING_MOVE_THRESHOLD = 80;   // meters before re-routing
  const ROUTING_INTERVAL = 45000;      // auto-refresh ms
  const ROUTING_STALE_MS = 120000;     // show "last updated" after this
  const ROUTE_BATCH_SIZE = 6;          // requests per batch
  const ROUTE_BATCH_DELAY = 300;       // ms between batches

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elList = $('#place-list');
  const elEmpty = $('#empty-state');
  const elCount = $('#results-count');
  const elSearch = $('#search-input');
  const elSearchClear = $('#search-clear');
  const elFiltersTrack = $('#filters-track');
  const elSortDropdown = $('#sort-dropdown');
  const elLocationPrompt = $('#location-prompt');
  const elRoutingStatus = $('#routing-status');
  const elMapView = $('#map-view');
  const elListView = $('#list-view');
  const elMapDetail = $('#map-detail');
  const elMapDetailContent = $('#map-detail-content');

  // ════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════

  async function init() {
    showSkeletons();
    try {
      const resp = await fetch('approved_places.json');
      places = await resp.json();
    } catch (e) {
      elList.innerHTML = '<p style="padding:20px;color:#A89F94;">Could not load places data.</p>';
      return;
    }

    buildFilters();
    measureHeader();
    render();
    bindEvents();

    // Check if location was previously granted
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state === 'granted') {
          startLocation();
        } else {
          showLocationPrompt();
        }
      } catch {
        showLocationPrompt();
      }
    } else {
      showLocationPrompt();
    }
  }

  // ── Skeleton loading ──
  function showSkeletons() {
    let html = '';
    for (let i = 0; i < 6; i++) {
      html += '<div class="skeleton-card"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    }
    elList.innerHTML = html;
  }

  // ── Measure header for layout offset ──
  function measureHeader() {
    const h = $('#app-header').offsetHeight;
    headerHeight = h;
    document.documentElement.style.setProperty('--header-h', h + 'px');
  }

  // ════════════════════════════════════════════════
  //  FILTERS
  // ════════════════════════════════════════════════

  function buildFilters() {
    // Discover categories from data
    const catCounts = {};
    places.forEach(p => {
      (p.category_tags || []).forEach(c => {
        catCounts[c] = (catCounts[c] || 0) + 1;
      });
    });

    let html = '';
    Object.keys(CATEGORY_META).forEach(key => {
      if (!catCounts[key]) return;
      const meta = CATEGORY_META[key];
      html += `<button class="filter-chip" data-cat="${key}">${meta.icon} ${meta.label} <span class="chip-count">${catCounts[key]}</span></button>`;
    });
    // Any categories in data not in CATEGORY_META
    Object.keys(catCounts).forEach(key => {
      if (CATEGORY_META[key]) return;
      const label = key.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      html += `<button class="filter-chip" data-cat="${key}">${label} <span class="chip-count">${catCounts[key]}</span></button>`;
    });
    elFiltersTrack.innerHTML = html;
  }

  // ════════════════════════════════════════════════
  //  FILTERING, SEARCH & SORT
  // ════════════════════════════════════════════════

  function getFilteredPlaces() {
    let list = places;

    // Category filter (OR within categories)
    if (activeFilters.size > 0) {
      list = list.filter(p =>
        (p.category_tags || []).some(t => activeFilters.has(t))
      );
    }

    // Text search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p => {
        const haystack = [
          p.name, p.normalized_name, p.short_description, p.more_notes,
          ...(p.category_tags || [])
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    // Sort
    list = [...list];
    switch (currentSort) {
      case 'walking-time':
        list.sort((a, b) => {
          const da = routingCache[a.id]?.duration ?? Infinity;
          const db = routingCache[b.id]?.duration ?? Infinity;
          return da - db;
        });
        break;
      case 'walking-distance':
        list.sort((a, b) => {
          const da = routingCache[a.id]?.distance ?? Infinity;
          const db = routingCache[b.id]?.distance ?? Infinity;
          return da - db;
        });
        break;
      case 'name':
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return list;
  }

  // ════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════

  function render() {
    const filtered = getFilteredPlaces();

    if (filtered.length === 0) {
      elList.innerHTML = '';
      elEmpty.classList.remove('hidden');
      elCount.textContent = '';
    } else {
      elEmpty.classList.add('hidden');
      elCount.textContent = `${filtered.length} place${filtered.length !== 1 ? 's' : ''}`;
      renderList(filtered);
    }

    if (mapReady) renderMapMarkers(filtered);
  }

  function renderList(list) {
    const now = Date.now();
    let html = '';

    list.forEach(p => {
      const rc = routingCache[p.id];
      const hasRouting = rc && rc.duration != null;
      const isStale = hasRouting && (now - rc.timestamp > ROUTING_STALE_MS);
      const timeStr = hasRouting ? formatDuration(rc.duration) : '';
      const distStr = hasRouting ? formatDistance(rc.distance) : '';
      const staleStr = isStale ? `<span class="stale-indicator">~${formatTimeAgo(rc.timestamp)}</span>` : '';
      const gmapsUrl = getGoogleMapsUrl(p);
      const tags = (p.category_tags || []).map(t => {
        const meta = CATEGORY_META[t];
        const label = meta ? meta.label : t.replace(/-/g, ' ');
        return `<span class="card-tag">${label}</span>`;
      }).join('');

      html += `
        <div class="place-card" data-id="${p.id}">
          <div class="card-header">
            <div class="card-name">${esc(p.name)}</div>
            ${hasRouting || locationGranted ? `
            <div class="card-distance">
              ${hasRouting ? `<div class="card-time">${timeStr}</div><div class="card-meters">${distStr}</div>${staleStr}` : '<div class="card-meters" style="color:var(--text-muted);">Calculating…</div>'}
            </div>` : ''}
          </div>
          <div class="card-tags">${tags}</div>
          <div class="card-desc">${esc(p.short_description)}</div>
          ${p.more_notes ? `
            <button class="card-more-toggle" data-target="notes-${p.id}">More details ▾</button>
            <div class="card-more-notes" id="notes-${p.id}">${esc(p.more_notes)}</div>
          ` : ''}
          <div class="card-actions">
            <button class="card-btn card-btn-map" data-action="show-map" data-id="${p.id}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/></svg>
              Map
            </button>
            <a class="card-btn card-btn-nav" href="${gmapsUrl}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
              Directions
            </a>
          </div>
        </div>`;
    });

    elList.innerHTML = html;
  }

  // ════════════════════════════════════════════════
  //  MAP
  // ════════════════════════════════════════════════

  function initMap() {
    if (map) return;

    map = L.map('map', {
      center: [48.8566, 2.3522],
      zoom: 13,
      zoomControl: false,
      attributionControl: false,
    });

    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.attribution({ position: 'bottomright', prefix: false })
      .addAttribution('© <a href="https://openstreetmap.org">OSM</a>')
      .addTo(map);

    // Warm, elegant tile style
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);

    map.on('movestart', () => { mapFollowUser = false; });

    mapReady = true;

    if (userLat != null) addUserMarker();
    renderMapMarkers(getFilteredPlaces());

    // Delay to let tile rendering settle
    setTimeout(() => map.invalidateSize(), 200);
  }

  function addUserMarker() {
    if (!map || userLat == null) return;

    if (userPulse) map.removeLayer(userPulse);
    if (userMarker) map.removeLayer(userMarker);

    const pulseIcon = L.divIcon({ className: '', html: '<div class="user-marker-pulse"></div>', iconSize: [40, 40], iconAnchor: [20, 20] });
    const userIcon = L.divIcon({ className: '', html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

    userPulse = L.marker([userLat, userLng], { icon: pulseIcon, interactive: false, zIndexOffset: 500 }).addTo(map);
    userMarker = L.marker([userLat, userLng], { icon: userIcon, interactive: false, zIndexOffset: 600 }).addTo(map);
  }

  function updateUserMarker() {
    if (!map || userLat == null) return;
    if (userMarker) userMarker.setLatLng([userLat, userLng]);
    if (userPulse) userPulse.setLatLng([userLat, userLng]);
    if (mapFollowUser && currentView === 'map') {
      map.panTo([userLat, userLng], { animate: true, duration: 0.5 });
    }
  }

  function renderMapMarkers(list) {
    if (!map) return;

    // Clear old
    placeMarkers.forEach(m => map.removeLayer(m));
    placeMarkers = [];

    list.forEach(p => {
      const catIcon = (p.category_tags || []).map(t => CATEGORY_META[t]?.icon).find(Boolean) || '📍';
      const icon = L.divIcon({
        className: '',
        html: `<div class="custom-marker"><span class="custom-marker-inner">${catIcon}</span></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -34],
      });

      const marker = L.marker([p.latitude, p.longitude], { icon }).addTo(map);

      marker.on('click', () => showMapPopup(p, marker));
      placeMarkers.push(marker);
    });
  }

  function showMapPopup(p, marker) {
    const rc = routingCache[p.id];
    const hasRouting = rc && rc.duration != null;
    const gmapsUrl = getGoogleMapsUrl(p);
    const tags = (p.category_tags || []).map(t => {
      const meta = CATEGORY_META[t];
      const label = meta ? meta.label : t;
      return `<span class="card-tag">${label}</span>`;
    }).join('');

    const content = `
      <div class="popup-inner">
        <div class="popup-name">${esc(p.name)}</div>
        <div class="popup-tags">${tags}</div>
        <div class="popup-desc">${esc(p.short_description)}</div>
        ${hasRouting ? `
        <div class="popup-stats">
          <div class="popup-stat"><span class="popup-stat-val">${formatDuration(rc.duration)}</span> walk</div>
          <div class="popup-stat"><span class="popup-stat-val">${formatDistance(rc.distance)}</span></div>
        </div>` : ''}
        <a class="popup-nav-btn" href="${gmapsUrl}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
          Open in Google Maps
        </a>
      </div>`;

    marker.bindPopup(content, { maxWidth: 280, closeButton: true }).openPopup();
  }

  // ════════════════════════════════════════════════
  //  GEOLOCATION
  // ════════════════════════════════════════════════

  function showLocationPrompt() {
    if (locationGranted) return;
    elLocationPrompt.classList.remove('hidden');
  }

  function startLocation() {
    if (!navigator.geolocation) {
      elLocationPrompt.innerHTML = '<p>Geolocation is not supported by your browser. You can still browse the guide!</p>';
      elLocationPrompt.classList.remove('hidden');
      return;
    }

    elLocationPrompt.classList.add('hidden');
    $('#location-btn').classList.add('active');

    // High-accuracy watch
    locationWatchId = navigator.geolocation.watchPosition(
      onLocationUpdate,
      onLocationError,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    locationGranted = true;
  }

  function onLocationUpdate(pos) {
    const newLat = pos.coords.latitude;
    const newLng = pos.coords.longitude;

    const moved = userLat == null || haversine(userLat, userLng, newLat, newLng) > ROUTING_MOVE_THRESHOLD;

    userLat = newLat;
    userLng = newLng;

    if (mapReady) {
      addUserMarker();
      updateUserMarker();
    }

    if (moved) {
      fetchRouting();
    }

    // Start periodic routing refresh
    if (!routingTimer) {
      routingTimer = setInterval(() => {
        if (locationGranted && userLat != null) fetchRouting();
      }, ROUTING_INTERVAL);
    }
  }

  function onLocationError(err) {
    console.warn('Location error:', err.message);
    if (err.code === 1) {
      // Permission denied
      elLocationPrompt.innerHTML = '<p>Location access was denied. You can still browse the guide! Tap the location button to try again.</p>';
      elLocationPrompt.classList.remove('hidden');
      $('#location-btn').classList.remove('active');
      locationGranted = false;
    }
  }

  // ════════════════════════════════════════════════
  //  OSRM ROUTING
  // ════════════════════════════════════════════════

  async function fetchRouting() {
    if (userLat == null || routingInFlight) return;

    const visiblePlaces = getFilteredPlaces();
    if (visiblePlaces.length === 0) return;

    routingInFlight = true;
    showRoutingStatus('Updating walking times…');

    const now = Date.now();
    let successCount = 0;
    let errorCount = 0;

    // Batch places into groups to avoid hammering the server
    const batches = [];
    for (let i = 0; i < visiblePlaces.length; i += ROUTE_BATCH_SIZE) {
      batches.push(visiblePlaces.slice(i, i + ROUTE_BATCH_SIZE));
    }

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];

      // Fetch each route in this batch concurrently
      const promises = batch.map(async (p) => {
        const url = `${OSRM_ROUTE_BASE}/${userLng},${userLat};${p.longitude},${p.latitude}?overview=false`;
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            routingCache[p.id] = {
              duration: route.duration,
              distance: route.distance,
              timestamp: now
            };
            successCount++;
          } else {
            throw new Error('No route found');
          }
        } catch (e) {
          errorCount++;
          // Keep stale cache entry if it exists
        }
      });

      await Promise.all(promises);

      // Render progress after each batch so cards update progressively
      render();

      // Small delay between batches to be respectful to the public server
      if (b < batches.length - 1) {
        await new Promise(r => setTimeout(r, ROUTE_BATCH_DELAY));
      }
    }

    lastRoutingPos = { lat: userLat, lng: userLng };
    routingInFlight = false;

    if (errorCount > 0 && successCount === 0) {
      const cached = Object.values(routingCache).length;
      showRoutingStatus(cached > 0 ? 'Using cached walking times' : 'Could not fetch walking times — will retry');
    } else if (errorCount > 0) {
      showRoutingStatus(`Updated ${successCount} of ${successCount + errorCount} places`);
      setTimeout(() => showRoutingStatus(''), 3000);
    } else {
      showRoutingStatus('');
    }

    render();
  }

  function showRoutingStatus(msg) {
    if (!msg) {
      elRoutingStatus.classList.add('hidden');
      return;
    }
    elRoutingStatus.textContent = msg;
    elRoutingStatus.classList.remove('hidden');
  }

  // ════════════════════════════════════════════════
  //  EVENTS
  // ════════════════════════════════════════════════

  function bindEvents() {
    // Filter chips
    elFiltersTrack.addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      const cat = chip.dataset.cat;
      if (activeFilters.has(cat)) {
        activeFilters.delete(cat);
        chip.classList.remove('active');
      } else {
        activeFilters.add(cat);
        chip.classList.add('active');
      }
      render();
      if (locationGranted && userLat != null) fetchRouting();
    });

    // Search
    elSearch.addEventListener('input', () => {
      searchQuery = elSearch.value.trim();
      elSearchClear.classList.toggle('visible', searchQuery.length > 0);
      render();
    });
    elSearchClear.addEventListener('click', () => {
      elSearch.value = '';
      searchQuery = '';
      elSearchClear.classList.remove('visible');
      render();
    });

    // Sort
    $('#sort-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      elSortDropdown.classList.toggle('hidden');
    });
    elSortDropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.sort-option');
      if (!opt) return;
      currentSort = opt.dataset.sort;
      $$('.sort-option').forEach(el => el.classList.remove('active'));
      opt.classList.add('active');
      elSortDropdown.classList.add('hidden');
      render();
    });
    document.addEventListener('click', () => elSortDropdown.classList.add('hidden'));

    // View toggle
    $$('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === currentView) return;
        currentView = view;
        $$('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (view === 'map') {
          elListView.classList.add('hidden');
          elMapView.classList.remove('hidden');
          if (!mapReady) initMap();
          setTimeout(() => map.invalidateSize(), 100);
          if (userLat != null) {
            mapFollowUser = true;
            map.setView([userLat, userLng], 14, { animate: true });
          }
        } else {
          elMapView.classList.add('hidden');
          elListView.classList.remove('hidden');
          elMapDetail.classList.add('hidden');
        }
      });
    });

    // Location button
    $('#location-btn').addEventListener('click', () => {
      if (locationGranted && userLat != null) {
        // Re-center map if in map view
        if (currentView === 'map' && map) {
          mapFollowUser = true;
          map.setView([userLat, userLng], 15, { animate: true });
        }
      } else {
        startLocation();
      }
    });

    // Enable location button in prompt
    $('#enable-location-btn')?.addEventListener('click', startLocation);

    // Delegated events on list
    elList.addEventListener('click', (e) => {
      // More notes toggle
      const toggle = e.target.closest('.card-more-toggle');
      if (toggle) {
        const target = document.getElementById(toggle.dataset.target);
        if (target) {
          target.classList.toggle('open');
          toggle.textContent = target.classList.contains('open') ? 'Less details ▴' : 'More details ▾';
        }
        return;
      }

      // Show on map button
      const mapBtn = e.target.closest('[data-action="show-map"]');
      if (mapBtn) {
        const placeId = mapBtn.dataset.id;
        const place = places.find(p => p.id === placeId);
        if (place) showPlaceOnMap(place);
        return;
      }
    });

    // Clear filters in empty state
    $('#clear-filters-btn')?.addEventListener('click', () => {
      activeFilters.clear();
      searchQuery = '';
      elSearch.value = '';
      elSearchClear.classList.remove('visible');
      $$('.filter-chip').forEach(c => c.classList.remove('active'));
      render();
    });

    // Close map detail
    elMapDetail.addEventListener('click', (e) => {
      if (e.target === elMapDetail || e.target.classList.contains('map-detail-handle')) {
        elMapDetail.classList.remove('visible');
        setTimeout(() => elMapDetail.classList.add('hidden'), 300);
      }
    });
  }

  function showPlaceOnMap(place) {
    // Switch to map view
    currentView = 'map';
    $$('.view-btn').forEach(b => b.classList.remove('active'));
    $('[data-view="map"]').classList.add('active');
    elListView.classList.add('hidden');
    elMapView.classList.remove('hidden');

    if (!mapReady) initMap();
    setTimeout(() => {
      map.invalidateSize();
      mapFollowUser = false;
      map.setView([place.latitude, place.longitude], 16, { animate: true });

      // Find and open popup for this place
      const idx = getFilteredPlaces().findIndex(p => p.id === place.id);
      if (idx >= 0 && placeMarkers[idx]) {
        showMapPopup(place, placeMarkers[idx]);
      }
    }, 150);
  }

  // ════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════

  function getGoogleMapsUrl(place) {
    // Deep link optimized for iPhone — opens in Google Maps app if installed
    if (userLat != null) {
      return `https://www.google.com/maps/dir/?api=1&origin=${userLat},${userLng}&destination=${encodeURIComponent(place.google_maps_query || place.name + ', Paris')}&travelmode=walking`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.google_maps_query || place.name + ', Paris')}`;
  }

  function formatDuration(seconds) {
    if (seconds == null) return '—';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDistance(meters) {
    if (meters == null) return '—';
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function formatTimeAgo(timestamp) {
    const diff = Math.round((Date.now() - timestamp) / 60000);
    if (diff < 1) return 'just now';
    return `${diff}m ago`;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Boot ──
  document.addEventListener('DOMContentLoaded', init);

})();
