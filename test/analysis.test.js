import { describe, expect, test } from "bun:test";
import { analyzePullRequests, countRegionCollisions, parsePatchRegions } from "../src/analysis.js";

// Builds a patch that replaces base lines `from..to` with one new line,
// with one context line on each side, like GitHub's unified diffs.
function replaceLines(from, to) {
  const removed = Array.from({ length: to - from + 1 }, (_, i) => `-old ${from + i}`);
  return [`@@ -${from - 1},${to - from + 3} +${from - 1},3 @@`, ` ctx`, ...removed, `+new`, ` ctx`].join("\n");
}

function insertAfter(line) {
  return [`@@ -${line},0 +${line + 1},1 @@`, `+inserted`].join("\n");
}

const regionsOf = (patch) => parsePatchRegions(patch);

function pr(number, files, extra = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    author: "dev",
    isDraft: false,
    updatedAt: "2026-10-01T00:00:00Z",
    mergeable: "MERGEABLE",
    baseRef: "main",
    additions: 1,
    deletions: 1,
    filesTruncated: false,
    files,
    ...extra,
  };
}

const modified = (path, patch) => ({ path, status: "modified", regions: regionsOf(patch) });

describe("collisions between two edits of one file", () => {
  test("edits of the same line collide", () => {
    expect(countRegionCollisions(regionsOf(replaceLines(10, 12)), regionsOf(replaceLines(12, 14)))).toBe(1);
  });

  test("edits of adjacent lines collide, as in git", () => {
    expect(countRegionCollisions(regionsOf(replaceLines(10, 12)), regionsOf(replaceLines(13, 14)))).toBe(1);
  });

  test("edits separated by one unchanged line do not collide", () => {
    expect(countRegionCollisions(regionsOf(replaceLines(10, 12)), regionsOf(replaceLines(14, 15)))).toBe(0);
  });

  test("an insertion collides with an edit of the line right after it", () => {
    expect(countRegionCollisions(regionsOf(insertAfter(9)), regionsOf(replaceLines(10, 10)))).toBe(1);
  });

  test("an insertion does not collide with an edit two lines away", () => {
    expect(countRegionCollisions(regionsOf(insertAfter(9)), regionsOf(replaceLines(11, 11)))).toBe(0);
  });

  test("a file without a patch collides with any edit", () => {
    expect(parsePatchRegions(undefined)).toBeNull();
    expect(countRegionCollisions(null, regionsOf(replaceLines(500, 500)))).toBe(1);
  });

  test("hunk context lines do not count as changes", () => {
    // Line 9 and line 11 are context of the hunk that edits line 10.
    const patch = "@@ -9,3 +9,3 @@\n ctx 9\n-old 10\n+new 10\n ctx 11";
    expect(parsePatchRegions(patch)).toEqual([[19, 21]]);
  });
});

describe("analyzePullRequests", () => {
  test("classifies isolated, overlapping, and colliding PRs", () => {
    const report = analyzePullRequests([
      pr(1, [modified("a.js", replaceLines(10, 12))]),
      pr(2, [modified("a.js", replaceLines(11, 11))]),
      pr(3, [modified("a.js", replaceLines(200, 201))]),
      pr(4, [modified("b.js", replaceLines(1, 1))]),
    ]);
    const byNumber = Object.fromEntries(report.prs.map((p) => [p.number, p]));

    expect(byNumber[1].status).toBe("collides");
    expect(byNumber[1].collidingPrCount).toBe(1);
    expect(byNumber[3].status).toBe("overlaps");
    expect(byNumber[3].overlaps.map((o) => o.number).sort()).toEqual([1, 2]);
    expect(byNumber[4].status).toBe("isolated");
    expect(byNumber[4].hotspotFiles).toEqual([]);

    expect(report.hotspots).toEqual([{ path: "a.js", baseRef: "main", prs: [1, 2, 3], collidingPrs: [1, 2] }]);
  });

  test("PRs into different base branches never overlap", () => {
    const report = analyzePullRequests([
      pr(1, [modified("a.js", replaceLines(1, 1))]),
      pr(2, [modified("a.js", replaceLines(1, 1))], { baseRef: "release" }),
    ]);
    expect(report.prs.map((p) => p.status)).toEqual(["isolated", "isolated"]);
    expect(report.hotspots).toEqual([]);
  });

  test("two PRs that add the same path collide", () => {
    const added = { path: "new.js", status: "added", regions: regionsOf(insertAfter(0)) };
    const report = analyzePullRequests([pr(1, [added]), pr(2, [added])]);
    expect(report.prs[0].status).toBe("collides");
  });

  test("deleting a file collides with an edit of that file", () => {
    const removed = { path: "a.js", status: "removed", regions: [] };
    const report = analyzePullRequests([pr(1, [removed]), pr(2, [modified("a.js", replaceLines(400, 400))])]);
    expect(report.prs[1].status).toBe("collides");
  });

  test("a rename overlaps with edits of the old path", () => {
    const renamed = { path: "b.js", previousPath: "a.js", status: "renamed", regions: [] };
    const report = analyzePullRequests([pr(1, [renamed]), pr(2, [modified("a.js", replaceLines(5, 5))])]);
    expect(report.prs[1].status).toBe("overlaps");
    expect(report.prs[1].overlaps[0].sharedFiles).toEqual(["a.js"]);
  });

  test("overlaps list the most colliding PR first", () => {
    const report = analyzePullRequests([
      pr(1, [modified("a.js", replaceLines(10, 10)), modified("b.js", replaceLines(10, 10))]),
      pr(2, [modified("a.js", replaceLines(300, 300))]),
      pr(3, [modified("b.js", replaceLines(10, 10))]),
    ]);
    expect(report.prs[0].overlaps.map((o) => o.number)).toEqual([3, 2]);
  });
});
