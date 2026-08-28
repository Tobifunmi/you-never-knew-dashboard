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

function checkKokoro(log) {
  // Kokoro runs 100% locally — no external API, no account, no quota.
  // Not a "live" check like the others; just surfaces the local
  // production count so the dashboard still shows something real for
  // the engine actually narrating every video, instead of a frozen
  // ElevenLabs number nothing calls anymore.
  const dashboardUrl = "https://huggingface.co/hexgrad/Kokoro-82M";
  const entry = log && log.kokoro;
  const count = entry && entry.count ? entry.count : 0;
  const status = count
    ? `runs 100% locally — no usage cap or account. ${count} video(s) narrated so far.`
    : "runs 100% locally — no usage cap or account. No videos narrated yet.";
  return { service: "Kokoro (narration)", live: false, status, dashboard_url: dashboardUrl };
}

async function checkPexels() {
  const apiKey = process.env.PEXELS_API_KEY;
  const dashboardUrl = "https://www.pexels.com/api/";
  if (!apiKey) return { service: "Pexels", live: false, status: "no API key set in Netlify env vars", dashboard_url: dashboardUrl };

  try {
    // Cache-bust: an identical repeated query ("nature", per_page=1) risks
    // getting served from Pexels' own response cache, which can return
    // stale/frozen rate-limit headers from whenever that response was
    // first cached rather than the account's actual current usage — this
    // showed up as the dashboard's "used" number never moving even as
    // real usage climbed. A random per-request query param forces a
    // fresh, uncached response every time.
    const cacheBust = Math.random().toString(36).slice(2);
    const res = await fetch(`https://api.pexels.com/videos/search?query=nature&per_page=1&_=${cacheBust}`, {
      headers: { Authorization: apiKey, "Cache-Control": "no-cache" },
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
    // Same cache-busting defense as checkPexels() — Pixabay's own
    // number hasn't shown the frozen-value symptom Pexels did, but an
    // identical repeated query risks the same failure mode, so this is
    // preventive rather than a confirmed fix for an observed bug here.
    const cacheBust = Math.random().toString(36).slice(2);
    const res = await fetch(`https://pixabay.com/api/videos/?key=${apiKey}&q=nature&per_page=3&_=${cacheBust}`, {
      headers: { "Cache-Control": "no-cache" },
    });
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
      status: `no usage_log.json found in repo yet — self-tracking hasn't logged any calls, or GITHUB_REPO isn't set correctly.`,
      dashboard_url: dashboardUrl,
    };
  }
  const entry = log[key];
  if (!entry || !entry.count) {
    return { service: displayName, live: false, status: `no calls logged yet.`, dashboard_url: dashboardUrl };
  }
  return {
    service: displayName,
    live: false,
    status: `self-tracked: ${entry.count} calls logged since ${entry.since || "unknown"} (last: ${entry.last_call || "unknown"}).`,
    dashboard_url: dashboardUrl,
  };
}

function checkYouTubeEstimate(log) {
  const dashboardUrl = "https://console.cloud.google.com/apis/dashboard";
  if (!log) {
    return {
      service: "YouTube Data API",
      live: false,
      status: `no usage_log.json found in repo yet.`,
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
    return { service: "YouTube Data API", live: false, status: `no calls logged yet.`, dashboard_url: dashboardUrl };
  }

  return {
    service: "YouTube Data API",
    live: false,
    status: `self-tracked, ALL-TIME estimate: ~${totalUnits.toLocaleString()} quota units (${breakdown.join("; ")}). Default daily budget is 10,000 units — this is cumulative, not today's usage.`,
    dashboard_url: dashboardUrl,
  };
}

exports.handler = async function () {
  const [pexels, pixabay, usageLog] = await Promise.all([
    checkPexels(),
    checkPixabay(),
    fetchUsageLog(),
  ]);

  // Pexels/Pixabay have a LIVE quota % already, but no notion of
  // "videos" — layer the self-tracked call/video correlation on top
  // as a supplementary note so a video that burned unusual credits is
  // visible even though the live percentage alone can't show that.
  pexels.note = selfTrackedNote(usageLog, "pexels") || pexels.note || null;
  pixabay.note = selfTrackedNote(usageLog, "pixabay") || pixabay.note || null;

  const results = [
    checkKokoro(usageLog),
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
