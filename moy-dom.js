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

function validate(config) {
  const ensure = (ok, path) => { if (!ok) throw new Error("Мой дом: проверьте " + path); };
  const entity = (id, domains) => typeof id === "string" && entityPattern.test(id) &&
    (!domains || domains.includes(domainOf(id)));
  const label = value => typeof value === "string" && Boolean(value.trim());
  const pairs = (list, path, predicate) => {
    if (list === undefined) return;
    ensure(Array.isArray(list) && list.every(row => Array.isArray(row) && row.length === 2 && predicate(...row)), path);
  };
  ensure(config && typeof config === "object" && !Array.isArray(config), "конфигурацию карточки");
  pairs(config.quick_lights, "quick_lights", (id, name) => entity(id, lightDomains) && label(name));
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
  ["rooms", "Дом"],
  ["lights", "Свет"],
  ["climate", "Климат"],
  ["more", "Ещё"],
];

const modes = { off:"Выключен", heat:"Обогрев", cool:"Охлаждение", auto:"Авто", heat_cool:"Обогрев и охлаждение", fan_only:"Вентиляция", dry:"Осушение" };
const actions = { heating:"Запрос обогрева", cooling:"Запрос охлаждения", idle:"Ожидание", off:"Выключен", fan:"Вентиляция", drying:"Осушение" };
const presets = { none:"Обычный", sleep:"Сон", away:"Не дома", eco:"Эко", comfort:"Комфорт", home:"Дома", boost:"Быстрый нагрев", activity:"Активность" };
const themes = [["auto", "Авто по солнцу"], ["light", "Светлая"], ["dark", "Тёмная"]];
const palettes = {
  pistachio:{ label:"Фисташковая", swatch:"#8da176" },
  stone:{ label:"Песочная", swatch:"#b29974" },
  slate:{ label:"Сланцевая", swatch:"#718da9" },
  clay:{ label:"Терракотовая", swatch:"#ba7960" },
};
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
    this.palette = "pistachio";
    this.pending = new Map();
    this.failures = new Map();
    this.zone = 0;
    this.section = "rooms";
    this.theme = "auto";
    this.darkPreference = matchMedia("(prefers-color-scheme: dark)");
    this.onSystemThemeChange = () => this.updateTheme();
    this.bindings = [];
    this.zones = [];
    this.config = {};
    this.extra = [];
    this.hazards = [];
    this.entityIds = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem("moy-dom-view") || "{}");
      const palette = localStorage.getItem("moy-dom-palette");
      if (Object.hasOwn(palettes, palette)) this.palette = palette;
      if (Number.isInteger(saved.zone) && saved.zone >= 0) this.zone = saved.zone;
      if (sections.some(([id]) => id === saved.section)) this.section = saved.section;
      const theme = localStorage.getItem("moy-dom-theme");
      if (themes.some(([id]) => id === theme)) this.theme = theme;
    } catch { /* The panel also works with browser storage disabled. */ }
  }

  connectedCallback() {
    this.darkPreference.addEventListener("change", this.onSystemThemeChange);
    if (this.shell) return;
    const style = element("style", "", styles);
    this.shell = element("div", "shell");
    const toolbar = element("header", "toolbar");
    this.nav = element("nav", "navigation");
    this.nav.setAttribute("aria-label", "Разделы дома");
    for (const [id, name] of sections) {
      const item = button(name, () => this.select(this.zone, id));
      item.dataset.section = id;
      this.nav.append(item);
    }
    toolbar.append(element("strong", "", "Мой дом"), this.nav);
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
    this.darkPreference.removeEventListener("change", this.onSystemThemeChange);
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
    try { localStorage.setItem("moy-dom-view", JSON.stringify({ zone, section })); } catch { /* Optional preference. */ }
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
    const rooms = this.zones.flatMap(zone => zone.rooms);
    for (const item of this.nav.children) {
      if (item.dataset.section === "lights") item.hidden = !rooms.some(room => room.lights?.length);
      if (item.dataset.section === "climate") item.hidden = !rooms.some(room => room.climate || room.details?.length);
      if (item.hidden && item.dataset.section === this.section) this.section = "rooms";
    }
    if (!this.zones.length && this.section !== "more") {
      this.content.append(element("p", "muted", "Добавьте устройства в Home Assistant. Панель покажет их после подключения."));
      this.refresh();
      return;
    }
    for (const item of this.nav.children) item.setAttribute("aria-pressed", String(item.dataset.section === this.section));

    if (this.room) {
      const title = element("div", "titlebar");
      title.append(button("‹", () => this.select(this.zone, "rooms"), "back-button"), element("h1", "", this.room.name));
      title.firstChild.setAttribute("aria-label", "Назад к комнатам");
      this.content.append(title, this.roomView(this.room, false));
    } else if (this.section === "rooms") {
      this.renderHome();
    } else {
      const name = this.section === "more" ? "Настройки" : sections.find(([id]) => id === this.section)[1];
      this.content.append(element("h1", "page-title", name));
      if (this.section === "more") {
        this.renderMore();
      } else {
        this.content.append(this.floors);
        const grid = element("div", "overview-grid");
        const rooms = this.zones[this.zone].rooms.filter(room => this.section !== "climate" || room.climate || room.details?.length);
        for (const room of rooms) grid.append(this.roomView(room));
        this.content.append(grid);
        if (!rooms.length) this.content.append(element("p", "muted", "В этой зоне нет устройств климата."));
      }
    }
    this.refresh();
  }

  renderHome() {
    const grid = element("div", "overview-grid");
    const left = element("div", "stack");
    const right = element("div", "stack");
    const hero = element("section", "hero");
    const header = element("div", "hero-row");
    const title = element("div");
    const count = element("div", "hero-muted");
    title.append(element("h1", "", "Дом"), count);
    const weather = element("div", "weather");
    header.append(title, weather);
    const actions = element("div", "hero-row hero-actions");
    const off = button("Погасить свет", () => this.confirmZoneOff(), "quiet");
    off.hidden = !this.zoneLights.length;
    actions.append(element("span", "", this.zones[this.zone].name), off);
    hero.append(header, actions);
    const quick = element("section", "room");
    quick.append(element("h2", "", "Быстрый свет"));
    for (const [id, name] of this.quick) quick.append(this.lightView(id, name, "Быстрый свет", false));
    quick.hidden = !this.quick.length;

    const issues = button("", () => {
      const list = this.zoneLights.filter(({ id }) => !available(this.state(id)));
      this.showDialog("Свет недоступен", ...list.map(({name}) => element("p", "", name)));
    }, "issues");
    const failures = element("div", "error");
    failures.setAttribute("role", "status");
    const list = element("section", "room");
    list.append(element("h2", "", "Комнаты"));
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
    this.bindings.push(() => {
      const outdoor = this.state(this.config.outdoor_temperature);
      setText(weather, available(outdoor) ? valueText(outdoor.state, "°") + " на улице" : "");
      const lights = this.zoneLights;
      const on = lights.filter(({id}) => this.state(id)?.state === "on");
      const pending = lights.some(({id}) => this.pending.has(id));
      off.disabled = !this.connected || !on.length || pending;
      setText(off, pending ? "Ожидание…" : "Погасить свет");
      const total = new Set(this.zones.flatMap(zone => zone.rooms).flatMap(room => room.lights ?? [])
        .filter(([id]) => this.state(id)?.state === "on").map(([id]) => id)).size;
      setText(count, this.connected ? "Включено светильников: " + total : "Нет связи");
      const unavailable = lights.filter(({id}) => !available(this.state(id)));
      const rooms = [...new Set(unavailable.map(({name}) => name.split(" — ")[0]))];
      issues.hidden = !this.connected || !unavailable.length;
      setText(issues, rooms.join(", ") + " · свет недоступен ›");
      const failed = lights.filter(({id}) => this.failures.has(id));
      failures.hidden = !failed.length;
      setText(failures, failed.map(({name,id}) => name + ": " + this.failures.get(id)).join(" · "));
    });
    left.append(hero, quick);
    right.append(this.floors, issues, failures, list);
    grid.append(left, right);
    this.content.append(grid);
  }

  roomView(room, showName = true) {
    const section = element("section", "room");
    if (showName) section.append(element("h2", "", room.name));
    const readings = element("p", "muted");
    section.append(readings);
    this.bindings.push(() => {
      const temperature = this.state(room.temperature);
      const humidity = this.state(room.humidity);
      const values = [
        available(temperature) ? valueText(temperature.state, "°") : null,
        available(humidity) ? "Влажность " + valueText(humidity.state, "%") : null,
      ].filter(Boolean);
      readings.hidden = !values.length;
      setText(readings, values.join(" · "));
    });
    if (this.section !== "climate") {
      for (const [id, name] of room.lights ?? []) section.append(this.lightView(id, name, room.name));
    }
    if (this.section !== "lights") {
      if (room.climate) {
        const climate = element("div", "climate");
        const status = element("p", "muted");
        climate.append(element("h2", "", "Термостат"), status,
          button("Настроить климат", () => this.openClimate(room), "primary"));
        this.bindings.push(() => {
          const entity = this.state(room.climate);
          setText(status, available(entity) ?
            "Сейчас " + valueText(entity.attributes.current_temperature, "°") +
            " · задано " + valueText(entity.attributes.temperature, "°") + " · " +
            (actions[entity.attributes.hvac_action] || modes[entity.state] || entity.state) : "Термостат недоступен");
        });
        section.append(climate);
      }
      for (const [id, name] of room.details || []) section.append(this.detailsRow(id, name));
    }
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
    this.dialog.replaceChildren(header, ...children);
    this.dialog.showModal();
  }

  openClimate(room) {
    const first = this.bindings.length;
    const controls = this.climateView(room);
    const updates = this.bindings.splice(first);
    this.dialogUpdates = updates;
    this.dialog.addEventListener("close", () => {
      if (this.dialogUpdates === updates) this.dialogUpdates = null;
    }, { once:true });
    this.showDialog(room.name, controls);
    this.refresh();
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

  detailsRow(id, name) {
    const row = button("", () => this.moreInfo(id), "detail-row");
    const status = element("span", "muted");
    row.append(element("span", "", name), status, element("span", "chevron", "›"));
    this.bindings.push(() => {
      const entity = this.state(id);
      row.disabled = !entity;
      setText(status, available(entity) ? (entity.state === "on" ? "Включено" : entity.state === "off" ? "Выключено" : "Открыть") : "Недоступно");
    });
    return row;
  }

  moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  lightView(id, name, roomName, showDimmer = true) {
    const wrapper = element("div", "device");
    const row = element("div", "light-row");
    const label = element("label", "light-label");
    const state = element("span", "device-state");
    const toggle = element("input", "switch");
    toggle.type = "checkbox";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", roomName + " — " + name);
    label.append(element("span", "", name), state, toggle);
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
      toggle.checked = on;
      toggle.disabled = !this.connected || !available(entity) || pending;
      setText(state, pending ? "Ожидание ответа" : !this.connected ? "Нет связи" : !available(entity) ? "Недоступно" : on ? "Включено" : "Выключено");
      const modes = entity?.attributes?.supported_color_modes;
      const dimmable = domainOf(id) === "light" && Array.isArray(modes) && modes.some(mode => ["brightness", "color_temp", "hs", "xy", "rgb", "rgbw", "rgbww", "white"].includes(mode));
      dimmer.hidden = !showDimmer || !dimmable || !on || !available(entity);
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
    head.append(element("span", "", "Термостат"), current);
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
    const settings = button("Подробности", () => this.moreInfo(id), "quiet");
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
    const appearance = element("section", "room appearance");
    const title = element("h2", "room-name", "Внешний вид");
    appearance.append(title,
      this.appearancePicker("palette", "Цветовая палитра", Object.entries(palettes)),
      this.appearancePicker("theme", "Режим", themes),
      element("p", "muted", "Авто переключает тему по восходу и закату. Выбор сохраняется в этом браузере."));
    this.content.append(appearance);

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
      const text = element("span", "", item.label || item);
      if (item.swatch) {
        const swatch = element("i", "swatch");
        swatch.style.setProperty("--swatch", item.swatch);
        text.prepend(swatch);
      }
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
    const sun = this.state("sun.sun")?.state;
    const night = sun === "below_horizon" || (sun !== "above_horizon" && this.darkPreference.matches);
    this.shell.dataset.palette = this.palette;
    this.shell.dataset.theme = this.theme === "auto" ? (night ? "dark" : "light") : this.theme;
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
:host {display:block;height:100%;font:16px Inter,system-ui,sans-serif}
* {box-sizing:border-box}
[hidden] {display:none!important}
.shell {
  color-scheme: light;
  --surface:#eeefe6; --paper:#f9f9f2; --line:#d7dacb; --ink:#262e23; --muted:#5b6557;
  --olive:#32442e; --on:#eff5e6; --accent:#e1e8d5; --warn:#785022; --warn-bg:#f2e8d7;
  --hero:#303e2a; --hero-text:#f3f6ea; --hero-muted:#c9d5be;
}
.shell[data-theme=dark] {
  color-scheme:dark;
  --surface:#181e18; --paper:#222a22; --line:#394638; --ink:#eff2e7; --muted:#b1beac;
  --olive:#c8dfad; --on:#24311e; --accent:#34432f; --warn:#f0c48b; --warn-bg:#392e22;
  --hero:#2c3928; --hero-text:#f3f6ea; --hero-muted:#c9d5be;
}
.shell[data-palette=stone] {
  --surface:#eeece6; --paper:#faf8f3; --line:#d9d4ca; --ink:#2d2b26; --muted:#655f53;
  --olive:#544b3b; --on:#fff8ec; --accent:#e9e1d2; --hero:#4a4135; --hero-text:#fff8ec; --hero-muted:#e4d7c4;
}
.shell[data-palette=stone][data-theme=dark] {
  --surface:#201e1b; --paper:#2b2823; --line:#49433a; --ink:#f3eee3; --muted:#c9c0b1;
  --olive:#e4cba5; --on:#30271d; --accent:#453b2e; --hero:#43392d; --hero-text:#fff8ec; --hero-muted:#e4d7c4;
}
.shell[data-palette=slate] {
  --surface:#e9edf0; --paper:#f6f9fb; --line:#cfd8df; --ink:#252f39; --muted:#536373;
  --olive:#344d64; --on:#f0f7ff; --accent:#dce7ef; --hero:#2f4458; --hero-text:#f0f7ff; --hero-muted:#c9d9e7;
}
.shell[data-palette=slate][data-theme=dark] {
  --surface:#191e24; --paper:#232b34; --line:#3d4c5b; --ink:#ecf2f8; --muted:#b7c7d7;
  --olive:#b4d4ef; --on:#233549; --accent:#334557; --hero:#2d4051; --hero-text:#f0f7ff; --hero-muted:#c9d9e7;
}
.shell[data-palette=clay] {
  --surface:#f0eae6; --paper:#fcf7f3; --line:#e0d1c9; --ink:#382a25; --muted:#705b53;
  --olive:#784733; --on:#fff4ee; --accent:#f0ddd2; --hero:#663e30; --hero-text:#fff4ee; --hero-muted:#f1d2c2;
}
.shell[data-palette=clay][data-theme=dark] {
  --surface:#241c19; --paper:#322521; --line:#524039; --ink:#f6ebe4; --muted:#d3bcb0;
  --olive:#efb59b; --on:#40271e; --accent:#51372e; --hero:#4c332a; --hero-text:#fff4ee; --hero-muted:#f1d2c2;
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
h1 {font-size:clamp(1.8rem,4.5vw,3.25rem);line-height:1.06;letter-spacing:-.055em;margin:0;font-weight:650}
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
.room {min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:13px 16px}
h2 {margin:0 0 7px;font-size:1.2rem;letter-spacing:-.035em}
.room-reading {margin-left:auto;font-size:1.35rem;letter-spacing:-.055em;white-space:nowrap}
.device + .device,.room-head + .room-head {border-top:1px solid var(--line)}
.room-head {border:0;background:transparent;width:100%;display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:left;padding:18px 0}
.room-name {font-size:1.12rem;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.room-meta {display:block;color:var(--muted);font-size:.78rem;font-weight:400;margin-top:5px}
.chevron {font-size:1.25rem;font-weight:400;color:var(--olive)}
.devices {padding:0 0 16px}
.light-label {display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:center;gap:3px 12px;min-height:58px;padding:7px 0;overflow-wrap:anywhere}
.device-state {grid-row:2;grid-column:1;font-size:.73rem;color:var(--muted)}
.switch {grid-row:1/3;grid-column:2;appearance:none;width:46px;height:28px;background:var(--track);border:0;border-radius:16px;position:relative;margin:0;cursor:pointer}
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
.navigation button {border:0;background:transparent;border-radius:10px;color:var(--muted);font-size:.86rem;padding:5px 12px}
.navigation button[aria-pressed=true] {color:var(--ink);background:var(--accent);font-weight:700}
dialog {width:min(460px,calc(100% - 24px));max-height:85dvh;padding:18px;border:1px solid var(--line);border-radius:18px;background:var(--paper);color:var(--ink)}
dialog::backdrop {background:#10170db5}
.dialog-head {display:flex;justify-content:space-between;align-items:center;gap:10px}
.dialog-head button {font-size:1.4rem;min-width:44px}
.sr-only {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.appearance-group { margin:14px 0 0; padding:0; border:0; min-width:0; }
.appearance-group legend { margin-bottom:8px; padding:0; font-weight:650; }
.choices { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
.palette-choices { grid-template-columns:repeat(2,minmax(0,1fr)); }
.choice { position:relative; min-width:0; }
.choice input { position:absolute; opacity:0; width:1px; height:1px; }
.choice span { min-height:44px; display:flex; align-items:center; justify-content:center; gap:8px;
  border:1px solid var(--line); border-radius:10px; padding:5px 6px; font-size:13px; cursor:pointer; }
.choice input:checked + span { background:var(--accent); border-color:var(--olive); font-weight:650; }
.choice input:focus-visible + span { outline:2px solid var(--olive); outline-offset:2px; }
.swatch { flex:none; width:13px; height:13px; border-radius:50%; background:var(--swatch); }
.appearance-note { margin-top:9px; }

.choices.palette {grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:780px) {
  .body {padding:0 12px calc(74px + env(safe-area-inset-bottom))}
  .toolbar {min-height:46px;margin-bottom:12px}
  .navigation {position:fixed;inset:auto 0 0;z-index:2;padding:5px 8px calc(5px + env(safe-area-inset-bottom));background:var(--paper);border-top:1px solid var(--line)}
  .navigation button {flex:1;padding:4px}
  .overview-grid,.overview-grid:has(> .stack) {grid-template-columns:minmax(0,1fr);gap:12px}
  .stack {gap:12px}
  .hero {padding:15px 14px 8px}
  .hero-actions {margin-top:9px}
  .room {padding:10px 12px}
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
  name: "Мой дом",
  description: "Панель дома с автоматическим подбором помещений и устройств",
  preview: true,
});
