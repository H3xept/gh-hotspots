// Content script: adds hotspot badges to the PR list and a hotspot panel to
// every repository page. Data comes from the background worker.
(() => {
  if (window.__prHotspotsLoaded) return;
  window.__prHotspotsLoaded = true;

  const state = {
    repoKey: null,
    report: null,
    error: null,
    loading: false,
    panelOpen: false,
    tab: "prs", // "prs" | "files" | "map"
    sort: "risk", // "risk" | "activity" | "number"
    expanded: new Set(),
    pair: null, // [a, b] selected in the overlap map
    panelWidth: 480, // px; persisted in chrome.storage.local as "panelWidth"
  };

  // ---------------------------------------------------------------- context

  /** Returns the repository of the current page, or null off repository pages. */
  function currentRepo() {
    if (!document.querySelector('meta[name="octolytics-dimension-repository_nwo"]')) return null;
    const [, owner, name] = location.pathname.split("/");
    if (!owner || !name) return null;
    return { owner, name, key: `${owner}/${name}`.toLowerCase() };
  }

  /** "list" on /pulls, the PR number on /pull/N, otherwise null. */
  function currentPage() {
    const [, , , section, number] = location.pathname.split("/");
    if (section === "pulls") return { kind: "list" };
    if (section === "pull" && /^\d+$/.test(number ?? "")) return { kind: "pr", number: Number(number) };
    return { kind: "other" };
  }

  // ------------------------------------------------------------------ data

  async function load(force) {
    const repo = currentRepo();
    if (!repo) return;
    state.loading = true;
    state.error = null;
    render();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "getReport", owner: repo.owner, name: repo.name, force });
    } catch (error) {
      response = { ok: false, error: { kind: "extension", message: "The extension was reloaded. Reload this page." } };
    }
    if (state.repoKey !== repo.key) return; // the user navigated to another repository
    state.loading = false;
    if (response.ok) state.report = response.report;
    else state.error = response.error;
    render();
    applyBadges();
  }

  // ------------------------------------------------------------- formatting

  const escapeMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => escapeMap[c]);

  function age(iso) {
    const minutes = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 60) return `${Math.round(minutes)}m`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = hours / 24;
    if (days < 60) return `${Math.round(days)}d`;
    if (days < 730) return `${Math.round(days / 30)}mo`;
    return `${Math.round(days / 365)}y`;
  }

  const isStale = (pr) => Date.now() - new Date(pr.updatedAt).getTime() > state.report.staleDays * 86400000;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function statusLabel(pr) {
    if (pr.status === "collides") return `likely conflicts with ${plural(pr.collidingPrCount, "PR")}`;
    if (pr.status === "overlaps") return `shares files with ${plural(pr.overlaps.length, "PR")}`;
    return "isolated";
  }

  function riskOrder(a, b) {
    return (
      b.collidingPrCount - a.collidingPrCount ||
      b.collisionCount - a.collisionCount ||
      Number(b.mergeable === "CONFLICTING") - Number(a.mergeable === "CONFLICTING") ||
      b.overlaps.length - a.overlaps.length ||
      b.number - a.number
    );
  }

  function sortedPrs() {
    const prs = [...state.report.prs];
    if (state.sort === "activity") prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    else if (state.sort === "number") prs.sort((a, b) => b.number - a.number);
    else prs.sort(riskOrder);
    return prs;
  }

  // ----------------------------------------------------------------- badges

  function badgeTooltip(pr) {
    const lines = [`#${pr.number}: ${statusLabel(pr)}`];
    for (const overlap of pr.overlaps.slice(0, 8)) {
      const kind = overlap.collisions > 0 ? `${plural(overlap.collisions, "overlapping change")} in` : "same";
      lines.push(`  #${overlap.number}: ${kind} ${plural(overlap.sharedFiles.length, "file")}`);
    }
    if (pr.overlaps.length > 8) lines.push(`  …and ${pr.overlaps.length - 8} more`);
    if (pr.mergeable === "CONFLICTING") lines.push("Conflicts with its base branch now.");
    lines.push(`Last activity ${age(pr.updatedAt)} ago. Click for details.`);
    return lines.join("\n");
  }

  function badgeHtml(pr) {
    const chips = [`<span class="prh-chip prh-${pr.status}">${esc(statusLabel(pr))}</span>`];
    if (pr.mergeable === "CONFLICTING") chips.push('<span class="prh-chip prh-base-conflict">conflicts with base</span>');
    chips.push(`<span class="prh-chip ${isStale(pr) ? "prh-stale" : "prh-activity"}">${age(pr.updatedAt)} ago</span>`);
    return chips.join("");
  }

  /** Adds or refreshes one badge group after each PR title link on the list page. */
  function applyBadges() {
    const repo = currentRepo();
    if (!repo || !state.report || currentPage().kind !== "list") return;
    const byNumber = new Map(state.report.prs.map((pr) => [pr.number, pr]));
    const pathPattern = new RegExp(`^/${escapeRegExp(repo.owner)}/${escapeRegExp(repo.name)}/pull/(\\d+)/?$`, "i");
    const done = new Set();

    for (const link of document.querySelectorAll('a[href*="/pull/"]')) {
      if (link.closest(".prh-badges, header, nav")) continue;
      const url = new URL(link.href, location.href);
      const match = url.hash ? null : pathPattern.exec(url.pathname);
      const text = link.textContent.trim();
      if (!match || !text || text.startsWith("#")) continue;
      const number = Number(match[1]);
      const pr = byNumber.get(number);
      if (!pr || done.has(number)) continue;
      done.add(number);

      const signature = `${state.report.fetchedAt}:${number}`;
      let badge = link.nextElementSibling?.classList.contains("prh-badges") ? link.nextElementSibling : null;
      if (badge?.dataset.signature === signature) continue;
      badge?.remove();
      badge = document.createElement("span");
      badge.className = "prh-badges";
      badge.dataset.signature = signature;
      badge.title = badgeTooltip(pr);
      badge.innerHTML = badgeHtml(pr);
      badge.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanelAt(number);
      });
      link.after(badge);
    }
  }

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ------------------------------------------------------------------ panel

  let host = null;
  let root = null;

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "pr-hotspots-root";
    root = host.attachShadow({ mode: "open" });
    root.addEventListener("click", onPanelClick);
    root.addEventListener("change", onPanelChange);
    root.addEventListener("pointerdown", onResizeStart);
    document.body.append(host);
  }

  function removeHost() {
    host?.remove();
    host = null;
    applyDock();
  }

  // The open panel docks to the right edge: the page gets a right margin of
  // the panel's width, so GitHub's layout reflows instead of sitting under it.
  const MIN_PANEL_WIDTH = 320;
  const MIN_PAGE_WIDTH = 400;

  function clampWidth(width) {
    const max = Math.max(MIN_PANEL_WIDTH, document.documentElement.clientWidth - MIN_PAGE_WIDTH);
    return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)));
  }

  function applyDock() {
    const html = document.documentElement;
    if (state.panelOpen && host?.isConnected) {
      html.style.setProperty("margin-right", `${clampWidth(state.panelWidth)}px`, "important");
    } else {
      html.style.removeProperty("margin-right");
    }
  }

  function onResizeStart(event) {
    const handle = event.target.closest?.(".resize");
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("active");
    const panel = root.querySelector(".panel");

    const onMove = (move) => {
      state.panelWidth = clampWidth(document.documentElement.clientWidth - move.clientX);
      panel.style.width = `${state.panelWidth}px`;
      applyDock();
    };
    const onEnd = () => {
      handle.classList.remove("active");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      chrome.storage.local.set({ panelWidth: state.panelWidth }).catch(() => {});
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  function openPanelAt(number) {
    state.panelOpen = true;
    state.tab = "prs";
    if (number) state.expanded.add(number);
    render();
    if (number) root.querySelector(`[data-row="${number}"]`)?.scrollIntoView({ block: "center" });
  }

  function launcherHtml() {
    const page = currentPage();
    let label = "PR hotspots";
    let tone = "";
    if (state.loading && !state.report) label = "PR hotspots…";
    else if (state.error) [label, tone] = ["PR hotspots: error", "danger"];
    else if (state.report && page.kind === "pr") {
      const pr = state.report.prs.find((p) => p.number === page.number);
      if (pr) [label, tone] = [`This PR ${statusLabel(pr)}`, toneOf(pr)];
    } else if (state.report) {
      const colliding = state.report.prs.filter((p) => p.status === "collides").length;
      label = `PR hotspots · ${colliding} likely conflicting`;
      tone = colliding ? "danger" : "success";
    }
    return `<button class="launcher ${tone}" data-action="toggle">${esc(label)}</button>`;
  }

  const toneOf = (pr) => ({ collides: "danger", overlaps: "attention", isolated: "success" })[pr.status];

  function summaryHtml(report) {
    const count = (fn) => report.prs.filter(fn).length;
    const items = [
      ["success", count((p) => p.status === "isolated"), "isolated"],
      ["attention", count((p) => p.status === "overlaps"), "share files"],
      ["danger", count((p) => p.status === "collides"), "likely conflict"],
      ["danger-strong", count((p) => p.mergeable === "CONFLICTING"), "conflict with base"],
      ["severe", count(isStale), `idle > ${report.staleDays}d`],
    ];
    return `<div class="summary">${items
      .map(([tone, n, label]) => `<div class="stat ${tone}"><b>${n}</b><span>${esc(label)}</span></div>`)
      .join("")}</div>`;
  }

  function prRowHtml(pr, focusNumber) {
    const expanded = state.expanded.has(pr.number);
    const flags = [];
    if (pr.mergeable === "CONFLICTING") flags.push('<span class="chip danger-strong">base conflict</span>');
    if (pr.isDraft) flags.push('<span class="chip muted">draft</span>');
    if (pr.filesTruncated) flags.push('<span class="chip muted" title="GitHub returned only part of the file list">partial</span>');
    const detail = expanded ? prDetailHtml(pr) : "";
    return `
      <div class="row ${pr.number === focusNumber ? "focus" : ""}" data-row="${pr.number}">
        <button class="row-main" data-action="expand" data-number="${pr.number}" aria-expanded="${expanded}">
          <span class="dot ${toneOf(pr)}"></span>
          <span class="title"><span class="num">#${pr.number}</span> ${esc(pr.title)}
            <span class="sub">${esc(pr.author)} · ${plural(pr.fileCount, "file")} · +${pr.additions} −${pr.deletions}${pr.baseRef ? ` · into ${esc(pr.baseRef)}` : ""}</span>
          </span>
          <span class="meta">
            <span class="status ${toneOf(pr)}">${esc(statusLabel(pr))}</span>
            ${flags.join("")}
            <span class="when ${isStale(pr) ? "severe" : ""}" title="${esc(new Date(pr.updatedAt).toLocaleString())}">${age(pr.updatedAt)} ago</span>
          </span>
        </button>
        ${detail}
      </div>`;
  }

  function prDetailHtml(pr) {
    const byNumber = new Map(state.report.prs.map((p) => [p.number, p]));
    const overlaps = pr.overlaps.length
      ? pr.overlaps
          .map((o) => {
            const other = byNumber.get(o.number);
            const colliding = new Set(o.collidingFiles);
            const files = o.sharedFiles
              .map((f) => `<li class="${colliding.has(f) ? "danger" : ""}">${colliding.has(f) ? "⚠ " : ""}<code>${esc(f)}</code></li>`)
              .join("");
            const summary =
              o.collisions > 0
                ? `${plural(o.collisions, "overlapping change")} in ${plural(o.collidingFiles.length, "file")}, ${o.sharedFiles.length} shared`
                : `${plural(o.sharedFiles.length, "shared file")}, changes far apart`;
            return `<div class="overlap">
              <a href="${esc(other.url)}" target="_blank" rel="noopener"><span class="dot ${o.collisions ? "danger" : "attention"}"></span>#${o.number} ${esc(other.title)}</a>
              <span class="sub">${esc(summary)} · ${esc(other.author)} · ${age(other.updatedAt)} ago</span>
              <ul>${files}</ul>
            </div>`;
          })
          .join("")
      : '<p class="sub">No other open PR touches these files.</p>';
    return `<div class="detail">
      <a class="open" href="${esc(pr.url)}">Open #${pr.number} →</a>
      ${overlaps}
    </div>`;
  }

  function filesTabHtml(report) {
    if (!report.hotspots.length) return '<p class="empty">No file is touched by more than one open PR.</p>';
    const max = report.hotspots[0].prs.length;
    const titles = new Map(report.prs.map((p) => [p.number, p]));
    return `<div class="files">${report.hotspots
      .map((h) => {
        const colliding = new Set(h.collidingPrs);
        const chips = h.prs
          .map((n) => {
            const pr = titles.get(n);
            return `<a class="chip ${colliding.has(n) ? "danger" : "attention"}" href="${esc(pr.url)}" title="${esc(pr.title)}">#${n}</a>`;
          })
          .join("");
        return `<div class="file">
          <div class="file-head"><code title="${esc(h.path)}">${esc(h.path)}</code><b>${h.prs.length} PRs</b></div>
          <div class="bar"><span style="width:${(100 * h.prs.length) / max}%" class="${h.collidingPrs.length ? "danger" : "attention"}"></span></div>
          <div class="chips">${chips}</div>
        </div>`;
      })
      .join("")}</div>`;
  }

  function mapTabHtml(report) {
    const prs = report.prs.filter((p) => p.status !== "isolated").sort(riskOrder).slice(0, 60);
    if (!prs.length) return '<p class="empty">Every open PR is isolated.</p>';
    const pairOf = new Map();
    for (const pr of prs) for (const o of pr.overlaps) pairOf.set(`${pr.number}:${o.number}`, o);

    const header = prs.map((p) => `<div class="col-label" title="#${p.number} ${esc(p.title)}">${p.number}</div>`).join("");
    const rows = prs
      .map((row) => {
        const cells = prs
          .map((col) => {
            if (row.number === col.number) return '<div class="cell self"></div>';
            const o = pairOf.get(`${row.number}:${col.number}`);
            if (!o) return '<div class="cell"></div>';
            const strength = o.collisions
              ? Math.min(1, 0.35 + o.collisions / 8)
              : Math.min(0.9, 0.25 + o.sharedFiles.length / 10);
            const selected = state.pair && state.pair.includes(row.number) && state.pair.includes(col.number);
            const tip = `#${row.number} × #${col.number}: ${plural(o.sharedFiles.length, "shared file")}, ${plural(o.collisions, "overlapping change")}`;
            return `<button class="cell ${o.collisions ? "danger" : "attention"} ${selected ? "selected" : ""}" style="opacity:${strength.toFixed(2)}" data-action="pair" data-a="${row.number}" data-b="${col.number}" title="${esc(tip)}"></button>`;
          })
          .join("");
        return `<div class="row-label" title="${esc(row.title)}">#${row.number}</div>${cells}`;
      })
      .join("");

    let selection = '<p class="sub">Select a cell to see the shared files of two PRs.</p>';
    if (state.pair) {
      const [a, b] = state.pair;
      const o = pairOf.get(`${a}:${b}`);
      const prA = report.prs.find((p) => p.number === a);
      const prB = report.prs.find((p) => p.number === b);
      if (o && prA && prB) {
        const colliding = new Set(o.collidingFiles);
        selection = `<div class="overlap">
          <div><a href="${esc(prA.url)}">#${a} ${esc(prA.title)}</a></div>
          <div><a href="${esc(prB.url)}">#${b} ${esc(prB.title)}</a></div>
          <ul>${o.sharedFiles.map((f) => `<li class="${colliding.has(f) ? "danger" : ""}">${colliding.has(f) ? "⚠ " : ""}<code>${esc(f)}</code></li>`).join("")}</ul>
        </div>`;
      }
    }

    return `<div class="legend"><span class="swatch attention"></span>shared files <span class="swatch danger"></span>overlapping changes · darker = more</div>
      <div class="matrix" style="grid-template-columns: 56px repeat(${prs.length}, 14px); grid-template-rows: 36px">
        <div></div>${header}${rows}
      </div>
      ${selection}`;
  }

  function panelHtml() {
    const report = state.report;
    const page = currentPage();
    const focus = page.kind === "pr" ? page.number : null;
    const updated = report ? `updated ${age(new Date(report.fetchedAt).toISOString())} ago` : "";
    const analyzed =
      report && report.totalOpen > report.prs.length
        ? ` · ${report.prs.length} of ${report.totalOpen} open PRs (most recently updated)`
        : report
          ? ` · ${report.prs.length} open PRs`
          : "";

    let body;
    if (state.error) {
      const settings = state.error.kind === "auth" ? '<button class="link" data-action="settings">Open settings</button>' : "";
      body = `<div class="error">${esc(state.error.message)} ${settings}</div>`;
    } else if (!report) {
      body = '<p class="empty">Loading open pull requests…</p>';
    } else {
      let tabBody;
      if (state.tab === "files") tabBody = filesTabHtml(report);
      else if (state.tab === "map") tabBody = mapTabHtml(report);
      else {
        const prs = sortedPrs();
        const focused = focus ? prs.find((p) => p.number === focus) : null;
        const ordered = focused ? [focused, ...prs.filter((p) => p !== focused)] : prs;
        tabBody = `<div class="toolbar">Sort by
            <select data-action="sort">
              <option value="risk" ${state.sort === "risk" ? "selected" : ""}>conflict risk</option>
              <option value="activity" ${state.sort === "activity" ? "selected" : ""}>last activity</option>
              <option value="number" ${state.sort === "number" ? "selected" : ""}>newest</option>
            </select></div>
          <div class="rows">${ordered.map((pr) => prRowHtml(pr, focus)).join("") || '<p class="empty">No open pull requests.</p>'}</div>`;
      }
      const tab = (id, label) =>
        `<button class="tab ${state.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}</button>`;
      body = `${summaryHtml(report)}
        <div class="tabs">${tab("prs", "Pull requests")}${tab("files", `Hotspot files (${report.hotspots.length})`)}${tab("map", "Overlap map")}</div>
        <div class="tab-body">${tabBody}</div>`;
    }

    return `<aside class="panel" role="complementary" aria-label="PR hotspots" style="width:${clampWidth(state.panelWidth)}px">
      <div class="resize" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
      <header>
        <div>
          <h2>PR hotspots</h2>
          <div class="sub">${esc(report?.repo ?? currentRepo()?.key ?? "")}${esc(analyzed)}${updated ? ` · ${esc(updated)}` : ""}</div>
        </div>
        <div class="actions">
          <button data-action="refresh" ${state.loading ? "disabled" : ""}>${state.loading ? "Loading…" : "Refresh"}</button>
          <button data-action="settings" title="Settings">Settings</button>
          <button data-action="toggle" title="Close (Esc)">✕</button>
        </div>
      </header>
      ${body}
    </aside>`;
  }

  function render() {
    if (!currentRepo()) return removeHost();
    ensureHost();
    const scroll = root.querySelector(".tab-body")?.scrollTop ?? 0;
    root.innerHTML = `<style>${PANEL_CSS}</style>${state.panelOpen ? panelHtml() : launcherHtml()}`;
    const body = root.querySelector(".tab-body");
    if (body) body.scrollTop = scroll;
    applyDock();
  }

  function onPanelClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target || target.tagName === "SELECT") return;
    const action = target.dataset.action;
    if (action === "toggle") {
      state.panelOpen = !state.panelOpen;
      if (state.panelOpen && !state.report && !state.loading) load(false);
      const page = currentPage();
      if (state.panelOpen && page.kind === "pr") {
        state.tab = "prs";
        state.expanded.add(page.number);
      }
    } else if (action === "refresh") {
      load(true);
      return;
    } else if (action === "settings") {
      chrome.runtime.sendMessage({ type: "openOptions" });
      return;
    } else if (action === "tab") {
      state.tab = target.dataset.tab;
    } else if (action === "expand") {
      const number = Number(target.dataset.number);
      if (state.expanded.has(number)) state.expanded.delete(number);
      else state.expanded.add(number);
    } else if (action === "pair") {
      state.pair = [Number(target.dataset.a), Number(target.dataset.b)];
    }
    render();
  }

  function onPanelChange(event) {
    if (event.target.dataset.action === "sort") {
      state.sort = event.target.value;
      render();
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.panelOpen) {
      state.panelOpen = false;
      render();
    }
  });

  // ------------------------------------------------------------- lifecycle

  let lastUrl = null;

  /** Reacts to GitHub's client-side navigation and to list re-renders. */
  function sync() {
    const repo = currentRepo();
    if (!repo) {
      state.repoKey = null;
      removeHost();
      return;
    }
    if (repo.key !== state.repoKey) {
      Object.assign(state, { repoKey: repo.key, report: null, error: null, loading: false, expanded: new Set(), pair: null });
    }
    const page = currentPage();
    const wantsData = page.kind !== "other" || state.panelOpen;
    if (wantsData && !state.report && !state.loading && !state.error) load(false);
    if (location.href !== lastUrl || !host?.isConnected) {
      lastUrl = location.href;
      render();
    }
    applyBadges();
  }

  let scheduled = 0;
  const scheduleSync = () => {
    clearTimeout(scheduled);
    scheduled = setTimeout(sync, 150);
  };
  new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("turbo:load", scheduleSync);
  window.addEventListener("popstate", scheduleSync);
  window.addEventListener("resize", () => {
    if (!state.panelOpen) return;
    root?.querySelector(".panel")?.style.setProperty("width", `${clampWidth(state.panelWidth)}px`);
    applyDock();
  });

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    :host, button, select { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
    button { color: inherit; }
    a { color: var(--fgColor-accent, #0969da); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .sub { color: var(--fgColor-muted, #59636e); font-size: 12px; }
    .empty { color: var(--fgColor-muted, #59636e); padding: 24px 16px; text-align: center; }

    .launcher {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
      padding: 8px 14px; border-radius: 999px; cursor: pointer; font-weight: 600;
      background: var(--bgColor-default, #fff); color: var(--fgColor-default, #1f2328);
      border: 1px solid var(--borderColor-default, #d1d9e0);
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
    }
    .launcher::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: var(--fgColor-muted, #59636e); vertical-align: 1px; }
    .launcher.success::before { background: var(--fgColor-success, #1a7f37); }
    .launcher.attention::before { background: var(--fgColor-attention, #9a6700); }
    .launcher.danger::before { background: var(--fgColor-danger, #d1242f); }

    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483000;
      display: flex; flex-direction: column;
      background: var(--bgColor-default, #fff); color: var(--fgColor-default, #1f2328);
      border-left: 1px solid var(--borderColor-default, #d1d9e0);
    }
    .resize { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; touch-action: none; z-index: 1; }
    .resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; transition: background .15s; }
    .resize:hover::after, .resize.active::after { background: var(--fgColor-accent, #0969da); }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3); }
    h2 { margin: 0; font-size: 16px; }
    .actions { display: flex; gap: 6px; flex-shrink: 0; }
    .actions button, .link {
      padding: 3px 10px; border-radius: 6px; cursor: pointer;
      background: var(--button-default-bgColor-rest, #f6f8fa); border: 1px solid var(--borderColor-default, #d1d9e0);
    }
    .actions button:disabled { opacity: .6; cursor: progress; }
    .error { margin: 16px; padding: 12px; border-radius: 6px; color: var(--fgColor-danger, #d1242f); background: var(--bgColor-danger-muted, #ffebe9); }

    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 6px; padding: 12px 16px; }
    .stat { padding: 6px 8px; border-radius: 6px; background: var(--bgColor-muted, #f6f8fa); border-top: 3px solid var(--borderColor-default, #d1d9e0); }
    .stat b { display: block; font-size: 18px; }
    .stat span { font-size: 11px; color: var(--fgColor-muted, #59636e); }
    .stat.success { border-top-color: var(--fgColor-success, #1a7f37); }
    .stat.attention { border-top-color: var(--fgColor-attention, #9a6700); }
    .stat.danger { border-top-color: var(--fgColor-danger, #d1242f); }
    .stat.danger-strong { border-top-color: var(--bgColor-danger-emphasis, #cf222e); }
    .stat.severe { border-top-color: var(--fgColor-severe, #bc4c00); }

    .tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3); }
    .tab { padding: 8px 10px; background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; color: var(--fgColor-muted, #59636e); }
    .tab.active { color: var(--fgColor-default, #1f2328); font-weight: 600; border-bottom-color: var(--underlineNav-borderColor-active, #fd8c73); }
    .tab-body { flex: 1; overflow: auto; }
    .toolbar { padding: 8px 16px; color: var(--fgColor-muted, #59636e); font-size: 12px; }
    select { margin-left: 6px; color: inherit; background: var(--bgColor-default, #fff); border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; padding: 2px 6px; }

    .row { border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3); }
    .row.focus { background: var(--bgColor-accent-muted, #ddf4ff); }
    .row-main { display: flex; width: 100%; gap: 10px; align-items: flex-start; padding: 9px 16px; text-align: left; background: none; border: none; cursor: pointer; }
    .row-main:hover { background: var(--bgColor-muted, #f6f8fa); }
    .title { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
    .title .sub { display: block; font-weight: 400; }
    .num { color: var(--fgColor-muted, #59636e); font-weight: 400; }
    .meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; font-size: 12px; }
    .status.success { color: var(--fgColor-success, #1a7f37); }
    .status.attention { color: var(--fgColor-attention, #9a6700); }
    .status.danger { color: var(--fgColor-danger, #d1242f); font-weight: 600; }
    .when { color: var(--fgColor-muted, #59636e); }
    .when.severe { color: var(--fgColor-severe, #bc4c00); font-weight: 600; }

    .dot { display: inline-block; flex-shrink: 0; width: 9px; height: 9px; border-radius: 50%; margin: 5px 6px 0 0; background: var(--fgColor-muted, #59636e); }
    .dot.success { background: var(--fgColor-success, #1a7f37); }
    .dot.attention { background: var(--fgColor-attention, #bf8700); }
    .dot.danger { background: var(--fgColor-danger, #d1242f); }

    .chip { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 1px solid transparent; }
    .chip.muted { color: var(--fgColor-muted, #59636e); border-color: var(--borderColor-default, #d1d9e0); }
    .chip.danger-strong { color: #fff; background: var(--bgColor-danger-emphasis, #cf222e); }
    .chip.danger { color: var(--fgColor-danger, #d1242f); background: var(--bgColor-danger-muted, #ffebe9); }
    .chip.attention { color: var(--fgColor-attention, #9a6700); background: var(--bgColor-attention-muted, #fff8c5); }

    .detail { padding: 4px 16px 12px 35px; }
    .detail .open { display: inline-block; margin-bottom: 8px; font-size: 12px; }
    .overlap { margin: 6px 0 10px; }
    .overlap > a { font-weight: 600; }
    .overlap .sub { display: block; }
    ul { margin: 4px 0 0; padding-left: 16px; }
    li { overflow-wrap: anywhere; }
    li.danger { color: var(--fgColor-danger, #d1242f); }

    .files { padding: 8px 16px; }
    .file { padding: 8px 0; border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3); }
    .file-head { display: flex; justify-content: space-between; gap: 12px; }
    .file-head code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
    .file-head b { flex-shrink: 0; font-size: 12px; }
    .bar { height: 4px; margin: 5px 0; border-radius: 2px; background: var(--bgColor-muted, #f6f8fa); }
    .bar span { display: block; height: 100%; border-radius: 2px; }
    .bar .danger { background: var(--fgColor-danger, #d1242f); }
    .bar .attention { background: var(--fgColor-attention, #bf8700); }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }

    .legend { padding: 10px 16px; font-size: 12px; color: var(--fgColor-muted, #59636e); }
    .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 8px; vertical-align: -1px; }
    .swatch.attention, .cell.attention { background: var(--fgColor-attention, #bf8700); }
    .swatch.danger, .cell.danger { background: var(--fgColor-danger, #d1242f); }
    .matrix { display: grid; gap: 1px; padding: 0 16px 12px; grid-auto-rows: 14px; align-items: center; overflow-x: auto; }
    .col-label { font-size: 8px; color: var(--fgColor-muted, #59636e); writing-mode: vertical-rl; transform: rotate(180deg); height: 34px; align-self: end; line-height: 14px; }
    .row-label { font-size: 11px; color: var(--fgColor-muted, #59636e); text-align: right; padding-right: 6px; }
    .cell { width: 14px; height: 14px; padding: 0; border: none; border-radius: 2px; background: var(--bgColor-muted, #f6f8fa); }
    button.cell { cursor: pointer; }
    .cell.self { background: var(--borderColor-default, #d1d9e0); }
    .cell.selected { outline: 2px solid var(--fgColor-accent, #0969da); opacity: 1 !important; }
    .tab-body > .sub, .tab-body > .overlap { padding: 0 16px; }
  `;

  chrome.storage.local
    .get("panelWidth")
    .then(({ panelWidth }) => {
      if (Number.isFinite(panelWidth)) state.panelWidth = panelWidth;
    })
    .catch(() => {})
    .finally(sync);
})();
