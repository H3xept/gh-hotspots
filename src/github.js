// GitHub API access for the background worker.

import { parsePatchRegions } from "./analysis.js";

const API = "https://api.github.com";
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 10; // 1000 files per PR; GitHub caps the endpoint at 3000.
const FILE_FETCH_CONCURRENCY = 6;

export class GitHubError extends Error {
  /** @param {"auth" | "not_found" | "rate_limit" | "network" | "api"} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function request(token, path, init = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new GitHubError("network", `Network error: ${error.message}`);
  }
  if (response.status === 401) throw new GitHubError("auth", "GitHub rejected the token (401).");
  if (response.status === 404) throw new GitHubError("not_found", "Repository not found, or the token has no access to it.");
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (remaining === "0" || response.status === 429) {
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : "later";
      throw new GitHubError("rate_limit", `GitHub API rate limit reached. It resets at ${when}.`);
    }
    throw new GitHubError("auth", "The token lacks permission for this repository (403).");
  }
  if (!response.ok) throw new GitHubError("api", `GitHub API error ${response.status}.`);
  return response.json();
}

const OPEN_PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String, $pageSize: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $pageSize, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft updatedAt mergeable headRefOid baseRefName
        additions deletions changedFiles
        author { login }
      }
    }
  }
}`;

/**
 * Lists open PRs, most recently updated first, up to `limit`.
 * @returns {Promise<{ total: number, nodes: object[] }>}
 */
export async function fetchOpenPullRequests(token, owner, name, limit) {
  const nodes = [];
  let cursor = null;
  let total = 0;
  while (nodes.length < limit) {
    const body = await request(token, "/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: OPEN_PRS_QUERY,
        variables: { owner, name, cursor, pageSize: Math.min(50, limit - nodes.length) },
      }),
    });
    if (body.errors?.length) {
      const notFound = body.errors.some((e) => e.type === "NOT_FOUND");
      throw new GitHubError(notFound ? "not_found" : "api", body.errors.map((e) => e.message).join("; "));
    }
    const connection = body.data.repository.pullRequests;
    total = connection.totalCount;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return { total, nodes };
}

/**
 * Fetches the changed files of one PR and reduces each patch to base-file
 * regions, so the cache stores a few numbers instead of the full diff.
 */
export async function fetchPullRequestFiles(token, owner, name, number) {
  const files = [];
  let truncated = false;
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const batch = await request(
      token,
      `/repos/${owner}/${name}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
    );
    for (const file of batch) {
      files.push({
        path: file.filename,
        previousPath: file.previous_filename,
        status: file.status,
        regions: parsePatchRegions(file.patch),
      });
    }
    if (batch.length < FILES_PER_PAGE) break;
    if (page === MAX_FILE_PAGES) truncated = true;
  }
  return { files, truncated };
}

/** Runs `worker` over `items` with at most `limit` calls in flight. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

export { FILE_FETCH_CONCURRENCY };
