const card = document.querySelector("moy-dom-dashboard");
const floors = {
  downstairs: { name: "Первый этаж", level: 0 },
  upstairs: { name: "Второй этаж", level: 1 },
  garden: { name: "Участок", level: 2 },
};
const areas = {
  living: { name: "Гостиная", floor_id: "downstairs" },
  kitchen: { name: "Кухня", floor_id: "downstairs" },
  hall: { name: "Прихожая", floor_id: "downstairs" },
  bedroom: { name: "Спальня", floor_id: "upstairs" },
  yard: { name: "Сад", floor_id: "garden" },
};
const states = {};
const entities = {};
function add(entity_id, friendly_name, state, area_id, attributes = {}) {
  states[entity_id] = { entity_id, state, attributes: { friendly_name, ...attributes } };
  if (area_id) entities[entity_id] = { area_id };
}
add("light.living_main", "Потолочный свет", "on", "living", { brightness: 184, supported_color_modes: ["brightness"] });
add("light.living_floor", "Торшер", "off", "living");
add("light.living_strip", "Подсветка", "on", "living");
add("light.kitchen", "Свет на кухне", "off", "kitchen");
add("light.hall", "Свет в прихожей", "unavailable", "hall");
add("light.pendant", "Подвес", "off", "bedroom", { icon: "mdi:ceiling-light" });
add("light.spots", "Точечный свет", "off", "bedroom", { icon: "mdi:track-light" });
add("light.bedside", "Ночник", "on", "bedroom", { icon: "mdi:lamp" });
add("light.yard", "Садовые фонари", "off", "yard");
add("sensor.living_temperature", "Температура гостиной", "22.8", "living", { device_class: "temperature" });
add("sensor.kitchen_temperature", "Температура кухни", "23.4", "kitchen", { device_class: "temperature" });
add("sensor.living_humidity", "Влажность гостиной", "52", "living", { device_class: "humidity" });
add("sensor.bedroom_temperature", "Температура спальни", "21.6", "bedroom", { device_class: "temperature" });
add("sensor.outdoor_temperature", "Температура на улице", "14", null);
add("climate.living", "Термостат гостиной", "heat", "living", {
  current_temperature: 22.8, temperature: 23, min_temp: 16, max_temp: 30,
  target_temp_step: 0.5, hvac_modes: ["off", "heat", "cool"], hvac_action: "idle",
  preset_modes: ["none", "eco", "sleep"], preset_mode: "none",
});
add("climate.bedroom", "Термостат спальни", "heat", "bedroom", {
  ...states["climate.living"].attributes, friendly_name: "Термостат спальни", current_temperature: 21.6,
});
add("camera.entry", "Входная камера", "idle", null);
add("alarm_control_panel.home", "Охрана", "disarmed", null);
add("vacuum.robot", "Робот-пылесос", "docked", null);
add("media_player.tv", "Телевизор", "off", null);
add("switch.desk_outlet", "Розетка у стола", "off", "living");
add("button.restart_sensor", "Перезапустить датчик", "unknown", "hall");
add("cover.bedroom_blinds", "Шторы спальни", "closed", "bedroom");
add("scene.evening", "Вечерний свет", "unknown", null);
add("script.goodnight", "Спокойной ночи", "off", null);
add("sun.sun", "Солнце", "above_horizon", null);

const devices = {};
function publish() {
  card.hass = { states: { ...states }, areas, floors, entities, devices, connected: true, callService };
}

async function callService(domain, service, data, { entity_id }) {
  const previous = states[entity_id];
  const next = { ...previous, attributes: { ...previous.attributes } };
  if (domain === "light") {
    next.state = service === "turn_off" ? "off" : "on";
    if (data.brightness_pct !== undefined) next.attributes.brightness = Math.round(data.brightness_pct * 2.55);
  } else if (service === "set_temperature") {
    next.attributes.temperature = data.temperature;
  } else if (service === "set_hvac_mode") {
    next.state = data.hvac_mode;
    next.attributes.hvac_action = next.state === "off" ? "off" : "idle";
  } else if (service === "set_preset_mode") {
    next.attributes.preset_mode = data.preset_mode;
  }
  states[entity_id] = next;
  publish();
}

card.setConfig({ outdoor_temperature: "sensor.outdoor_temperature" });
publish();
const params = new URLSearchParams(location.search);
const panel = card.querySelector("moy-dom-panel");
if (params.get("room") === "bedroom") {
  panel.zone = panel.zones.findIndex(zone => zone.rooms.some(room => room.id === "area:bedroom"));
  panel.room = panel.zones[panel.zone].rooms.find(room => room.id === "area:bedroom");
  panel.section = "rooms";
  panel.renderSection();
}
const picker = document.getElementById("theme");
const requested = params.get("theme");
if (requested === "dark" || requested === "light") panel.theme = requested;
picker.value = panel.theme;
picker.addEventListener("change", () => {
  panel.theme = picker.value;
  try { localStorage.setItem("moy-dom-theme", picker.value); } catch { /* Optional preference. */ }
  const option = panel.shadowRoot.querySelector('input[name="theme"][value="' + picker.value + '"]');
  if (option) option.checked = true;
  panel.updateTheme();
});
panel.shadowRoot.addEventListener("change", () => { picker.value = panel.theme; });
panel.updateTheme();

if (params.get("view") === "climate" && panel.room?.climate) panel.openClimate(panel.room);

const details = document.getElementById("details");
card.addEventListener("hass-more-info", event => {
  const state = states[event.detail.entityId];
  if (!state) return;
  details.querySelector("h2").textContent = state.attributes.friendly_name;
  details.querySelector("p").textContent = "Состояние в демо: " + state.state;
  details.showModal();
});
