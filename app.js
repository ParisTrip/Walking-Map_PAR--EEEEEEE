/* ════════════════════════════════════════════════
   Paris Trip Companion — app.js v2.1
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
  let routingCache = {};
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

  // ── Routing Config ──
  // Uses OSRM Route API for accurate street-routed distances.
  // Walking time calculated at 1.0 m/s = 3.6 km/h (family pace, matches Google Maps).
  const OSRM_ROUTE = 'https://router.project-osrm.org/route/v1/foot';
  const WALK_SPEED_MS = 1.0;
  const ROUTING_MOVE_THRESHOLD = 80;
  const ROUTING_INTERVAL = 60000;
  const ROUTING_STALE_MS = 180000;
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 400;

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
    console.log('[Paris v2.1] Initializing…');
    showSkeletons();
    try {
      const resp = await fetch('approved_places.json?v=21');
      places = await resp.json();
      console.log('[Paris] Loaded ' + places.length + ' places');
    } catch (e) {
      elList.innerHTML = '<p style="padding:20px;color:#A89F94;">Could not load places data.</p>';
      return;
    }

    buildFilters();
    measureHeader();
    render();
    bindEvents();

    if (navigator.permissions && navigator.permissions.query) {
      try {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state === 'granted') {
          startLocation();
        } else {
          showLocationPrompt();
        }
      } catch (e2) {
        showLocationPrompt();
      }
    } else {
      showLocationPrompt();
    }
  }

  function showSkeletons() {
    var html = '';
    for (var i = 0; i < 6; i++) {
      html += '<div class="skeleton-card"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    }
    elList.innerHTML = html;
  }

  function measureHeader() {
    var h = $('#app-header').offsetHeight;
    headerHeight = h;
    document.documentElement.style.setProperty('--header-h', h + 'px');
  }

  // ════════════════════════════════════════════════
  //  FILTERS
  // ════════════════════════════════════════════════

  function buildFilters() {
    var catCounts = {};
    places.forEach(function(p) {
      (p.category_tags || []).forEach(function(c) {
        catCounts[c] = (catCounts[c] || 0) + 1;
      });
    });

    var html = '';
    Object.keys(CATEGORY_META).forEach(function(key) {
      if (!catCounts[key]) return;
      var meta = CATEGORY_META[key];
      html += '<button class="filter-chip" data-cat="' + key + '">' + meta.icon + ' ' + meta.label + ' <span class="chip-count">' + catCounts[key] + '</span></button>';
    });
    Object.keys(catCounts).forEach(function(key) {
      if (CATEGORY_META[key]) return;
      var label = key.replace(/-/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
      html += '<button class="filter-chip" data-cat="' + key + '">' + label + ' <span class="chip-count">' + catCounts[key] + '</span></button>';
    });
    elFiltersTrack.innerHTML = html;
  }

  // ════════════════════════════════════════════════
  //  FILTERING, SEARCH & SORT
  // ════════════════════════════════════════════════

  function getFilteredPlaces() {
    var list = places;

    if (activeFilters.size > 0) {
      list = list.filter(function(p) {
        return (p.category_tags || []).some(function(t) { return activeFilters.has(t); });
      });
    }

    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      list = list.filter(function(p) {
        var haystack = [
          p.name, p.normalized_name, p.short_description, p.more_notes
        ].concat(p.category_tags || []).join(' ').toLowerCase();
        return haystack.indexOf(q) !== -1;
      });
    }

    list = list.slice();
    if (currentSort === 'walking-time') {
      list.sort(function(a, b) {
        var da = routingCache[a.id] ? routingCache[a.id].duration : Infinity;
        var db = routingCache[b.id] ? routingCache[b.id].duration : Infinity;
        return da - db;
      });
    } else if (currentSort === 'walking-distance') {
      list.sort(function(a, b) {
        var da = routingCache[a.id] ? routingCache[a.id].distance : Infinity;
        var db = routingCache[b.id] ? routingCache[b.id].distance : Infinity;
        return da - db;
      });
    } else if (currentSort === 'name') {
      list.sort(function(a, b) { return a.name.localeCompare(b.name); });
    }
    return list;
  }

  // ════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════

  function render() {
    var filtered = getFilteredPlaces();

    if (filtered.length === 0) {
      elList.innerHTML = '';
      elEmpty.classList.remove('hidden');
      elCount.textContent = '';
    } else {
      elEmpty.classList.add('hidden');
      elCount.textContent = filtered.length + ' place' + (filtered.length !== 1 ? 's' : '');
      renderList(filtered);
    }

    if (mapReady) renderMapMarkers(filtered);
  }

  function renderList(list) {
    var now = Date.now();
    var html = '';

    list.forEach(function(p) {
      var rc = routingCache[p.id];
      var hasRouting = rc && rc.duration != null;
      var isStale = hasRouting && (now - rc.timestamp > ROUTING_STALE_MS);
      var timeStr = hasRouting ? '~' + formatDuration(rc.duration) : '';
      var distStr = hasRouting ? formatDistance(rc.distance) : '';
      var staleStr = isStale ? '<span class="stale-indicator">updated ' + formatTimeAgo(rc.timestamp) + '</span>' : '';
      var gmapsUrl = getGoogleMapsUrl(p);
      var tags = (p.category_tags || []).map(function(t) {
        var meta = CATEGORY_META[t];
        var label = meta ? meta.label : t.replace(/-/g, ' ');
        return '<span class="card-tag">' + label + '</span>';
      }).join('');

      html += '<div class="place-card" data-id="' + p.id + '">' +
        '<div class="card-header">' +
          '<div class="card-name">' + esc(p.name) + '</div>' +
          (hasRouting || locationGranted ?
            '<div class="card-distance">' +
              (hasRouting ?
                '<div class="card-time">' + timeStr + '</div><div class="card-meters">' + distStr + '</div>' + staleStr
                : '<div class="card-meters" style="color:var(--text-muted);">Calculating…</div>') +
            '</div>' : '') +
        '</div>' +
        '<div class="card-tags">' + tags + '</div>' +
        '<div class="card-desc">' + esc(p.short_description) + '</div>' +
        (p.more_notes ?
          '<button class="card-more-toggle" data-target="notes-' + p.id + '">More details ▾</button>' +
          '<div class="card-more-notes" id="notes-' + p.id + '">' + esc(p.more_notes) + '</div>'
          : '') +
        '<div class="card-actions">' +
          '<button class="card-btn card-btn-map" data-action="show-map" data-id="' + p.id + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/></svg> Map</button>' +
          '<a class="card-btn card-btn-nav" href="' + gmapsUrl + '" target="_blank" rel="noopener">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg> Directions</a>' +
        '</div>' +
      '</div>';
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
      .addAttribution('&copy; <a href="https://openstreetmap.org">OSM</a>')
      .addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);

    map.on('movestart', function() { mapFollowUser = false; });

    mapReady = true;

    if (userLat != null) addUserMarker();
    renderMapMarkers(getFilteredPlaces());

    setTimeout(function() { map.invalidateSize(); }, 200);
  }

  function addUserMarker() {
    if (!map || userLat == null) return;

    if (userPulse) map.removeLayer(userPulse);
    if (userMarker) map.removeLayer(userMarker);

    var pulseIcon = L.divIcon({ className: '', html: '<div class="user-marker-pulse"></div>', iconSize: [40, 40], iconAnchor: [20, 20] });
    var userIcon = L.divIcon({ className: '', html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

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

    placeMarkers.forEach(function(m) { map.removeLayer(m); });
    placeMarkers = [];

    list.forEach(function(p) {
      var catIcon = '📍';
      (p.category_tags || []).some(function(t) {
        if (CATEGORY_META[t]) { catIcon = CATEGORY_META[t].icon; return true; }
        return false;
      });
      var icon = L.divIcon({
        className: '',
        html: '<div class="custom-marker"><span class="custom-marker-inner">' + catIcon + '</span></div>',
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -34],
      });

      var marker = L.marker([p.latitude, p.longitude], { icon: icon }).addTo(map);
      marker.on('click', function() { showMapPopup(p, marker); });
      placeMarkers.push(marker);
    });
  }

  function showMapPopup(p, marker) {
    var rc = routingCache[p.id];
    var hasRouting = rc && rc.duration != null;
    var gmapsUrl = getGoogleMapsUrl(p);
    var tags = (p.category_tags || []).map(function(t) {
      var meta = CATEGORY_META[t];
      var label = meta ? meta.label : t;
      return '<span class="card-tag">' + label + '</span>';
    }).join('');

    var statsHtml = '';
    if (hasRouting) {
      statsHtml = '<div class="popup-stats">' +
        '<div class="popup-stat"><span class="popup-stat-val">~' + formatDuration(rc.duration) + '</span> walk</div>' +
        '<div class="popup-stat"><span class="popup-stat-val">' + formatDistance(rc.distance) + '</span></div>' +
      '</div>';
    }

    var content = '<div class="popup-inner">' +
      '<div class="popup-name">' + esc(p.name) + '</div>' +
      '<div class="popup-tags">' + tags + '</div>' +
      '<div class="popup-desc">' + esc(p.short_description) + '</div>' +
      statsHtml +
      '<a class="popup-nav-btn" href="' + gmapsUrl + '" target="_blank" rel="noopener">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg> Open in Google Maps</a>' +
    '</div>';

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

    locationWatchId = navigator.geolocation.watchPosition(
      onLocationUpdate,
      onLocationError,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    locationGranted = true;
  }

  function onLocationUpdate(pos) {
    var newLat = pos.coords.latitude;
    var newLng = pos.coords.longitude;

    var moved = userLat == null || haversine(userLat, userLng, newLat, newLng) > ROUTING_MOVE_THRESHOLD;

    userLat = newLat;
    userLng = newLng;
    console.log('[Paris] Location: ' + userLat.toFixed(5) + ', ' + userLng.toFixed(5));

    if (mapReady) {
      addUserMarker();
      updateUserMarker();
    }

    if (moved) {
      fetchAllRoutes();
    }

    if (!routingTimer) {
      routingTimer = setInterval(function() {
        if (locationGranted && userLat != null) fetchAllRoutes();
      }, ROUTING_INTERVAL);
    }
  }

  function onLocationError(err) {
    console.warn('[Paris] Location error:', err.message);
    if (err.code === 1) {
      elLocationPrompt.innerHTML = '<p>Location access was denied. You can still browse the guide! Tap the location button to try again.</p>';
      elLocationPrompt.classList.remove('hidden');
      $('#location-btn').classList.remove('active');
      locationGranted = false;
    }
  }

  // ════════════════════════════════════════════════
  //  OSRM ROUTE API — Accurate Walking Routes
  // ════════════════════════════════════════════════

  function fetchOneRoute(place) {
    var url = OSRM_ROUTE + '/' + userLng + ',' + userLat + ';' + place.longitude + ',' + place.latitude + '?overview=false&alternatives=false';

    console.log('[Paris] Fetching route for ' + place.name + ': ' + url);

    return fetch(url)
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(data) {
        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
          throw new Error('No route returned');
        }

        var route = data.routes[0];
        // route.distance = actual routed walking distance in meters
        var routedDistance = route.distance;
        // Calculate time at family walking pace (1.0 m/s = 3.6 km/h)
        var duration = routedDistance / WALK_SPEED_MS;

        console.log('[Paris] ' + place.name + ': OSRM distance=' + Math.round(routedDistance) + 'm, calculated time=' + Math.round(duration/60) + 'min');

        return { id: place.id, distance: routedDistance, duration: duration };
      });
  }

  function fetchAllRoutes() {
    if (userLat == null || routingInFlight) return;

    var visible = getFilteredPlaces();
    if (visible.length === 0) return;

    routingInFlight = true;
    showRoutingStatus('Updating walking times…');

    var now = Date.now();
    var ok = 0;
    var fail = 0;

    // Process in sequential batches
    var batchIndex = 0;

    function processBatch() {
      if (batchIndex >= visible.length) {
        // All done
        lastRoutingPos = { lat: userLat, lng: userLng };
        routingInFlight = false;

        if (fail > 0 && ok === 0) {
          showRoutingStatus('Could not fetch walking times — will retry');
        } else if (fail > 0) {
          showRoutingStatus('Updated ' + ok + ' of ' + (ok + fail) + ' places');
          setTimeout(function() { showRoutingStatus(''); }, 4000);
        } else {
          showRoutingStatus('');
          console.log('[Paris] All ' + ok + ' routes updated successfully');
        }
        render();
        return;
      }

      var batch = visible.slice(batchIndex, batchIndex + BATCH_SIZE);
      batchIndex += BATCH_SIZE;

      var promises = batch.map(function(p) {
        return fetchOneRoute(p)
          .then(function(result) {
            routingCache[result.id] = {
              distance: result.distance,
              duration: result.duration,
              timestamp: now
            };
            ok++;
          })
          .catch(function(err) {
            fail++;
            console.warn('[Paris] Route failed for ' + p.name + ':', err.message);
          });
      });

      Promise.all(promises).then(function() {
        render(); // Progressive update
        setTimeout(processBatch, BATCH_DELAY_MS);
      });
    }

    processBatch();
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
    elFiltersTrack.addEventListener('click', function(e) {
      var chip = e.target.closest('.filter-chip');
      if (!chip) return;
      var cat = chip.dataset.cat;
      if (activeFilters.has(cat)) {
        activeFilters.delete(cat);
        chip.classList.remove('active');
      } else {
        activeFilters.add(cat);
        chip.classList.add('active');
      }
      render();
      if (locationGranted && userLat != null) fetchAllRoutes();
    });

    elSearch.addEventListener('input', function() {
      searchQuery = elSearch.value.trim();
      elSearchClear.classList.toggle('visible', searchQuery.length > 0);
      render();
    });
    elSearchClear.addEventListener('click', function() {
      elSearch.value = '';
      searchQuery = '';
      elSearchClear.classList.remove('visible');
      render();
    });

    $('#sort-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      elSortDropdown.classList.toggle('hidden');
    });
    elSortDropdown.addEventListener('click', function(e) {
      var opt = e.target.closest('.sort-option');
      if (!opt) return;
      currentSort = opt.dataset.sort;
      $$('.sort-option').forEach(function(el) { el.classList.remove('active'); });
      opt.classList.add('active');
      elSortDropdown.classList.add('hidden');
      render();
    });
    document.addEventListener('click', function() { elSortDropdown.classList.add('hidden'); });

    $$('.view-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var view = btn.dataset.view;
        if (view === currentView) return;
        currentView = view;
        $$('.view-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');

        if (view === 'map') {
          elListView.classList.add('hidden');
          elMapView.classList.remove('hidden');
          if (!mapReady) initMap();
          setTimeout(function() { map.invalidateSize(); }, 100);
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

    $('#location-btn').addEventListener('click', function() {
      if (locationGranted && userLat != null) {
        if (currentView === 'map' && map) {
          mapFollowUser = true;
          map.setView([userLat, userLng], 15, { animate: true });
        }
      } else {
        startLocation();
      }
    });

    var enableBtn = $('#enable-location-btn');
    if (enableBtn) enableBtn.addEventListener('click', startLocation);

    elList.addEventListener('click', function(e) {
      var toggle = e.target.closest('.card-more-toggle');
      if (toggle) {
        var target = document.getElementById(toggle.dataset.target);
        if (target) {
          target.classList.toggle('open');
          toggle.textContent = target.classList.contains('open') ? 'Less details ▴' : 'More details ▾';
        }
        return;
      }

      var mapBtn = e.target.closest('[data-action="show-map"]');
      if (mapBtn) {
        var placeId = mapBtn.dataset.id;
        var place = places.find(function(p) { return p.id === placeId; });
        if (place) showPlaceOnMap(place);
        return;
      }
    });

    var clearBtn = $('#clear-filters-btn');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      activeFilters.clear();
      searchQuery = '';
      elSearch.value = '';
      elSearchClear.classList.remove('visible');
      $$('.filter-chip').forEach(function(c) { c.classList.remove('active'); });
      render();
    });

    elMapDetail.addEventListener('click', function(e) {
      if (e.target === elMapDetail || e.target.classList.contains('map-detail-handle')) {
        elMapDetail.classList.remove('visible');
        setTimeout(function() { elMapDetail.classList.add('hidden'); }, 300);
      }
    });
  }

  function showPlaceOnMap(place) {
    currentView = 'map';
    $$('.view-btn').forEach(function(b) { b.classList.remove('active'); });
    $('[data-view="map"]').classList.add('active');
    elListView.classList.add('hidden');
    elMapView.classList.remove('hidden');

    if (!mapReady) initMap();
    setTimeout(function() {
      map.invalidateSize();
      mapFollowUser = false;
      map.setView([place.latitude, place.longitude], 16, { animate: true });

      var filtered = getFilteredPlaces();
      var idx = -1;
      for (var i = 0; i < filtered.length; i++) {
        if (filtered[i].id === place.id) { idx = i; break; }
      }
      if (idx >= 0 && placeMarkers[idx]) {
        showMapPopup(place, placeMarkers[idx]);
      }
    }, 150);
  }

  // ════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════

  function getGoogleMapsUrl(place) {
    if (userLat != null) {
      return 'https://www.google.com/maps/dir/?api=1&origin=' + userLat + ',' + userLng + '&destination=' + encodeURIComponent(place.google_maps_query || place.name + ', Paris') + '&travelmode=walking';
    }
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place.google_maps_query || place.name + ', Paris');
  }

  function formatDuration(seconds) {
    if (seconds == null) return '—';
    var mins = Math.round(seconds / 60);
    if (mins < 1) return '1 min';
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
  }

  function formatDistance(meters) {
    if (meters == null) return '—';
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters / 1000).toFixed(1) + ' km';
  }

  function formatTimeAgo(timestamp) {
    var diff = Math.round((Date.now() - timestamp) / 60000);
    if (diff < 1) return 'just now';
    return diff + 'm ago';
  }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Boot ──
  document.addEventListener('DOMContentLoaded', init);

})();
