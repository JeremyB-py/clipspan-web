// Google Play badge for every element marked data-google-play.
//
// Leave PLAY_STORE_URL empty until the listing is public. Until then those elements keep
// their plain "coming soon" text: Google's badge guidelines don't allow an altered or
// inactive badge, so it only appears once it can link to the listing. When ClipSpan is
// live, set it to https://play.google.com/store/apps/details?id=com.clipspan.app
{
  const PLAY_STORE_URL = "";

  if (PLAY_STORE_URL) {
    for (const slot of document.querySelectorAll("[data-google-play]")) {
      const link = document.createElement("a");
      link.className = "play-badge";
      link.href = PLAY_STORE_URL;
      const badge = document.createElement("img");
      // Google's artwork, unmodified. Its transparent border is the required clear space.
      badge.src = "/assets/google-play-badge.png";
      badge.alt = "Get it on Google Play";
      badge.width = 646;
      badge.height = 250;
      link.append(badge);
      slot.replaceChildren(link);
    }
  }
}
