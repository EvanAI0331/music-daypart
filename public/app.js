const apiBase = window.MUSIC_API_BASE || "http://127.0.0.1:8787";
const checksEl = document.querySelector("#checks");
const loginResultEl = document.querySelector("#login-result");
const readyEl = document.querySelector("#ready-pill");
const scheduleEl = document.querySelector("#schedule");
const audioEl = document.querySelector("#audio");
const loginActionEl = document.querySelector("#login-action");
let editableConfig = null;
const volumeSlider = document.querySelector("#volume-slider");
const volumeNumber = document.querySelector("#volume-number");
let scheduleRendered = false;
let volumeApplyTimer = null;
let lastAppliedVolume = null;
let isEditingVolume = false;
let activePanel = "schedule";

function cls(ok) {
  return ok ? "ok" : "bad";
}

async function fetchJson(path, options) {
  const response = await fetch(`${apiBase}${path}`, options);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

async function refresh() {
  const data = await fetchJson("/api/health");
  if (!editableConfig) await loadConfig();
  readyEl.textContent = data.ok ? "就绪" : "阻塞";
  readyEl.className = `pill ${data.ok ? "ok" : "bad"}`;

  checksEl.innerHTML = data.checks.map((check) => `
    <div class="status ${cls(check.ok)}">
      <div class="label">${check.name}</div>
      <div class="value"><span class="dot"></span>${check.detail || (check.ok ? "正常" : "失败")}</div>
    </div>
  `).join("");
  syncLoginAction(data.checks);

  if (!scheduleRendered) {
    renderSchedule(data);
  } else {
    updateScheduleActiveSlot(data.slot.id);
  }

  const outputDevices = Array.isArray(data.audio?.outputDevices) ? data.audio.outputDevices : [];
  const speakers = Array.isArray(data.audio?.speakers) ? data.audio.speakers : [];
  const outputDeviceName = data.audio?.outputDeviceName || "";
  const currentOutput = data.audio?.currentOutput || "";
  audioEl.innerHTML = [
    outputDevices.length > 0
      ? `<div class="audio-device-list">
      ${outputDevices.map((name) => `
        <button class="device-option ${name === currentOutput ? "active" : ""}" data-output-device="${escapeAttr(name)}">
          <span>${escapeText(name)}</span>
          <small>${name === currentOutput ? "当前输出" : "点击选择"}</small>
        </button>
      `).join("")}
    </div>`
      : `<div class="speaker">
        <div><b>音频输出</b><br><small>当前 Mac 未安装 SwitchAudioSource，已使用系统默认输出</small></div>
        <span class="pill ok">默认</span>
      </div>`,
    ...speakers.map((speaker) => `
      <div class="speaker">
        <div><b>${speaker.name}</b><br><small>${speaker.address || speaker.error || "Bluetooth output"}</small></div>
        <span class="pill ${speaker.connected ? "ok" : "bad"}">${speaker.connected ? "已连接" : "未连接"}</span>
      </div>
    `),
    `<div class="speaker">
      <div><b>${escapeText(outputDeviceName || "系统默认输出")}</b><br><small>当前输出：${escapeText(currentOutput || "系统默认")}</small></div>
      <span class="pill ${!outputDeviceName || currentOutput === outputDeviceName ? "ok" : "bad"}">${!outputDeviceName || currentOutput === outputDeviceName ? "可用" : "不匹配"}</span>
    </div>`
  ].join("");
  bindOutputDeviceButtons();

  document.querySelector("#slot").textContent = data.slot.id;
  document.querySelector("#player").textContent = data.nowPlaying || "-";
  document.querySelector("#daemon").textContent = data.nextTrack || "-";
  syncVolumeControls(data.audio?.volume?.actual ?? data.audio?.volume?.configured);
}

function syncLoginAction(checks) {
  const loginCheck = checks.find((check) => check.name === "网易云登录");
  const loggedIn = loginCheck?.ok === true;
  loginActionEl.textContent = loggedIn ? "已登录" : "登录";
  loginActionEl.disabled = loggedIn;
}

function renderSchedule(data) {
  scheduleEl.innerHTML = (editableConfig?.slots || []).map((slot, index) => `
    <article class="slot-card">
      <div class="slot-card-head">
        <label class="slot-toggle">
          <input class="slot-enabled" type="checkbox" data-slot="${index}" data-field="enabled" ${slot.enabled !== false ? "checked" : ""}>
          <span></span>
        </label>
        <span class="slot-id pill ${slot.id === data.slot.id ? "ok" : ""}">${slot.id}</span>
        <span class="slot-window">${escapeText(slot.start)}-${escapeText(slot.end)}</span>
      </div>
      <div class="slot-times">
        <label><span>开始</span><input data-slot="${index}" data-field="start" value="${escapeAttr(slot.start)}" aria-label="${escapeAttr(slot.id)} 开始时间"></label>
        <label><span>结束</span><input data-slot="${index}" data-field="end" value="${escapeAttr(slot.end)}" aria-label="${escapeAttr(slot.id)} 结束时间"></label>
      </div>
      <label class="slot-field"><span>氛围</span><input data-slot="${index}" data-field="intent" value="${escapeAttr(slot.intent)}" aria-label="${escapeAttr(slot.id)} 氛围" placeholder="只影响选歌方向，不直接搜索"></label>
      <label class="slot-field"><span>偏好关键词</span><textarea class="slot-keywords" data-slot="${index}" data-field="keywords" placeholder="用于画像和策略，不会直接照抄搜索">${escapeText((slot.keywords || []).join('\n'))}</textarea></label>
      <label class="slot-field"><span>反向关键词</span><textarea class="slot-keywords negative" data-slot="${index}" data-field="negativeKeywords" placeholder="排除或禁止的风格、歌手、场景；每行一个">${escapeText((slot.negativeKeywords || []).join('\n'))}</textarea></label>
    </article>
  `).join("");
  scheduleRendered = true;
  bindConfigInputs();
  setActivePanel(activePanel);
}

async function loadConfig() {
  const payload = await fetchJson("/api/config");
  editableConfig = payload.config;
  const volume = Number(editableConfig.playback?.volume ?? 50);
  syncVolumeControls(volume, true);
}

function bindConfigInputs() {
  for (const input of document.querySelectorAll("[data-slot]")) {
    const updateSlot = () => {
      const slot = editableConfig.slots[Number(input.dataset.slot)];
      if (input.dataset.field === "enabled") {
        slot.enabled = input.checked;
      } else if (input.dataset.field === "keywords") {
        slot.keywords = input.value.split(/[\n,，、]/).map((item) => item.trim()).filter(Boolean);
      } else if (input.dataset.field === "negativeKeywords") {
        slot.negativeKeywords = input.value.split(/[\n,，、]/).map((item) => item.trim()).filter(Boolean);
      } else {
        slot[input.dataset.field] = input.value;
      }
    };
    input.addEventListener("input", updateSlot);
    if (input.type === "checkbox") input.addEventListener("change", updateSlot);
  }
}

function updateScheduleActiveSlot(slotId) {
  for (const pill of scheduleEl.querySelectorAll(".slot-id")) {
    pill.classList.toggle("ok", pill.textContent === slotId);
  }
}

async function saveConfig(button) {
  button.disabled = true;
  try {
    editableConfig.playback = editableConfig.playback || {};
    editableConfig.playback.volume = normalizedVolume(volumeNumber.value);
    const result = await fetchJson("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: editableConfig })
    });
    editableConfig = result.config;
    scheduleRendered = false;
    await refresh();
  } catch (error) {
    readyEl.textContent = `保存失败：${error.message}`;
    readyEl.className = "pill bad";
  } finally {
    button.disabled = false;
  }
}

async function applyVolumeNow(volume) {
  try {
    if (volume === lastAppliedVolume) return;
    const result = await fetchJson("/api/volume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ volume })
    });
    const actual = result.result.actualVolume ?? result.result.volume;
    lastAppliedVolume = actual;
    syncVolumeControls(actual, true);
    if (editableConfig) {
      editableConfig.playback = editableConfig.playback || {};
      editableConfig.playback.volume = actual;
    }
    readyEl.textContent = `音量 ${actual}`;
    readyEl.className = "pill ok";
  } catch (error) {
    readyEl.textContent = `音量失败：${error.message}`;
    readyEl.className = "pill bad";
  }
}

function scheduleVolumeApply(volume) {
  clearTimeout(volumeApplyTimer);
  volumeApplyTimer = setTimeout(() => {
    applyVolumeNow(volume);
  }, 180);
}

function syncVolumeControls(value, force = false) {
  const volume = normalizedVolume(value);
  if (!force && isEditingVolume) return;
  volumeSlider.value = String(volume);
  volumeNumber.value = String(volume);
  lastAppliedVolume = volume;
  if (editableConfig) {
    editableConfig.playback = editableConfig.playback || {};
    editableConfig.playback.volume = volume;
  }
}

async function runAction(action, button) {
  button.disabled = true;
  try {
    const result = await fetchJson("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });
    if (action === "doctor") {
      readyEl.textContent = result.result.ok ? "自检通过" : "自检阻塞";
      readyEl.className = `pill ${result.result.ok ? "ok" : "bad"}`;
      setActivePanel("status");
      return;
    }
    if (action === "login") {
      showLoginResult(result.result);
      readyEl.textContent = "登录已发起";
      readyEl.className = "pill ok";
      setActivePanel("status");
      return;
    }
    readyEl.textContent = `${action} 完成`;
    readyEl.className = "pill ok";
  } catch (error) {
    readyEl.textContent = `${actionLabel(action)}失败：${error.message}`;
    readyEl.className = "pill bad";
  } finally {
    button.disabled = false;
    await refresh();
  }
}

function showLoginResult(result) {
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {}
  const link = findLoginLink(raw);
  const message = result.status === "already_logged_in"
    ? "当前已经登录，无需重复授权"
    : payload?.message || result.status || "已启动后台登录流程";
  loginResultEl.innerHTML = `
    <div class="login-card">
      <strong>网易云登录</strong>
      <small>${escapeText(message)}</small>
      ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">打开登录链接</a>` : ""}
      ${raw ? `<pre>${escapeText(raw)}</pre>` : ""}
    </div>
  `;
}

function findLoginLink(text) {
  return String(text || "").match(/https?:\/\/[^\s"'<>]+/)?.[0] || "";
}

function actionLabel(action) {
  const map = {
    doctor: "自检",
    login: "登录",
    "run-once": "播放",
    pause: "暂停",
    stop: "停止",
    state: "状态"
  };
  return map[action] || action;
}

async function setOutputDevice(name, button) {
  button.disabled = true;
  try {
    const result = await fetchJson("/api/output-device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (editableConfig) {
      editableConfig.playback = editableConfig.playback || {};
      editableConfig.playback.outputDeviceName = result.result.outputDeviceName;
    }
    readyEl.textContent = `输出 ${result.result.outputDeviceName}`;
    readyEl.className = "pill ok";
    await refresh();
  } catch (error) {
    readyEl.textContent = `输出失败：${error.message}`;
    readyEl.className = "pill bad";
  } finally {
    button.disabled = false;
  }
}

function bindOutputDeviceButtons() {
  for (const button of document.querySelectorAll("[data-output-device]")) {
    button.addEventListener("click", () => setOutputDevice(button.dataset.outputDevice, button));
  }
}

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => runAction(button.dataset.action, button));
}
document.querySelector("#save-config").addEventListener("click", (event) => saveConfig(event.currentTarget));
for (const button of document.querySelectorAll("[data-panel-tab]")) {
  button.addEventListener("click", () => setActivePanel(button.dataset.panelTab));
}
volumeSlider.addEventListener("input", () => {
  isEditingVolume = true;
  const volume = normalizedVolume(volumeSlider.value);
  volumeNumber.value = String(volume);
  if (editableConfig) {
    editableConfig.playback = editableConfig.playback || {};
    editableConfig.playback.volume = volume;
  }
  scheduleVolumeApply(volume);
});
volumeNumber.addEventListener("input", () => {
  isEditingVolume = true;
  const volume = normalizedVolume(volumeNumber.value);
  volumeSlider.value = String(volume);
  if (editableConfig) {
    editableConfig.playback = editableConfig.playback || {};
    editableConfig.playback.volume = volume;
  }
  scheduleVolumeApply(volume);
});
volumeSlider.addEventListener("change", () => { isEditingVolume = false; });
volumeNumber.addEventListener("change", () => { isEditingVolume = false; });

refresh().catch((error) => {
  readyEl.textContent = "后端离线";
  readyEl.className = "pill bad";
});
setInterval(() => refresh().catch(() => {}), 5000);

function setActivePanel(panelName) {
  activePanel = panelName;
  for (const button of document.querySelectorAll("[data-panel-tab]")) {
    button.classList.toggle("active", button.dataset.panelTab === panelName);
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.classList.toggle("active", panel.dataset.panel === panelName);
  }
}

function translateState(value) {
  const map = {
    stopped: "已停止",
    playing: "播放中",
    paused: "已暂停",
    state: "状态正常",
    unknown: "未知"
  };
  return map[value] || value;
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizedVolume(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(60, Math.round(parsed)));
}
