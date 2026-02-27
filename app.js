/* ════════════════════════════════════════════════
   Paris Trip Companion — app.js v3.1
   Uses OpenRouteService Directions API for
   accurate walking distances and times.
   ════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ┌──────────────────────────────────────────────┐
  // │  PASTE YOUR FREE API KEY BELOW               │
  // │  Get one at: openrouteservice.org/dev/#/signup│
  // └──────────────────────────────────────────────┘
  var ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImJlZTFkZTEwYTkzOTQwYThhOTZjM2ZlOTFlZmIzNGU2IiwiaCI6Im11cm11cjY0In0=';

  // ── Category config ──
  var CATEGORY_META = {
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
  var places = [];
  var activeFilters = new Set();
  var searchQuery = '';
  var currentSort = 'walking-time';
  var currentView = 'list';
  var userLat = null;
  var userLng = null;
  var locationWatchId = null;
  var locationGranted = false;
  var routingCache = {};
  var lastRoutingPos = null;
  var routingInFlight = false;
  var routingTimer = null;
  var map = null;
  var mapReady = false;
  var userMarker = null;
  var userPulse = null;
  var placeMarkers = [];
  var mapFollowUser = true;
  var headerHeight = 0;

  // ── Routing Config ──
  var ORS_DIR = 'https://api.openrouteservice.org/v2/directions/foot-walking';
  var ROUTING_MOVE_THRESHOLD = 80;
  var ROUTING_INTERVAL = 60000;
  var ROUTING_STALE_MS = 180000;
  var BATCH_SIZE = 4;       // ORS free = 40 req/min, so 4 at a time
  var BATCH_DELAY_MS = 700; // ~700ms between batches to stay under rate limit

  // ── DOM refs ──
  var $ = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return document.querySelectorAll(sel); };

  var elList, elEmpty, elCount, elSearch, elSearchClear, elFiltersTrack;
  var elSortDropdown, elLocationPrompt, elRoutingStatus;
  var elMapView, elListView, elMapDetail, elMapDetailContent;

  // ════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════

  function init() {
    console.log('[Paris v3.1] Initializing — ORS Directions routing');

    elList = $('#place-list');
    elEmpty = $('#empty-state');
    elCount = $('#results-count');
    elSearch = $('#search-input');
    elSearchClear = $('#search-clear');
    elFiltersTrack = $('#filters-track');
    elSortDropdown = $('#sort-dropdown');
    elLocationPrompt = $('#location-prompt');
    elRoutingStatus = $('#routing-status');
    elMapView = $('#map-view');
    elListView = $('#list-view');
    elMapDetail = $('#map-detail');
    elMapDetailContent = $('#map-detail-content');

    if (ORS_API_KEY === 'PASTE_YOUR_KEY_HERE') {
      console.warn('[Paris] ⚠️ No API key set! Paste your free OpenRouteService key in app.js');
    }
    showSkeletons();

    fetch('approved_places.json?v=31')
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        places = data;
        console.log('[Paris] Loaded ' + places.length + ' places');
        buildFilters();
        measureHeader();
        render();
        bindEvents();
        checkLocationPermission();
      })
      .catch(function() {
        elList.innerHTML = '<p style="padding:20px;color:#A89F94;">Could not load places data.</p>';
      });
  }

  function checkLocationPermission() {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then(function(perm) {
          if (perm.state === 'granted') startLocation();
          else showLocationPrompt();
        })
        .catch(function() { showLocationPrompt(); });
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
        var haystack = [p.name, p.normalized_name, p.short_description, p.more_notes]
          .concat(p.category_tags || []).join(' ').toLowerCase();
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
          '<div class="card-more-notes" id="notes-' + p.id + '">' + esc(p.more_notes) + '</div>' : '') +
        '<div class="card-actions">' +
          '<button class="card-btn card-btn-map" data-action="show-map" data-id="' + p.id + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/></svg> Map</button>' +
          '<a class="card-btn card-btn-nav" href="' + gmapsUrl + '" target="_blank" rel="noopener">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg> Directions</a>' +
        '</div></div>';
    });
    elList.innerHTML = html;
  }

  // ════════════════════════════════════════════════
  //  MAP
  // ════════════════════════════════════════════════

  function initMap() {
    if (map) return;
    map = L.map('map', { center: [48.8566, 2.3522], zoom: 13, zoomControl: false, attributionControl: false });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.attribution({ position: 'bottomright', prefix: false })
      .addAttribution('&copy; <a href="https://openstreetmap.org">OSM</a>').addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd'
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
    var uIcon = L.divIcon({ className: '', html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    userPulse = L.marker([userLat, userLng], { icon: pulseIcon, interactive: false, zIndexOffset: 500 }).addTo(map);
    userMarker = L.marker([userLat, userLng], { icon: uIcon, interactive: false, zIndexOffset: 600 }).addTo(map);
  }

  function updateUserMarker() {
    if (!map || userLat == null) return;
    if (userMarker) userMarker.setLatLng([userLat, userLng]);
    if (userPulse) userPulse.setLatLng([userLat, userLng]);
    if (mapFollowUser && currentView === 'map') map.panTo([userLat, userLng], { animate: true, duration: 0.5 });
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
        iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -34]
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
      return '<span class="card-tag">' + (meta ? meta.label : t) + '</span>';
    }).join('');
    var statsHtml = '';
    if (hasRouting) {
      statsHtml = '<div class="popup-stats">' +
        '<div class="popup-stat"><span class="popup-stat-val">~' + formatDuration(rc.duration) + '</span> walk</div>' +
        '<div class="popup-stat"><span class="popup-stat-val">' + formatDistance(rc.distance) + '</span></div></div>';
    }
    var content = '<div class="popup-inner">' +
      '<div class="popup-name">' + esc(p.name) + '</div>' +
      '<div class="popup-tags">' + tags + '</div>' +
      '<div class="popup-desc">' + esc(p.short_description) + '</div>' +
      statsHtml +
      '<a class="popup-nav-btn" href="' + gmapsUrl + '" target="_blank" rel="noopener">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg> Open in Google Maps</a></div>';
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
      elLocationPrompt.innerHTML = '<p>Geolocation is not supported. You can still browse the guide!</p>';
      elLocationPrompt.classList.remove('hidden');
      return;
    }
    elLocationPrompt.classList.add('hidden');
    $('#location-btn').classList.add('active');
    locationWatchId = navigator.geolocation.watchPosition(onLocationUpdate, onLocationError,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
    locationGranted = true;
  }

  function onLocationUpdate(pos) {
    var newLat = pos.coords.latitude;
    var newLng = pos.coords.longitude;
    var moved = userLat == null || haversine(userLat, userLng, newLat, newLng) > ROUTING_MOVE_THRESHOLD;
    userLat = newLat;
    userLng = newLng;
    console.log('[Paris] Location: ' + userLat.toFixed(5) + ', ' + userLng.toFixed(5));
    if (mapReady) { addUserMarker(); updateUserMarker(); }
    if (moved) fetchRoutes();
    if (!routingTimer) {
      routingTimer = setInterval(function() {
        if (locationGranted && userLat != null) fetchRoutes();
      }, ROUTING_INTERVAL);
    }
  }

  function onLocationError(err) {
    console.warn('[Paris] Location error:', err.message);
    if (err.code === 1) {
      elLocationPrompt.innerHTML = '<p>Location access denied. You can still browse! Tap location button to retry.</p>';
      elLocationPrompt.classList.remove('hidden');
      $('#location-btn').classList.remove('active');
      locationGranted = false;
    }
  }

  // ════════════════════════════════════════════════
  //  OPENROUTESERVICE DIRECTIONS API
  //  Individual route requests in controlled batches.
  //  GET endpoint — simple and reliable on free tier.
  // ════════════════════════════════════════════════

  function fetchOneRoute(place) {
    // ORS GET directions: start=lng,lat&end=lng,lat
    var url = ORS_DIR + '?api_key=' + ORS_API_KEY +
      '&start=' + userLng + ',' + userLat +
      '&end=' + place.longitude + ',' + place.latitude;

    return fetch(url)
      .then(function(resp) {
        if (resp.status === 429) throw new Error('Rate limited');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(data) {
        // GeoJSON response — summary is in features[0].properties.summary
        var summary = data.features[0].properties.summary;
        return {
          id: place.id,
          distance: summary.distance,  // meters — actual routed walking distance
          duration: summary.duration    // seconds — ORS-calculated walking time
        };
      });
  }

  function fetchRoutes() {
    if (userLat == null || routingInFlight) return;
    if (ORS_API_KEY === 'PASTE_YOUR_KEY_HERE') {
      console.warn('[Paris] No API key — get a free one at openrouteservice.org');
      showRoutingStatus('API key needed — see console');
      return;
    }

    var visible = getFilteredPlaces();
    if (visible.length === 0) return;

    routingInFlight = true;
    showRoutingStatus('Updating walking times…');
    console.log('[Paris] Fetching routes for ' + visible.length + ' places via ORS Directions…');

    var now = Date.now();
    var ok = 0;
    var fail = 0;
    var batchIndex = 0;

    function processBatch() {
      if (batchIndex >= visible.length) {
        // Done
        lastRoutingPos = { lat: userLat, lng: userLng };
        routingInFlight = false;
        if (fail > 0 && ok === 0) {
          showRoutingStatus('Could not fetch walking times — will retry');
        } else if (fail > 0) {
          showRoutingStatus('Updated ' + ok + ' of ' + (ok + fail) + ' places');
          setTimeout(function() { showRoutingStatus(''); }, 4000);
        } else {
          showRoutingStatus('');
          console.log('[Paris] ✓ All ' + ok + ' routes updated');
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
            console.log('[Paris] ' + p.name + ': ' + Math.round(result.distance) + 'm, ~' + Math.round(result.duration / 60) + ' min');
          })
          .catch(function(err) {
            fail++;
            console.warn('[Paris] Failed ' + p.name + ':', err.message);
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
    if (!msg) { elRoutingStatus.classList.add('hidden'); return; }
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
      if (activeFilters.has(cat)) { activeFilters.delete(cat); chip.classList.remove('active'); }
      else { activeFilters.add(cat); chip.classList.add('active'); }
      render();
      if (locationGranted && userLat != null) fetchRoutes();
    });

    elSearch.addEventListener('input', function() {
      searchQuery = elSearch.value.trim();
      elSearchClear.classList.toggle('visible', searchQuery.length > 0);
      render();
    });
    elSearchClear.addEventListener('click', function() {
      elSearch.value = ''; searchQuery = ''; elSearchClear.classList.remove('visible'); render();
    });

    $('#sort-btn').addEventListener('click', function(e) {
      e.stopPropagation(); elSortDropdown.classList.toggle('hidden');
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
          if (userLat != null) { mapFollowUser = true; map.setView([userLat, userLng], 14, { animate: true }); }
        } else {
          elMapView.classList.add('hidden');
          elListView.classList.remove('hidden');
          elMapDetail.classList.add('hidden');
        }
      });
    });

    $('#location-btn').addEventListener('click', function() {
      if (locationGranted && userLat != null) {
        if (currentView === 'map' && map) { mapFollowUser = true; map.setView([userLat, userLng], 15, { animate: true }); }
      } else { startLocation(); }
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
      }
    });

    var clearBtn = $('#clear-filters-btn');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      activeFilters.clear(); searchQuery = ''; elSearch.value = '';
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
      if (idx >= 0 && placeMarkers[idx]) showMapPopup(place, placeMarkers[idx]);
    }, 150);
  }

  // ════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════

  function getGoogleMapsUrl(place) {
    if (userLat != null) {
      return 'https://www.google.com/maps/dir/?api=1&origin=' + userLat + ',' + userLng +
        '&destination=' + encodeURIComponent(place.google_maps_query || place.name + ', Paris') + '&travelmode=walking';
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
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
