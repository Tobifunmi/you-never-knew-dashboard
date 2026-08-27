// netlify/functions/usage.js
//
// Combines LIVE API queries (ElevenLabs, Pexels, Pixabay) with self-tracked
// counts read fresh from the public GitHub repo (Jamendo, Gemini, YouTube)
// into one JSON response. Called by usage-dashboard.html on every page load,
// so every reload is genuinely current — nothing here is cached/prebuilt.
//
// Required Netlify environment variables (Site settings -> Environment
// variables — these are SEPARATE from your GitHub Secrets, must be added
// here too):
//   ELEVENLABS_API_KEY
//   PEXELS_API_KEY
//   PIXABAY_API_KEY
//   GITHUB_REPO        e.g. "yourusername/you-never-knew-automation"
//   GITHUB_BRANCH      optional, defaults to "main"

const YOUTUBE_QUOTA_COSTS = {
  youtube_upload: { label: "uploads", cost: 1600 },
  youtube_playlist_create: { label: "playlist creations", cost: 50 },
  youtube_playlist_item_insert: { label: "playlist item adds", cost: 50 },
  youtube_playlist_list: { label: "playlist list calls", cost: 1 },
  youtube_playlist_item_list: { label: "playlist item checks", cost: 1 },
};

function fmtUnix(ts) {
  if (!ts) return null;
  return new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function maskKey(key) {
  if (!key) return "(empty)";
  if (key.length <= 8) return `(${key.length} chars, too short to mask safely)`;
  return `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars)`;
}

async function checkElevenLabs() {
  const rawApiKey = process.env.ELEVENLABS_API_KEY;
  const dashboardUrl = "https://elevenlabs.io/app/usage";
  if (!rawApiKey) return { service: "ElevenLabs", live: false, status: "no API key set in Netlify env vars", dashboard_url: dashboardUrl };

  // Trims defensively — a stray leading/trailing space or newline from a
  // copy-paste into Netlify's env var field is a common, invisible cause
  // of "key looks right everywhere except here". If trimming is what saved
  // this call, the masked-key debug info below still surfaces the raw
  // length so you can go fix the value at the source rather than relying
  // on this trim forever.
  const apiKey = rawApiKey.trim();

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} — key Netlify is using: ${maskKey(rawApiKey)}` +
        (rawApiKey !== apiKey ? " [had leading/trailing whitespace, trimmed before use]" : "")
      );
    }
    const data = await res.json();
    const used = data.character_count || 0;
    const limit = data.character_limit || 0;
    return {
      service: "ElevenLabs",
      live: true,
      used,
      limit,
      pct: limit ? Math.round((used / limit) * 1000) / 10 : 0,
      resets: fmtUnix(data.next_character_count_reset_unix),
      dashboard_url: dashboardUrl,
    };
  } catch (e) {
    return { service: "ElevenLabs", live: false, status: `error: ${e.message}`, dashboard_url: dashboardUrl };
  }
}

async function checkPexels() {
  const apiKey = process.env.PEXELS_API_KEY;
  const dashboardUrl = "https://www.pexels.com/api/";
  if (!apiKey) return { service: "Pexels", live: false, status: "no API key set in Netlify env vars", dashboard_url: dashboardUrl };

  try {
    const res = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const limit = res.headers.get("x-ratelimit-limit");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (limit == null || remaining == null) {
      return { service: "Pexels", live: false, status: "call succeeded but no rate-limit headers returned", dashboard_url: dashboardUrl };
    }
    const used = Number(limit) - Number(remaining);
    return {
      service: "Pexels",
      live: true,
      used,
      limit: Number(limit),
      pct: Math.round((used / Number(limit)) * 1000) / 10,
      resets: fmtUnix(reset),
      dashboard_url: dashboardUrl,
    };
  } catch (e) {
    return { service: "Pexels", live: false, status: `error: ${e.message}`, dashboard_url: dashboardUrl };
  }
}

async function checkPixabay() {
  const apiKey = process.env.PIXABAY_API_KEY;
  const dashboardUrl = "https://pixabay.com/api/docs/";
  if (!apiKey) return { service: "Pixabay", live: false, status: "no API key set in Netlify env vars", dashboard_url: dashboardUrl };

  try {
    const res = await fetch(`https://pixabay.com/api/videos/?key=${apiKey}&q=nature&per_page=3`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const limit = res.headers.get("x-ratelimit-limit");
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (limit == null || remaining == null) {
      return {
        service: "Pixabay",
        live: false,
        status: "call succeeded (key is valid) but no rate-limit headers found",
        dashboard_url: dashboardUrl,
      };
    }
    return {
      service: "Pixabay",
      live: true,
      used: Number(limit) - Number(remaining),
      limit: Number(limit),
      note: "rolling 60s window, not a monthly balance",
      dashboard_url: dashboardUrl,
    };
  } catch (e) {
    return { service: "Pixabay", live: false, status: `error: ${e.message}`, dashboard_url: dashboardUrl };
  }
}

async function fetchUsageLog() {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!repo) return null;

  const url = `https://raw.githubusercontent.com/${repo}/${branch}/database/usage_log.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function selfTrackedNote(log, key) {
  if (!log) return null;
  const entry = log[key];
  if (!entry || !entry.count) return null;
  const count = entry.count;
  const videoCount = Array.isArray(entry.videos) ? entry.videos.length : 0;
  if (videoCount) {
    return `${count} calls across ${videoCount} video(s) (~${(count / videoCount).toFixed(1)}/video)`;
  }
  return `${count} calls logged (no video linkage yet)`;
}

function checkSelfTracked(log, key, displayName, dashboardUrl) {
  if (!log) {
    return {
      service: displayName,
      live: false,
      status: `no usage_log.json found in repo yet — self-tracking hasn't logged any calls, or GITHUB_REPO isn't set correctly. Check manually: ${dashboardUrl}`,
      dashboard_url: dashboardUrl,
    };
  }
  const entry = log[key];
  if (!entry || !entry.count) {
    return { service: displayName, live: false, status: `no calls logged yet. Check manually: ${dashboardUrl}`, dashboard_url: dashboardUrl };
  }
  return {
    service: displayName,
    live: false,
    status: `self-tracked: ${entry.count} calls logged since ${entry.since || "unknown"} (last: ${entry.last_call || "unknown"}). For real quota: ${dashboardUrl}`,
    dashboard_url: dashboardUrl,
  };
}

function checkYouTubeEstimate(log) {
  const dashboardUrl = "https://console.cloud.google.com/apis/dashboard";
  if (!log) {
    return {
      service: "YouTube Data API",
      live: false,
      status: `no usage_log.json found in repo yet. Check manually: ${dashboardUrl}`,
      dashboard_url: dashboardUrl,
    };
  }

  let totalUnits = 0;
  let totalCalls = 0;
  const breakdown = [];

  for (const [key, { label, cost }] of Object.entries(YOUTUBE_QUOTA_COSTS)) {
    const count = log[key] && log[key].count ? log[key].count : 0;
    if (count) {
      const units = count * cost;
      totalUnits += units;
      totalCalls += count;
      breakdown.push(`${count} ${label} (~${units.toLocaleString()} units)`);
    }
  }

  if (totalCalls === 0) {
    return { service: "YouTube Data API", live: false, status: `no calls logged yet. Check manually: ${dashboardUrl}`, dashboard_url: dashboardUrl };
  }

  return {
    service: "YouTube Data API",
    live: false,
    status: `self-tracked, ALL-TIME estimate: ~${totalUnits.toLocaleString()} quota units (${breakdown.join("; ")}). Default daily budget is 10,000 units — this is cumulative, not today's usage. Authoritative source: ${dashboardUrl}`,
    dashboard_url: dashboardUrl,
  };
}

exports.handler = async function () {
  const [elevenlabs, pexels, pixabay, usageLog] = await Promise.all([
    checkElevenLabs(),
    checkPexels(),
    checkPixabay(),
    fetchUsageLog(),
  ]);

  // ElevenLabs/Pexels/Pixabay have a LIVE quota % already, but no notion
  // of "videos" — layer the self-tracked call/video correlation on top
  // as a supplementary note so a video that burned unusual credits is
  // visible even though the live percentage alone can't show that.
  elevenlabs.note = selfTrackedNote(usageLog, "elevenlabs") || elevenlabs.note || null;
  pexels.note = selfTrackedNote(usageLog, "pexels") || pexels.note || null;
  pixabay.note = selfTrackedNote(usageLog, "pixabay") || pixabay.note || null;

  const results = [
    elevenlabs,
    pexels,
    pixabay,
    checkSelfTracked(usageLog, "jamendo", "Jamendo", "https://devportal.jamendo.com/"),
    checkSelfTracked(usageLog, "gemini", "Gemini", "https://aistudio.google.com/usage"),
    checkYouTubeEstimate(usageLog),
  ];

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ generated_at: new Date().toISOString(), results }),
  };
};
