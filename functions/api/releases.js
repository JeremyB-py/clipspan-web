import { json } from "../_lib/auth.js";
import { classifyAsset, githubJson, repoName } from "../_lib/github.js";

export async function onRequestGet(context) {
  let release;
  try {
    release = await githubJson(
      context.env,
      `/repos/${repoName(context.env)}/releases/latest`,
    );
  } catch (error) {
    const status = error.status === 404 ? 404 : 502;
    return json(
      { error: status === 404 ? "No GitHub release is published yet." : "Could not load the latest release." },
      status,
    );
  }

  const assets = (release.assets || [])
    .map((asset) => {
      const classified = classifyAsset(asset.name);
      if (!classified) {
        return null;
      }
      return {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        platform: classified.platform,
        label: classified.label,
      };
    })
    .filter(Boolean);

  return json({
    tag: release.tag_name || "",
    name: release.name || release.tag_name || "Latest release",
    publishedAt: release.published_at || "",
    notes: release.body || "",
    assets,
  });
}
