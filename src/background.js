// Background service worker: fetches PR data, caches it, and runs the analysis.

import { analyzePullRequests } from "./analysis.js";
import {
  FILE_FETCH_CONCURRENCY,
  GitHubError,
  fetchOpenPullRequests,
  fetchPullRequestFiles,
  mapWithConcurrency,
} from "./github.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const REPORT_TTL_MS = 5 * 60 * 1000;

/** One in-flight build per repository, shared by all tabs that ask. */
const inFlight = new Map();

/** Lists storage keys without loading every cached value. */
async function storedKeys() {
  if (chrome.storage.local.getKeys) return chrome.storage.local.getKeys();
  return Object.keys(await chrome.storage.local.get(null));
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...stored.settings };
}

async function buildReport(owner, name, settings) {
  const repoKey = `${owner}/${name}`.toLowerCase();
  const { total, nodes } = await fetchOpenPullRequests(settings.token, owner, name, settings.maxPullRequests);

  // A PR's files only change when its head commit changes, so the cache
  // entry is reused while the head SHA matches.
  const fileKeys = nodes.map((pr) => `files:${repoKey}#${pr.number}`);
  const cached = fileKeys.length ? await chrome.storage.local.get(fileKeys) : {};
  const fresh = {};

  const fileSets = await mapWithConcurrency(nodes, FILE_FETCH_CONCURRENCY, async (pr, index) => {
    const hit = cached[fileKeys[index]];
    if (hit && hit.sha === pr.headRefOid) return hit;
    const result = await fetchPullRequestFiles(settings.token, owner, name, pr.number);
    const entry = { sha: pr.headRefOid, ...result };
    fresh[fileKeys[index]] = entry;
    return entry;
  });

  // Drop cache entries for PRs that are no longer open (or no longer analyzed).
  const keep = new Set(fileKeys);
  const stale = (await storedKeys()).filter((key) => key.startsWith(`files:${repoKey}#`) && !keep.has(key));
  if (stale.length) await chrome.storage.local.remove(stale);
  if (Object.keys(fresh).length) await chrome.storage.local.set(fresh);

  const analysis = analyzePullRequests(
    nodes.map((pr, index) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? "ghost",
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      mergeable: pr.mergeable,
      baseRef: pr.baseRefName,
      additions: pr.additions,
      deletions: pr.deletions,
      filesTruncated: fileSets[index].truncated,
      files: fileSets[index].files,
    })),
  );

  return {
    repo: `${owner}/${name}`,
    fetchedAt: Date.now(),
    totalOpen: total,
    staleDays: settings.staleDays,
    ...analysis,
  };
}

async function getReport(owner, name, force) {
  const settings = await loadSettings();
  if (!settings.token) {
    throw new GitHubError("auth", "Add a GitHub token in the extension settings.");
  }
  const reportKey = `report:${owner}/${name}`.toLowerCase();
  if (!force) {
    const stored = (await chrome.storage.local.get(reportKey))[reportKey];
    if (stored && Date.now() - stored.fetchedAt < REPORT_TTL_MS) return stored;
  }
  let pending = inFlight.get(reportKey);
  if (!pending) {
    pending = buildReport(owner, name, settings)
      .then(async (report) => {
        await chrome.storage.local.set({ [reportKey]: report });
        return report;
      })
      .finally(() => inFlight.delete(reportKey));
    inFlight.set(reportKey, pending);
  }
  return pending;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getReport") {
    getReport(message.owner, message.name, Boolean(message.force))
      .then((report) => sendResponse({ ok: true, report }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: { kind: error.kind ?? "api", message: error.message ?? String(error) },
        }),
      );
    return true; // keeps the channel open for the async response
  }
  if (message?.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// A settings change can change the analyzed PR set, so cached reports are stale.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const reports = (await storedKeys()).filter((key) => key.startsWith("report:"));
  if (reports.length) await chrome.storage.local.remove(reports);
});
