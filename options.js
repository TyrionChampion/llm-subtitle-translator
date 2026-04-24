const $ = (id) => document.getElementById(id);

const MODEL_HINTS = {
  gemini: "默认: gemini-2.5-flash；也可填 gemini-2.5-pro 等。",
  openai: "默认: gpt-4o-mini；也可填 gpt-4.1-mini / gpt-4.1 等。",
  anthropic: "默认: claude-haiku-4-5-20251001；也可填其他 Claude 型号。",
  "google-translate":
    "Google Translate v2 无需模型设置，此项可留空。Cloud Translation API v2，需要在 Google Cloud Console 开启 API 并创建 API Key。",
  "google-translate-v3":
    "默认 general/translation-llm（Gemini 驱动，质量最好）；填 general/nmt 则用传统 NMT。也可填完整资源路径 projects/PROJECT/locations/LOC/models/general/translation-llm 或自训 AutoML 模型。",
  custom: "填写你的目标模型名。Endpoint 必须是 OpenAI chat/completions 兼容。",
};

// Local cache of the per-provider maps so that editing the API key or model
// for the currently-selected provider writes back to the correct slot, and
// switching providers instantly swaps the displayed value.
let apiKeys = {};
let models = {};
let skipLanguages = [];

function toast(msg, ok = true) {
  const el = $("saveStatus");
  el.textContent = msg;
  el.classList.add("visible");
  el.style.background = ok ? "" : "var(--err)";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("visible"), 1500);
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "getSettings" });
  // IMPORTANT: mutate the existing objects in place. The bindFixedSlot /
  // bindLLMField handlers captured the original references via closure; if
  // we reassigned the variables here, those handlers would keep writing to
  // the old (now-orphaned) object and never touch the displayed state.
  for (const k of Object.keys(apiKeys)) delete apiKeys[k];
  Object.assign(apiKeys, s.apiKeys || {});
  for (const k of Object.keys(models)) delete models[k];
  Object.assign(models, s.models || {});
  skipLanguages.length = 0;
  skipLanguages.push(...(s.skipLanguages || []));
  renderSkipChips();
  $("provider").value = s.provider;
  $("customEndpoint").value = s.customEndpoint || "";
  $("temperature").value = s.temperature ?? 0.2;
  $("targetLanguage").value = s.targetLanguage || "简体中文";
  $("contextLines").value = s.contextLines ?? 0;
  $("showOriginal").checked = !!s.showOriginal;
  $("enabled").checked = !!s.enabled;
  $("debug").checked = !!s.debug;
  $("fontFamily").value = s.fontFamily || "";
  $("fontSize").value = s.fontSize ?? 32;
  $("googleProjectId").value = s.googleProjectId || "";
  $("googleLocation").value = s.googleLocation || "us-central1";
  applyProviderSwap();
}

function applyProviderSwap() {
  const p = $("provider").value;
  const isV2 = p === "google-translate";
  const isV3 = p === "google-translate-v3";
  const isLLM = !isV2 && !isV3;

  // Show exactly one of the three blocks.
  $("llmBlock").hidden = !isLLM;
  $("v2Block").hidden = !isV2;
  $("v3Block").hidden = !isV3;
  $("customRow").hidden = p !== "custom";
  $("modelHint").textContent = MODEL_HINTS[p] || "";

  // Populate each block's fields from its own slot in the per-provider maps.
  $("apiKey").value = isLLM ? apiKeys[p] || "" : "";
  $("model").value = isLLM ? models[p] || "" : "";
  $("apiKeyV2").value = apiKeys["google-translate"] || "";
  $("saJson").value = apiKeys["google-translate-v3"] || "";
  $("modelV3").value = models["google-translate-v3"] || "";
}

async function saveField(key, value) {
  await chrome.runtime.sendMessage({
    type: "setSettings",
    patch: { [key]: value },
  });
  toast("已保存");
}

function bindText(id, key, parse = (v) => v) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveField(key, parse(el.value)), 300);
  });
}

function bindSelect(id, key) {
  $(id).addEventListener("change", (e) => {
    saveField(key, e.target.value);
    if (id === "provider") applyProviderSwap();
  });
}

function bindCheckbox(id, key) {
  $(id).addEventListener("change", (e) => saveField(key, e.target.checked));
}

// Per-provider save: write to apiKeys[provider] / models[provider].
function bindPerProvider(id, mapRef, mapName) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = $("provider").value;
      mapRef[p] = el.value;
      saveField(mapName, { ...mapRef });
    }, 300);
  });
}

bindSelect("provider", "provider");

// LLM block: apiKey / model go to the currently-selected provider's slot —
// but only when an LLM provider is actually active.
function bindLLMField(id, mapRef, mapName) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = $("provider").value;
      if (p === "google-translate" || p === "google-translate-v3") return;
      mapRef[p] = el.value;
      saveField(mapName, { ...mapRef });
    }, 300);
  });
}
bindLLMField("apiKey", apiKeys, "apiKeys");
bindLLMField("model", models, "models");

// Fixed-slot fields — each writes to a specific provider's slot regardless
// of which provider is currently active.
function bindFixedSlot(id, mapRef, mapName, slot) {
  const el = $(id);
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      mapRef[slot] = el.value;
      saveField(mapName, { ...mapRef });
    }, 300);
  });
}
bindFixedSlot("apiKeyV2", apiKeys, "apiKeys", "google-translate");
bindFixedSlot("saJson", apiKeys, "apiKeys", "google-translate-v3");
bindFixedSlot("modelV3", models, "models", "google-translate-v3");
bindText("customEndpoint", "customEndpoint");
bindText("temperature", "temperature", (v) => Number(v));
bindText("targetLanguage", "targetLanguage");
bindText("contextLines", "contextLines", (v) => Number(v));
bindCheckbox("showOriginal", "showOriginal");
bindCheckbox("enabled", "enabled");
bindCheckbox("debug", "debug");
bindText("fontFamily", "fontFamily");
bindText("fontSize", "fontSize", (v) => Number(v));
bindText("googleProjectId", "googleProjectId");
bindText("googleLocation", "googleLocation");

// Show/hide password inputs (shared helper)
function bindPasswordToggle(inputId, btnId) {
  $(btnId).addEventListener("click", () => {
    const input = $(inputId);
    const btn = $(btnId);
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "隐藏";
    } else {
      input.type = "password";
      btn.textContent = "显示";
    }
  });
}
bindPasswordToggle("apiKey", "toggleApiKey");
bindPasswordToggle("apiKeyV2", "toggleApiKeyV2");

// ---- Skip languages (chips UI) ----
function renderSkipChips() {
  const host = $("skipChips");
  host.innerHTML = "";
  for (const lang of skipLanguages) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = lang;
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.type = "button";
    btn.textContent = "×";
    btn.title = `移除 ${lang}`;
    btn.addEventListener("click", () => {
      const idx = skipLanguages.indexOf(lang);
      if (idx >= 0) {
        skipLanguages.splice(idx, 1);
        saveField("skipLanguages", [...skipLanguages]);
        renderSkipChips();
      }
    });
    chip.appendChild(btn);
    host.appendChild(chip);
  }
  // Mark preset buttons as active if the language is already in the list
  document.querySelectorAll("#skipPresets .preset").forEach((b) => {
    b.classList.toggle("active", skipLanguages.includes(b.dataset.lang));
  });
}

function addSkipLang(lang) {
  const v = (lang || "").trim();
  if (!v) return;
  if (skipLanguages.includes(v)) return;
  skipLanguages.push(v);
  saveField("skipLanguages", [...skipLanguages]);
  renderSkipChips();
}

document.querySelectorAll("#skipPresets .preset").forEach((b) => {
  b.addEventListener("click", () => {
    const lang = b.dataset.lang;
    if (skipLanguages.includes(lang)) {
      // Clicking an active preset removes it
      skipLanguages.splice(skipLanguages.indexOf(lang), 1);
      saveField("skipLanguages", [...skipLanguages]);
    } else {
      skipLanguages.push(lang);
      saveField("skipLanguages", [...skipLanguages]);
    }
    renderSkipChips();
  });
});

$("skipLangAdd").addEventListener("click", () => {
  const input = $("skipLangCustom");
  addSkipLang(input.value);
  input.value = "";
});
$("skipLangCustom").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("skipLangAdd").click();
  }
});

// Show/hide Service Account JSON (textarea uses a CSS mask class rather than
// input type=password, which doesn't apply to <textarea>).
$("toggleSaJson").addEventListener("click", () => {
  const ta = $("saJson");
  const btn = $("toggleSaJson");
  if (ta.classList.contains("masked")) {
    ta.classList.remove("masked");
    btn.textContent = "隐藏";
  } else {
    ta.classList.add("masked");
    btn.textContent = "显示";
  }
});
// Default: masked
$("saJson").classList.add("masked");

$("testBtn").addEventListener("click", async () => {
  const statusEl = $("testStatus");
  statusEl.textContent = "测试中…";
  statusEl.className = "inline-status";
  const resp = await chrome.runtime.sendMessage({
    type: "translate",
    lines: ["Hello, world."],
    history: [],
  });
  if (resp?.ok) {
    statusEl.textContent = `✓ 成功: ${resp.translations[0]}`;
    statusEl.className = "inline-status ok";
  } else {
    statusEl.textContent = `✗ ${resp?.error || "未知错误"}`;
    statusEl.className = "inline-status err";
  }
});

load();
