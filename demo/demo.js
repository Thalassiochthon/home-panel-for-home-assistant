const card = document.querySelector("moy-dom-dashboard");
const floors = {
  downstairs: { name: "Первый этаж", level: 0 },
  upstairs: { name: "Второй этаж", level: 1 },
  garden: { name: "Участок", level: 2 },
};
const areas = {
  living: { name: "Кухня-гостиная", floor_id: "downstairs" },
  bath: { name: "Ванная", floor_id: "downstairs" },
  veranda: { name: "Веранда", floor_id: "downstairs" },
  landing: { name: "Тамбур", floor_id: "upstairs" },
  dressing: { name: "Гардероб", floor_id: "upstairs" },
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
add("light.bath", "Основной свет", "off", "bath");
add("light.living_strip", "LED-подсветка", "on", "living");
add("light.kitchen", "Свет на кухне", "off", "living");
add("light.hall", "Свет в прихожей", "unavailable", "hall");
add("light.porch", "Свет веранды", "off", "veranda");
add("light.landing", "Основной свет", "off", "landing");
add("light.dressing", "Основной свет", "off", "dressing");
add("light.pendant", "Подвес", "off", "bedroom", { icon: "mdi:ceiling-light" });
add("light.spots", "Точечный свет", "off", "bedroom", { icon: "mdi:track-light" });
add("light.bedside", "Ночник", "on", "bedroom", { icon: "mdi:lamp" });
add("light.yard", "Садовые фонари", "off", "yard");
add("sensor.living_temperature", "Температура гостиной", "23.2", "living", { device_class: "temperature", unit_of_measurement: "°C" });
add("sensor.veranda_temperature", "Температура веранды", "10.5", "veranda", { device_class: "temperature", unit_of_measurement: "°C" });
add("sensor.living_humidity", "Влажность гостиной", "52", "living", { device_class: "humidity", unit_of_measurement: "%" });
add("sensor.bedroom_temperature", "Температура спальни", "23.7", "bedroom", { device_class: "temperature", unit_of_measurement: "°C" });
add("sensor.bedroom_humidity", "Влажность спальни", "46", "bedroom", { device_class: "humidity", unit_of_measurement: "%" });
add("sensor.outdoor_temperature", "Температура на улице", "14", null, { unit_of_measurement:"°C" });
add("climate.living", "Термостат гостиной", "heat", "living", {
  current_temperature: 23.2, temperature: 23, min_temp: 16, max_temp: 30,
  target_temp_step: 0.5, hvac_modes: ["off", "heat", "cool"], hvac_action: "idle",
  preset_modes: ["none", "eco", "sleep"], preset_mode: "none",
});
add("climate.bedroom", "Термостат спальни", "heat", "bedroom", {
  ...states["climate.living"].attributes, friendly_name: "Термостат спальни", current_temperature: 23.7,
});
add("climate.living_remote", "Пульт кухни-гостиной", "off", "living");
add("climate.bedroom_remote", "Пульт спальни", "off", "bedroom");
add("climate.veranda", "Термостат веранды", "heat", "veranda", {
  ...states["climate.living"].attributes, current_temperature:10.5, temperature:8, min_temp:3,
});
add("sensor.system_status", "Состояние системы", "В сети", null);
add("automation.night", "Ночное освещение", "on", null);
add("camera.entry", "Входная камера", "idle", null);
add("alarm_control_panel.home", "Охрана", "disarmed", null);
add("vacuum.robot", "Робот-пылесос", "docked", null);
add("media_player.tv", "Телевизор", "off", null);
add("switch.desk_outlet", "Розетка у стола", "off", "living");
add("button.restart_sensor", "Перезапустить датчик", "unknown", "hall");
add("cover.bedroom_blinds", "Шторы спальни", "closed", "bedroom");
add("binary_sensor.occupied", "Присутствие", "on", null);
add("scene.night", "Спокойной ночи", "unknown", null);
add("scene.arrival", "Вернулись домой", "unknown", null);
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

const params = new URLSearchParams(location.search);
const previewPower = params.get("meter") === "heater";
if (previewPower) add("sensor.heater_power", "Розетка конвектора", "840", null, { device_class:"power", unit_of_measurement:"W" });
const layout = discover({ states, entities, areas, floors, devices });
for (const room of layout.zones.flatMap(zone => zone.rooms)) {
  const remote = room.details.find(([id]) => id.endsWith("_remote"));
  if (remote) room.ir = remote[0];
}
card.setConfig({
  zones: layout.zones,
  more: [...layout.more, ["Автоматизация ночного света", "automation.night"], ["Состояние системы", "sensor.system_status"]],
  quick_lights: [["light.bedside", "Ночник"]],
  summary_rooms: ["area:living", "area:bedroom"],
  ...(previewPower ? { power_meter: "sensor.heater_power" } : {}),
  outdoor_temperature: "sensor.outdoor_temperature", presence: "binary_sensor.occupied", alarm: "alarm_control_panel.home",
  home_scenes: [["scene.night", "Спокойной ночи"], ["scene.arrival", "Вернулись домой"]],
});
publish();
const panel = card.querySelector("moy-dom-panel");
if (params.get("view") === "home") panel.select(0, "home");
if (params.get("room") === "bedroom") {
  panel.zone = panel.zones.findIndex(zone => zone.rooms.some(room => room.id === "area:bedroom"));
  panel.room = panel.zones[panel.zone].rooms.find(room => room.id === "area:bedroom");
  panel.section = "rooms";
  panel.renderSection();
}
const requested = params.get("theme");
if (requested === "dark" || requested === "light") panel.theme = requested;
const badge = document.createElement("small");
badge.className = "demo-badge";
badge.textContent = "Демо";
badge.title = "Виртуальные устройства";
panel.shadowRoot.querySelector(".toolbar > strong").append(badge);
panel.updateTheme();

if (params.get("view") === "climate" && panel.room?.climate) panel.openClimate(panel.room);

const details = document.getElementById("details");
const plans = {
  "scene.night": { description: "Основной свет в гостиной и спальне погаснет, ночник включится. Термостат спальни перейдёт в режим «Сон».",
    lights: { "light.living_main":"off", "light.pendant":"off", "light.bedside":"on" }, preset:"sleep" },
  "scene.arrival": { description: "Включится потолочный свет в гостиной. Термостат спальни вернётся в обычный режим. Охрана управляется отдельно.",
    lights: { "light.living_main":"on" }, preset:"none" },
};
const run = document.createElement("button");
run.type = "button";
run.textContent = "Попробовать в демо";
details.querySelector("form").prepend(run);
card.addEventListener("hass-more-info", event => {
  const state = states[event.detail.entityId];
  if (!state) return;
  details.querySelector("h2").textContent = state.attributes.friendly_name;
  details.querySelector("p").textContent = "Состояние в демо: " + state.state;
  const plan = plans[event.detail.entityId];
  run.hidden = !plan;
  run.onclick = null;
  if (plan) {
    details.querySelector("p").textContent = "Концепт сценария. " + plan.description;
    run.onclick = () => {
      for (const [id, value] of Object.entries(plan.lights)) states[id] = { ...states[id], state:value };
      const thermostat = states["climate.bedroom"];
      states["climate.bedroom"] = { ...thermostat, attributes:{ ...thermostat.attributes, preset_mode:plan.preset } };
      publish();
      details.querySelector("p").textContent = "Сценарий выполнен в демо.";
      run.hidden = true;
      details.querySelector('button:not([hidden])').focus();
    };
  } else if (state.entity_id === "alarm_control_panel.home") {
    details.querySelector("p").textContent = "Охрана снята. Это демонстрация статуса Alarmo.";
  }
  details.showModal();
});
