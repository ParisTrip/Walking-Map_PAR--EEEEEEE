/* ════════════════════════════════════════════════
   Paris Trip Companion — app.js v4.0
   Uses OSRM car profile for reliable street distances,
   calculates walking time at family pace.
   No API key needed.
   ════════════════════════════════════════════════ */

(function () {
  'use strict';

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

  // OSRM car profile gives accurate street distances.
  // Walking time = distance / walking speed.
  // 4.0 km/h = 1.11 m/s — comfortable family pace matching Google Maps.
  var OSRM_ROUTE = 'https://router.project-osrm.org/route/v1/driving';
  var WALK_SPEED_MS = 1.11;
  var ROUTING_MOVE_THRESHOLD = 80;
  var ROUTING_INTERVAL = 60000;
  var ROUTING_STALE_MS = 180000;
  var BATCH_SIZE = 5;
  var BATCH_DELAY_MS = 500;

  var $ = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return document.querySelectorAll(sel); };

  var elList, elEmpty, elCount, elSearch, elSearchClear, elFiltersTrack;
  var elSortDropdown, elLocationPrompt, elRoutingStatus;
  var elMapView, elListView, elMapDetail, elMapDetailContent;

  function init() {
    console.log('[Paris v4.0] Initializing — OSRM driving distances + walking pace');
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

    showSkeletons();
    fetch('approved_places.json?v=40')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        places = data;
        console.log('[Paris] Loaded ' + places.length + ' places');
        buildFilters(); measureHeader(); render(); bindEvents(); checkLocationPermission();
      })
      .catch(function() {
        elList.innerHTML = '<p style="padding:20px;color:#A89F94;">Could not load places data.</p>';
      });
  }

  function checkLocationPermission() {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then(function(p) { if (p.state === 'granted') startLocation(); else showLocationPrompt(); })
        .catch(function() { showLocationPrompt(); });
    } else { showLocationPrompt(); }
  }

  function showSkeletons() {
    var h = '';
    for (var i = 0; i < 6; i++) h += '<div class="skeleton-card"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    elList.innerHTML = h;
  }

  function measureHeader() {
    headerHeight = $('#app-header').offsetHeight;
    document.documentElement.style.setProperty('--header-h', headerHeight + 'px');
  }

  function buildFilters() {
    var cc = {};
    places.forEach(function(p) { (p.category_tags||[]).forEach(function(c) { cc[c]=(cc[c]||0)+1; }); });
    var h = '';
    Object.keys(CATEGORY_META).forEach(function(k) {
      if (!cc[k]) return;
      h += '<button class="filter-chip" data-cat="'+k+'">'+CATEGORY_META[k].icon+' '+CATEGORY_META[k].label+' <span class="chip-count">'+cc[k]+'</span></button>';
    });
    Object.keys(cc).forEach(function(k) {
      if (CATEGORY_META[k]) return;
      var l = k.replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
      h += '<button class="filter-chip" data-cat="'+k+'">'+l+' <span class="chip-count">'+cc[k]+'</span></button>';
    });
    elFiltersTrack.innerHTML = h;
  }

  function getFilteredPlaces() {
    var list = places;
    if (activeFilters.size > 0) list = list.filter(function(p) { return (p.category_tags||[]).some(function(t){return activeFilters.has(t);}); });
    if (searchQuery) { var q = searchQuery.toLowerCase(); list = list.filter(function(p) { return [p.name,p.normalized_name,p.short_description,p.more_notes].concat(p.category_tags||[]).join(' ').toLowerCase().indexOf(q)!==-1; }); }
    list = list.slice();
    if (currentSort==='walking-time') list.sort(function(a,b){ return (routingCache[a.id]?routingCache[a.id].duration:Infinity)-(routingCache[b.id]?routingCache[b.id].duration:Infinity); });
    else if (currentSort==='walking-distance') list.sort(function(a,b){ return (routingCache[a.id]?routingCache[a.id].distance:Infinity)-(routingCache[b.id]?routingCache[b.id].distance:Infinity); });
    else if (currentSort==='name') list.sort(function(a,b){ return a.name.localeCompare(b.name); });
    return list;
  }

  function render() {
    var f = getFilteredPlaces();
    if (f.length===0) { elList.innerHTML=''; elEmpty.classList.remove('hidden'); elCount.textContent=''; }
    else { elEmpty.classList.add('hidden'); elCount.textContent=f.length+' place'+(f.length!==1?'s':''); renderList(f); }
    if (mapReady) renderMapMarkers(f);
  }

  function renderList(list) {
    var now=Date.now(), h='';
    list.forEach(function(p) {
      var rc=routingCache[p.id], has=rc&&rc.duration!=null;
      var stale=has&&(now-rc.timestamp>ROUTING_STALE_MS);
      var ts=has?'~'+fmtDur(rc.duration):'', ds=has?fmtDist(rc.distance):'';
      var ss=stale?'<span class="stale-indicator">updated '+fmtAgo(rc.timestamp)+'</span>':'';
      var gu=gmapsUrl(p);
      var tags=(p.category_tags||[]).map(function(t){var m=CATEGORY_META[t];return '<span class="card-tag">'+(m?m.label:t.replace(/-/g,' '))+'</span>';}).join('');
      h+='<div class="place-card" data-id="'+p.id+'"><div class="card-header"><div class="card-name">'+esc(p.name)+'</div>'+
        (has||locationGranted?'<div class="card-distance">'+(has?'<div class="card-time">'+ts+'</div><div class="card-meters">'+ds+'</div>'+ss:'<div class="card-meters" style="color:var(--text-muted)">Calculating…</div>')+'</div>':'')+
        '</div><div class="card-tags">'+tags+'</div><div class="card-desc">'+esc(p.short_description)+'</div>'+
        (p.more_notes?'<button class="card-more-toggle" data-target="notes-'+p.id+'">More details ▾</button><div class="card-more-notes" id="notes-'+p.id+'">'+esc(p.more_notes)+'</div>':'')+
        '<div class="card-actions"><button class="card-btn card-btn-map" data-action="show-map" data-id="'+p.id+'"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/></svg> Map</button>'+
        '<a class="card-btn card-btn-nav" href="'+gu+'" target="_blank" rel="noopener"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg> Directions</a></div></div>';
    });
    elList.innerHTML=h;
  }

  // ── MAP ──
  function initMap() {
    if (map) return;
    map=L.map('map',{center:[48.8566,2.3522],zoom:13,zoomControl:false,attributionControl:false});
    L.control.zoom({position:'topright'}).addTo(map);
    L.control.attribution({position:'bottomright',prefix:false}).addAttribution('&copy; <a href="https://openstreetmap.org">OSM</a>').addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{maxZoom:19,subdomains:'abcd'}).addTo(map);
    map.on('movestart',function(){mapFollowUser=false;});
    mapReady=true;
    if (userLat!=null) addUserMarker();
    renderMapMarkers(getFilteredPlaces());
    setTimeout(function(){map.invalidateSize();},200);
  }
  function addUserMarker() {
    if (!map||userLat==null) return;
    if (userPulse) map.removeLayer(userPulse);
    if (userMarker) map.removeLayer(userMarker);
    userPulse=L.marker([userLat,userLng],{icon:L.divIcon({className:'',html:'<div class="user-marker-pulse"></div>',iconSize:[40,40],iconAnchor:[20,20]}),interactive:false,zIndexOffset:500}).addTo(map);
    userMarker=L.marker([userLat,userLng],{icon:L.divIcon({className:'',html:'<div class="user-marker"></div>',iconSize:[16,16],iconAnchor:[8,8]}),interactive:false,zIndexOffset:600}).addTo(map);
  }
  function updateUserMarker() {
    if (!map||userLat==null) return;
    if (userMarker) userMarker.setLatLng([userLat,userLng]);
    if (userPulse) userPulse.setLatLng([userLat,userLng]);
    if (mapFollowUser&&currentView==='map') map.panTo([userLat,userLng],{animate:true,duration:0.5});
  }
  function renderMapMarkers(list) {
    if (!map) return;
    placeMarkers.forEach(function(m){map.removeLayer(m);}); placeMarkers=[];
    list.forEach(function(p) {
      var ci='📍'; (p.category_tags||[]).some(function(t){if(CATEGORY_META[t]){ci=CATEGORY_META[t].icon;return true;}return false;});
      var mk=L.marker([p.latitude,p.longitude],{icon:L.divIcon({className:'',html:'<div class="custom-marker"><span class="custom-marker-inner">'+ci+'</span></div>',iconSize:[32,32],iconAnchor:[16,32],popupAnchor:[0,-34]})}).addTo(map);
      mk.on('click',function(){showMapPopup(p,mk);}); placeMarkers.push(mk);
    });
  }
  function showMapPopup(p,marker) {
    var rc=routingCache[p.id],has=rc&&rc.duration!=null,gu=gmapsUrl(p);
    var tags=(p.category_tags||[]).map(function(t){var m=CATEGORY_META[t];return '<span class="card-tag">'+(m?m.label:t)+'</span>';}).join('');
    var st=has?'<div class="popup-stats"><div class="popup-stat"><span class="popup-stat-val">~'+fmtDur(rc.duration)+'</span> walk</div><div class="popup-stat"><span class="popup-stat-val">'+fmtDist(rc.distance)+'</span></div></div>':'';
    marker.bindPopup('<div class="popup-inner"><div class="popup-name">'+esc(p.name)+'</div><div class="popup-tags">'+tags+'</div><div class="popup-desc">'+esc(p.short_description)+'</div>'+st+'<a class="popup-nav-btn" href="'+gu+'" target="_blank" rel="noopener"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg> Open in Google Maps</a></div>',{maxWidth:280,closeButton:true}).openPopup();
  }

  // ── GEOLOCATION ──
  function showLocationPrompt() { if (locationGranted) return; elLocationPrompt.classList.remove('hidden'); }
  function startLocation() {
    if (!navigator.geolocation) { elLocationPrompt.innerHTML='<p>Geolocation not supported. You can still browse!</p>'; elLocationPrompt.classList.remove('hidden'); return; }
    elLocationPrompt.classList.add('hidden'); $('#location-btn').classList.add('active');
    locationWatchId=navigator.geolocation.watchPosition(onLocUpdate,onLocError,{enableHighAccuracy:true,maximumAge:10000,timeout:15000});
    locationGranted=true;
  }
  function onLocUpdate(pos) {
    var nLat=pos.coords.latitude,nLng=pos.coords.longitude;
    var moved=userLat==null||haversine(userLat,userLng,nLat,nLng)>ROUTING_MOVE_THRESHOLD;
    userLat=nLat; userLng=nLng;
    console.log('[Paris] Location: '+userLat.toFixed(5)+', '+userLng.toFixed(5));
    if (mapReady){addUserMarker();updateUserMarker();}
    if (moved) fetchRoutes();
    if (!routingTimer) routingTimer=setInterval(function(){if(locationGranted&&userLat!=null)fetchRoutes();},ROUTING_INTERVAL);
  }
  function onLocError(err) {
    console.warn('[Paris] Location error:',err.message);
    if (err.code===1) { elLocationPrompt.innerHTML='<p>Location denied. You can still browse! Tap location to retry.</p>'; elLocationPrompt.classList.remove('hidden'); $('#location-btn').classList.remove('active'); locationGranted=false; }
  }

  // ── OSRM ROUTING (car profile for reliable distances) ──
  function fetchOneRoute(place) {
    var url=OSRM_ROUTE+'/'+userLng+','+userLat+';'+place.longitude+','+place.latitude+'?overview=false&alternatives=false';
    return fetch(url).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(data){
      if(data.code!=='Ok'||!data.routes||!data.routes.length) throw new Error('No route');
      var d=data.routes[0].distance; // meters via streets
      return {id:place.id, distance:d, duration:d/WALK_SPEED_MS};
    });
  }

  function fetchRoutes() {
    if (userLat==null||routingInFlight) return;
    var visible=getFilteredPlaces();
    if (!visible.length) return;
    routingInFlight=true;
    showRoutingStatus('Updating walking times…');
    console.log('[Paris] Fetching routes for '+visible.length+' places via OSRM driving…');
    var now=Date.now(),ok=0,fail=0,bi=0;

    function batch() {
      if (bi>=visible.length) {
        lastRoutingPos={lat:userLat,lng:userLng}; routingInFlight=false;
        if(fail>0&&ok===0) showRoutingStatus('Could not fetch — will retry');
        else if(fail>0){showRoutingStatus('Updated '+ok+' of '+(ok+fail)); setTimeout(function(){showRoutingStatus('');},4000);}
        else{showRoutingStatus(''); console.log('[Paris] ✓ All '+ok+' routes updated');}
        render(); return;
      }
      var b=visible.slice(bi,bi+BATCH_SIZE); bi+=BATCH_SIZE;
      Promise.all(b.map(function(p){
        return fetchOneRoute(p).then(function(r){
          routingCache[r.id]={distance:r.distance,duration:r.duration,timestamp:now};
          ok++;
          console.log('[Paris] '+p.name+': '+Math.round(r.distance)+'m, ~'+Math.round(r.duration/60)+' min');
        }).catch(function(e){fail++;console.warn('[Paris] Failed '+p.name+':',e.message);});
      })).then(function(){render();setTimeout(batch,BATCH_DELAY_MS);});
    }
    batch();
  }

  function showRoutingStatus(msg) {
    if(!msg){elRoutingStatus.classList.add('hidden');return;}
    elRoutingStatus.textContent=msg; elRoutingStatus.classList.remove('hidden');
  }

  // ── EVENTS ──
  function bindEvents() {
    elFiltersTrack.addEventListener('click',function(e){
      var c=e.target.closest('.filter-chip'); if(!c) return;
      var cat=c.dataset.cat;
      if(activeFilters.has(cat)){activeFilters.delete(cat);c.classList.remove('active');}
      else{activeFilters.add(cat);c.classList.add('active');}
      render(); if(locationGranted&&userLat!=null)fetchRoutes();
    });
    elSearch.addEventListener('input',function(){searchQuery=elSearch.value.trim();elSearchClear.classList.toggle('visible',searchQuery.length>0);render();});
    elSearchClear.addEventListener('click',function(){elSearch.value='';searchQuery='';elSearchClear.classList.remove('visible');render();});
    $('#sort-btn').addEventListener('click',function(e){e.stopPropagation();elSortDropdown.classList.toggle('hidden');});
    elSortDropdown.addEventListener('click',function(e){var o=e.target.closest('.sort-option');if(!o)return;currentSort=o.dataset.sort;$$('.sort-option').forEach(function(el){el.classList.remove('active');});o.classList.add('active');elSortDropdown.classList.add('hidden');render();});
    document.addEventListener('click',function(){elSortDropdown.classList.add('hidden');});
    $$('.view-btn').forEach(function(btn){btn.addEventListener('click',function(){
      var v=btn.dataset.view; if(v===currentView)return; currentView=v;
      $$('.view-btn').forEach(function(b){b.classList.remove('active');}); btn.classList.add('active');
      if(v==='map'){elListView.classList.add('hidden');elMapView.classList.remove('hidden');if(!mapReady)initMap();setTimeout(function(){map.invalidateSize();},100);if(userLat!=null){mapFollowUser=true;map.setView([userLat,userLng],14,{animate:true});}}
      else{elMapView.classList.add('hidden');elListView.classList.remove('hidden');elMapDetail.classList.add('hidden');}
    });});
    $('#location-btn').addEventListener('click',function(){
      if(locationGranted&&userLat!=null){if(currentView==='map'&&map){mapFollowUser=true;map.setView([userLat,userLng],15,{animate:true});}}else startLocation();
    });
    var eb=$('#enable-location-btn'); if(eb)eb.addEventListener('click',startLocation);
    elList.addEventListener('click',function(e){
      var tg=e.target.closest('.card-more-toggle');
      if(tg){var t=document.getElementById(tg.dataset.target);if(t){t.classList.toggle('open');tg.textContent=t.classList.contains('open')?'Less details ▴':'More details ▾';}return;}
      var mb=e.target.closest('[data-action="show-map"]');
      if(mb){var pl=places.find(function(p){return p.id===mb.dataset.id;});if(pl)showOnMap(pl);}
    });
    var cb=$('#clear-filters-btn'); if(cb)cb.addEventListener('click',function(){activeFilters.clear();searchQuery='';elSearch.value='';elSearchClear.classList.remove('visible');$$('.filter-chip').forEach(function(c){c.classList.remove('active');});render();});
    elMapDetail.addEventListener('click',function(e){if(e.target===elMapDetail||e.target.classList.contains('map-detail-handle')){elMapDetail.classList.remove('visible');setTimeout(function(){elMapDetail.classList.add('hidden');},300);}});
  }

  function showOnMap(place) {
    currentView='map'; $$('.view-btn').forEach(function(b){b.classList.remove('active');}); $('[data-view="map"]').classList.add('active');
    elListView.classList.add('hidden'); elMapView.classList.remove('hidden');
    if(!mapReady)initMap();
    setTimeout(function(){map.invalidateSize();mapFollowUser=false;map.setView([place.latitude,place.longitude],16,{animate:true});
      var fl=getFilteredPlaces(),idx=-1;for(var i=0;i<fl.length;i++){if(fl[i].id===place.id){idx=i;break;}}
      if(idx>=0&&placeMarkers[idx])showMapPopup(place,placeMarkers[idx]);
    },150);
  }

  // ── HELPERS ──
  function gmapsUrl(p) {
    if(userLat!=null) return 'https://www.google.com/maps/dir/?api=1&origin='+userLat+','+userLng+'&destination='+encodeURIComponent(p.google_maps_query||p.name+', Paris')+'&travelmode=walking';
    return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(p.google_maps_query||p.name+', Paris');
  }
  function fmtDur(s){if(s==null)return'—';var m=Math.round(s/60);if(m<1)return'1 min';if(m<60)return m+' min';var h=Math.floor(m/60),r=m%60;return r>0?h+'h '+r+'m':h+'h';}
  function fmtDist(m){if(m==null)return'—';if(m<1000)return Math.round(m)+' m';return(m/1000).toFixed(1)+' km';}
  function fmtAgo(ts){var d=Math.round((Date.now()-ts)/60000);return d<1?'just now':d+'m ago';}
  function haversine(lat1,lon1,lat2,lon2){var R=6371000,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
  function esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=s;return d.innerHTML;}

  document.addEventListener('DOMContentLoaded',init);
})();
