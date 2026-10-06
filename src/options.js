import { DEFAULT_SETTINGS } from "./settings.js";

const form = document.getElementById("form");
const fields = ["token", "maxPullRequests", "staleDays"];
const status = document.getElementById("status");

const { settings } = await chrome.storage.local.get("settings");
const current = { ...DEFAULT_SETTINGS, ...settings };
for (const field of fields) document.getElementById(field).value = current[field];

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = {
    token: document.getElementById("token").value.trim(),
    maxPullRequests: clamp(document.getElementById("maxPullRequests").valueAsNumber, 1, 500, DEFAULT_SETTINGS.maxPullRequests),
    staleDays: clamp(document.getElementById("staleDays").valueAsNumber, 1, 365, DEFAULT_SETTINGS.staleDays),
  };
  await chrome.storage.local.set({ settings: next });
  status.textContent = "Saved. Reload the GitHub tab to apply.";
});

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
