const DEFAULT_REPO = "JeremyB-py/clipspan";

const SKIP_EXT = /\.(aab|sig)$/i;
const SKIP_NAME = /privacy\.md$|latest\.json$|unsigned|debug|clipspan-daemon/i;

export function repoName(env) {
  return env.GITHUB_REPO || DEFAULT_REPO;
}

export function classifyAsset(name) {
  if (SKIP_EXT.test(name) || SKIP_NAME.test(name)) {
    return null;
  }
  if (/\.apk$/i.test(name)) {
    return { platform: "android", label: "Android APK" };
  }
  if (/\.AppImage$/i.test(name)) {
    return { platform: "linux-appimage", label: "Linux AppImage" };
  }
  if (/\.deb$/i.test(name)) {
    return { platform: "linux-deb", label: "Linux .deb" };
  }
  if (/\.msi$/i.test(name)) {
    return { platform: "windows", label: "Windows MSI" };
  }
  if (/\.exe$/i.test(name)) {
    return { platform: "windows", label: "Windows installer" };
  }
  return null;
}

export async function githubJson(env, path) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured");
  }
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "clipspan-web-downloads",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`GitHub ${response.status}`);
    error.status = response.status;
    error.detail = detail.slice(0, 300);
    throw error;
  }
  return response.json();
}

export async function githubAsset(env, assetId) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured");
  }
  return fetch(
    `https://api.github.com/repos/${repoName(env)}/releases/assets/${assetId}`,
    {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "User-Agent": "clipspan-web-downloads",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
    },
  );
}
