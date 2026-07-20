// Unhideddit background service worker.
// Posts are fetched here (not in the content script) because api.reddit.com is a
// cross-origin host; running the request from the extension avoids page-origin CORS.

async function fetchPosts({ username, sort = "new", t = null, after = null }) {
  const q = `author:"${username}"`;
  let url = `https://api.reddit.com/search/?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(
    sort
  )}&limit=25&include_over_18=on`;
  if (sort === "top" && t) url += `&t=${encodeURIComponent(t)}`;
  if (after) url += `&after=${encodeURIComponent(after)}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new Error("USER_NOT_FOUND");
    if (res.status === 403) throw new Error("BANNED_OR_PRIVATE");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status >= 500) throw new Error("REDDIT_UNAVAILABLE");
    throw new Error(`HTTP_${res.status}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("BAD_RESPONSE");
  }
  const posts = (data?.data?.children || [])
    .filter((c) => c.kind === "t3")
    .map((c) => c.data);
  return { posts, after: data?.data?.after || null };
}

// Direct profile listing (submitted posts or comments). This is the authoritative,
// complete list of a user's non-hidden activity — Reddit's search index is lossy and
// silently drops items, so we merge this with the author: search for full coverage.
async function fetchListing({ username, kind = "submitted", sort = "new", after = null, credentialed = false }) {
  // Credentialed = use the user's logged-in session so NSFW/18+ items are included.
  const host = credentialed ? "https://www.reddit.com" : "https://api.reddit.com";
  let url = `${host}/user/${encodeURIComponent(username)}/${kind}${credentialed ? ".json" : ""}?limit=100&sort=${encodeURIComponent(
    sort
  )}&raw_json=1`;
  if (after) url += `&after=${encodeURIComponent(after)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: credentialed ? "include" : "omit",
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new Error("USER_NOT_FOUND");
    if (res.status === 403) throw new Error("BANNED_OR_PRIVATE");
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status >= 500) throw new Error("REDDIT_UNAVAILABLE");
    throw new Error(`HTTP_${res.status}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("BAD_RESPONSE");
  }
  return {
    children: (data?.data?.children || []).map((c) => c.data),
    after: data?.data?.after || null,
  };
}

// Archive backends. Reddit-removed and deleted items are gone from Reddit's own
// search + listing, so we query external archives that captured them:
//   - PullPush (api.pullpush.io): the long-running Pushshift successor.
//   - arctic-shift: more up-to-date; catches recently-removed posts PullPush lacks.
// Both return Reddit-shaped objects under `data`; paginated by `before` (epoch secs).
async function fetchArchive({ username, kind = "submission", before = null, provider = "pullpush" }) {
  const isComment = kind === "comment";
  let url;
  if (provider === "arctic") {
    const type = isComment ? "comments" : "posts";
    url = `https://arctic-shift.photon-reddit.com/api/${type}/search?author=${encodeURIComponent(
      username
    )}&limit=100&sort=desc`;
  } else {
    const type = isComment ? "comment" : "submission";
    url = `https://api.pullpush.io/reddit/search/${type}/?author=${encodeURIComponent(
      username
    )}&size=100&sort=desc`;
  }
  if (before) url += `&before=${encodeURIComponent(before)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch {
    throw new Error("ARCHIVE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`ARCHIVE_${res.status}`);
  const data = await res.json();
  const items = data?.data || [];
  const oldest = items.length ? Math.floor(items[items.length - 1].created_utc) : null;
  return { items, before: items.length >= 100 ? oldest : null };
}

async function fetchAbout(username) {
  const res = await fetch(
    `https://api.reddit.com/user/${encodeURIComponent(username)}/about`,
    { headers: { Accept: "application/json" }, cache: "no-store" }
  );
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const data = await res.json();
  return data?.data || null;
}

// ---------- snapshot to disk ----------

// Service workers have no DOM/URL.createObjectURL, so text files are saved as
// base64 data: URLs; media is handed to Chrome's downloader by URL (no CORS).
function dataUrl(mime, text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

function download(url, filename) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download(
        { url, filename, saveAs: false, conflictAction: "overwrite" },
        (id) => resolve(Boolean(id) && !chrome.runtime.lastError)
      );
    } catch {
      resolve(false);
    }
  });
}

async function snapshot({ username, postsJson, commentsJson, indexHtml, media }) {
  const safe = (username || "user").replace(/[^\w.-]/g, "_");
  const base = `Unhideddit/${safe}/`;
  await download(dataUrl("application/json", postsJson), base + "posts.json");
  await download(dataUrl("application/json", commentsJson), base + "comments.json");
  await download(dataUrl("text/html;charset=utf-8", indexHtml), base + "index.html");
  let mediaOk = 0;
  let mediaFail = 0;
  for (const m of media || []) {
    if (await download(m.url, base + m.filename)) mediaOk++;
    else mediaFail++;
  }
  return { mediaOk, mediaFail };
}

// ---------- watch list (background poller) ----------

const POLL_ALARM = "unhideddit-poll";
const DEFAULT_INTERVAL = 1; // minutes — Chrome's floor for background alarms

const store = {
  get: (defaults) => new Promise((r) => chrome.storage.local.get(defaults, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
};

const seenKey = (user) => `seen_${user.toLowerCase()}`;
const safeName = (user) => (user || "user").replace(/[^\w.-]/g, "_");

function wslug(s) {
  return String(s || "post").toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "post";
}
function wext(u) {
  const m = String(u).split("?")[0].match(/\.(jpe?g|png|gif|webp|mp4)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}
function watchMedia(p) {
  const id = p.id;
  const out = [];
  if (p.is_gallery && p.media_metadata) {
    let i = 0;
    for (const k of Object.keys(p.media_metadata)) {
      const s = p.media_metadata[k]?.s;
      const u = (s?.u || s?.gif || "").replace(/&amp;/g, "&");
      if (u) out.push({ url: u, filename: `${id}_${wslug(p.title)}_${i++}.${wext(u)}` });
    }
  } else {
    const url = p.url_overridden_by_dest || p.url || "";
    const clean = url.split("?")[0];
    const isImg =
      p.post_hint === "image" ||
      /\.(jpe?g|png|gif|webp)$/i.test(clean) ||
      /(i\.redd\.it|i\.imgur\.com)/.test(url);
    if (isImg && url) out.push({ url, filename: `${id}_${wslug(p.title)}.${wext(url)}` });
  }
  return out;
}

async function ensureAlarm() {
  const { interval } = await store.get({ interval: DEFAULT_INTERVAL });
  const mins = Math.max(1, Number(interval) || DEFAULT_INTERVAL);
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: mins });
}

async function collectLatest(user) {
  // Credentialed so NSFW/18+ posts of a logged-in viewer are included.
  const [posts, comments] = await Promise.all([
    fetchListing({ username: user, kind: "submitted", sort: "new", credentialed: true }).catch(() => ({ children: [] })),
    fetchListing({ username: user, kind: "comments", sort: "new", credentialed: true }).catch(() => ({ children: [] })),
  ]);
  return { posts: posts.children || [], comments: comments.children || [] };
}

// Add a user; seed "seen" with what's already up so we only save posts made
// AFTER watching begins (the ones you'd otherwise miss overnight).
async function addWatch(user) {
  const { watchlist } = await store.get({ watchlist: [] });
  if (!watchlist.some((u) => u.toLowerCase() === user.toLowerCase())) watchlist.push(user);
  const { posts, comments } = await collectLatest(user);
  const seen = [...posts, ...comments].map((x) => x.name);
  await store.set({ watchlist, [seenKey(user)]: seen });
  await ensureAlarm();
  return watchlist;
}

async function removeWatch(user) {
  const { watchlist } = await store.get({ watchlist: [] });
  const next = watchlist.filter((u) => u.toLowerCase() !== user.toLowerCase());
  await store.set({ watchlist: next });
  await new Promise((r) => chrome.storage.local.remove(seenKey(user), r));
  return next;
}

async function pollUser(user) {
  const s = await store.get({ [seenKey(user)]: [] });
  const seen = new Set(s[seenKey(user)] || []);
  const base = `Unhideddit/${safeName(user)}/watch/`;
  const { posts, comments } = await collectLatest(user);
  let saved = 0;

  for (const p of posts) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    await download(dataUrl("application/json", JSON.stringify(p, null, 2)), `${base}posts/${p.id}.json`);
    for (const m of watchMedia(p)) await download(m.url, `${base}media/${m.filename}`);
    saved++;
  }
  for (const c of comments) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    await download(dataUrl("application/json", JSON.stringify(c, null, 2)), `${base}comments/${c.id}.json`);
    saved++;
  }

  // Cap the seen list so it can't grow without bound.
  await store.set({ [seenKey(user)]: [...seen].slice(-8000) });
  if (saved > 0) {
    try {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Unhideddit",
        message: `Saved ${saved} new item${saved > 1 ? "s" : ""} from u/${user}`,
      });
    } catch {}
  }
  return saved;
}

async function pollAll() {
  const { watchlist } = await store.get({ watchlist: [] });
  for (const user of watchlist) {
    try {
      await pollUser(user);
    } catch {}
  }
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) pollAll();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "UNHIDE_WATCH_ADD") {
    addWatch(msg.username)
      .then((watchlist) => sendResponse({ ok: true, watchlist }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true;
  }
  if (msg?.type === "UNHIDE_WATCH_REMOVE") {
    removeWatch(msg.username)
      .then((watchlist) => sendResponse({ ok: true, watchlist }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true;
  }
  if (msg?.type === "UNHIDE_WATCH_GET") {
    store.get({ watchlist: [], interval: DEFAULT_INTERVAL }).then((s) => sendResponse({ ok: true, ...s }));
    return true;
  }
  if (msg?.type === "UNHIDE_WATCH_INTERVAL") {
    store
      .set({ interval: Math.max(1, Number(msg.interval) || DEFAULT_INTERVAL) })
      .then(ensureAlarm)
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "UNHIDE_SNAPSHOT") {
    snapshot(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true; // async
  }
  if (msg?.type === "UNHIDE_FETCH_POSTS") {
    fetchPosts(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true; // async
  }
  if (msg?.type === "UNHIDE_FETCH_LISTING") {
    fetchListing(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true; // async
  }
  if (msg?.type === "UNHIDE_FETCH_ARCHIVE") {
    fetchArchive(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true; // async
  }
  if (msg?.type === "UNHIDE_FETCH_ABOUT") {
    fetchAbout(msg.username)
      .then((about) => sendResponse({ ok: true, about }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
    return true; // async
  }
  return false;
});
