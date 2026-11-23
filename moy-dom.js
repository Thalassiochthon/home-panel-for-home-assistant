const domainOf = id => id.split(".")[0];
const entityPattern = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const lightDomains = ["light", "switch"];
const detailDomains = ["fan", "humidifier"];
const extraDomains = ["camera", "alarm_control_panel", "vacuum", "media_player"];

function discover(hass) {
  const states = hass?.states ?? {};
  const rooms = new Map();
  const zones = new Map();
  const more = [];
  const alerts = [];
  for (const [id, state] of Object.entries(states)) {
    const domain = domainOf(id);
    const metadata = hass.entities?.[id];
    if (metadata?.hidden) continue;
    const name = state.attributes?.friendly_name || id;
    const kind = state.attributes?.device_class;
    if (extraDomains.includes(domain)) more.push([name, id]);
    if (domain === "binary_sensor" && ["moisture", "smoke"].includes(kind)) {
      alerts.push([id, name + " · тревога"]);
    }
    const roomField = domain === "sensor" && ["temperature", "humidity"].includes(kind) ? kind : null;
    if (domain !== "light" && domain !== "climate" && !detailDomains.includes(domain) && !roomField) continue;
    const areaId = metadata?.area_id ?? hass.devices?.[metadata?.device_id]?.area_id;
    const area = hass.areas?.[areaId];
    const floor = area?.floor_id && hass.floors?.[area.floor_id];
    const zoneKey = floor ? area.floor_id : null;
    if (!zones.has(zoneKey)) zones.set(zoneKey, {
      name: floor?.name ?? "Дом", level: floor?.level ?? Infinity, rooms: [],
    });
    const roomKey = area ? areaId : null;
    if (!rooms.has(roomKey)) {
      const room = { id: area ? "area:" + areaId : "unassigned", name: area?.name ?? "Без комнаты", lights: [], details: [] };
      rooms.set(roomKey, room);
      zones.get(zoneKey).rooms.push(room);
    }
    const room = rooms.get(roomKey);
    if (domain === "light") room.lights.push([id, name]);
    else if (domain === "climate" && !room.climate) room.climate = id;
    else if (roomField && !room[roomField]) room[roomField] = id;
    else room.details.push([id, name]);
  }
  return { zones: [...zones.values()].sort((a, b) => a.level - b.level), more, alerts };
}

function matchingEntities(hass, query) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return Object.entries(hass?.states ?? {})
    .filter(([id, state]) => {
      if (hass.entities?.[id]?.hidden) return false;
      const name = state.attributes?.friendly_name || id;
      const text = (name + " " + id).toLocaleLowerCase();
      return words.every(word => text.includes(word));
    })
    .map(([id, state]) => [id, state.attributes?.friendly_name || id])
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
}

function validate(config) {
  const ensure = (ok, path) => { if (!ok) throw new Error("Home Panel: проверьте " + path); };
  const entity = (id, domains) => typeof id === "string" && entityPattern.test(id) &&
    (!domains || domains.includes(domainOf(id)));
  const label = value => typeof value === "string" && Boolean(value.trim());
  const pairs = (list, path, predicate) => {
    if (list === undefined) return;
    ensure(Array.isArray(list) && list.every(row => Array.isArray(row) && row.length === 2 && predicate(...row)), path);
  };
  ensure(config && typeof config === "object" && !Array.isArray(config), "конфигурацию карточки");
  pairs(config.quick_lights, "quick_lights", (id, name) => entity(id, lightDomains) && label(name));
  if (config.presence !== undefined) ensure(entity(config.presence, ["binary_sensor"]), "presence");
  if (config.alarm !== undefined) ensure(entity(config.alarm, ["alarm_control_panel"]), "alarm");
  if (config.summary_rooms !== undefined) ensure(Array.isArray(config.summary_rooms) && config.summary_rooms.every(label), "summary_rooms");
  if (config.power_meter !== undefined) ensure(entity(config.power_meter, ["sensor"]), "power_meter");
  if (config.power_scope !== undefined) ensure(["home", "device"].includes(config.power_scope), "power_scope");
  pairs(config.home_scenes, "home_scenes", (id, name) => entity(id, ["scene"]) && label(name));
  pairs(config.alerts, "alerts", (id, name) => entity(id, ["binary_sensor"]) && label(name));
  pairs(config.more, "more", (name, target) => label(name) && (entity(target) ||
    (typeof target === "string" && /^\/[a-z0-9_/-]+(?:[?#][^\\\s]*)?$/i.test(target) && !target.startsWith("//"))));
  if (config.outdoor_temperature !== undefined) ensure(entity(config.outdoor_temperature, ["sensor"]), "outdoor_temperature");
  if (config.zones === undefined) return;
  ensure(Array.isArray(config.zones) && config.zones.length, "zones");
  const ids = new Set();
  config.zones.forEach((zone, index) => {
    const path = "zones[" + index + "]";
    ensure(zone && label(zone.name) && Array.isArray(zone.rooms) && zone.rooms.length, path);
    zone.rooms.forEach((room, roomIndex) => {
      const key = path + ".rooms[" + roomIndex + "]";
      ensure(room && label(room.name) && label(room.id) && !ids.has(room.id), key + " (уникальный id и имя)");
      ids.add(room.id);
      pairs(room.lights, key + ".lights", (id, name) => entity(id, lightDomains) && label(name));
      pairs(room.details, key + ".details", (id, name) => entity(id) && label(name));
      for (const field of ["temperature", "humidity", "climate", "ir"]) {
        if (room[field] !== undefined) ensure(entity(room[field], [field === "climate" || field === "ir" ? "climate" : "sensor"]), key + "." + field);
      }
    });
  });
}

const sections = [
  ["home", "Дом"],
  ["rooms", "Комнаты"],
  ["more", "Ещё"],
];

const modes = { off:"Выключен", heat:"Обогрев", cool:"Охлаждение", auto:"Авто", heat_cool:"Обогрев и охлаждение", fan_only:"Вентиляция", dry:"Осушение" };
const actions = { heating:"Запрос обогрева", cooling:"Запрос охлаждения", idle:"Ожидание", off:"Выключен", fan:"Вентиляция", drying:"Осушение" };
const presets = { none:"Обычный", sleep:"Сон", away:"Не дома", eco:"Эко", comfort:"Комфорт", home:"Дома", boost:"Быстрый нагрев", activity:"Активность" };
const themes = [["light", "Светлая"], ["dark", "Тёмная"]];
const format = new Intl.NumberFormat("ru", { maximumFractionDigits: 1 });
const available = entity => Boolean(entity && !["unknown", "unavailable"].includes(entity.state));
const numeric = value => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const valueText = (value, suffix) => numeric(value) === null ? "—" : format.format(Number(value)) + suffix;
const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Inline symbols also work in the standalone demo without the HA frontend.
const iconPaths = {
  "mdi:ceiling-light": "M12 2v6m-9 9a9 9 0 0 1 18 0z M10 20h4",
  "mdi:track-light": "M2 5h20 M5 5v4l-3 5 4 2 3-5-4-2 M15 5v4l2 6 4-2-2-6z",
  "mdi:lamp": "M7 4h10l3 10H4z M12 14v6m-5 1h10",
  home: "M2 11l10-8 10 8 M5 10v11h14V10 M9 21v-6h6v6",
  humidity: "M12 2C10 6 5 10 5 15a7 7 0 0 0 14 0c0-5-5-9-7-13z M8 15a4 4 0 0 0 4 4",
  power: "M14 2 5 14h6l-1 8 9-13h-6z",
  settings: "M3 6h6m5 0h7 M3 12h11m5 0h2 M3 18h2m5 0h11 M9 3v6m6 0v6M7 15v6",
  presence: "M2 11l10-8 10 8 M5 10v11h14V10 M9 21v-6h6v6",
  offline: "M3 3l18 18 M2 9l2-1m4-2a16 16 0 0 1 14 3 M5 13a11 11 0 0 1 3-2m5-1a12 12 0 0 1 6 3 M8 16a6 6 0 0 1 5-1 M12 20h.01",
  "mdi:weather-night": "M19.8 14.6A8.5 8.5 0 0 1 9.4 4.2 8.5 8.5 0 1 0 19.8 14.6z",
  "mdi:home-import-outline": "M3 11 12 3l9 8v9h-7 M8 11l4 4-4 4 M12 15H2",
  shield: "M12 2l8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5z",
  scene: "M7 4l13 8-13 8z",
  rooms: "M3 3h18v18H3z M3 12h7m0-9v9m5 3v6m0-9h6",
  lights: "M8.5 15c0-2-3-3.3-3-7a6.5 6.5 0 0 1 13 0c0 3.7-3 5-3 7z M9 18h6m-5 3h4",
  climate: "M9 14.5V5a3 3 0 0 1 6 0v9.5a5 5 0 1 1-6 0z M12 8v9",
  more: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  switch: "M7 8h8a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8z M13 12h2",
};

function pictogram(kind) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "pictogram");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", iconPaths[kind]);
  svg.append(path);
  return svg;
}

function button(text, handler, className) {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

class MoyDomPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.room = null;
    this.pending = new Map();
    this.failures = new Map();
    this.zone = 0;
    this.section = "home";
    this.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    this.bindings = [];
    this.zones = [];
    this.config = {};
    this.extra = [];
    this.hazards = [];
    this.entityIds = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem("moy-dom-navigation-v2") || "{}");
      if (Number.isInteger(saved.zone) && saved.zone >= 0) this.zone = saved.zone;
      if (sections.some(([id]) => id === saved.section)) this.section = saved.section;
      const theme = localStorage.getItem("moy-dom-theme");
      if (themes.some(([id]) => id === theme)) this.theme = theme;
    } catch { /* The panel also works with browser storage disabled. */ }
  }

  connectedCallback() {
    if (this.shell) return;
    const style = element("style", "", styles);
    this.shell = element("div", "shell");
    const toolbar = element("header", "toolbar");
    this.nav = element("nav", "navigation");
    this.nav.setAttribute("aria-label", "Разделы дома");
    for (const [id, name] of sections) {
      const item = button(name, () => this.select(this.zone, id));
      item.prepend(pictogram(id));
      item.dataset.section = id;
      this.nav.append(item);
    }
    const appearance = button("", () => this.showDialog("Оформление", this.appearancePicker("theme", "Режим", themes)), "settings-button");
    appearance.setAttribute("aria-label", "Настройки оформления");
    appearance.append(pictogram("settings"));
    toolbar.append(element("strong", "", "Home Panel"), this.nav, appearance);
    const body = element("div", "body");
    this.floors = element("nav", "floors");
    this.floors.setAttribute("aria-label", "Этажи и участок");

    this.connection = element("div", "notice");
    this.connection.setAttribute("role", "status");
    this.alerts = element("div", "notice warning");
    this.alerts.setAttribute("role", "status");
    this.content = element("main");
    this.dialog = element("dialog");
    this.dialog.setAttribute("aria-labelledby", "dialog-title");
    body.append(toolbar, this.connection, this.alerts, this.content);
    this.shell.append(body, this.dialog);
    this.shadowRoot.append(style, this.shell);
    this.renderSection();
  }

  disconnectedCallback() {
    for (const command of this.pending.values()) clearTimeout(command.timer);
    this.pending.clear();
  }

  set hass(value) {
    const previous = this.home;
    this.home = value;
    const registries = ["areas", "floors", "devices", "entities"];
    const states = Object.keys(value?.states || {});
    if (!previous || registries.some(key => previous[key] !== value?.[key]) ||
        states.length !== this.entityIds.size || states.some(id => !this.entityIds.has(id))) {
      this.entityIds = new Set(states);
      this.updateLayout();
    } else this.refresh();
  }

  configure(config) {
    this.config = config;
    this.updateLayout();
  }

  updateLayout() {
    const layout = discover(this.home);
    this.zones = this.config.zones ?? layout.zones;
    this.extra = this.config.more ?? layout.more;
    this.hazards = this.config.alerts ?? layout.alerts;
    this.quick = this.config.quick_lights ?? this.zones.flatMap(zone => zone.rooms)
      .find(room => room.lights?.length)?.lights.slice(0, 3) ?? [];
    if (!this.zones[this.zone]) this.zone = 0;
    if (this.room) this.room = this.zones.flatMap(zone => zone.rooms).find(room => room.id === this.room.id) ?? null;
    if (this.shell) this.renderSection();
  }

  state(id) { return id && this.home?.states?.[id]; }
  get connected() { return Boolean(this.home?.states && this.home.connected !== false && this.home.connection?.connected !== false); }

  select(zone, section) {
    if (this.zone === zone && this.section === section && !this.room) return;
    this.room = null;
    this.dialog.close();
    this.zone = zone;
    this.section = section;
    try { localStorage.setItem("moy-dom-navigation-v2", JSON.stringify({ zone, section })); } catch { /* Optional preference. */ }
    this.renderSection();
  }

  get zoneLights() {
    const entries = (this.zones[this.zone]?.rooms ?? []).flatMap(room => (room.lights ?? []).map(([id, name]) => ({ id, name: room.name + " — " + name })));
    return [...new Map(entries.map(light => [light.id, light])).values()];
  }

  renderSection() {
    this.bindings = [];
    this.content.replaceChildren();
    this.floors.replaceChildren(...this.zones.map(({ name }, index) => {
      const item = button(name, () => this.select(index, this.section));
      item.setAttribute("aria-pressed", String(index === this.zone));
      return item;
    }));
    this.floors.hidden = this.zones.length < 2;
    for (const item of this.nav.children) item.setAttribute("aria-pressed", String(item.dataset.section === this.section));
    if (this.section === "more") {
      this.content.append(element("h1", "page-title", "Ещё"));
      this.renderMore();
    } else if (!this.zones.length) {
      this.content.append(element("p", "muted", "После подключения здесь появятся комнаты и устройства."));
    } else if (this.section === "home") {
      this.renderHome();
    } else if (this.room) {
      const title = element("div", "titlebar");
      title.append(button("‹  " + this.zones[this.zone].name, () => this.select(this.zone, "rooms"), "back-button"), element("h1", "", this.room.name));
      title.firstChild.setAttribute("aria-label", "Назад к комнатам");
      this.content.append(title, this.roomView(this.room, false));
    } else {
      this.content.append(element("h1", "page-title", "Комнаты"), this.floors);
      this.renderRooms();
    }
    this.refresh();
  }

  get allLights() {
    const rooms = this.zones.flatMap(zone => zone.rooms);
    const entries = rooms.flatMap(room => (room.lights || []).map(([id, name]) => [id, { id, name, room:room.name }]));
    return new Map(entries);
  }

  roomReading(room, key) {
    const sensor = this.state(room[key]);
    const value = numeric(sensor?.state);
    if (!this.connected || !available(sensor) || value === null) return null;
    const unit = sensor.attributes?.unit_of_measurement;
    if (key === "humidity") return unit === "%" && value >= 0 && value <= 100 ? value : null;
    if (unit === "°C") return value;
    return unit === "°F" ? (value - 32) * 5 / 9 : null;
  }

  openReadings(key, title) {
    const rooms = this.zones.flatMap(zone => zone.rooms);
    this.showLiveDialog(title, () => {
      const list = element("div");
      for (const room of rooms.filter(room => room[key])) {
        const row = button("", () => {
          this.dialog.close();
          this.zone = this.zones.findIndex(zone => zone.rooms.includes(room));
          this.section = "rooms";
          this.room = room;
          this.renderSection();
        }, "detail-row");
        const reading = element("strong");
        row.append(element("span", "", room.name), reading, element("span", "chevron", "›"));
        list.append(row);
        this.bindings.push(() => setText(reading, valueText(this.roomReading(room, key), key === "humidity" ? " %" : " °C")));
      }
      return list;
    });
  }

  homeReadings() {
    const strip = element("div", "home-readings");
    const rooms = this.zones.flatMap(zone => zone.rooms);
    const metric = (name, icon, open, read, featured = false) => {
      const cell = button("", open, "home-metric" + (featured ? " featured" : ""));
      cell.dataset.kind = icon;
      const label = element("span", "metric-label", name);
      label.prepend(pictogram(icon));
      const value = element("strong");
      const note = element("small");
      cell.append(label, value, note);
      strip.append(cell);
      this.bindings.push(() => {
        const [reading, caption] = this.connected ? read() : ["—", "Нет связи"];
        value.classList.toggle("word-value", reading === "По комнатам");
        setText(value, reading);
        setText(note, caption);
        if (icon === "lights") cell.setAttribute("aria-label", "Свет по всему дому · " + reading + " · " + caption);
      });
    };
    for (const [key, name, icon, suffix] of [["temperature", "Температура", "climate", "°"], ["humidity", "Влажность", "humidity", "%"]]) {
      const sources = rooms.filter(room => room[key] && room[key] !== this.config.outdoor_temperature);
      if (!sources.length) continue;
      const selected = sources.filter(room => this.config.summary_rooms?.includes(room.id));
      metric(name, icon, () => this.openReadings(key, name + " по комнатам"), () => {
        if (!selected.length) return ["По комнатам", "Открыть показания"];
        const readings = selected.map(room => ({room, value:this.roomReading(room, key)})).filter(item => item.value !== null);
        if (!readings.length) return ["—", "Нет показаний"];
        const values = readings.map(item => item.value);
        const low = format.format(Math.min(...values)), high = format.format(Math.max(...values));
        const caption = readings.length === 1 ? readings[0].room.name : "Жилые комнаты";
        const partial = readings.length < selected.length ? " · " + readings.length + "/" + selected.length : "";
        return [(low === high ? low : low + "–" + high) + suffix, caption + partial];
      }, key === "temperature");
    }
    const lights = [...this.allLights.values()];
    if (lights.length) metric("Свет", "lights", () => this.openLights(lights), () => {
      const states = lights.map(({id}) => this.state(id)?.state);
      const known = states.some(state => state === "on" || state === "off");
      return [known ? String(states.filter(state => state === "on").length) : "—", known ? "Включено" : "Нет показаний"];
    });
    if (this.config.power_meter) metric(this.config.power_scope === "home" ? "Мощность дома" : "Мощность прибора", "power", () => this.moreInfo(this.config.power_meter), () => {
      const meter = this.state(this.config.power_meter);
      const unit = meter?.attributes?.unit_of_measurement;
      if (!available(meter) || !["W", "kW"].includes(unit)) return ["—", "Нет показаний"];
      return [valueText(meter.state, unit === "kW" ? " кВт" : " Вт"), meter.attributes.friendly_name || "Измеритель"];
    });
    return strip;
  }

  openLights(lights, offline = false) {
    this.showLiveDialog(offline ? "Свет без связи" : "Где горит свет", () => {
      const list = element("div");
      const empty = element("p", "muted");
      list.append(empty);
      const rows = lights.map(({id, name, room}) => {
        const row = this.lightView(id, name, room, false);
        list.append(row);
        return {id, row};
      });
      this.bindings.push(() => {
        let visible = 0;
        for (const {id, row} of rows) {
          const state = this.state(id)?.state;
          row.hidden = !this.connected || (offline ? ["on", "off"].includes(state) : state !== "on" && !this.pending.has(id) && !this.failures.has(id));
          if (!row.hidden) visible++;
        }
        empty.hidden = visible > 0;
        setText(empty, !this.connected ? "Нет связи с домом." : offline ? "Все светильники на связи." : "Среди доступных светильников включённых нет.");
      });
      return list;
    });
  }

  renderHome() {
    const grid = element("div", "overview-grid home-grid");
    const main = element("div", "stack");
    const side = element("div", "stack");
    const hero = element("section", "hero");
    const header = element("div", "hero-row");
    const weather = element("span", "weather");
    header.append(element("h1", "", "Дом сейчас"), weather);
    hero.append(header, this.homeReadings());
    this.bindings.push(() => {
      const outdoor = this.state(this.config.outdoor_temperature);
      setText(weather, this.connected && available(outdoor) ? "На улице " + valueText(outdoor.state, " " + (outdoor.attributes.unit_of_measurement || "°")) : "");
    });
    const presence = this.config.presence;
    const alarm = this.config.alarm ?? this.extra.find(([, id]) => id.startsWith("alarm_control_panel."))?.[1];
    const statuses = element("div", "home-status");
    if (presence) {
      const value = element("strong");
      const item = element("div", "status-item");
      item.append(pictogram("presence"), element("span", "sr-only", "Присутствие"), value);
      statuses.append(item);
      this.bindings.push(() => {
        const state = this.connected && this.state(presence)?.state;
        setText(value, state === "on" ? "Кто-то дома" : state === "off" ? "Никого дома" : "Нет данных");
      });
    }
    if (alarm) {
      const item = button("", () => this.moreInfo(alarm), "status-item");
      const value = element("strong");
      item.append(pictogram("shield"), value, element("span", "chevron", "›"));
      statuses.append(item);
      const labels = { disarmed:"Охрана снята", armed_away:"Под охраной", armed_home:"Охрана дома",
        armed_night:"Ночная охрана", armed_vacation:"В отпуске", armed_custom_bypass:"Частичная охрана",
        arming:"Постановка", disarming:"Снятие", pending:"Задержка входа", triggered:"Тревога" };
      this.bindings.push(() => {
        const entity = this.state(alarm);
        setText(value, this.connected && available(entity) ? labels[entity.state] || entity.state : "Нет данных");
        item.setAttribute("aria-label", "Состояние охраны · " + value.textContent);
        item.classList.toggle("alarm-active", this.connected && entity?.state === "triggered");
        item.disabled = !this.connected || !entity;
      });
    }
    if (statuses.childElementCount) hero.append(statuses);
    main.append(hero);
    const lights = [...this.allLights.values()];
    const issues = button("", () => this.openLights(lights, true), "issues");
    const problem = element("span");
    issues.append(pictogram("offline"), problem, element("span", "chevron", "›"));
    this.bindings.push(() => {
      const count = lights.filter(({id}) => !["on", "off"].includes(this.state(id)?.state)).length;
      issues.hidden = !this.connected || !count;
      setText(problem, "Свет без связи · " + count);
    });
    main.append(issues);
    if (lights.length || this.quick.length) {
      const favorites = element("section", "room");
      const head = element("div", "section-head");
      head.append(element("h2", "", "Избранное"), button("Изменить", () => this.editFavorites(), "quiet"));
      favorites.append(head);
      const catalog = this.favoriteCatalog();
      const ids = this.favoriteIds(catalog);
      for (const id of ids) {
        const {room, name} = catalog.get(id);
        favorites.append(this.lightView(id, name, room, false));
      }
      if (!ids.length) favorites.append(element("p", "muted", "Закрепите светильники для быстрого доступа."));
      side.append(favorites);
    }
    if (this.config.home_scenes?.length) {
      const scenes = element("section", "room scenes");
      scenes.append(element("h2", "", "Сценарии"));
      for (const [id, name] of this.config.home_scenes) {
        const row = button("", () => this.moreInfo(id), "detail-row");
        const icon = this.state(id)?.attributes?.icon;
        row.append(pictogram(iconPaths[icon] ? icon : "scene"), element("span", "scene-name", name), element("span", "chevron", "›"));
        scenes.append(row);
        this.bindings.push(() => { row.disabled = !this.connected || !this.state(id) || this.state(id).state === "unavailable"; });
      }
      side.append(scenes);
    }
    grid.append(main);
    if (side.childElementCount) grid.append(side);
    this.content.append(grid);
  }

  favoriteCatalog() {
    const catalog = this.allLights;
    for (const [id, name] of this.quick) catalog.set(id, {id, room:catalog.get(id)?.room, name});
    return catalog;
  }

  get favoritesKey() {
    return "moy-dom-favorites:" + location.pathname + ":" + (this.home?.user?.id || "local");
  }

  favoriteIds(catalog) {
    let ids = this.quick.map(([id]) => id);
    try {
      const saved = JSON.parse(localStorage.getItem(this.favoritesKey));
      if (Array.isArray(saved)) ids = saved;
    } catch { /* Browser storage is optional. */ }
    const session = this.sessionFavorites;
    return [...new Set(session?.key === this.favoritesKey ? session.ids : ids)].filter(id => catalog.has(id));
  }

  editFavorites() {
    const catalog = this.favoriteCatalog();
    const selected = new Set(this.favoriteIds(catalog));
    const form = element("div");
    for (const [id, {name, room}] of catalog) {
      const label = element("label", "favorite-option");
      const check = element("input");
      check.type = "checkbox";
      check.checked = selected.has(id);
      check.addEventListener("change", () => check.checked ? selected.add(id) : selected.delete(id));
      label.append(check, element("span", "", room ? room + " · " + name : name));
      form.append(label);
    }
    const save = button("Сохранить", () => {
      this.sessionFavorites = { key:this.favoritesKey, ids:[...selected] };
      try { localStorage.setItem(this.favoritesKey, JSON.stringify(this.sessionFavorites.ids)); } catch { /* Local session still works. */ }
      this.dialog.close();
      this.renderSection();
    }, "primary");
    this.showDialog("Избранный свет", form, save);
  }

  renderRooms() {
    const list = element("section", "room");
    list.append(element("h2", "", this.zones[this.zone].name));
    for (const room of this.zones[this.zone].rooms) {
      const row = button("", () => { this.room = room; this.renderSection(); }, "room-head");
      const labels = element("span", "room-label");
      const meta = element("span", "room-meta");
      const temperature = element("strong", "room-reading");
      labels.append(element("span", "room-name", room.name), meta);
      row.append(labels, temperature, element("span", "chevron", "›"));
      list.append(row);
      this.bindings.push(() => {
        const lights = (room.lights ?? []).map(([id]) => this.state(id));
        const active = lights.filter(light => light?.state === "on").length;
        setText(meta, !this.connected ? "Нет связи" : active ? "Включено: " + active :
          !lights.length ? "" : lights.filter(available).length === lights.length ? "Свет выключен" : "Свет недоступен");
        const sensor = this.state(room.temperature);
        setText(temperature, available(sensor) ? valueText(sensor.state, "°") : "");
      });
    }
    const label = "Погасить свет · " + this.zones[this.zone].name;
    const off = button(label, () => this.confirmZoneOff(), "quiet");
    const failures = element("p", "error");
    failures.setAttribute("role", "status");
    const lights = this.zoneLights;
    this.bindings.push(() => {
      off.disabled = !this.connected || !lights.some(({id}) => this.state(id)?.state === "on") || lights.some(({id}) => this.pending.has(id));
      const errors = lights.filter(({id}) => this.failures.has(id)).map(({name,id}) => name + " · " + this.failures.get(id));
      failures.hidden = !errors.length;
      setText(failures, errors.join(", "));
    });
    this.content.append(list);
    if (lights.length) this.content.append(off, failures);
  }

  roomView(room, showName = true) {
    const section = element("section", showName ? "room" : "room-console");
    if (showName) section.append(element("h2", "", room.name));
    const readings = element("p", "muted readings");
    section.append(readings);
    this.bindings.push(() => {
      const temperature = this.state(room.temperature);
      const humidity = this.state(room.humidity);
      const values = [
        available(temperature) && (showName || !room.climate || !available(this.state(room.climate)) || numeric(this.state(room.climate)?.attributes?.current_temperature) === null) ? valueText(temperature.state, "°") : null,
        available(humidity) ? "Влажность " + valueText(humidity.state, "%") : null,
      ].filter(Boolean);
      readings.hidden = !values.length;
      setText(readings, values.join(" · "));
    });
    if (room.lights?.length) {
      const lights = element("section", "lighting");
      if (!showName) lights.append(element("h2", "", "Освещение"));
      for (const [id, name] of room.lights) lights.append(this.lightView(id, name, room.name));
      section.append(lights);
    }
    if (room.climate) {
      const climate = element("section", "climate-card");
      const header = element("div", "climate-head");
      const adjust = button("Настроить", () => this.openClimate(room), "climate-adjust");
      adjust.setAttribute("aria-label", "Настроить климат");
      header.append(element("h2", "", "Климат"), adjust);
      const values = element("div", "climate-values");
      const current = element("strong");
      const target = element("strong");
      for (const [caption, value] of [["Сейчас", current], ["Цель", target]]) {
        const metric = element("div");
        metric.append(element("span", "", caption), value);
        values.append(metric);
      }
      const status = element("p", "muted");
      const remote = element("p", "muted");
      climate.append(header, values, status, remote);
      this.bindings.push(() => {
        const entity = this.state(room.climate);
        const ready = available(entity) && this.connected;
        setText(current, valueText(ready ? entity.attributes.current_temperature : null, "°"));
        setText(target, valueText(ready ? entity.attributes.temperature : null, "°"));
        remote.hidden = !room.ir;
        const ir = this.state(room.ir);
        setText(remote, room.ir ? "ИК-пульт · " + (this.connected && available(ir) ? modes[ir.state] || ir.state : "Нет данных") : "");
        setText(status, ready ? ["Термостат · " + (modes[entity.state] || entity.state), actions[entity.attributes.hvac_action]]
          .filter(Boolean).join(" · ") : "Термостат недоступен");
      });
      section.append(climate);
    }
    for (const [id, name] of room.details || []) section.append(this.detailsRow(id, name));
    return section;
  }

  showDialog(title, ...children) {
    const header = element("div", "dialog-head");
    const label = element("h2", "", title);
    label.id = "dialog-title";
    const close = button("×", () => this.dialog.close(), "quiet");
    close.setAttribute("aria-label", "Закрыть");
    close.autofocus = true;
    header.append(label, close);
    this.dialog.classList.toggle("thermostat-sheet", children[0]?.classList.contains("climate"));
    this.dialog.replaceChildren(header, ...children);
    this.dialog.showModal();
  }

  showLiveDialog(title, build) {
    const first = this.bindings.length;
    const controls = build();
    const updates = this.bindings.splice(first);
    this.dialogUpdates = updates;
    this.dialog.addEventListener("close", () => {
      if (this.dialogUpdates === updates) this.dialogUpdates = null;
    }, { once:true });
    this.showDialog(title, controls);
    this.refresh();
  }

  openClimate(room) {
    this.showLiveDialog("Термостат", () => this.climateView(room));
  }

  confirmZoneOff() {
    const zone = this.zone;
    const lights = this.zoneLights.filter(({id}) => this.state(id)?.state === "on");
    this.showDialog("Погасить свет?",
      element("p", "", this.zones[zone].name + " · включено " + lights.length),
      button("Погасить", () => {
        this.dialog.close();
        if (this.zone !== zone) return;
        for (const {id} of lights) {
          if (this.state(id)?.state === "on") this.send(id, id.split(".")[0], "turn_off", {}, entity => entity.state === "off");
        }
      }, "primary"));
  }

  detailsRow(id, name, bindings = this.bindings) {
    const row = button("", () => this.moreInfo(id), "detail-row");
    const status = element("span", "muted");
    row.append(element("span", "", name), status, element("span", "chevron", "›"));
    bindings.push(() => {
      const entity = this.state(id);
      row.disabled = !entity;
      setText(status, available(entity) ? (entity.state === "on" ? "Включено" : entity.state === "off" ? "Выключено" : "Открыть") : entity ? "Недоступно" : "Не найдено");
    });
    return row;
  }

  moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  lightView(id, name, roomName, inRoom = true) {
    const wrapper = element("div", "device");
    const row = element("div", "light-row");
    const label = element("div", "light-label");
    const state = element("span", "device-state");
    const toggle = element("input", "switch");
    toggle.type = "checkbox";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", roomName ? roomName + " — " + name : name);
    const icon = element("span", "device-icon");
    icon.setAttribute("aria-hidden", "true");
    const fallback = pictogram(domainOf(id) === "switch" ? "switch" : "lights");
    const custom = element("ha-icon");
    custom.hidden = true;
    icon.append(fallback, custom);
    const details = button("", () => this.moreInfo(id), "device-details");
    details.setAttribute("aria-label", [roomName, name, "подробности"].filter(Boolean).join(" — "));
    details.append(icon, element("span", "", name + " ›"), state);
    label.append(details, toggle);
    row.append(label);
    const dimmer = element("label", "dimmer");
    const range = element("input");
    range.type = "range";
    range.min = "1";
    range.max = "100";
    range.setAttribute("aria-label", "Яркость — " + name);
    const output = element("output");
    dimmer.append(element("span", "sr-only", "Яркость"), range, output);
    const error = element("p", "error");
    error.setAttribute("role", "status");
    wrapper.append(row, dimmer, error);

    toggle.addEventListener("change", () => {
      const on = toggle.checked;
      this.send(id, id.split(".")[0], on ? "turn_on" : "turn_off", {}, entity => entity.state === (on ? "on" : "off"));
    });
    range.addEventListener("input", () => setText(output, range.value + "%"));
    range.addEventListener("change", () => {
      const brightness = Number(range.value);
      this.send(id, "light", "turn_on", { brightness_pct: brightness }, entity =>
        entity.state === "on" && numeric(entity.attributes?.brightness) !== null &&
        Math.abs(Number(entity.attributes.brightness) / 2.55 - brightness) <= 2);
    });
    range.addEventListener("blur", () => this.refresh());

    this.bindings.push(() => {
      const entity = this.state(id);
      const on = entity?.state === "on";
      const pending = this.pending.has(id);
      const assigned = this.home?.entities?.[id]?.icon || entity?.attributes?.icon;
      const path = iconPaths[assigned] || iconPaths[domainOf(id) === "switch" ? "switch" : "lights"];
      if (fallback.firstChild.getAttribute("d") !== path) fallback.firstChild.setAttribute("d", path);
      details.disabled = !entity;
      const useCustom = Boolean(assigned && customElements.get("ha-icon"));
      if (useCustom && custom.icon !== assigned) custom.icon = assigned;
      custom.hidden = !useCustom;
      fallback.style.display = useCustom ? "none" : "";
      icon.classList.toggle("lit", this.connected && on);
      toggle.checked = on;
      toggle.disabled = !this.connected || !available(entity) || pending;
      const status = pending ? "Ожидание ответа" : !this.connected ? "Нет связи" : !available(entity) ? "Недоступно" : on ? "Включено" : "Выключено";
      setText(state, !inRoom && roomName ? roomName + " · " + status : status);
      const modes = entity?.attributes?.supported_color_modes;
      const dimmable = domainOf(id) === "light" && Array.isArray(modes) && modes.some(mode => ["brightness", "color_temp", "hs", "xy", "rgb", "rgbw", "rgbww", "white"].includes(mode));
      dimmer.hidden = !inRoom || !dimmable || !on || !available(entity);
      range.disabled = !this.connected || pending;
      if (this.shadowRoot.activeElement !== range || pending) {
        const brightness = numeric(entity?.attributes?.brightness);
        if (brightness !== null) range.value = String(Math.max(1, Math.round(brightness / 2.55)));
        setText(output, brightness === null ? "—" : range.value + "%");
      }
      this.showError(error, id);
    });
    return wrapper;
  }

  climateView(room) {
    const id = room.climate;
    const box = element("div", "climate");
    const head = element("div", "climate-head");
    const current = element("span", "muted");
    head.append(element("span", "", room.name), current);
    const temperature = element("div", "temperature");
    const value = element("strong");
    const label = element("div", "target");
    label.append(value, element("span", "", "Заданная температура"));
    const decrease = button("−", () => this.stepTemperature(id, -1), "step");
    decrease.setAttribute("aria-label", "Уменьшить температуру — " + room.name);
    const increase = button("+", () => this.stepTemperature(id, 1), "step");
    increase.setAttribute("aria-label", "Увеличить температуру — " + room.name);
    temperature.append(decrease, label, increase);
    const mode = this.climateSelect("Режим", modes, next => this.send(id, "climate", "set_hvac_mode", { hvac_mode: next }, entity => entity.state === next));
    const preset = this.climateSelect("Пресет", presets, next => this.send(id, "climate", "set_preset_mode", { preset_mode: next }, entity => entity.attributes?.preset_mode === next));
    const status = element("p", "muted climate-status");
    const error = element("p", "error");
    error.setAttribute("role", "status");
    const settings = button("Карточка устройства ›", () => {
      if (this.dialog.open) this.dialog.close();
      this.moreInfo(id);
    }, "quiet");
    box.append(head, temperature, mode.row, preset.row, status, error, settings);

    this.bindings.push(() => {
      const entity = this.state(id);
      const attributes = entity?.attributes || {};
      const ready = this.connected && available(entity) && !this.pending.has(id);
      const target = available(entity) ? numeric(attributes.temperature) : null;
      const limits = this.temperatureLimits(attributes);
      setText(current, "Сейчас " + valueText(available(entity) ? attributes.current_temperature : null, "°"));
      setText(value, valueText(target, "°"));
      decrease.disabled = !ready || target === null || !limits || target <= limits.min;
      increase.disabled = !ready || target === null || !limits || target >= limits.max;
      mode.update(attributes.hvac_modes, entity?.state, ready);
      preset.update(attributes.preset_modes, attributes.preset_mode, ready);
      const ir = room.ir ? " · ИК-управление " + (available(this.state(room.ir)) ? "доступно" : "недоступно") : "";
      const activity = !available(entity) ? "Термостат недоступен" : actions[attributes.hvac_action] || "Режим: " + (modes[entity.state] || entity.state);
      setText(status, this.pending.has(id) ? "Ожидание ответа" : activity + ir);
      settings.disabled = !entity;
      this.showError(error, id);
    });
    return box;
  }

  climateSelect(name, labels, onChange) {
    const row = element("label", "select-row");
    const select = element("select");
    select.addEventListener("change", () => onChange(select.value));
    row.append(element("span", "", name), select);
    let previous = "";
    return { row, update: (choices, current, ready) => {
      const values = Array.isArray(choices) ? choices : [];
      row.hidden = !values.length;
      const key = JSON.stringify(values);
      if (previous !== key) {
        select.replaceChildren(...values.map(value => {
          const option = element("option", "", labels[value] || value);
          option.value = value;
          return option;
        }));
        previous = key;
      }
      if (select.value !== current) select.value = current || "";
      select.disabled = !ready;
    } };
  }

  temperatureLimits(attributes) {
    const min = numeric(attributes.min_temp);
    const max = numeric(attributes.max_temp);
    const step = numeric(attributes.target_temp_step);
    return min !== null && max !== null && step > 0 ? { min, max, step } : null;
  }

  stepTemperature(id, direction) {
    const attributes = this.state(id)?.attributes || {};
    const limits = this.temperatureLimits(attributes);
    const current = numeric(attributes.temperature);
    if (!limits || current === null) return;
    const target = Number(Math.max(limits.min, Math.min(limits.max, current + direction * limits.step)).toFixed(3));
    this.send(id, "climate", "set_temperature", { temperature: target }, entity => numeric(entity.attributes?.temperature) === target);
  }

  renderMore() {
    const list = element("section", "room links");
    const entries = this.extra;
    for (const [name, destination] of entries) {
      if (destination.startsWith("/")) {
        const link = element("a", "detail-row");
        link.href = destination;
        link.append(element("span", "", name), element("span", "chevron", "›"));
        list.append(link);
      } else list.append(this.detailsRow(destination, name));
    }
    if (entries.length) this.content.append(list);
    this.renderEntitySearch();
  }

  renderEntitySearch() {
    const section = element("section", "room links");
    const input = element("input", "entity-search");
    input.type = "search";
    input.placeholder = "Например, розетка или switch";
    input.setAttribute("aria-label", "Поиск по названию или ID сущности");
    const status = element("p", "muted");
    status.setAttribute("role", "status");
    const list = element("div");
    let rows = [];
    let previous = "";
    const update = () => {
      const results = matchingEntities(this.home, input.value);
      const visible = results.slice(0, 30);
      const key = JSON.stringify(visible);
      if (key !== previous) {
        previous = key;
        rows = [];
        list.replaceChildren(...visible.map(([id, name]) => this.detailsRow(id, name, rows)));
      }
      for (const refresh of rows) refresh();
      setText(status, !input.value.trim() ? "Введите название, тип или ID сущности." :
        !results.length ? "Ничего не найдено." :
        results.length > visible.length ? "Показаны 30 из " + results.length + ". Уточните запрос." : "");
    };
    input.addEventListener("input", update);
    section.append(element("h2", "room-name", "Все сущности"), input, status, list);
    this.content.append(section);
    this.bindings.push(update);
  }

  appearancePicker(key, title, options) {
    const group = element("fieldset", "appearance-group");
    group.append(element("legend", "", title));
    const choices = element("div", "choices " + key);
    for (const [id, item] of options) {
      const label = element("label", "choice");
      const input = element("input");
      input.type = "radio";
      input.name = key;
      input.value = id;
      input.checked = this[key] === id;
      input.addEventListener("change", () => {
        this[key] = id;
        try { localStorage.setItem("moy-dom-" + key, id); } catch { /* Optional preference. */ }
        this.updateTheme();
      });
      const text = element("span", "", item);
      label.append(input, text);
      choices.append(label);
    }
    group.append(choices);
    return group;
  }

  showError(element, id) {
    const message = this.failures.get(id) || "";
    element.hidden = !message;
    setText(element, message);
  }

  updateTheme() {
    if (!this.shell) return;
    this.shell.dataset.theme = this.theme;
  }

  async send(id, domain, service, data, confirmed) {
    if (!this.connected || !available(this.state(id)) || this.pending.has(id)) {
      this.refresh();
      return;
    }
    this.failures.delete(id);
    const command = { confirmed, acknowledged: false };
    command.timer = setTimeout(() => this.finish(id, command, "Устройство не подтвердило изменение. Повтори действие."), 8500);
    this.pending.set(id, command);
    this.refresh();
    try {
      await this.home.callService(domain, service, data, { entity_id: id });
      command.acknowledged = true;
      this.refresh();
    } catch {
      this.finish(id, command, "Команда не выполнена. Повтори действие.");
    }
  }

  finish(id, command, message = "") {
    if (this.pending.get(id) !== command) return;
    clearTimeout(command.timer);
    this.pending.delete(id);
    if (message) this.failures.set(id, message);
    this.refresh();
  }

  refresh() {
    if (!this.shell) return;
    this.updateTheme();
    for (const [id, command] of this.pending) {
      const entity = this.state(id);
      let failure;
      if (!this.connected) failure = "Связь потеряна. Проверь состояние после подключения.";
      else if (!available(entity)) failure = "Устройство недоступно.";
      if (failure || (command.acknowledged && command.confirmed(entity))) {
        clearTimeout(command.timer);
        this.pending.delete(id);
        if (failure) this.failures.set(id, failure);
      }
    }
    this.connection.hidden = this.connected;
    setText(this.connection, this.home ? "Связь с Home Assistant потеряна. Подключаемся…" : "Подключаемся к Home Assistant…");
    const hazards = this.hazards.filter(([id]) => this.state(id)?.state === "on");
    this.alerts.replaceChildren();
    for (const [id, title] of hazards) this.alerts.append(button(title + " ›", () => this.moreInfo(id), "quiet"));
    this.alerts.hidden = !hazards.length;
    for (const update of this.bindings) update();
    if (this.dialog.open) for (const update of this.dialogUpdates || []) update();
  }
}

const styles = `
:host {display:block;height:100%;font:16px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
* {box-sizing:border-box}
[hidden] {display:none!important}
.shell {
  color-scheme:light;
  --surface:#edf1f6; --paper:#ffffff; --line:#cbd3df; --ink:#111925; --muted:#4d6075;
  --olive:#1857ca; --on:#ffffff; --accent:#dfebff; --warn:#884309; --warn-bg:#fff0dc;
  --hero:#182333; --hero-text:#f6f9ff; --hero-muted:#bdcce1;
}
.shell[data-theme=dark] {
  color-scheme:dark;
  --surface:#0c1016; --paper:#171c24; --line:#353e4c; --ink:#f2f6fd; --muted:#aab7c9;
  --olive:#79acff; --on:#08172e; --accent:#1d3353; --warn:#ffc17d; --warn-bg:#38291b;
  --hero:#1b2533; --hero-text:#f2f6fd; --hero-muted:#afbed4;
}
.shell {min-height:100%;background:var(--surface);color:var(--ink);--warning:var(--warn);--track:var(--line);--active:var(--olive);--knob:var(--paper)}
button,input,select {font:inherit;color:inherit}
button,a,input,select {touch-action:manipulation}
button {min-height:44px;cursor:pointer}
button:disabled,input:disabled,select:disabled {cursor:default;opacity:.53}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible {outline:2px solid var(--olive);outline-offset:3px}
.body {max-width:1240px;margin:auto;padding:0 24px 40px;min-width:0}
.toolbar {display:flex;align-items:center;gap:24px;min-height:64px;border-bottom:1px solid var(--line);margin-bottom:20px}
.toolbar strong {font-size:1.12rem;white-space:nowrap}
h1 {font-size:clamp(1.8rem,4.5vw,3.25rem);line-height:1.06;letter-spacing:-.038em;margin:0;font-weight:650}
.page-title,.titlebar {margin-bottom:16px}
.titlebar {display:flex;align-items:center;gap:12px}
.back-button {width:44px;flex:none;font-size:1.35rem;border:1px solid var(--line);border-radius:12px;background:var(--paper)}
.muted {color:var(--muted);font-size:.82rem}
.overview-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}
.overview-grid:has(> .stack) {grid-template-columns:minmax(0,1.22fr) minmax(0,1fr)}
.stack {display:grid;gap:14px;min-width:0}
.hero {background:var(--hero);color:var(--hero-text);border-radius:22px;padding:22px}
.hero-row {display:flex;justify-content:space-between;align-items:center;gap:10px}
.hero-row:first-child {align-items:start}
.hero-muted,.weather {color:var(--hero-muted);font-size:.88rem;margin-top:6px}
.weather {text-align:right}
.hero-actions {margin-top:14px;border-top:1px solid #ffffff38;padding-top:5px}
.hero-actions button {color:inherit}
.issues {text-align:left;border:0;border-radius:12px;padding:8px 12px;color:var(--warn);background:var(--warn-bg);font-size:.84rem}
.floors {display:flex;flex-wrap:wrap;gap:4px;border-radius:16px;padding:4px;background:var(--accent)}
.floors button {flex:1 0 25%;border:0;border-radius:12px;padding:8px 6px;background:transparent;font-size:.82rem;overflow-wrap:anywhere}
.floors button[aria-pressed=true] {background:var(--paper);color:var(--olive);box-shadow:0 1px 5px #2029150d;font-weight:650}
.quiet {background:transparent;border:0;padding:5px 8px;color:var(--olive);font-size:.85rem;font-weight:600}
.primary {border:0;border-radius:12px;padding:0 14px;background:var(--olive);color:var(--on);font-weight:650}
.room {min-width:0;background:var(--paper);border:0;border-radius:17px;padding:16px 20px}
h2 {margin:0 0 7px;font-size:1.2rem;letter-spacing:-.035em}
.room-reading {margin-left:auto;font-size:1.35rem;letter-spacing:-.038em;white-space:nowrap}
.device + .device,.room-head + .room-head {border-top:1px solid var(--line)}
.room-head {border:0;background:transparent;width:100%;display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:left;padding:18px 0}
.room-name {font-size:1.12rem;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.room-meta {display:block;color:var(--muted);font-size:.78rem;font-weight:400;margin-top:5px}
.chevron {font-size:1.25rem;font-weight:400;color:var(--olive)}
.devices {padding:0 0 16px}
.pictogram {width:21px;height:21px;flex:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;fill:none}
.device-icon {display:grid;place-items:center;grid-row:1/3;grid-column:1;color:var(--muted);--mdc-icon-size:21px}
.device-icon.lit {color:var(--olive)}
.device-icon.lit .pictogram {fill:currentColor}
.device-icon [hidden] {display:none}
.light-label {display:flex;align-items:center;gap:12px}
.device-details {flex:1;min-width:0;color:inherit;font:inherit;text-align:left;background:transparent;border:0;display:grid;grid-template-columns:26px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:3px 12px;min-height:60px;padding:9px 0;overflow-wrap:anywhere}
.device-state {grid-row:2;grid-column:2;font-size:.73rem;color:var(--muted)}
.switch {grid-row:1/3;grid-column:3;appearance:none;width:46px;height:28px;background:var(--track);border:0;border-radius:16px;position:relative;margin:0;cursor:pointer}
.switch::before {content:"";position:absolute;left:3px;top:3px;width:22px;height:22px;border-radius:50%;background:var(--knob);box-shadow:0 1px 3px #0002;transition:transform .15s}
.switch:checked {background:var(--active)}
.switch:checked::before {transform:translateX(18px)}
.dimmer {display:flex;align-items:center;gap:14px;min-height:44px}
.dimmer input {width:100%;min-width:0;min-height:44px;accent-color:var(--olive)}
output {min-width:3ch;font-size:.78rem;color:var(--muted)}
.climate {padding-top:16px;margin-top:10px;border-top:1px solid var(--line)}
.climate-head,.select-row,.detail-row {display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.temperature {display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 0 12px}
.target {text-align:center}
.target strong {display:block;font-size:2.15rem;font-weight:550;letter-spacing:-.06em}
.target span,.climate-status {color:var(--muted);font-size:.75rem}
.step {width:44px;flex:0 0 44px;border:1px solid var(--line);border-radius:50%;background:var(--paper);color:var(--olive);font-size:1.4rem}
.select-row {min-height:48px;font-size:.84rem}
select {max-width:65%;min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--paper);padding:6px 8px}
.detail-row {text-decoration:none;border:0;border-bottom:1px solid var(--line);background:transparent;width:100%;min-height:52px;color:var(--ink);text-align:left;font-size:.92rem;padding:8px 0}
.detail-row span:first-child {flex:1}
.notice,.error {font-size:.8rem;line-height:1.5;color:var(--warning)}
.notice {padding:10px 0}
.warning button {display:block;color:var(--warning)}
.appearance {padding-bottom:16px;margin-bottom:12px}
.error {margin:4px 0}
.links {margin-top:14px}
.navigation {display:flex;gap:4px}
.navigation button {display:flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;border-radius:10px;color:var(--muted);font-size:.86rem;padding:5px 12px}
.navigation button[aria-pressed=true] {color:var(--ink);background:var(--accent);font-weight:700}
dialog {width:min(460px,calc(100% - 24px));max-height:85dvh;padding:18px;border:1px solid var(--line);border-radius:18px;background:var(--paper);color:var(--ink)}
dialog::backdrop {background:#0b111ab5}
.dialog-head {display:flex;justify-content:space-between;align-items:center;gap:10px}
.dialog-head button {font-size:1.4rem;min-width:44px}
.sr-only {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.appearance-group { margin:14px 0 0; padding:0; border:0; min-width:0; }
.appearance-group legend { margin-bottom:8px; padding:0; font-weight:650; }
.choices { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; }
.choice { position:relative; min-width:0; }
.choice input { position:absolute; opacity:0; width:1px; height:1px; }
.choice span { min-height:44px; display:flex; align-items:center; justify-content:center; gap:8px;
  border:1px solid var(--line); border-radius:10px; padding:5px 6px; font-size:13px; cursor:pointer; }
.choice input:checked + span { background:var(--accent); border-color:var(--olive); font-weight:650; }
.choice input:focus-visible + span { outline:2px solid var(--olive); outline-offset:2px; }
.entity-search { width:100%; min-height:44px; padding:8px 12px; font:inherit; color:var(--ink); background:var(--paper); border:1px solid var(--line); border-radius:8px; }
.entity-search:focus-visible { outline:2px solid var(--olive); outline-offset:2px; }
.appearance-note { margin-top:9px; }

@media(max-width:780px) {
  .body {padding:0 16px calc(74px + env(safe-area-inset-bottom))}
  .toolbar {min-height:46px;margin-bottom:12px}
  .navigation {position:fixed;inset:auto 0 0;z-index:2;padding:5px 8px calc(5px + env(safe-area-inset-bottom));background:var(--paper);border-top:1px solid var(--line)}
  .navigation button[aria-pressed=true] {background:transparent;color:var(--olive)}
  .navigation {background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(16px)}
  .navigation button {font-size:.72rem;flex:1;flex-direction:column;gap:2px;padding:4px}
  .overview-grid,.overview-grid:has(> .stack) {grid-template-columns:minmax(0,1fr);gap:12px}
  .stack {gap:12px}
  .hero {padding:15px 14px 8px}
  .hero-actions {margin-top:9px}
  .room {padding:12px 16px}
}

/* The wallpaper is drawn locally. More opaque cards remain legible without blur. */
.shell {
  --glass:rgb(247 251 255 / .72); --edge:rgb(255 255 255 / .83);
  --shine:rgb(255 255 255 / .8); --shade:rgb(43 66 109 / .12);
  --sky:#c6dbef; --ribbon:#93bcf2; --violet:#a8a6df; --mist:#eaf7ff;
  --knob:#fff;
  min-height:100dvh;
  background-color:var(--sky);
  background-image:
    radial-gradient(ellipse 105% 58% at 108% -3%,transparent 44%,var(--mist) 50%,var(--ribbon) 55%,transparent 68%),
    radial-gradient(ellipse 120% 85% at -29% 12%,transparent 45%,var(--violet) 64%,transparent 78%),
    linear-gradient(148deg,var(--sky),var(--surface) 76%);
  background-size:100% max(100dvh,650px);background-repeat:no-repeat;
}
.shell[data-theme=dark] {
  --glass:rgb(18 30 49 / .75); --edge:rgb(202 225 255 / .21);
  --shine:rgb(216 236 255 / .18); --shade:rgb(0 4 12 / .32);
  --sky:#0e172b; --ribbon:#30558c; --violet:#3d3765; --mist:#819fbf;
  --muted:#c1cee0; --olive:#a4c9ff;
}
.body {max-width:1060px}
.toolbar {justify-content:space-between;border:0}
.titlebar {display:grid;justify-items:start;gap:12px;margin:24px 0}
.titlebar h1 {font-size:clamp(2.3rem,5vw,4rem);letter-spacing:-.055em}
.back-button,.climate-adjust {width:auto;border-radius:100px;padding:0 15px;font-size:.88rem;font-weight:600}
.room-console {display:grid;grid-template-columns:minmax(0,1.32fr) minmax(0,1fr);align-items:start;gap:16px}
.readings {grid-column:1/-1;margin:0 0 8px}
.room-console > .detail-row {grid-column:1/-1}
.room-console > .lighting,.room-console > .climate-card,.room,.navigation,.back-button,.climate-adjust,dialog {
  background:var(--glass);border:1px solid var(--edge);box-shadow:inset 0 1px 0 var(--shine),0 8px 26px var(--shade);
  -webkit-backdrop-filter:blur(22px) saturate(128%);backdrop-filter:blur(22px) saturate(128%);
}
.room-console > .lighting,.room-console > .climate-card {border-radius:24px;padding:20px}
.navigation {border-radius:32px;padding:4px}
.navigation button,.navigation button[aria-pressed=true] {border-radius:24px}
.light-label {min-height:64px}
.device-icon {border-radius:12px;background:var(--accent);width:36px;height:36px;color:var(--ink)}
.device-icon.lit {background:var(--olive);color:var(--on)}
.device-details {grid-template-columns:36px minmax(0,1fr)}
.climate-values {display:flex;align-items:flex-end;gap:30px;margin:18px 0 12px}
.climate-values span,.climate-values strong {display:block}
.climate-values span {font-size:.78rem;color:var(--muted)}
.climate-values strong {font-size:clamp(2rem,6vw,3.3rem);line-height:1.12;font-weight:550;letter-spacing:-.055em;font-variant-numeric:tabular-nums}
.climate-values div+div strong {font-size:1.65rem}
.climate-head h2,.climate-card p {margin:0}
.climate-adjust {color:var(--olive);box-shadow:inset 0 1px 0 var(--shine)}
.room > .climate-card {padding-top:14px}
@media(max-width:780px) {
  .room-console {grid-template-columns:minmax(0,1fr);gap:12px}
  .navigation {inset:auto 12px max(10px,env(safe-area-inset-bottom));margin:auto;max-width:440px;padding:4px;z-index:3}
  .navigation button[aria-pressed=true] {background:var(--accent)}
  .body {padding-bottom:calc(90px + env(safe-area-inset-bottom))}
  .titlebar {margin:8px 0 16px;gap:10px}
  .room-console > .lighting,.room-console > .climate-card {padding:16px}
}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more) {
  .shell {--glass:var(--paper);background:var(--surface)}
}
/* Detail sheets use a lighter scrim so the room remains visible around them. */
.thermostat-sheet {--sheet-tint:color-mix(in srgb,var(--paper) 77%,transparent);
  padding:20px 22px;border-radius:26px;overflow:auto;overscroll-behavior:contain;
  background:var(--paper)}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
  .thermostat-sheet {background:linear-gradient(135deg,var(--shine),transparent 38%),var(--sheet-tint);
    -webkit-backdrop-filter:blur(14px) saturate(145%);backdrop-filter:blur(14px) saturate(145%)}
}
.thermostat-sheet::backdrop {background:rgb(5 12 24 / .28)}
.thermostat-sheet .climate {border:0;margin:0;padding:6px 0 0}
.thermostat-sheet .climate-head {color:var(--muted);font-size:.9rem}
.thermostat-sheet .dialog-head h2 {margin:0;font-size:1.5rem;letter-spacing:-.035em}
.thermostat-sheet .temperature {padding:20px 0}
.thermostat-sheet .target strong {font-size:2.85rem;font-variant-numeric:tabular-nums}
.thermostat-sheet .select-row {border-top:1px solid var(--line);padding:4px 0}
.thermostat-sheet .step,.thermostat-sheet select {background:var(--accent)}
.thermostat-sheet .climate-status {font-size:.85rem}
.thermostat-sheet .quiet:last-child {padding-inline:0}
.switch {flex:none}
.switch::after {content:"";position:absolute;inset:-8px 0}
@media(max-width:780px) {
  .thermostat-sheet {margin:auto auto max(8px,env(safe-area-inset-bottom));width:min(480px,calc(100% - 16px));
    max-height:calc(100dvh - 24px);padding:18px 20px 12px}
}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more) {
  .thermostat-sheet {background:var(--paper);backdrop-filter:none}
}
.toolbar {gap:12px}
.toolbar > strong {display:flex;align-items:center;gap:9px;margin-right:auto}
.demo-badge {border:1px solid var(--line);border-radius:7px;color:var(--muted);padding:2px 6px;font-size:.72rem;font-weight:550}
.settings-button {display:grid;place-items:center;border:0;border-radius:50%;width:44px;background:var(--glass);color:var(--ink)}
.section-head {display:flex;align-items:center;justify-content:space-between;gap:12px}
.section-head h2 {margin:0}.section-head .quiet {padding-right:0}
.floors {margin-bottom:14px}
.favorite-option {display:flex;align-items:center;gap:12px;min-height:48px;border-bottom:1px solid var(--line)}
.favorite-option input {accent-color:var(--olive);width:20px;height:20px}
dialog .primary {margin-top:14px}
.home-grid .room,.room-console > .lighting,.room-console > .climate-card {background:var(--paper)}
/* The summary reads as one instrument. The surrounding actions have their own surfaces. */
.shell {
  --summary-fill:rgb(255 255 255 / .8); --summary-rule:rgb(57 82 121 / .19);
  --summary-ink:#16253e; --summary-note:#435671; --summary-blue:#255f9d;
  background-image:radial-gradient(ellipse 84% 45% at 97% 0%,#bfd6f0 0%,transparent 83%),
    linear-gradient(160deg,#e9eff8,var(--surface) 66%);
}
.shell[data-theme=dark] {
  --summary-fill:rgb(29 43 63 / .85); --summary-rule:rgb(207 224 248 / .17);
  --summary-ink:#f2f6ff; --summary-note:#c0cde0; --summary-blue:#a6ccff;
  background-image:radial-gradient(ellipse 84% 45% at 97% 0%,#263951 0%,transparent 83%),
    linear-gradient(155deg,#121b2b,var(--surface) 67%);
}
.home-grid .hero {padding:0;border:0;border-radius:0;background:transparent;color:var(--ink)}
.hero-row {align-items:baseline;flex-wrap:wrap;gap:4px 12px}
.hero-row:first-child {align-items:baseline}
.home-grid h1 {font-size:clamp(1.85rem,3vw,2.45rem);font-weight:630;letter-spacing:-.045em;line-height:1.12}
.home-grid .weather {color:var(--summary-note);font-size:.86rem;margin:0}
.home-readings {
  display:grid;grid-auto-columns:minmax(0,1fr);grid-auto-flow:column;align-items:stretch;
  margin-top:15px;padding:12px 5px;border:1px solid var(--summary-rule);border-radius:18px;
  background:var(--summary-fill);color:var(--summary-ink);box-shadow:inset 0 1px 0 var(--shine);
  container-type:inline-size;
}
.home-readings:empty {display:none}
.home-readings:has(.featured):has(> :nth-child(3)) {grid-template-columns:minmax(0,1.35fr) minmax(0,1.16fr) minmax(0,.80fr)}
.home-readings:has(> :nth-child(4)) {grid-auto-flow:row;row-gap:10px}
.home-readings > :nth-child(4) {grid-column:1/-1}
.home-metric {
  display:grid;justify-items:start;align-content:start;min-width:0;gap:5px;min-height:48px;
  padding:2px clamp(6px,2.5cqw,16px);border:0;text-align:left;background:transparent;
}
.home-metric + .home-metric {border-inline-start:1px solid var(--summary-rule)}
.home-metric:nth-child(4) {grid-template-columns:auto 1fr;align-items:baseline;column-gap:12px;
  border:0;border-top:1px solid var(--summary-rule);padding-top:10px}
.home-metric:nth-child(4) small {grid-column:1/-1}
.metric-label {display:flex;align-items:center;gap:4px;color:var(--summary-blue);font-size:.81rem;font-weight:550;line-height:1.2}
.metric-label .pictogram {width:15px;height:15px}
.home-metric strong {font-size:clamp(1.2rem,6.8cqw,1.75rem);font-variant-numeric:tabular-nums;
  letter-spacing:-.047em;font-weight:570;line-height:1.2;overflow-wrap:anywhere}
.home-metric strong.word-value {font-size:1rem;letter-spacing:0}
.home-metric[data-kind=lights] {padding-inline-end:2px}
.home-metric small {font-size:.77rem;line-height:1.3;color:var(--summary-note);overflow-wrap:anywhere}
.home-status {display:flex;align-items:center;flex-wrap:wrap;gap:0 18px}
.status-item {display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;
  padding:0;min-height:44px;color:var(--summary-note);font-size:.84rem;text-align:left}
.status-item .pictogram {height:16px;width:16px}
.status-item strong {font-weight:500}.status-item .chevron {color:inherit;font-size:1rem}
.status-item.alarm-active {color:var(--warn);font-weight:700}
.issues {display:flex;align-items:center;gap:8px;width:100%;background:transparent;color:var(--summary-note);
  border-top:1px solid var(--summary-rule);border-radius:0;font-weight:500;padding:0 4px;min-height:44px}
.issues .pictogram {width:17px;height:17px;color:var(--warn)}
.issues .chevron {margin-left:auto;color:var(--summary-note)}
.home-grid > .stack:first-child {gap:0}
.home-grid > .stack + .stack {gap:18px}
.home-grid .room {border:1px solid var(--summary-rule);box-shadow:0 2px 10px var(--shade);border-radius:19px;padding:12px 18px}
.home-grid .room h2 {font-size:1.12rem;font-weight:620;letter-spacing:-.025em}
.home-grid .room > h2 {margin:5px 0 6px}
.home-grid .room .device-details {font-weight:550}
.home-grid .room .device-state {font-size:.8rem;font-weight:400}
.home-grid .detail-row {border:0;min-height:50px;font-weight:500}
.home-grid .detail-row + .detail-row {border-top:1px solid var(--line)}
.home-grid .detail-row > .pictogram {color:var(--summary-blue);width:22px;height:22px}
.home-grid .scene-name {flex:1}
.home-grid .room.scenes {background:transparent;border-color:transparent;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
.home-grid .scenes > h2 {margin-bottom:6px}
.home-grid .device-icon.lit .pictogram {fill:none}
.home-grid .detail-row .chevron {color:var(--muted)}
.room-console .climate-card p + p {margin-top:6px}
@media(hover:hover) {
  .home-metric:hover,.status-item:is(button):hover,.issues:hover {background:var(--accent);border-radius:8px}
}
@media(max-width:780px) {
  .toolbar {min-height:52px;margin-bottom:12px}
  .toolbar > strong {font-size:1rem}
  .navigation button {font-size:.8rem}
  .home-grid > .stack + .stack {gap:14px}
  .home-grid .room {padding:10px 16px}
}
@media(max-width:355px) {
  .home-readings:has(.featured):has(> :nth-child(3)) {grid-template-columns:minmax(0,1.26fr) minmax(0,1fr) minmax(4.8rem,.82fr)}
}
@container (max-width:300px) {
  .metric-label .pictogram {display:none}
  .home-metric {padding-inline:4px}
  .home-metric small {font-size:.75rem}
  .home-metric strong {font-size:1rem}
}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more) {
  .shell,.shell[data-theme=dark] {--summary-fill:var(--paper);background:var(--surface)}
}
@media(prefers-reduced-motion:reduce) {.switch::before {transition:none}}
`;

customElements.define("moy-dom-panel", MoyDomPanel);

class MoyDomDashboard extends HTMLElement {
  static getStubConfig() { return {}; }

  setConfig(config = {}) {
    validate(config);
    if (!this.panel) {
      this.panel = document.createElement("moy-dom-panel");
      this.append(this.panel);
    }
    this.panel.configure(config);
  }

  set hass(hass) {
    if (!this.panel) this.setConfig();
    this.panel.hass = hass;
  }

  getCardSize() { return 10; }
}

customElements.define("moy-dom-dashboard", MoyDomDashboard);
window.customCards ??= [];
window.customCards.push({
  type: "moy-dom-dashboard",
  name: "Home Panel",
  description: "Панель дома с автоматическим подбором помещений и устройств",
  preview: true,
});
