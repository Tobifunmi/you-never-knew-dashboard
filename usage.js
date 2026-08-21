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

async function checkElevenLabs() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { service: "ElevenLabs", live: false, status: "no API key set in Netlify env vars" };

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    };
  } catch (e) {
    return { service: "ElevenLabs", live: false, status: `error: ${e.message}` };
  }
}

async function checkPexels() {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return { service: "Pexels", live: false, status: "no API key set in Netlify env vars" };

  try {
    const res = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const limit = res.headers.get("x-ratelimit-limit");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (limit == null || remaining == null) {
      return { service: "Pexels", live: false, status: "call succeeded but no rate-limit headers returned" };
    }
    const used = Number(limit) - Number(remaining);
    return {
      service: "Pexels",
      live: true,
      used,
      limit: Number(limit),
      pct: Math.round((used / Number(limit)) * 1000) / 10,
      resets: fmtUnix(reset),
    };
  } catch (e) {
    return { service: "Pexels", live: false, status: `error: ${e.message}` };
  }
}

async function checkPixabay() {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) return { service: "Pixabay", live: false, status: "no API key set in Netlify env vars" };

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
      };
    }
    return {
      service: "Pixabay",
      live: true,
      used: Number(limit) - Number(remaining),
      limit: Number(limit),
      note: "rolling 60s window, not a monthly balance",
    };
  } catch (e) {
    return { service: "Pixabay", live: false, status: `error: ${e.message}` };
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

function checkSelfTracked(log, key, displayName, dashboardUrl) {
  if (!log) {
    return {
      service: displayName,
      live: false,
      status: `no usage_log.json found in repo yet — self-tracking hasn't logged any calls, or GITHUB_REPO isn't set correctly. Check manually: ${dashboardUrl}`,
    };
  }
  const entry = log[key];
  if (!entry || !entry.count) {
    return { service: displayName, live: false, status: `no calls logged yet. Check manually: ${dashboardUrl}` };
  }
  return {
    service: displayName,
    live: false,
    status: `self-tracked: ${entry.count} calls logged since ${entry.since || "unknown"} (last: ${entry.last_call || "unknown"}). For real quota: ${dashboardUrl}`,
  };
}

function checkYouTubeEstimate(log) {
  const dashboardUrl = "https://console.cloud.google.com/apis/dashboard";
  if (!log) {
    return {
      service: "YouTube Data API",
      live: false,
      status: `no usage_log.json found in repo yet. Check manually: ${dashboardUrl}`,
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
    return { service: "YouTube Data API", live: false, status: `no calls logged yet. Check manually: ${dashboardUrl}` };
  }

  return {
    service: "YouTube Data API",
    live: false,
    status: `self-tracked, ALL-TIME estimate: ~${totalUnits.toLocaleString()} quota units (${breakdown.join("; ")}). Default daily budget is 10,000 units — this is cumulative, not today's usage. Authoritative source: ${dashboardUrl}`,
  };
}

exports.handler = async function () {
  const [elevenlabs, pexels, pixabay, usageLog] = await Promise.all([
    checkElevenLabs(),
    checkPexels(),
    checkPixabay(),
    fetchUsageLog(),
  ]);

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
