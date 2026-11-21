interface GitHubFileUpdate {
  path: string;
  beforeContent: string;
  afterContent: string;
}

interface GitHubRepository {
  owner: string;
  name: string;
  apiBase: string;
}

function repositoryDetails(repoUrl: string): GitHubRepository {
  let url: URL;
  try {
    const sshRemote = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(repoUrl);
    const normalized = sshRemote
      ? `https://${sshRemote[1]}/${sshRemote[2]}`
      : repoUrl.includes("://")
        ? repoUrl
        : `https://${repoUrl}`;
    url = new URL(normalized);
  } catch {
    throw new Error("The configured documentation repository URL is invalid.");
  }
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("The documentation repository URL must include an owner and repository.");
  const owner = parts.at(-2)!;
  const name = parts.at(-1)!;
  const configuredApi = process.env.GITHUB_API_BASE?.replace(/\/+$/, "");
  const apiBase = configuredApi || (
    url.hostname.toLowerCase() === "github.com"
      ? "https://api.github.com"
      : `${url.origin}/api/v3`
  );
  return { owner, name, apiBase };
}

async function githubRequest<T>(
  repository: GitHubRepository,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required to create documentation pull requests.");
  let response: Response;
  try {
    response = await fetch(`${repository.apiBase}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new Error(`GitHub publishing request failed (${error instanceof Error ? error.name : "unknown"}).`);
  }
  if (!response.ok) {
    throw new Error(
      `GitHub publishing request failed with status ${response.status} on ${init.method || "GET"} ${path} — verify the repository URL, file path, and fine-grained token repository access.`
    );
  }
  return response.json() as Promise<T>;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function contentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function createDocumentationPullRequest(input: {
  repoUrl: string;
  docsRoot: string;
  sessionId: string;
  headRevision: string;
  title: string;
  files: GitHubFileUpdate[];
}): Promise<{ url: string; branch: string; baseBranch: string; merged: boolean }> {
  if (input.files.length === 0) throw new Error("Cannot publish an empty documentation patch.");
  const root = input.docsRoot.replace(/^\/+|\/+$/g, "");
  for (const file of input.files) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").includes("..") ||
      (root && file.path !== root && !file.path.startsWith(`${root}/`))
    ) {
      throw new Error(`Documentation path is outside the configured docs root: ${file.path}`);
    }
  }
  const totalBytes = input.files.reduce(
    (total, file) => total + Buffer.byteLength(file.afterContent, "utf8"),
    0
  );
  if (totalBytes > 500_000) throw new Error("Documentation patch exceeds the 500 KB publishing limit.");

  const repository = repositoryDetails(input.repoUrl);
  const apiRoot = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const metadata = await githubRequest<{ default_branch: string }>(repository, apiRoot);
  const baseBranch = metadata.default_branch;
  const branch = `docline-${input.sessionId}`;

  const existingPullRequests = await githubRequest<
    { html_url: string; state: string; merged_at: string | null }[]
  >(
    repository,
    `${apiRoot}/pulls?state=all&head=${encodeURIComponent(`${repository.owner}:${branch}`)}`
  );
  if (existingPullRequests[0]) {
    const existing = existingPullRequests[0];
    if (existing.merged_at) {
      return { url: existing.html_url, branch, baseBranch, merged: true };
    }
    if (existing.state !== "open") {
      throw new Error("The pull request for this session was closed without merging.");
    }
    return { url: existing.html_url, branch, baseBranch, merged: false };
  }

  const baseRef = await githubRequest<{ object: { sha: string } }>(
    repository,
    `${apiRoot}/git/ref/heads/${encodeURIComponent(baseBranch)}`
  );
  const baseCommit = await githubRequest<{ tree: { sha: string } }>(
    repository,
    `${apiRoot}/git/commits/${encodeURIComponent(baseRef.object.sha)}`
  );

  const tree = [];
  for (const file of input.files) {
    const remote = await githubRequest<{ content: string; encoding: string }>(
      repository,
      `${apiRoot}/contents/${contentPath(file.path)}?ref=${encodeURIComponent(baseBranch)}`
    );
    if (remote.encoding !== "base64") {
      throw new Error(`GitHub returned an unsupported encoding for ${file.path}.`);
    }
    const remoteContent = Buffer.from(remote.content.replace(/\n/g, ""), "base64").toString("utf8");
    if (normalizeText(remoteContent) !== normalizeText(file.beforeContent)) {
      throw new Error(`Documentation file changed on GitHub since the proposal was created: ${file.path}`);
    }
    const blob = await githubRequest<{ sha: string }>(repository, `${apiRoot}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: file.afterContent, encoding: "utf-8" }),
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await githubRequest<{ sha: string }>(repository, `${apiRoot}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const commit = await githubRequest<{ sha: string }>(repository, `${apiRoot}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `docs: propose updates for ${input.title}`,
      tree: newTree.sha,
      parents: [baseRef.object.sha],
    }),
  });

  const refPath = `${apiRoot}/git/ref/heads/${encodeURIComponent(branch)}`;
  const refResponse = await fetch(`${repository.apiBase}${refPath}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (refResponse.status === 404) {
    await githubRequest(repository, `${apiRoot}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  } else if (refResponse.ok) {
    await githubRequest(repository, refPath, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    throw new Error(`GitHub branch check failed with status ${refResponse.status}.`);
  }

  const pullRequest = await githubRequest<{ html_url: string }>(repository, `${apiRoot}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `Documentation update: ${input.title}`,
      body: [
        "This pull request contains a human-approved documentation proposal.",
        "",
        `Source revision: \`${input.headRevision}\``,
        `Pipeline session: \`${input.sessionId}\``,
      ].join("\n"),
      head: branch,
      base: baseBranch,
    }),
  });
  return { url: pullRequest.html_url, branch, baseBranch, merged: false };
}
