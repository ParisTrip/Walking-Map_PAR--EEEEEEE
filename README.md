# Paris Trip Companion

A mobile-first, static travel web app for exploring Paris on foot. Designed for two older adults and two children — it shows live walking times and distances to curated destinations, sorted by what's nearest.

## Architecture

```
paris-app/
├── index.html              ← Main app (single page)
├── styles.css              ← Mobile-first styles
├── app.js                  ← All application logic
├── approved_places.json    ← Curated place data (drives the app)
├── review_places.json      ← Items needing human review
└── README.md               ← This file
```

### Design Decisions

- **List-first, map-second**: The primary screen is a distance-sorted list. The map is one tap away.
- **Data-driven**: All content lives in `approved_places.json`. Add/edit/remove places there — the UI adapts automatically. Categories are discovered from the data, so adding a new category tag in the JSON automatically creates a new filter chip.
- **No hotel marker**: The user's live location dot is shown, but no hotel or lodging is pinned.
- **Walking-first**: All times and distances use route-based walking calculations (not straight-line). Google Maps handoff defaults to walking directions.
- **No paid services**: Uses OSRM public API (free, no key), OpenStreetMap tiles via Carto (free), and Leaflet (open source).

## UI Structure

### Header
- App title
- Location button (enable/re-center)
- Sort button (walking time / walking distance / name)
- Search bar (filters places by name, description, notes, and categories)
- Horizontally scrollable category filter chips

### List View (default)
Each card shows:
- Place name
- Category tags
- Walking time + walking distance (live)
- One-line description
- Expandable "More details" section with notes
- "Map" button → shows place on map
- "Directions" button → opens Google Maps for walking directions

### Map View
- OpenStreetMap tiles (Carto light theme)
- User location with blue dot + pulse animation
- Category-icon markers for each filtered place
- Tap marker → popup with details + Google Maps link
- Auto-follows user unless manually panned

### View Toggle
Floating pill at bottom of screen toggles between List and Map.

## How Walking Times Work

### Routing Provider
The app uses the **OSRM (Open Source Routing Machine) public demo server** for walking directions:
- Endpoint: `https://router.project-osrm.org/table/v1/foot/`
- **Table API**: Sends one request with the user's position + all visible destinations. OSRM returns a matrix of walking durations and distances in a single response.
- No API key required. Free for personal/light use.

### Refresh Strategy
Walking times are refreshed when:
1. **First location fix**: Immediately after geolocation permission is granted
2. **Meaningful movement**: When the user moves more than 80 meters from the last routing position
3. **Periodic refresh**: Every 45 seconds while the app is active
4. **Filter change**: When category filters change (since the set of visible destinations changes)

### Graceful Degradation
- If a routing request fails, the app shows the most recent cached times with a subtle "last updated" indicator
- If location is denied, the app still works as a browseable guide with categories, search, and map browsing
- Times show "Calculating…" during the initial fetch

## Free Static Hosting (GitHub Pages)

### Setup Steps

1. **Create a GitHub repository**
   ```bash
   # Initialize and push
   cd paris-app
   git init
   git add .
   git commit -m "Initial Paris trip app"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/paris-trip.git
   git push -u origin main
   ```

2. **Enable GitHub Pages**
   - Go to your repo → Settings → Pages
   - Source: "Deploy from a branch"
   - Branch: `main`, folder: `/ (root)`
   - Click Save

3. **Access your site**
   - URL will be: `https://YOUR_USERNAME.github.io/paris-trip/`
   - GitHub Pages serves over HTTPS by default (required for geolocation)
   - May take 1-2 minutes for first deploy

### Alternative: Netlify Drop
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the entire `paris-app` folder onto the page
3. Your site is live instantly with HTTPS

### Alternative: Cloudflare Pages
1. Connect your GitHub repo at [pages.cloudflare.com](https://pages.cloudflare.com)
2. No build command needed — it's static files

## Editing the Data

### Adding a place
Add an entry to `approved_places.json`:
```json
{
  "id": "my-new-place",
  "name": "My New Place",
  "normalized_name": "my new place",
  "category_tags": ["cafes", "family"],
  "short_description": "Short one-liner.",
  "more_notes": "Longer notes and tips.",
  "address_or_search_text": "Full address, Paris",
  "latitude": 48.XXXX,
  "longitude": 2.XXXX,
  "source_notes": "Who recommended it",
  "google_maps_query": "My+New+Place,+Paris",
  "status": "approved"
}
```

### Adding a new category
Just use a new tag string in `category_tags`. The filter chip will auto-generate. To customize the label and icon, add it to `CATEGORY_META` in `app.js`:
```javascript
'day-trip': { label: 'Day Trip', icon: '🚂' },
```

### Removing a place
Delete its entry from `approved_places.json`.

## Review Bucket

`review_places.json` contains 4 items that need your decision:

| Place | Reason | Suggested Action |
|-------|--------|-----------------|
| Hippopotamus Restaurants | Flagged as chain/touristy in spreadsheet | Remove unless wanted as backup |
| Paul (Bakery Chain) | Ubiquitous chain; recommender says any bakery is as good | Add as a general tip, not a pin |
| Palace of Versailles | 20 km outside Paris; doesn't fit walking app | Add with "Day Trip" tag or exclude |
| Musée des Arts Forains | Limited hours (Wed/weekends), needs advance booking | Approve if trip dates align |

## Assumptions

1. **OSRM demo server** is suitable for a personal trip app with ~40 destinations. For heavier use, self-hosting OSRM or using OpenRouteService (free tier, requires API key) would be more reliable.
2. **Coordinates** are best-effort from known addresses. Most are highly accurate for central Paris landmarks. A few smaller/newer establishments (Ostra Paris, MONBLEU, The French Bastards) may need GPS confirmation — they're close but worth double-checking on Google Maps.
3. **Google Maps deep links** use the `maps/dir/` format which works well on iPhone — opens the Google Maps app if installed, falls back to browser.
4. **Eiffel Tower light show times** should be verified closer to the trip date, as schedules can change seasonally.
5. **The app works offline for browsing** (if cached by the browser), but routing and map tiles require an internet connection.

## Tech Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| Map tiles | Carto / OpenStreetMap | Free |
| Map library | Leaflet 1.9.4 | Free / open source |
| Walking routing | OSRM public API (foot profile) | Free |
| Fonts | Google Fonts (Cormorant Garamond + DM Sans) | Free |
| Hosting | GitHub Pages / Netlify / Cloudflare Pages | Free |
| Navigation | Google Maps deep links | Free |
