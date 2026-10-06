// Pure analysis of open pull requests. No browser or network APIs here, so
// the background worker and the unit tests share the same code.
//
// Coordinates: a changed region is a closed interval on the base file, in
// "half-line" units. Line n spans [2n-1, 2n+1]; the gap before line n is the
// point 2n-1. Modifying lines a..b gives [2a-1, 2b+1]. Inserting before line
// n gives [2n-1, 2n-1]. Two regions collide when the intervals intersect,
// which matches git's rule that overlapping or adjacent edits conflict.

/** Marks a file whose changed lines are unknown (binary, huge, added, removed). */
export const WHOLE_FILE = null;

/**
 * Parses a unified diff patch into changed regions on the base file.
 * @param {string | undefined} patch
 * @returns {Array<[number, number]> | null} regions, or WHOLE_FILE when the patch is missing
 */
export function parsePatchRegions(patch) {
  if (!patch) return WHOLE_FILE;
  const regions = [];
  let oldLine = 0;
  let run = null; // [start, end] of the current block of -/+ lines

  const closeRun = () => {
    if (run) regions.push(run);
    run = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      closeRun();
      const match = /^@@ -(\d+)/.exec(line);
      if (!match) return WHOLE_FILE;
      oldLine = Number(match[1]);
      // "-0,0" (empty base) and "-n,0" (pure insertion after line n) both
      // place the next base line at n + 1.
      if (/^@@ -\d+,0 /.test(line)) oldLine += 1;
      continue;
    }
    const kind = line[0];
    if (kind === "-") {
      const start = 2 * oldLine - 1;
      const end = 2 * oldLine + 1;
      if (run) run[1] = Math.max(run[1], end);
      else run = [start, end];
      oldLine += 1;
    } else if (kind === "+") {
      const gap = 2 * oldLine - 1;
      if (!run) run = [gap, gap];
    } else if (kind === "\\") {
      // "\ No newline at end of file" carries no line.
    } else {
      closeRun();
      oldLine += 1;
    }
  }
  closeRun();
  return regions;
}

/**
 * Counts intersecting region pairs between two touches of the same file.
 * A WHOLE_FILE touch collides once with any other touch.
 */
export function countRegionCollisions(a, b) {
  if (a === WHOLE_FILE || b === WHOLE_FILE) return 1;
  let count = 0;
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      if (aStart <= bEnd && bStart <= aEnd) count += 1;
    }
  }
  return count;
}

/**
 * Builds the file touches for one PR. Added and removed files count as whole
 * files: two PRs that add the same path, or one that deletes a file another
 * edits, always conflict. A rename also touches the previous path.
 */
function touchesOf(pr) {
  const touches = [];
  for (const file of pr.files) {
    const whole = file.status === "added" || file.status === "removed";
    const regions = whole ? WHOLE_FILE : file.regions;
    touches.push({ path: file.path, regions });
    if (file.previousPath && file.previousPath !== file.path) {
      touches.push({ path: file.previousPath, regions });
    }
  }
  return touches;
}

/**
 * @typedef {object} PullRequestInput
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} author
 * @property {boolean} isDraft
 * @property {string} updatedAt ISO timestamp of the last activity
 * @property {"MERGEABLE" | "CONFLICTING" | "UNKNOWN"} mergeable state against the base branch
 * @property {string} baseRef
 * @property {number} additions
 * @property {number} deletions
 * @property {boolean} filesTruncated true when GitHub returned only part of the file list
 * @property {Array<{path: string, previousPath?: string, status: string, regions: Array<[number, number]> | null}>} files
 */

/**
 * Compares every open PR with every other PR on the same base branch.
 * @param {PullRequestInput[]} pullRequests
 */
export function analyzePullRequests(pullRequests) {
  // path key -> list of { pr, regions }. PRs on different base branches never
  // merge into the same tree, so the key includes the base branch.
  const byFile = new Map();
  for (const pr of pullRequests) {
    for (const touch of touchesOf(pr)) {
      const key = `${pr.baseRef}\u0000${touch.path}`;
      let list = byFile.get(key);
      if (!list) byFile.set(key, (list = []));
      // A rename that maps a path onto itself would add the PR twice.
      if (list.some((entry) => entry.pr === pr)) continue;
      list.push({ pr, regions: touch.regions, path: touch.path });
    }
  }

  // pair key "a:b" (a < b) -> { sharedFiles, collidingFiles, collisions }
  const pairs = new Map();
  const hotspots = [];
  for (const entries of byFile.values()) {
    if (entries.length < 2) continue;
    const path = entries[0].path;
    const hotspot = { path, baseRef: entries[0].pr.baseRef, prs: [], collidingPrs: new Set() };
    for (const entry of entries) hotspot.prs.push(entry.pr.number);

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [first, second] =
          entries[i].pr.number < entries[j].pr.number ? [entries[i], entries[j]] : [entries[j], entries[i]];
        const key = `${first.pr.number}:${second.pr.number}`;
        let pair = pairs.get(key);
        if (!pair) pairs.set(key, (pair = { sharedFiles: [], collidingFiles: [], collisions: 0 }));
        pair.sharedFiles.push(path);
        const collisions = countRegionCollisions(first.regions, second.regions);
        if (collisions > 0) {
          pair.collidingFiles.push(path);
          pair.collisions += collisions;
          hotspot.collidingPrs.add(first.pr.number);
          hotspot.collidingPrs.add(second.pr.number);
        }
      }
    }
    hotspots.push(hotspot);
  }

  const overlapsByPr = new Map(pullRequests.map((pr) => [pr.number, []]));
  for (const [key, pair] of pairs) {
    const [a, b] = key.split(":").map(Number);
    overlapsByPr.get(a).push({ number: b, ...pair });
    overlapsByPr.get(b).push({ number: a, ...pair });
  }

  const hotspotPaths = new Set(hotspots.map((h) => `${h.baseRef}\u0000${h.path}`));

  const prs = pullRequests.map((pr) => {
    const overlaps = overlapsByPr
      .get(pr.number)
      .sort((x, y) => y.collisions - x.collisions || y.sharedFiles.length - x.sharedFiles.length || x.number - y.number);
    const collisionCount = overlaps.reduce((sum, o) => sum + o.collisions, 0);
    const collidingPrCount = overlaps.filter((o) => o.collisions > 0).length;
    const status = collidingPrCount > 0 ? "collides" : overlaps.length > 0 ? "overlaps" : "isolated";
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      mergeable: pr.mergeable,
      baseRef: pr.baseRef,
      additions: pr.additions,
      deletions: pr.deletions,
      fileCount: pr.files.length,
      filesTruncated: pr.filesTruncated,
      status,
      overlaps,
      collisionCount,
      collidingPrCount,
      hotspotFiles: pr.files
        .map((f) => f.path)
        .filter((path) => hotspotPaths.has(`${pr.baseRef}\u0000${path}`)),
    };
  });

  return {
    prs,
    hotspots: hotspots
      .map((h) => ({ path: h.path, baseRef: h.baseRef, prs: h.prs.sort((x, y) => x - y), collidingPrs: [...h.collidingPrs].sort((x, y) => x - y) }))
      .sort((x, y) => y.prs.length - x.prs.length || y.collidingPrs.length - x.collidingPrs.length || x.path.localeCompare(y.path)),
  };
}
