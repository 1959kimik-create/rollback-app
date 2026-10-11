const DB_NAME = "rollback-memory-v1";
const DB_STORE = "sessions";
const DB_SETTINGS_STORE = "settings";
const DOWNLOAD_DIRECTORY_KEY = "download-directory";
const ACCOUNT_KEY = "rollback-account-v1";
const PREFERENCES_KEY = "rollback-preferences-v1";
const OSM_TILE_SIZE = 256;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const screens = $$(".screen");
const maps = new WeakMap();
function preferencesKey(user) {
  return `${PREFERENCES_KEY}:${encodeURIComponent(user)}`;
}

function getAccounts() {
  const rawAccounts = localStorage.getItem(ACCOUNT_KEY);
  if (!rawAccounts) return [];
  const saved = JSON.parse(rawAccounts);
  if (Array.isArray(saved)) {
    if (!saved.every(account => account && typeof account.id === "string" && typeof account.passwordHash === "string")) {
      throw new Error("저장된 계정 정보를 읽을 수 없습니다.");
    }
    return saved;
  }
  if (!saved || typeof saved.id !== "string" || typeof saved.passwordHash !== "string") {
    throw new Error("저장된 계정 정보를 읽을 수 없습니다.");
  }
  const legacyPreferences = localStorage.getItem(PREFERENCES_KEY);
  if (legacyPreferences !== null) {
    const key = preferencesKey(saved.id);
    if (localStorage.getItem(key) === null) localStorage.setItem(key, legacyPreferences);
  }
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify([saved]));
  return [saved];
}

const state = {
  user: null,
  preferences: { gps: false, audio: false, camera: false },
  activeSession: null,
  watchId: null,
  recording: false,
  paused: false,
  wakeLock: null,
  currentPosition: null,
  reviewSession: null,
  modalStream: null,
  recorder: null,
  audioCapture: null,
  modalUrls: [],
  downloadDirectory: null,
  downloadTargetDirectory: null,
  toastTimer: null,
  db: null
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("이 브라우저에서는 기록 저장소를 사용할 수 없습니다."));
      return;
    }
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(DB_SETTINGS_STORE)) {
        request.result.createObjectStore(DB_SETTINGS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("기록 저장소를 열지 못했습니다."));
  });
}

function saveSession(session) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(session);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("기록 저장에 실패했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("기록 저장이 취소되었습니다."));
  });
}

function getAllSessions() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    request.onerror = () => reject(request.error || new Error("기록을 불러오지 못했습니다."));
  });
}

function getSession(id) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("기록을 불러오지 못했습니다."));
  });
}

function getSavedDownloadDirectory() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(DB_SETTINGS_STORE, "readonly")
      .objectStore(DB_SETTINGS_STORE).get(DOWNLOAD_DIRECTORY_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("저장 폴더 설정을 불러오지 못했습니다."));
  });
}

function saveDownloadDirectory(handle) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(DB_SETTINGS_STORE, "readwrite");
    transaction.objectStore(DB_SETTINGS_STORE).put(handle, DOWNLOAD_DIRECTORY_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("저장 폴더 설정을 저장하지 못했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("저장 폴더 설정 저장이 취소되었습니다."));
  });
}

function deleteSession(id) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("기록 삭제에 실패했습니다."));
  });
}

function deleteUserSessions(user) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(DB_STORE, "readwrite");
    const request = transaction.objectStore(DB_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.user === user) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("계정 기록을 삭제하지 못했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("계정 기록 삭제가 취소되었습니다."));
  });
}

function showScreen(id) {
  screens.forEach(screen => screen.classList.toggle("hidden", screen.id !== id));
  window.scrollTo(0, 0);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function setMessage(selector, message) {
  $(selector).textContent = message;
}

function safeText(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date(date));
}

async function hashPassword(password) {
  if (!window.crypto || !crypto.subtle) throw new Error("안전한 비밀번호 저장을 지원하는 브라우저가 필요합니다.");
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRecoveryCode(code) {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

function addPasswordVisibilityToggles(root = document) {
  $$('input[type="password"]', root).forEach(input => {
    const field = document.createElement("div");
    field.className = "password-field";
    input.before(field);
    field.append(input);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "password-visibility";
    toggle.textContent = "보기";
    const label = root.querySelector(`label[for="${input.id}"]`);
    const fieldName = label ? label.textContent.trim() : "비밀번호";
    toggle.setAttribute("aria-label", `${fieldName} 표시`);
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", () => {
      const showPassword = input.type === "password";
      input.type = showPassword ? "text" : "password";
      toggle.textContent = showPassword ? "숨기기" : "보기";
      toggle.setAttribute("aria-label", `${fieldName} ${showPassword ? "숨기기" : "표시"}`);
      toggle.setAttribute("aria-pressed", String(showPassword));
      input.focus();
    });
    field.append(toggle);
  });
}

function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{1,8}/g).join("-");
}

function showRecoveryCode(code, message) {
  const body = openModal("복구 코드 보관", message);
  body.innerHTML = '<p class="recovery-warning">이 코드는 비밀번호를 잊었을 때 필요합니다. 안전한 곳에 보관하세요. 이 화면을 닫으면 다시 확인할 수 없습니다.</p><code class="recovery-code"></code><p id="recovery-code-message" class="form-message" aria-live="polite"></p><div class="modal-actions"><button class="button button-outline" type="button" id="copy-recovery-code">복사</button><button class="button button-dark" type="button" id="finish-recovery-code">확인하고 계속</button></div>';
  $(".recovery-code", body).textContent = code;
  $("#copy-recovery-code", body).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      $("#recovery-code-message", body).textContent = "복구 코드를 복사했습니다.";
      $("#recovery-code-message", body).classList.remove("error");
    } catch (error) {
      console.error("복구 코드를 클립보드에 복사하지 못했습니다.", error);
      $("#recovery-code-message", body).textContent = "복사하지 못했습니다. 코드를 길게 눌러 직접 복사해 주세요.";
      $("#recovery-code-message", body).classList.add("error");
    }
  });
  $("#finish-recovery-code", body).addEventListener("click", closeModal);
}

function openPasswordRecoveryModal() {
  const body = openModal("비밀번호 찾기", "계정 아이디와 복구 코드를 입력해 새 비밀번호를 설정하세요.");
  body.innerHTML = `
    <form id="password-recovery-form">
      <label class="field-label" for="recovery-user-id">아이디</label>
      <input id="recovery-user-id" name="recovery-user-id" autocomplete="username" placeholder="아이디를 입력하세요" required maxlength="32">
      <label class="field-label" for="recovery-code">복구 코드</label>
      <input id="recovery-code" name="recovery-code" autocomplete="off" placeholder="복구 코드를 입력하세요" required>
      <label class="field-label" for="recovery-new-password">새 비밀번호</label>
      <input id="recovery-new-password" name="recovery-new-password" type="password" autocomplete="new-password" placeholder="4자 이상 입력하세요" required minlength="4" maxlength="64">
      <label class="field-label" for="recovery-confirm-password">새 비밀번호 확인</label>
      <input id="recovery-confirm-password" name="recovery-confirm-password" type="password" autocomplete="new-password" placeholder="새 비밀번호를 한 번 더 입력하세요" required minlength="4" maxlength="64">
      <p id="password-recovery-message" class="form-message" aria-live="polite"></p>
      <div class="modal-actions">
        <button class="button button-outline" type="button" id="cancel-password-recovery">취소</button>
        <button class="button button-dark" type="submit">비밀번호 재설정</button>
      </div>
    </form>`;
  addPasswordVisibilityToggles(body);
  $("#recovery-user-id", body).focus();
  $("#cancel-password-recovery", body).addEventListener("click", closeModal);
  $("#password-recovery-form", body).addEventListener("submit", async event => {
    event.preventDefault();
    const id = $("#recovery-user-id", body).value.trim();
    const code = normalizeRecoveryCode($("#recovery-code", body).value);
    const password = $("#recovery-new-password", body).value;
    const confirmation = $("#recovery-confirm-password", body).value;
    const message = $("#password-recovery-message", body);
    if (password !== confirmation) {
      message.textContent = "새 비밀번호가 서로 일치하지 않습니다.";
      $("#recovery-confirm-password", body).focus();
      return;
    }
    const submit = $("button[type='submit']", body);
    submit.disabled = true;
    try {
      const accounts = getAccounts();
      const account = accounts.find(item => item.id === id);
      const codeHash = await hashPassword(code);
      if (!account || !account.recoveryCodeHash || account.recoveryCodeHash !== codeHash) {
        message.textContent = "아이디 또는 복구 코드가 올바르지 않습니다.";
        return;
      }
      const recoveryCode = generateRecoveryCode();
      const passwordHash = await hashPassword(password);
      const recoveryCodeHash = await hashPassword(normalizeRecoveryCode(recoveryCode));
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(accounts.map(item =>
        item.id === id ? { ...item, passwordHash, recoveryCodeHash } : item
      )));
      closeModal();
      showRecoveryCode(recoveryCode, "비밀번호를 변경했습니다. 다음 복구에 사용할 새 코드를 보관하세요. 이전 코드는 더 이상 사용할 수 없습니다.");
      setMessage("#login-message", "비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요.");
    } catch (error) {
      console.error("비밀번호를 재설정하지 못했습니다.", error);
      message.textContent = error.message || "비밀번호를 재설정하지 못했습니다.";
    } finally {
      if (submit.isConnected) submit.disabled = false;
    }
  });
}

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey(state.user)) || "{}");
    state.preferences = { gps: !!saved.gps, audio: !!saved.audio, camera: !!saved.camera };
  } catch (error) {
    console.error("기능 설정을 읽지 못했습니다.", error);
  }
}

function persistPreferences() {
  state.preferences = {
    gps: $("#setting-gps").checked,
    audio: $("#setting-audio").checked,
    camera: $("#setting-camera").checked
  };
  localStorage.setItem(preferencesKey(state.user), JSON.stringify(state.preferences));
}

function renderPreferences() {
  $("#setting-gps").checked = state.preferences.gps;
  $("#setting-audio").checked = state.preferences.audio;
  $("#setting-camera").checked = state.preferences.camera;
}

function configureHome() {
  const now = new Date();
  $("#today-label").textContent = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(now).toUpperCase();
  $("#record-toggle").disabled = !state.preferences.gps;
  $("#pause-recording").disabled = !state.preferences.gps || !state.recording;
  $("#pause-recording").hidden = !state.preferences.gps;
  updateCaptureCard("voice", state.preferences.audio, "생각을 목소리로");
  updateCaptureCard("camera", state.preferences.camera, "순간을 눈에 담기");
  $("#location-status").innerHTML = `<i class="status-dot"></i>${state.preferences.gps ? "위치 기록 사용 가능" : "위치 기록 꺼짐"}`;
  renderMap(state.activeSession ? state.activeSession.route : [], state.activeSession ? state.activeSession.events : [], $("#map-canvas"));
}

function updateCaptureCard(action, enabled, description) {
  $$(`[data-action="${action}"]`).forEach(button => {
    button.disabled = false;
    button.removeAttribute("aria-disabled");
    button.classList.toggle("disabled-card", !enabled);
    $("small", button).textContent = enabled ? description : "설정에서 기능 켜기";
  });
}

function openFeatureSettings(feature) {
  renderPreferences();
  setMessage("#settings-message", "사용할 기능을 켠 뒤 시작하기를 눌러주세요.");
  showScreen("settings-screen");
  $(`#setting-${feature}`).focus();
}

function newSession() {
  const startedAt = new Date().toISOString();
  const date = dateKey(startedAt);
  state.activeSession = {
    id: makeId(),
    user: state.user,
    startedAt,
    date,
    sequence: 0,
    route: [],
    events: [],
    endedAt: null
  };
}

function getPosition() {
  if (!navigator.geolocation) {
    showToast(window.isSecureContext
      ? "이 브라우저는 위치 기록을 지원하지 않습니다."
      : "위치 기록은 HTTPS로 접속해야 사용할 수 있습니다.");
    return;
  }
  navigator.geolocation.getCurrentPosition(position => {
    addWaypoint(position);
    if (!state.recording || state.paused) return;
    state.watchId = navigator.geolocation.watchPosition(addWaypoint, locationError, {
      enableHighAccuracy: true, maximumAge: 5000, timeout: 15000
    });
  }, locationError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

function locationError(error) {
  const reasons = {
    1: "위치 권한이 허용되지 않았어요. 브라우저 설정에서 권한을 확인해 주세요.",
    2: "현재 위치를 확인할 수 없어요. GPS 신호를 확인해 주세요.",
    3: "위치 확인 시간이 초과됐어요. 다시 출발해 주세요."
  };
  $("#location-status").innerHTML = `<i class="status-dot"></i>위치 확인 필요`;
  showToast(reasons[error.code] || "위치 정보를 확인하지 못했습니다.");
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

function addWaypoint(position) {
  if (!state.activeSession || state.paused) return;
  const point = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: new Date(position.timestamp).toISOString()
  };
  const last = state.activeSession.route.at(-1);
  if (!last || Math.abs(point.lat - last.lat) + Math.abs(point.lon - last.lon) > 0.00001) {
    state.activeSession.route.push(point);
    state.currentPosition = point;
    estimateAudioEventPositions(state.activeSession);
    renderMap(state.activeSession.route, state.activeSession.events, $("#map-canvas"));
  }
  $("#location-status").innerHTML = '<i class="status-dot" style="background:#5f8b67"></i>위치 기록 중';
  $("#coordinate-label").textContent = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  $("#point-count").textContent = `${state.activeSession.route.length}개 위치`;
}

function estimateAudioEventPositions(session) {
  const routePoints = (session.route || []).map(point => ({ ...point, source: "route" }));
  const mediaPoints = (session.events || [])
    .filter(event => event.type !== "audio" && event.position)
    .map(event => ({ ...event.position, timestamp: event.timestamp, source: event.type }));
  const anchors = [...routePoints, ...mediaPoints]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  session.events.forEach(event => {
    if (event.type !== "audio" || (event.position && !event.positionEstimated) || anchors.length === 0) return;
    const time = new Date(event.timestamp).getTime();
    const before = [...anchors].reverse().find(anchor => new Date(anchor.timestamp).getTime() <= time);
    const after = anchors.find(anchor => new Date(anchor.timestamp).getTime() >= time);
    if (before && after && before !== after) {
      const start = new Date(before.timestamp).getTime();
      const duration = new Date(after.timestamp).getTime() - start;
      const ratio = duration > 0 ? (time - start) / duration : 0;
      event.position = {
        lat: before.lat + (after.lat - before.lat) * ratio,
        lon: before.lon + (after.lon - before.lon) * ratio
      };
      event.positionEstimated = true;
      return;
    }
    const nearest = anchors.reduce((best, anchor) => {
      if (!best) return anchor;
      return Math.abs(new Date(anchor.timestamp).getTime() - time) < Math.abs(new Date(best.timestamp).getTime() - time) ? anchor : best;
    }, null);
    event.position = { lat: nearest.lat, lon: nearest.lon };
    event.positionEstimated = true;
  });
}

function renderMap(route, events, target, onEventClick) {
  let map = maps.get(target);
  if (!map) {
    const tiles = document.createElement("div");
    tiles.className = "osm-tiles";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("osm-route");
    svg.setAttribute("preserveAspectRatio", "none");
    const message = document.createElement("p");
    message.className = "map-message";
    message.setAttribute("aria-live", "polite");
    const attribution = document.createElement("a");
    attribution.className = "map-attribution";
    attribution.href = "https://www.openstreetmap.org/copyright";
    attribution.target = "_blank";
    attribution.rel = "noreferrer";
    attribution.textContent = "© OpenStreetMap contributors";
    target.replaceChildren(tiles, svg, message, attribution);
    map = {
      target,
      tiles,
      svg,
      message,
      tileCache: new Map(),
      route: [],
      events: [],
      visibleTileKeys: [],
      width: 0,
      height: 0,
      hasView: false,
      userInteracted: false,
      zoom: 3,
      centerWorld: null,
      pointers: new Map(),
      gesture: null
    };
    maps.set(target, map);
    installMapGestures(map);
    if ("ResizeObserver" in window) {
      map.resizeObserver = new ResizeObserver(() => drawMap(map));
      map.resizeObserver.observe(target);
    }
  }
  map.route = route || [];
  map.events = events || [];
  map.onEventClick = onEventClick || null;
  drawMap(map);
}

function installMapGestures(map) {
  const { target } = map;
  const mapPoint = event => {
    const bounds = target.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const startPinch = () => {
    const [first, second] = [...map.pointers.values()];
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    map.gesture = {
      type: "pinch",
      startZoom: map.zoom,
      startDistance: distance,
      anchorWorld: {
        x: map.centerWorld.x + midpoint.x - map.width / 2,
        y: map.centerWorld.y + midpoint.y - map.height / 2
      }
    };
  };

  target.addEventListener("pointerdown", event => {
    if (!map.hasView || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.target instanceof Element && event.target.closest(".map-event-marker")) return;
    const point = mapPoint(event);
    map.pointers.set(event.pointerId, point);
    if (target.setPointerCapture) target.setPointerCapture(event.pointerId);
    if (map.pointers.size === 1) {
      map.gesture = { type: "pan", startPoint: point, startCenter: { ...map.centerWorld } };
    } else if (map.pointers.size === 2) {
      startPinch();
    }
    event.preventDefault();
  });

  target.addEventListener("pointermove", event => {
    if (!map.pointers.has(event.pointerId)) return;
    map.pointers.set(event.pointerId, mapPoint(event));
    if (map.pointers.size === 1 && map.gesture?.type === "pan") {
      const point = map.pointers.get(event.pointerId);
      const deltaX = point.x - map.gesture.startPoint.x;
      const deltaY = point.y - map.gesture.startPoint.y;
      map.userInteracted = true;
      map.centerWorld = {
        x: map.gesture.startCenter.x - deltaX,
        y: map.gesture.startCenter.y - deltaY
      };
      target.classList.add("is-dragging");
      drawMap(map);
    } else if (map.pointers.size >= 2 && map.gesture?.type === "pinch") {
      const [first, second] = [...map.pointers.values()];
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const zoom = Math.max(3, Math.min(19, map.gesture.startZoom + Math.log2(distance / map.gesture.startDistance)));
      const scale = 2 ** (zoom - map.gesture.startZoom);
      map.zoom = zoom;
      map.centerWorld = {
        x: map.gesture.anchorWorld.x * scale - (midpoint.x - map.width / 2),
        y: map.gesture.anchorWorld.y * scale - (midpoint.y - map.height / 2)
      };
      map.userInteracted = true;
      target.classList.add("is-dragging");
      drawMap(map);
    }
    event.preventDefault();
  });

  const endPointer = event => {
    if (!map.pointers.has(event.pointerId)) return;
    map.pointers.delete(event.pointerId);
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (map.pointers.size === 1) {
      const [pointer] = map.pointers.values();
      map.gesture = { type: "pan", startPoint: pointer, startCenter: { ...map.centerWorld } };
    } else {
      map.gesture = null;
    }
    if (!map.pointers.size) target.classList.remove("is-dragging");
    event.preventDefault();
  };
  target.addEventListener("pointerup", endPointer);
  target.addEventListener("pointercancel", endPointer);

  target.addEventListener("wheel", event => {
    if (!map.hasView) return;
    event.preventDefault();
    const point = mapPoint(event);
    const zoom = Math.max(3, Math.min(19, map.zoom - Math.sign(event.deltaY) * 0.5));
    const scale = 2 ** (zoom - map.zoom);
    const anchorWorld = {
      x: map.centerWorld.x + point.x - map.width / 2,
      y: map.centerWorld.y + point.y - map.height / 2
    };
    map.zoom = zoom;
    map.centerWorld = {
      x: anchorWorld.x * scale - (point.x - map.width / 2),
      y: anchorWorld.y * scale - (point.y - map.height / 2)
    };
    map.userInteracted = true;
    drawMap(map);
  }, { passive: false });
}

function projectToWorld(point, zoom) {
  const scale = OSM_TILE_SIZE * 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  const sinLatitude = Math.sin(latitude * Math.PI / 180);
  return {
    x: (point.lon + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale
  };
}

function drawMap(map) {
  const { target, tiles, svg, message, tileCache, route, events } = map;
  const width = target.clientWidth;
  const height = target.clientHeight;
  if (!width || !height) return;
  map.width = width;
  map.height = height;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren();

  const points = [...route, ...events.filter(event => event.position).map(event => event.position)];
  if (!points.length) {
    tiles.replaceChildren();
    map.visibleTileKeys = [];
    map.hasView = false;
    map.userInteracted = false;
    map.centerWorld = null;
    map.pointers.clear();
    map.gesture = null;
    target.classList.remove("is-interactive", "is-dragging");
    message.textContent = "경로를 기록하면 실제 지도가 표시됩니다.";
    message.hidden = false;
    return;
  }
  map.hasView = true;
  target.classList.add("is-interactive");

  if (!map.userInteracted || !map.centerWorld) {
    const availableWidth = Math.max(1, width - 72);
    const availableHeight = Math.max(1, height - 56);
    let zoom = 19;
    let projected = points.map(point => projectToWorld(point, zoom));
    while (zoom > 3) {
      const minX = Math.min(...projected.map(point => point.x));
      const maxX = Math.max(...projected.map(point => point.x));
      const minY = Math.min(...projected.map(point => point.y));
      const maxY = Math.max(...projected.map(point => point.y));
      if (maxX - minX <= availableWidth && maxY - minY <= availableHeight) break;
      zoom -= 1;
      projected = points.map(point => projectToWorld(point, zoom));
    }
    if (points.length === 1) {
      zoom = 16;
      projected = points.map(point => projectToWorld(point, zoom));
    }
    const minX = Math.min(...projected.map(point => point.x));
    const maxX = Math.max(...projected.map(point => point.x));
    const minY = Math.min(...projected.map(point => point.y));
    const maxY = Math.max(...projected.map(point => point.y));
    map.zoom = zoom;
    map.centerWorld = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  const zoom = map.zoom;
  const left = map.centerWorld.x - width / 2;
  const top = map.centerWorld.y - height / 2;
  const tileZoom = Math.floor(zoom);
  const tileScale = 2 ** (zoom - tileZoom);
  const tileSize = OSM_TILE_SIZE * tileScale;
  const tileLeft = left / tileScale;
  const tileTop = top / tileScale;
  const tileWidth = width / tileScale;
  const tileHeight = height / tileScale;
  const tileCount = 2 ** tileZoom;
  const firstTileX = Math.floor(tileLeft / OSM_TILE_SIZE);
  const lastTileX = Math.floor((tileLeft + tileWidth) / OSM_TILE_SIZE);
  const firstTileY = Math.max(0, Math.floor(tileTop / OSM_TILE_SIZE));
  const lastTileY = Math.min(tileCount - 1, Math.floor((tileTop + tileHeight) / OSM_TILE_SIZE));
  const visibleKeys = [];
  tiles.replaceChildren();

  for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
      const key = `${tileZoom}/${wrappedX}/${tileY}`;
      visibleKeys.push(key);
      let tile = tileCache.get(key);
      if (!tile) {
        const image = document.createElement("img");
        image.alt = "";
        image.draggable = false;
        image.className = "osm-tile";
        tile = { image, status: "loading" };
        image.addEventListener("load", () => {
          tile.status = "loaded";
          updateMapMessage(map);
        });
        image.addEventListener("error", () => {
          tile.status = "failed";
          updateMapMessage(map);
        });
        image.src = `https://tile.openstreetmap.org/${key}.png`;
        tileCache.set(key, tile);
      }
      tile.image.style.left = `${tileX * tileSize - left}px`;
      tile.image.style.top = `${tileY * tileSize - top}px`;
      tile.image.style.width = `${tileSize}px`;
      tile.image.style.height = `${tileSize}px`;
      tiles.append(tile.image);
    }
  }
  map.visibleTileKeys = visibleKeys;
  updateMapMessage(map);

  const pointAt = point => {
    const position = projectToWorld(point, zoom);
    return { x: position.x - left, y: position.y - top };
  };
  if (route.length > 1) {
    const path = document.createElementNS(svg.namespaceURI, "polyline");
    path.setAttribute("points", route.map(point => {
      const position = pointAt(point);
      return `${position.x},${position.y}`;
    }).join(" "));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#345d4d");
    path.setAttribute("stroke-width", "4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(path);
  }
  events.forEach((event, index) => {
    if (!event.position) return;
    const position = pointAt(event.position);
    const marker = document.createElementNS(svg.namespaceURI, "circle");
    marker.classList.add("map-event-marker");
    marker.setAttribute("cx", position.x);
    marker.setAttribute("cy", position.y);
    marker.setAttribute("r", "6");
    marker.setAttribute("fill", event.type === "photo" ? "#d5a445" : event.type === "video" ? "#ca785d" : "#718db2");
    marker.setAttribute("stroke", "#fff");
    marker.setAttribute("stroke-width", "2");
    if (map.onEventClick) {
      const typeNames = { photo: "사진", video: "동영상", audio: "음성 메모" };
      marker.setAttribute("role", "button");
      marker.setAttribute("tabindex", "0");
      marker.setAttribute("aria-label", `${typeNames[event.type] || "기록"} 열기, ${formatTime(event.timestamp)}`);
      marker.addEventListener("click", () => map.onEventClick(event));
      marker.addEventListener("keydown", keyEvent => {
        if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
        keyEvent.preventDefault();
        map.onEventClick(event);
      });
    }
    svg.append(marker);
  });
  if (route.length) {
    const start = pointAt(route[0]);
    const startMarker = document.createElementNS(svg.namespaceURI, "circle");
    startMarker.setAttribute("cx", start.x);
    startMarker.setAttribute("cy", start.y);
    startMarker.setAttribute("r", "5");
    startMarker.setAttribute("fill", "#fff");
    startMarker.setAttribute("stroke", "#345d4d");
    startMarker.setAttribute("stroke-width", "3");
    svg.append(startMarker);
    const end = pointAt(route.at(-1));
    const endMarker = document.createElementNS(svg.namespaceURI, "circle");
    endMarker.setAttribute("cx", end.x);
    endMarker.setAttribute("cy", end.y);
    endMarker.setAttribute("r", "6");
    endMarker.setAttribute("fill", "#345d4d");
    endMarker.setAttribute("stroke", "#fff");
    endMarker.setAttribute("stroke-width", "2");
    svg.append(endMarker);
  }
}

function updateMapMessage(map) {
  const visibleTiles = (map.visibleTileKeys || []).map(key => map.tileCache.get(key));
  const finished = visibleTiles.filter(tile => tile && tile.status !== "loading");
  const failed = finished.filter(tile => tile.status === "failed").length;
  if (!visibleTiles.length || visibleTiles.some(tile => !tile || tile.status === "loading") || !failed) {
    map.message.hidden = true;
    return;
  }
  map.message.textContent = failed === visibleTiles.length
    ? "지도를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."
    : "일부 지도 타일을 불러오지 못했습니다.";
  map.message.hidden = false;
}

function setRecordingUi() {
  $("#record-toggle-label").textContent = state.recording ? "기록 중" : "출발";
  $("#record-toggle").querySelector(".button-symbol").textContent = state.recording ? "●" : "▶";
  $("#record-toggle").classList.toggle("is-recording", state.recording);
  $("#pause-recording").disabled = !state.recording;
  $("#pause-label").textContent = state.paused ? "재개" : "일시정지";
  $("#pause-recording").querySelector(".button-symbol").textContent = state.paused ? "▶" : "Ⅱ";
  $("#recording-indicator").hidden = !state.recording;
  $("#recording-indicator").classList.toggle("is-paused", state.paused);
}

function startTracking() {
  if (!state.preferences.gps) return showToast("설정에서 위치 기록을 먼저 켜주세요.");
  if (state.paused) {
    state.paused = false;
    setRecordingUi();
    requestScreenWakeLock();
    getPosition();
    return;
  }
  if (state.recording) return;
  newSession();
  state.recording = true;
  state.paused = false;
  setRecordingUi();
  requestScreenWakeLock();
  $("#location-status").innerHTML = '<i class="status-dot"></i>위치 확인 중';
  getPosition();
}

async function requestScreenWakeLock() {
  if (!state.recording || state.paused || document.visibilityState !== "visible") return;
  if (!("wakeLock" in navigator)) {
    showToast("화면 자동 잠금을 막을 수 없습니다. 위치 기록 중에는 앱을 열어 두세요.");
    return;
  }
  if (state.wakeLock && !state.wakeLock.released) return;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock = wakeLock;
    wakeLock.addEventListener("release", () => {
      if (state.wakeLock === wakeLock) state.wakeLock = null;
    }, { once: true });
  } catch (error) {
    console.warn("화면 자동 잠금을 방지하지 못했습니다.", error);
    showToast("화면이 자동으로 잠길 수 있습니다. 위치 기록 중에는 앱을 열어 두세요.");
  }
}

function releaseScreenWakeLock() {
  const wakeLock = state.wakeLock;
  state.wakeLock = null;
  if (wakeLock) {
    wakeLock.release().catch(error => console.warn("화면 자동 잠금을 해제하지 못했습니다.", error));
  }
}

function pauseTracking() {
  if (!state.recording) return;
  if (state.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.paused = !state.paused;
  setRecordingUi();
  if (state.paused) releaseScreenWakeLock();
  else requestScreenWakeLock();
  $("#location-status").innerHTML = `<i class="status-dot"></i>${state.paused ? "일시정지" : "위치 기록 중"}`;
  if (!state.paused) getPosition();
}

async function endTracking(save) {
  if (state.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  releaseScreenWakeLock();
  if (state.activeSession && save) {
    const session = state.activeSession;
    session.endedAt = new Date().toISOString();
    estimateAudioEventPositions(session);
    const all = await getAllSessions();
    session.sequence = all.filter(item => item.date === session.date && item.user === state.user && item.id !== session.id).length + 1;
    await saveSession(session);
    showToast(`${session.date.replaceAll("-", "")}_${session.sequence} 기록을 저장했어요.`);
  } else if (state.activeSession && !save) {
    showToast("기록을 저장하지 않고 종료했어요.");
  } else {
    showToast("저장할 기록이 없습니다. 먼저 출발해 주세요.");
  }
  state.recording = false;
  state.paused = false;
  state.activeSession = null;
  setRecordingUi();
  configureHome();
  $("#point-count").textContent = "경로 기록 전";
  $("#coordinate-label").textContent = "위치 기록을 시작해 보세요";
  $("#location-status").innerHTML = `<i class="status-dot"></i>${state.preferences.gps ? "위치 대기 중" : "위치 기록 꺼짐"}`;
  renderMap([], [], $("#map-canvas"));
}

function mediaFilename(session, event) {
  const type = { audio: "voice", video: "video", photo: "photo" }[event.type] || "media";
  const timestamp = new Date(event.timestamp);
  const time = `${String(timestamp.getHours()).padStart(2, "0")}${String(timestamp.getMinutes()).padStart(2, "0")}${String(timestamp.getSeconds()).padStart(2, "0")}`;
  const mimeType = (event.mimeType || event.blob.type).split(";")[0].toLowerCase();
  const extensions = {
    "audio/3gpp": "3gp",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/x-m4a": "m4a",
    "audio/webm": "webm",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/3gpp": "3gp",
    "video/mp4": "mp4",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "video/x-m4v": "m4v",
    "video/webm": "webm"
  };
  const fallbackExtension = { audio: "wav", photo: "jpg", video: "webm" }[event.type] || "bin";
  const extension = extensions[mimeType] || fallbackExtension;
  const eventNumber = session.events.filter(item => item.type === event.type).indexOf(event) + 1;
  return `RB${session.date.replaceAll("-", "")}_${session.sequence || 1}_${type}_${time}_${eventNumber}.${extension}`;
}

async function prepareSavedDownloadDirectory() {
  state.downloadTargetDirectory = null;
  if (!state.downloadDirectory || typeof window.showDirectoryPicker !== "function") return null;

  try {
    const permission = await state.downloadDirectory.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") return null;
    state.downloadTargetDirectory = await state.downloadDirectory.getDirectoryHandle("RollBack", { create: true });
    return state.downloadTargetDirectory;
  } catch (error) {
    console.warn("저장 폴더를 다시 연결하지 못했습니다. 브라우저 기본 다운로드 위치를 사용합니다.", error);
    return null;
  }
}

async function saveFileToDownloadDirectory(directory, filename, blob) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch (abortError) {
      console.warn("파일 쓰기 작업을 정리하지 못했습니다.", abortError);
    }
    throw error;
  }
}

function startMediaDownload(event, session) {
  if (!event.blob || !session) throw new Error("다운로드할 미디어 파일이 없습니다.");
  const url = URL.createObjectURL(event.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = mediaFilename(session, event);
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function showCaptureResult(body, message) {
  stopStream();
  state.recorder = null;
  body.replaceChildren();
  const notice = document.createElement("div");
  notice.className = "preview-placeholder";
  notice.textContent = message;
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button button-dark button-wide";
  close.textContent = "닫기";
  close.addEventListener("click", closeModal);
  actions.append(close);
  body.append(notice, actions);
}

async function saveCapturedMedia(body, event, typeName) {
  const session = state.activeSession;
  const objectParticle = typeName === "음성 메모" || typeName === "사진" ? "를" : "을";
  const directory = state.downloadTargetDirectory;
  let downloadedToFolder = false;
  let defaultDownloadStarted = false;
  let downloadError = null;
  if (!directory) {
    try {
      startMediaDownload(event, session);
      defaultDownloadStarted = true;
    } catch (error) {
      downloadError = error;
    }
  }
  let storageError = null;
  try {
    await saveDraftOrSession();
  } catch (error) {
    storageError = error;
  }
  if (directory) {
    try {
      await saveFileToDownloadDirectory(directory, mediaFilename(session, event), event.blob);
      downloadedToFolder = true;
    } catch (error) {
      console.error("선택한 폴더에 미디어 파일을 저장하지 못했습니다.", error);
      try {
        startMediaDownload(event, session);
        defaultDownloadStarted = true;
      } catch (fallbackError) {
        downloadError = new Error(`${error.message}; 기본 다운로드도 실패했습니다: ${fallbackError.message}`);
      }
    }
  }
  if (downloadError && !downloadedToFolder && !defaultDownloadStarted) {
    const message = storageError
      ? `${typeName}을 앱 기록에 저장하지 못했습니다 (${storageError.message}). 파일 저장도 실패했습니다 (${downloadError.message}).`
      : `${typeName}은 앱 기록에 저장했지만 파일 저장에 실패했습니다: ${downloadError.message}`;
    showCaptureResult(body, message);
    return;
  }
  showCaptureResult(body, storageError
    ? `${typeName} 파일은 다운로드했지만 앱 기록에 저장하지 못했습니다: ${storageError.message}`
    : `${typeName}${objectParticle} 저장했습니다.`);
}

function openModal(title, description = "") {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${safeText(title)}"><div class="modal-header"><div><h2>${safeText(title)}</h2><p>${safeText(description)}</p></div><button type="button" class="modal-close" aria-label="닫기">×</button></div><div class="modal-body"></div></div>`;
  backdrop.addEventListener("click", event => {
    if (event.target === backdrop || event.target.closest(".modal-close")) closeModal();
  });
  $("#modal-root").append(backdrop);
  document.addEventListener("keydown", handleModalKeydown);
  return $(".modal-body", backdrop);
}

function handleModalKeydown(event) {
  if (event.key !== "Escape" || !$("#modal-root .modal-backdrop")) return;
  closeModal();
}

function openCreateAccountModal() {
  const body = openModal("계정 만들기", "이 기기에서 사용할 아이디와 비밀번호를 설정해 주세요.");
  body.innerHTML = `
    <form id="create-account-form">
      <label class="field-label" for="new-user-id">아이디</label>
      <input id="new-user-id" name="new-user-id" autocomplete="username" placeholder="아이디를 입력하세요" required maxlength="32">
      <label class="field-label" for="new-password">비밀번호</label>
      <input id="new-password" name="new-password" type="password" autocomplete="new-password" placeholder="4자 이상 입력하세요" required minlength="4" maxlength="64">
      <label class="field-label" for="confirm-password">비밀번호 확인</label>
      <input id="confirm-password" name="confirm-password" type="password" autocomplete="new-password" placeholder="비밀번호를 한 번 더 입력하세요" required minlength="4" maxlength="64">
      <p id="create-account-message" class="form-message" aria-live="polite"></p>
      <div class="modal-actions">
        <button class="button button-outline" type="button" id="cancel-create-account">취소</button>
        <button class="button button-dark" type="submit">계정 만들기</button>
      </div>
    </form>`;
  addPasswordVisibilityToggles(body);
  $("#new-user-id", body).focus();
  $("#cancel-create-account", body).addEventListener("click", closeModal);
  $("#create-account-form", body).addEventListener("submit", async event => {
    event.preventDefault();
    const id = $("#new-user-id", body).value.trim();
    const password = $("#new-password", body).value;
    const confirmation = $("#confirm-password", body).value;
    const message = $("#create-account-message", body);
    if (!id) {
      message.textContent = "아이디를 입력해 주세요.";
      $("#new-user-id", body).focus();
      return;
    }
    if (password !== confirmation) {
      message.textContent = "비밀번호가 서로 일치하지 않습니다.";
      $("#confirm-password", body).focus();
      return;
    }
    try {
      const accounts = getAccounts();
      if (accounts.some(account => account.id === id)) {
        message.textContent = "이미 사용 중인 아이디입니다. 다른 아이디를 입력해 주세요.";
        return;
      }
      const passwordHash = await hashPassword(password);
      const recoveryCode = generateRecoveryCode();
      const recoveryCodeHash = await hashPassword(normalizeRecoveryCode(recoveryCode));
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify([...accounts, { id, passwordHash, recoveryCodeHash }]));
      state.user = id;
      readPreferences();
      renderPreferences();
      setMessage("#login-message", "");
      closeModal();
      showScreen("settings-screen");
      showRecoveryCode(recoveryCode, "계정 복구 코드를 만들었습니다. 비밀번호를 잊었을 때 사용할 수 있습니다.");
    } catch (error) {
      message.textContent = error.message || "계정을 만들 수 없습니다.";
    }
  });
}

function stopStream() {
  if (state.modalStream) {
    state.modalStream.getTracks().forEach(track => track.stop());
    state.modalStream = null;
  }
}

function closeModal() {
  document.removeEventListener("keydown", handleModalKeydown);
  if (state.audioCapture) cleanupAudioCapture(state.audioCapture);
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recorder.onstop = null;
    state.recorder.stop();
  }
  state.recorder = null;
  stopStream();
  state.modalUrls.forEach(url => URL.revokeObjectURL(url));
  state.modalUrls = [];
  $("#modal-root").replaceChildren();
}

function eventPosition() {
  if (state.currentPosition) return { lat: state.currentPosition.lat, lon: state.currentPosition.lon };
  return null;
}

function addEvent(type, blob, mimeType) {
  if (!state.activeSession) newSession();
  const event = {
    id: makeId(),
    type,
    timestamp: new Date().toISOString(),
    position: eventPosition(),
    mimeType,
    blob
  };
  state.activeSession.events.push(event);
  renderMap(state.activeSession.route, state.activeSession.events, $("#map-canvas"));
  return event;
}

function createMediaRecorder(stream) {
  const candidates = ["video/mp4", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = typeof MediaRecorder.isTypeSupported === "function"
    ? candidates.find(candidate => MediaRecorder.isTypeSupported(candidate))
    : null;
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
}

function encodeWav(samples, sampleRate) {
  const sampleCount = samples.reduce((total, sample) => total + sample.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  samples.forEach(chunk => {
    for (let i = 0; i < chunk.length; i += 1) {
      const value = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  });
  return new Blob([buffer], { type: "audio/wav" });
}

function cleanupAudioCapture(capture) {
  if (!capture) return;
  capture.stopped = true;
  capture.processor.disconnect();
  capture.sink.disconnect();
  capture.source.disconnect();
  capture.stream.getTracks().forEach(track => track.stop());
  if (capture.context.state !== "closed") capture.context.close();
  if (state.audioCapture === capture) state.audioCapture = null;
  if (state.modalStream === capture.stream) state.modalStream = null;
}

async function finishVoiceRecording(body) {
  const capture = state.audioCapture;
  if (!capture) return;
  const blob = encodeWav(capture.samples, capture.context.sampleRate);
  cleanupAudioCapture(capture);
  if (!blob.size || blob.size <= 44) {
    $("#media-message", body).textContent = "녹음 데이터가 비어 있어 파일을 만들지 못했습니다. 다시 녹음해 주세요.";
    $("#audio-start", body).disabled = false;
    $("#audio-start", body).textContent = "다시 녹음";
    $("#audio-stop", body).disabled = true;
    $(".preview-placeholder", body).textContent = "녹음된 데이터가 없습니다.";
    return;
  }
  const event = addEvent("audio", blob, blob.type);
  await saveCapturedMedia(body, event, "음성 메모");
}

async function openVoiceModal() {
  if (!state.preferences.audio) return showToast("설정에서 음성 메모 기능을 먼저 켜주세요.");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
    return showToast(window.isSecureContext
      ? "이 브라우저는 음성 녹음을 지원하지 않습니다."
      : "음성 녹음은 HTTPS로 접속해야 사용할 수 있습니다.");
  }
  const body = openModal("음성 메모", "녹음을 마치면 설정한 저장 폴더에 자동 저장됩니다.");
  body.innerHTML = '<div class="preview-placeholder">녹음을 시작하면 이 순간의 목소리를 담습니다.</div><p class="form-message" id="media-message" aria-live="polite"></p><div class="modal-actions"><button class="button button-dark button-wide" type="button" id="audio-start">녹음 시작</button><button class="button button-outline button-wide" type="button" id="audio-stop" disabled>녹음 종료 및 저장</button></div>';
  $("#audio-start", body).addEventListener("click", async () => {
    let stream = null;
    let context = null;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.modalStream = stream;
      context = new AudioContextClass();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sink = context.createGain();
      const capture = { stream, context, source, processor, sink, samples: [], stopped: false };
      processor.onaudioprocess = event => {
        if (!capture.stopped) capture.samples.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      state.modalStream = stream;
      state.audioCapture = capture;
      $("#audio-start", body).disabled = true;
      $("#audio-start", body).textContent = "녹음 중...";
      $("#audio-stop", body).disabled = false;
      $(".preview-placeholder", body).textContent = "● 녹음 중입니다. 생각을 천천히 들려주세요.";
    } catch (error) {
      if (state.audioCapture) cleanupAudioCapture(state.audioCapture);
      else {
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (context && context.state !== "closed") context.close();
        state.modalStream = null;
      }
      $("#media-message", body).textContent = `마이크를 사용할 수 없습니다: ${error.message || "권한을 확인해 주세요."}`;
    }
  });
  $("#audio-stop", body).addEventListener("click", () => finishVoiceRecording(body));
}

async function saveDraftOrSession() {
  if (!state.activeSession) return;
  estimateAudioEventPositions(state.activeSession);
  state.activeSession.endedAt = null;
  const all = await getAllSessions();
  const existing = all.find(item => item.id === state.activeSession.id);
  if (existing) {
    await saveSession(state.activeSession);
    return;
  }
  const saved = all.filter(item => item.date === state.activeSession.date && item.user === state.user);
  state.activeSession.sequence = saved.length + 1;
  await saveSession(state.activeSession);
}

async function openCameraModal() {
  if (!state.preferences.camera) return showToast("설정에서 카메라 기능을 먼저 켜주세요.");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showToast(window.isSecureContext
      ? "이 브라우저는 카메라를 지원하지 않습니다."
      : "카메라 사용은 HTTPS로 접속해야 합니다.");
  }
  const body = openModal("순간 담기", "촬영을 마치면 설정한 저장 폴더에 자동 저장됩니다.");
  body.innerHTML = '<div class="modal-tab-row"><button class="modal-tab active" type="button" data-mode="photo">사진</button><button class="modal-tab" type="button" data-mode="video">동영상</button></div><video class="media-preview" id="camera-preview" autoplay playsinline muted></video><p class="form-message" id="media-message" aria-live="polite"></p><div class="modal-actions"><button class="button button-dark button-wide" type="button" id="capture-action">사진 촬영</button></div>';
  let mode = "photo";
  try {
    state.modalStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("#camera-preview", body).srcObject = state.modalStream;
  } catch (error) {
    $("#media-message", body).textContent = `카메라를 사용할 수 없습니다: ${error.message || "권한을 확인해 주세요."}`;
    $("#camera-preview", body).classList.add("hidden");
    return;
  }
  $$("[data-mode]", body).forEach(button => button.addEventListener("click", () => {
    mode = button.dataset.mode;
    $$("[data-mode]", body).forEach(tab => tab.classList.toggle("active", tab === button));
    $("#capture-action", body).textContent = mode === "photo" ? "사진 촬영" : "동영상 녹화 시작";
  }));
  $("#capture-action", body).addEventListener("click", async event => {
    const button = event.currentTarget;
    if (mode === "photo") {
      const video = $("#camera-preview", body);
      if (!video.videoWidth) return showToast("카메라 화면이 준비될 때까지 기다려 주세요.");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) return showToast("사진을 처리할 수 없습니다.");
      context.drawImage(video, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .9));
      if (!blob) return showToast("사진을 저장하지 못했습니다.");
      const capturedEvent = addEvent("photo", blob, "image/jpeg");
      await saveCapturedMedia(body, capturedEvent, "사진");
      return;
    }
    if (state.recorder && state.recorder.state !== "inactive") {
      state.recorder.stop();
      button.textContent = "저장 중...";
      button.disabled = true;
      return;
    }
    if (!window.MediaRecorder) return showToast("이 브라우저는 동영상 녹화를 지원하지 않습니다.");
    try {
      const chunks = [];
      const recorder = createMediaRecorder(state.modalStream);
      state.recorder = recorder;
      recorder.ondataavailable = item => { if (item.data.size) chunks.push(item.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "video/webm" });
        if (!blob.size) {
          $("#media-message", body).textContent = "녹화 데이터가 비어 있어 파일을 만들지 못했습니다. 다시 촬영해 주세요.";
          state.recorder = null;
          button.disabled = false;
          button.textContent = "동영상 녹화 다시 시작";
          return;
        }
        const capturedEvent = addEvent("video", blob, blob.type);
        await saveCapturedMedia(body, capturedEvent, "동영상");
      };
      recorder.start();
      button.textContent = "녹화 종료 및 저장";
      button.classList.remove("button-dark");
      button.classList.add("button-outline");
    } catch (error) {
      $("#media-message", body).textContent = `동영상을 녹화할 수 없습니다: ${error.message}`;
    }
  });
}

function openEvent(event) {
  const typeNames = { photo: "사진", video: "동영상", audio: "음성 메모" };
  const body = openModal(typeNames[event.type] || "기록", `${formatDate(event.timestamp)} · ${formatTime(event.timestamp)}`);
  const media = document.createElement("div");
  media.className = "event-media";
  if (!event.blob) {
    media.innerHTML = `<p class="empty-state">${safeText(typeNames[event.type] || "미디어")} 파일을 찾을 수 없습니다.</p>`;
  } else {
    const url = URL.createObjectURL(event.blob);
    state.modalUrls.push(url);
    if (event.type === "photo") {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "저장된 사진";
      media.append(image);
    } else {
      const player = document.createElement(event.type === "video" ? "video" : "audio");
      player.controls = true;
      player.preload = "metadata";
      player.playsInline = true;
      player.className = event.type === "audio" ? "audio-player" : "";
      const source = document.createElement("source");
      source.src = url;
      source.type = event.mimeType || event.blob.type;
      player.append(source);
      media.append(player);
      player.load();
    }
  }
  body.append(media);
  if (event.blob) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-outline button-wide delete-media";
    remove.textContent = "이 파일 삭제";
    remove.addEventListener("click", async () => {
      if (!confirm("이 음성·사진·동영상 파일을 기록에서 삭제할까요? 다운로드한 파일은 삭제되지 않습니다.")) return;
      remove.disabled = true;
      try {
        const currentSession = state.reviewSession && await getSession(state.reviewSession.id);
        if (!currentSession || currentSession.user !== state.user) {
          throw new Error("기록을 찾을 수 없어 파일을 삭제하지 못했습니다.");
        }
        const eventIndex = currentSession.events.findIndex(item => item.id === event.id);
        if (eventIndex < 0) throw new Error("파일을 찾을 수 없어 삭제하지 못했습니다.");
        currentSession.events.splice(eventIndex, 1);
        await saveSession(currentSession);
        closeModal();
        await showSessionDetail(currentSession.id);
        showToast("파일을 기록에서 삭제했습니다.");
      } catch (error) {
        console.error("기록 미디어를 삭제하지 못했습니다.", error);
        showToast(error.message || "파일을 삭제하지 못했습니다.");
        if (remove.isConnected) remove.disabled = false;
      }
    });
    body.append(remove);
  }
  if (event.position) {
    const location = document.createElement("p");
    location.className = "muted";
    location.textContent = `${event.positionEstimated ? "추정 위치" : "기록 위치"} · ${event.position.lat.toFixed(5)}, ${event.position.lon.toFixed(5)}`;
    body.append(location);
  } else {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "이 기록에는 위치 정보가 연결되어 있지 않습니다.";
    body.append(note);
  }
}

async function openReview() {
  showScreen("review-screen");
  $("#review-date").value = dateKey(new Date());
  $("#review-detail").classList.add("hidden");
  await renderReviewList();
}

async function renderReviewList() {
  const date = $("#review-date").value;
  const list = $("#review-list");
  const detail = $("#review-detail");
  detail.classList.add("hidden");
  try {
    const sessions = (await getAllSessions()).filter(session => session.user === state.user && session.date === date);
    if (!sessions.length) {
      list.innerHTML = '<div class="empty-state">이 날짜에는 저장된 기록이 없어요.<br>오늘의 순간을 하나 남겨볼까요?</div>';
      return;
    }
    list.innerHTML = sessions.map(session => `<div class="session-card"><button class="session-open" type="button" data-session-id="${safeText(session.id)}"><span class="session-icon">↶</span><span class="session-copy"><strong>${safeText(session.date.replaceAll("-", ""))}_${session.sequence || 1}</strong><small>${formatTime(session.startedAt)} · 경로 ${session.route.length}개 · 기록 ${session.events.length}개</small></span><span class="session-arrow">→</span></button><button class="session-delete" type="button" data-session-id="${safeText(session.id)}" aria-label="${safeText(session.date.replaceAll("-", ""))}_${session.sequence || 1} 기록 파일 삭제">삭제</button></div>`).join("");
    $$(".session-open", list).forEach(button => button.addEventListener("click", () => showSessionDetail(button.dataset.sessionId)));
    $$(".session-delete", list).forEach(button => button.addEventListener("click", () => removeReviewedSession(button.dataset.sessionId)));
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${safeText(error.message)}</div>`;
  }
}

async function removeReviewedSession(id) {
  if (!confirm("이 기록 파일의 지도 경로와 연결된 음성·사진·동영상을 모두 삭제할까요? 다운로드한 파일은 삭제되지 않습니다.")) return;
  try {
    const session = await getSession(id);
    if (!session || session.user !== state.user) throw new Error("기록을 찾을 수 없어 삭제하지 못했습니다.");
    await deleteSession(session.id);
    if (state.reviewSession?.id === session.id) {
      state.reviewSession = null;
      $("#review-detail").classList.add("hidden");
    }
    showToast("기록 파일을 삭제했습니다.");
    await renderReviewList();
  } catch (error) {
    console.error("기록 파일을 삭제하지 못했습니다.", error);
    showToast(error.message || "기록 파일을 삭제하지 못했습니다.");
  }
}

async function showSessionDetail(id) {
  const detail = $("#review-detail");
  try {
    const session = await getSession(id);
    if (!session || session.user !== state.user) return showToast("기록을 찾을 수 없습니다.");
    state.reviewSession = session;
    estimateAudioEventPositions(session);
    detail.classList.remove("hidden");
    detail.innerHTML = `<div class="detail-heading"><div><strong>${safeText(session.date.replaceAll("-", ""))}_${session.sequence || 1}</strong><small>${formatDate(session.startedAt)} · ${formatTime(session.startedAt)} 시작</small></div><button class="delete-session" type="button">이 기록 삭제</button></div><div class="map-card"><div class="map-topline"><span>기록된 여정</span><span>${session.route.length}개 위치</span></div><div class="map-canvas detail-map" role="group" aria-label="기록된 이동 경로와 OpenStreetMap 지도. 드래그하여 이동하고 두 손가락으로 확대·축소할 수 있습니다."></div><div class="map-bottomline"><span>노랑 사진 · 빨강 동영상 · 파랑 음성</span><span>N ↑</span></div></div><div class="event-list"></div>`;
    renderMap(session.route, session.events, $(".detail-map", detail), openEvent);
    const eventList = $(".event-list", detail);
    if (!session.events.length) {
      eventList.innerHTML = '<div class="empty-state">이 기록에 연결된 사진·동영상·음성 메모가 없습니다.</div>';
    } else {
      eventList.innerHTML = session.events.map(event => `<div class="event-item"><span class="event-dot ${safeText(event.type)}"></span><span><strong>${event.type === "photo" ? "사진" : event.type === "video" ? "동영상" : "음성 메모"}</strong><small>${formatTime(event.timestamp)}${event.position ? ` · ${event.position.lat.toFixed(4)}, ${event.position.lon.toFixed(4)}` : " · 위치 정보 없음"}</small></span><button type="button" data-event-id="${safeText(event.id)}">열기 →</button></div>`).join("");
      $$("[data-event-id]", eventList).forEach(button => {
        button.addEventListener("click", () => openEvent(session.events.find(item => item.id === button.dataset.eventId)));
      });
    }
    $(".delete-session", detail).addEventListener("click", () => removeReviewedSession(session.id));
    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showToast(error.message);
  }
}

async function saveActiveRecord() {
  if (!state.activeSession) return showToast("저장할 기록이 없습니다. 먼저 출발해 주세요.");
  const hasAnyData = state.activeSession.route.length || state.activeSession.events.length;
  if (!hasAnyData) return showToast("기록된 위치나 미디어가 없습니다.");
  try {
    await endTracking(true);
  } catch (error) {
    showToast(`기록을 저장하지 못했습니다: ${error.message}`);
  }
}

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#user-id").value.trim();
  const password = $("#password").value;
  if (!id || !password) return setMessage("#login-message", "아이디와 비밀번호를 모두 입력해 주세요.");
  try {
    const accounts = getAccounts();
    if (!accounts.length) return setMessage("#login-message", "먼저 이 기기에 계정을 만들어 주세요.");
    const digest = await hashPassword(password);
    const account = accounts.find(item => item.id === id && item.passwordHash === digest);
    if (!account) return setMessage("#login-message", "아이디 또는 비밀번호가 일치하지 않습니다.");
    state.user = id;
    readPreferences();
    renderPreferences();
    setMessage("#login-message", "");
    showScreen("settings-screen");
  } catch (error) {
    setMessage("#login-message", error.message || "로그인할 수 없습니다.");
  }
});

addPasswordVisibilityToggles($("#login-form"));

$("#create-account").addEventListener("click", openCreateAccountModal);

$("#recover-password").addEventListener("click", openPasswordRecoveryModal);

$("#manage-recovery-code").addEventListener("click", async () => {
  const user = state.user;
  if (!user) return;
  try {
    const accounts = getAccounts();
    const account = accounts.find(item => item.id === user);
    if (!account) throw new Error("계정을 찾을 수 없어 복구 코드를 만들지 못했습니다.");
    if (account.recoveryCodeHash && !confirm("새 복구 코드를 만들까요? 기존 코드는 즉시 사용할 수 없게 됩니다.")) return;
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashPassword(normalizeRecoveryCode(recoveryCode));
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(accounts.map(item =>
      item.id === user ? { ...item, recoveryCodeHash } : item
    )));
    showRecoveryCode(recoveryCode, account.recoveryCodeHash
      ? "새 복구 코드를 만들었습니다. 이전 코드는 더 이상 사용할 수 없습니다."
      : "기존 계정에 복구 코드를 만들었습니다. 비밀번호를 잊었을 때 사용할 수 있습니다.");
  } catch (error) {
    console.error("복구 코드를 만들지 못했습니다.", error);
    showToast(error.message || "복구 코드를 만들지 못했습니다.");
  }
});

$("#delete-account").addEventListener("click", async event => {
  const user = state.user;
  if (!user) return;
  if (!confirm(`'${user}' 계정을 삭제할까요?\n이 계정의 저장된 모든 기록과 설정이 삭제됩니다. 진행 중인 기록은 저장되지 않으며, 다운로드한 파일은 삭제되지 않습니다.`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (state.activeSession?.user === user) {
      if (state.recording) await endTracking(false);
      else {
        state.activeSession = null;
        renderMap([], [], $("#map-canvas"));
      }
    }
    closeModal();
    await deleteUserSessions(user);
    const accounts = getAccounts().filter(account => account.id !== user);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(accounts));
    localStorage.removeItem(preferencesKey(user));
    localStorage.removeItem(PREFERENCES_KEY);
    state.user = null;
    state.preferences = { gps: false, audio: false, camera: false };
    state.reviewSession = null;
    $("#user-id").value = "";
    $("#password").value = "";
    showScreen("login-screen");
    showToast("계정과 저장된 기록을 삭제했습니다.");
  } catch (error) {
    console.error("계정을 삭제하지 못했습니다.", error);
    showToast(error.message || "계정을 삭제하지 못했습니다.");
  } finally {
    button.disabled = false;
  }
});

$("#start-app").addEventListener("click", async event => {
  persistPreferences();
  if (!Object.values(state.preferences).some(Boolean)) {
    return setMessage("#settings-message", "앱을 시작하려면 사용할 기능을 하나 이상 선택해 주세요.");
  }
  const button = event.currentTarget;
  button.disabled = true;
  const originalText = button.innerHTML;
  button.textContent = "시작 중...";
  setMessage("#settings-message", "");
  try {
    await prepareSavedDownloadDirectory();
    configureHome();
    showScreen("home-screen");
  } finally {
    button.disabled = false;
    button.innerHTML = originalText;
  }
});

$("#record-toggle").addEventListener("click", startTracking);
$("#pause-recording").addEventListener("click", pauseTracking);
$("#save-record").addEventListener("click", saveActiveRecord);
$("#open-review").addEventListener("click", openReview);
$("#review-close").addEventListener("click", () => showScreen("home-screen"));
$("#review-date").addEventListener("change", renderReviewList);
$$("[data-action='review']").forEach(button => button.addEventListener("click", openReview));
$$("[data-action='home']").forEach(button => button.addEventListener("click", () => showScreen("home-screen")));
$$("[data-action='settings']").forEach(button => button.addEventListener("click", () => {
  renderPreferences();
  showScreen("settings-screen");
}));
$$("[data-action='voice']").forEach(button => button.addEventListener("click", () => {
  if (!state.preferences.audio) return openFeatureSettings("audio");
  openVoiceModal();
}));
$$("[data-action='camera']").forEach(button => button.addEventListener("click", () => {
  if (!state.preferences.camera) return openFeatureSettings("camera");
  openCameraModal();
}));
$$("[data-action='logout']").forEach(button => button.addEventListener("click", () => {
  if (state.recording && !confirm("진행 중인 기록이 종료됩니다. 로그아웃할까요?")) return;
  if (state.recording) endTracking(false);
  state.user = null;
  $("#password").value = "";
  showScreen("login-screen");
}));

async function initialize() {
  try {
    state.db = await openDatabase();
    try {
      state.downloadDirectory = await getSavedDownloadDirectory();
    } catch (error) {
      console.error("저장 폴더 설정을 불러오지 못했습니다.", error);
      showToast("저장 폴더 설정을 불러오지 못했습니다. 다음 저장 시 폴더를 다시 선택해 주세요.");
    }
    $("#review-date").value = dateKey(new Date());
  } catch (error) {
    console.error(error);
    showToast(error.message);
  }
  configureHome();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.recording && !state.paused) requestScreenWakeLock();
});

initialize();
