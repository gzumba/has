/**
 * Top Locations Card for Home Assistant
 * 
 * Shows the locations/zones where you've spent the most time over a chosen period.
 * 
 * INSTALLATION:
 *   1. Copy this file to /config/www/top-locations-card.js
 *   2. In HA Settings → Dashboards → Resources, add:
 *        URL: /local/top-locations-card.js
 *        Type: JavaScript Module
 *   3. Add the card to your dashboard (see YAML config below).
 *
 * REQUIREMENTS:
 *   - `recorder` integration enabled (default in HA)
 *   - One or more `device_tracker` or `person` entities that pass through zones
 *   - Zones defined in HA (home, work, etc.) or use GPS-based tracker zones
 *
 * YAML CONFIG EXAMPLE:
 *   type: custom:top-locations-card
 *   title: Top Locations
 *   entity: person.john          # or device_tracker.phone
 *   days: 7                      # 7 | 30 | 90 | 365
 *   max_locations: 6             # how many rows to show (default 5)
 *   show_visits: true            # show visit count alongside hours
 *   zones:                       # optional: override zone display names/icons
 *     home:
 *       name: Home
 *       icon: mdi:home
 *     work:
 *       name: Office
 *       icon: mdi:briefcase
 */

const CARD_VERSION = "1.1.0";

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function periodLabel(days) {
  if (days <= 7) return "This week";
  if (days <= 30) return "This month";
  if (days <= 90) return "Last 3 months";
  return "This year";
}

// MDI icons mapped to common zone names (fallback chain: config → name match → default)
const ZONE_ICON_MAP = {
  home: "mdi:home",
  work: "mdi:briefcase",
  office: "mdi:briefcase",
  gym: "mdi:dumbbell",
  school: "mdi:school",
  university: "mdi:school",
  cafe: "mdi:coffee",
  coffee: "mdi:coffee",
  shop: "mdi:shopping",
  store: "mdi:shopping",
  supermarket: "mdi:cart",
  park: "mdi:tree",
  hospital: "mdi:hospital-box",
  church: "mdi:church",
  airport: "mdi:airplane",
  station: "mdi:train",
  restaurant: "mdi:silverware-fork-knife",
};

function guessIcon(zoneName) {
  const lower = (zoneName || "").toLowerCase();
  for (const [key, icon] of Object.entries(ZONE_ICON_MAP)) {
    if (lower.includes(key)) return icon;
  }
  return "mdi:map-marker";
}

const BAR_COLORS = [
  "#1D9E75", "#378ADD", "#BA7517", "#D85A30",
  "#639922", "#7F77DD", "#D4537E", "#888780",
];

// ─── History API ─────────────────────────────────────────────────────────────

async function fetchZoneDurations(hass, entityId, days) {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();

  // Fetch history for the entity over the period
  const url = `history/period/${startIso}?filter_entity_id=${entityId}&end_time=${now.toISOString()}&minimal_response=true&no_attributes=true`;

  let history;
  try {
    history = await hass.callApi("GET", url);
  } catch (e) {
    console.error("[top-locations-card] History API error:", e);
    return null;
  }

  if (!history || !history[0] || history[0].length === 0) return [];

  const states = history[0];
  const durations = {}; // zone_name → minutes
  const visits = {};    // zone_name → count

  for (let i = 0; i < states.length - 1; i++) {
    const state = states[i].state;
    if (!state || state === "unavailable" || state === "unknown" || state === "not_home") continue;

    const from = new Date(states[i].last_changed || states[i].lu * 1000);
    const to = new Date(states[i + 1].last_changed || states[i + 1].lu * 1000);
    const mins = (to - from) / 60000;

    if (mins <= 0) continue;

    durations[state] = (durations[state] || 0) + mins;
    // Count a new visit only if prev state was different
    if (i === 0 || states[i - 1].state !== state) {
      visits[state] = (visits[state] || 0) + 1;
    }
  }

  // Handle the last state up to now
  const last = states[states.length - 1];
  const lastState = last.state;
  if (lastState && lastState !== "unavailable" && lastState !== "unknown" && lastState !== "not_home") {
    const from = new Date(last.last_changed || last.lu * 1000);
    const mins = (now - from) / 60000;
    if (mins > 0) {
      durations[lastState] = (durations[lastState] || 0) + mins;
    }
  }

  return Object.entries(durations)
    .map(([zone, minutes]) => ({ zone, minutes, visits: visits[zone] || 1 }))
    .sort((a, b) => b.minutes - a.minutes);
}

// ─── Card Definition ─────────────────────────────────────────────────────────

class TopLocationsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._data = null;
    this._loading = false;
    this._error = null;
    this._currentDays = 7;
  }

  static getConfigElement() {
    return document.createElement("top-locations-card-editor");
  }

  static getStubConfig() {
    return { entity: "person.your_name", days: 7, max_locations: 5 };
  }

  setConfig(config) {
    if (!config.entity) throw new Error("top-locations-card: 'entity' is required.");
    this._config = {
      title: "Top locations",
      days: 7,
      max_locations: 5,
      show_visits: true,
      zones: {},
      ...config,
    };
    this._currentDays = Number(this._config.days) || 7;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._data && !this._loading) {
      this._loadData();
    }
  }

  async _loadData() {
    if (!this._hass || !this._config.entity) return;
    this._loading = true;
    this._error = null;
    this._render();

    const data = await fetchZoneDurations(this._hass, this._config.entity, this._currentDays);
    this._loading = false;

    if (data === null) {
      this._error = "Could not load history. Check entity ID and recorder.";
    } else {
      this._data = data;
    }
    this._render();
  }

  _getZoneDisplay(zoneName) {
    const overrides = this._config.zones || {};
    const override = overrides[zoneName] || overrides[zoneName.toLowerCase()] || {};

    // Look up the zone.* entity in HA — this carries whatever icon + name the user set in the UI
    const zoneEntity = this._hass?.states?.[`zone.${zoneName}`];
    const haName = zoneEntity?.attributes?.friendly_name;
    // HA stores the icon on the entity attributes when set via the Zones UI
    const haIcon = zoneEntity?.attributes?.icon;

    // Priority: YAML config override → HA zone entity icon → keyword guess
    const icon = override.icon || haIcon || guessIcon(zoneName);
    const name = override.name || haName || zoneName.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    return { name, icon };
  }

  _onPeriodChange(days) {
    this._currentDays = days;
    this._data = null;
    this._loadData();
  }

  _render() {
    const cfg = this._config;
    const maxRows = Number(cfg.max_locations) || 5;
    const rows = (this._data || []).slice(0, maxRows);
    const maxMinutes = rows[0]?.minutes || 1;
    const totalMinutes = (this._data || []).reduce((s, r) => s + r.minutes, 0);

    const PERIODS = [
      { label: "Week", days: 7 },
      { label: "Month", days: 30 },
      { label: "3 months", days: 90 },
      { label: "Year", days: 365 },
    ];

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --c-accent: #1D9E75;
          --c-accent-bg: rgba(29,158,117,0.1);
          display: block;
        }
        ha-card {
          padding: 0;
          overflow: hidden;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px 10px;
          border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.08));
        }
        .title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .icon-wrap {
          width: 30px;
          height: 30px;
          background: var(--c-accent-bg);
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--c-accent);
        }
        .icon-wrap ha-icon {
          --mdc-icon-size: 18px;
        }
        .title {
          font-size: 14px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .period-tabs {
          display: flex;
          gap: 2px;
          background: var(--secondary-background-color, rgba(0,0,0,0.04));
          border-radius: 8px;
          padding: 2px;
        }
        .period-tab {
          font-size: 11px;
          padding: 3px 8px;
          border-radius: 6px;
          border: none;
          background: transparent;
          color: var(--secondary-text-color);
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s, color 0.15s;
        }
        .period-tab.active {
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          font-weight: 500;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .body {
          padding: 8px 16px 12px;
        }
        .loading, .error, .empty {
          padding: 24px 16px;
          text-align: center;
          font-size: 13px;
          color: var(--secondary-text-color);
        }
        .error { color: var(--error-color, #c62828); }
        .location-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 9px 0;
          border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.06));
        }
        .location-row:last-child { border-bottom: none; }
        .rank {
          font-size: 11px;
          color: var(--secondary-text-color);
          width: 14px;
          text-align: right;
          flex-shrink: 0;
        }
        .loc-icon {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .loc-icon ha-icon {
          --mdc-icon-size: 18px;
        }
        .loc-info {
          flex: 1;
          min-width: 0;
        }
        .loc-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .loc-sub {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-top: 1px;
        }
        .bar-col {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
          flex-shrink: 0;
          min-width: 64px;
        }
        .bar-time {
          font-size: 12px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .bar-bg {
          width: 64px;
          height: 4px;
          background: var(--secondary-background-color, rgba(0,0,0,0.06));
          border-radius: 99px;
          overflow: hidden;
        }
        .bar-fill {
          height: 100%;
          border-radius: 99px;
        }
        .footer {
          padding: 8px 16px;
          border-top: 1px solid var(--divider-color, rgba(0,0,0,0.08));
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .footer-label {
          font-size: 11px;
          color: var(--secondary-text-color);
        }
        .footer-val { font-weight: 500; color: var(--primary-text-color); }
        .spinner {
          display: inline-block;
          width: 18px;
          height: 18px;
          border: 2px solid var(--divider-color, #ddd);
          border-top-color: var(--c-accent);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin: 0 auto;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>

      <ha-card>
        <div class="header">
          <div class="title-row">
            <div class="icon-wrap">
              <ha-icon icon="mdi:map-marker-multiple"></ha-icon>
            </div>
            <span class="title">${cfg.title}</span>
          </div>
          <div class="period-tabs" role="tablist">
            ${PERIODS.map(p => `
              <button class="period-tab ${p.days === this._currentDays ? "active" : ""}"
                data-days="${p.days}"
                role="tab"
                aria-selected="${p.days === this._currentDays}"
                aria-label="${p.label}">${p.label}</button>
            `).join("")}
          </div>
        </div>

        <div class="body">
          ${this._loading ? `<div class="loading"><div class="spinner"></div><br>Loading history…</div>` :
            this._error ? `<div class="error">${this._error}</div>` :
            rows.length === 0 ? `<div class="empty">No location data found for this period.</div>` :
            rows.map((row, i) => {
              const { name, icon } = this._getZoneDisplay(row.zone);
              const pct = Math.round((row.minutes / maxMinutes) * 100);
              const color = BAR_COLORS[i % BAR_COLORS.length];
              const iconBg = color + "1a"; // 10% opacity
              const sub = cfg.show_visits
                ? `${row.visits} visit${row.visits !== 1 ? "s" : ""}`
                : "";
              return `
                <div class="location-row">
                  <span class="rank">${i + 1}</span>
                  <div class="loc-icon" style="background:${iconBg};color:${color}">
                    <ha-icon icon="${icon}"></ha-icon>
                  </div>
                  <div class="loc-info">
                    <div class="loc-name">${name}</div>
                    ${sub ? `<div class="loc-sub">${sub}</div>` : ""}
                  </div>
                  <div class="bar-col">
                    <span class="bar-time">${formatDuration(row.minutes)}</span>
                    <div class="bar-bg">
                      <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
                    </div>
                  </div>
                </div>`;
            }).join("")
          }
        </div>

        <div class="footer">
          <span class="footer-label">
            Total tracked: <span class="footer-val">${this._loading || !this._data ? "—" : formatDuration(totalMinutes)}</span>
          </span>
          <span class="footer-label">${periodLabel(this._currentDays)}</span>
        </div>
      </ha-card>
    `;

    // Attach period tab listeners after render
    this.shadowRoot.querySelectorAll(".period-tab").forEach(btn => {
      btn.addEventListener("click", () => this._onPeriodChange(Number(btn.dataset.days)));
    });
  }

  getCardSize() {
    return Math.ceil((this._config.max_locations || 5) * 0.8) + 2;
  }
}

customElements.define("top-locations-card", TopLocationsCard);

// ─── Card Editor (optional visual config UI) ──────────────────────────────────

class TopLocationsCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; }
  set hass(hass) { this._hass = hass; this._render(); }

  _render() {
    if (!this._hass) return;

    const entities = Object.keys(this._hass.states)
      .filter(e => e.startsWith("person.") || e.startsWith("device_tracker."))
      .sort();

    this.innerHTML = `
      <style>
        .editor { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        label { font-size: 13px; color: var(--secondary-text-color); }
        select, input { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font-family: inherit; font-size: 13px; margin-top: 4px; }
      </style>
      <div class="editor">
        <div>
          <label>Entity (person or device_tracker)
            <select id="entity">
              ${entities.map(e => `<option value="${e}" ${e === this._config?.entity ? "selected" : ""}>${e}</option>`).join("")}
            </select>
          </label>
        </div>
        <div>
          <label>Default period (days)
            <select id="days">
              ${[7, 30, 90, 365].map(d => `<option value="${d}" ${d == this._config?.days ? "selected" : ""}>${d}</option>`).join("")}
            </select>
          </label>
        </div>
        <div>
          <label>Max locations to show
            <input type="number" id="max_locations" min="1" max="10" value="${this._config?.max_locations ?? 5}" />
          </label>
        </div>
      </div>
    `;

    ["entity", "days", "max_locations"].forEach(id => {
      this.querySelector(`#${id}`)?.addEventListener("change", e => {
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: { ...this._config, [id]: id === "entity" ? e.target.value : Number(e.target.value) } },
          bubbles: true, composed: true,
        }));
      });
    });
  }
}

customElements.define("top-locations-card-editor", TopLocationsCardEditor);

// Register card in HA's card picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "top-locations-card",
  name: "Top Locations",
  description: "Shows the zones/locations where you've spent the most time.",
  preview: false,
});

console.info(`%c TOP-LOCATIONS-CARD %c v${CARD_VERSION} `, "background:#1D9E75;color:#fff;font-weight:700;padding:2px 4px;border-radius:4px 0 0 4px", "background:#444;color:#fff;padding:2px 4px;border-radius:0 4px 4px 0");
