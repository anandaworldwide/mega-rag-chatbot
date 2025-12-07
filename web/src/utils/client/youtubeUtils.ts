/**
 * Transform a YouTube URL into an embed URL with optional start time
 */
export function transformYouTubeUrl(url: string, startTime?: number, autoplay = false, origin?: string): string {
  try {
    const urlObj = new URL(url);
    let videoId = "";

    const host = urlObj.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      videoId = urlObj.pathname.slice(1);
    } else if (host === "youtube.com" && urlObj.pathname.includes("watch")) {
      videoId = urlObj.searchParams.get("v") || "";
    } else if (host === "youtube.com" && urlObj.pathname.startsWith("/shorts/")) {
      videoId = urlObj.pathname.split("/")[2] || "";
    }

    const baseUrl = `https://www.youtube.com/embed/${videoId}`;
    const params = new URLSearchParams();
    params.set("start", Math.floor(startTime || 0).toString());
    params.set("rel", "0");
    params.set("modestbranding", "1");
    params.set("playsinline", "1");
    params.set("enablejsapi", "1");
    if (origin) {
      params.set("origin", origin);
    }
    if (autoplay) {
      params.set("autoplay", "1");
    }
    return `${baseUrl}?${params.toString()}`;
  } catch {
    return url;
  }
}
