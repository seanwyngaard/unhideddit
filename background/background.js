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

// ---------- saving to disk ----------

const DEFAULT_DOWNLOAD_FOLDER = "Unhideddit";

const store = {
  get: (defaults) => new Promise((r) => chrome.storage.local.get(defaults, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
};

// chrome.downloads only accepts paths relative to the browser's Downloads
// directory. Keep nested folders useful while rejecting absolute/backtracking
// paths and characters that are invalid on common desktop filesystems.
function normalizeDownloadFolder(value) {
  const input = String(value ?? "").trim().replace(/\\/g, "/");
  if (!input) return DEFAULT_DOWNLOAD_FOLDER;
  if (input.startsWith("/") || /^[a-z]:\//i.test(input)) throw new Error("INVALID_DOWNLOAD_FOLDER");

  const parts = input.split("/").filter(Boolean);
  if (
    !parts.length ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        /[<>:"|?*\u0000-\u001f]/.test(part) ||
        /[. ]$/.test(part)
    )
  ) {
    throw new Error("INVALID_DOWNLOAD_FOLDER");
  }
  return parts.join("/");
}

async function getDownloadFolder() {
  const { downloadFolder } = await store.get({ downloadFolder: DEFAULT_DOWNLOAD_FOLDER });
  try {
    return normalizeDownloadFolder(downloadFolder);
  } catch {
    return DEFAULT_DOWNLOAD_FOLDER;
  }
}

// Service workers have no DOM/URL.createObjectURL, so text files are saved as
// base64 data: URLs; media is handed to Chrome's downloader by URL (no CORS).
function dataUrl(mime, text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

// Resolve only when Chrome reports that the transfer actually finished. The
// callback from downloads.download means "started", not "saved"; treating it
// as success makes interrupted media downloads disappear from the retry path.
function download(url, filename) {
  return new Promise((resolve) => {
    let downloadId = null;
    let settled = false;
    let timer = null;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(ok);
    };

    const onChanged = (delta) => {
      if (downloadId === null || delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") finish(true);
      else if (delta.state.current === "interrupted") finish(false);
    };

    try {
      chrome.downloads.onChanged.addListener(onChanged);
      chrome.downloads.download(
        { url, filename, saveAs: false, conflictAction: "overwrite" },
        (id) => {
          const error = chrome.runtime.lastError;
          if (!id || error) {
            finish(false);
            return;
          }
          downloadId = id;

          // Cover very small data URLs that may finish before onChanged is
          // delivered to this service worker.
          chrome.downloads.search({ id }, (items) => {
            const searchError = chrome.runtime.lastError;
            if (searchError || settled) return;
            const state = items?.[0]?.state;
            if (state === "complete") finish(true);
            else if (state === "interrupted") finish(false);
          });

          // Avoid retaining a listener forever if the browser never emits a
          // terminal event (for example, during shutdown).
          timer = setTimeout(() => finish(false), 5 * 60 * 1000);
        }
      );
    } catch {
      finish(false);
    }
  });
}

async function snapshot({ username, postsJson, commentsJson, indexHtml, media }) {
  const safe = (username || "user").replace(/[^\w.-]/g, "_");
  const folder = await getDownloadFolder();
  const base = `${folder}/${safe}/`;
  const coreFiles = await Promise.all([
    download(dataUrl("application/json", postsJson), base + "posts.json"),
    download(dataUrl("application/json", commentsJson), base + "comments.json"),
    download(dataUrl("text/html;charset=utf-8", indexHtml), base + "index.html"),
  ]);
  if (coreFiles.some((ok) => !ok)) throw new Error("SAVE_FAILED");
  let mediaOk = 0;
  let mediaFail = 0;
  for (const m of media || []) {
    if (await download(m.url, base + m.filename)) mediaOk++;
    else mediaFail++;
  }
  return { mediaOk, mediaFail, destination: `Downloads/${base}` };
}

// ---------- watch list (background poller) ----------

const POLL_ALARM = "unhideddit-poll";
const DEFAULT_INTERVAL = 1; // minutes — Chrome's floor for background alarms

const seenKey = (user) => `seen_${user.toLowerCase()}`;
const safeName = (user) => (user || "user").replace(/[^\w.-]/g, "_");

function wslug(s) {
  return String(s || "post").toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "post";
}
function wext(u) {
  const m = String(u).split("?")[0].match(/\.(jpe?g|png|gif|webp|mp4)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

function cleanMediaUrl(url) {
  return String(url || "").replace(/&amp;/g, "&");
}

function uniqueMediaUrls(urls) {
  return urls
    .map(cleanMediaUrl)
    .filter((url, index, all) => /^https?:\/\//.test(url) && all.indexOf(url) === index);
}

function previewCandidates(p) {
  const image = p.preview?.images?.[0];
  const resolutions = image?.resolutions;
  return uniqueMediaUrls([
    image?.source?.url,
    resolutions?.length ? resolutions[resolutions.length - 1]?.url : "",
    /^https?:\/\//.test(p.thumbnail || "") ? p.thumbnail : "",
  ]);
}

function watchMedia(p) {
  const id = p.id || String(p.name || "").replace(/^t3_/, "") || "post";
  const out = [];
  if (p.is_gallery && p.media_metadata) {
    const order = p.gallery_data?.items?.map((item) => item.media_id) || Object.keys(p.media_metadata);
    for (let i = 0; i < order.length; i++) {
      const entry = p.media_metadata[order[i]];
      const resolutions = entry?.p;
      const urls = uniqueMediaUrls([
        entry?.s?.u || entry?.s?.gif,
        resolutions?.length ? resolutions[resolutions.length - 1]?.u : "",
      ]);
      if (urls.length) {
        out.push({ urls, filename: `${id}_${wslug(p.title)}_${i}.${wext(urls[0])}` });
      }
    }
    // Removed or partially processed galleries sometimes retain only the
    // listing preview/thumbnail even though media_metadata is empty.
    if (!out.length) {
      const urls = previewCandidates(p);
      if (urls.length) out.push({ urls, filename: `${id}_${wslug(p.title)}_0.${wext(urls[0])}` });
    }
  } else {
    const direct = cleanMediaUrl(p.url_overridden_by_dest || p.url || "");
    const isDirectImage =
      p.post_hint === "image" ||
      /\.(jpe?g|png|gif|webp)$/i.test(direct.split("?")[0]) ||
      /(i\.redd\.it|i\.imgur\.com)/.test(direct);
    const urls = uniqueMediaUrls([isDirectImage ? direct : "", ...previewCandidates(p)]);
    if (urls.length) out.push({ urls, filename: `${id}_${wslug(p.title)}.${wext(urls[0])}` });
  }
  return out;
}

async function downloadWatchMedia(media, filename) {
  for (const url of media.urls || []) {
    if (await download(url, filename)) return true;
  }
  return false;
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
  const folder = await getDownloadFolder();
  const base = `${folder}/${safeName(user)}/watch/`;
  const { posts, comments } = await collectLatest(user);
  let saved = 0;
  let failed = 0;

  for (const p of posts) {
    if (seen.has(p.name)) continue;
    const ok = await download(
      dataUrl("application/json", JSON.stringify(p, null, 2)),
      `${base}posts/${p.id}.json`
    );
    if (!ok) {
      failed++;
      continue;
    }
    const media = watchMedia(p);
    // An image/gallery post with no usable URL is not complete. Leave it out
    // of seen so a later listing (after Reddit finishes processing it) retries.
    let mediaOk = media.length > 0 || !(p.is_gallery || p.post_hint === "image");
    for (const m of media) {
      if (!(await downloadWatchMedia(m, `${base}media/${m.filename}`))) mediaOk = false;
    }
    if (!mediaOk) {
      failed++;
      continue;
    }
    seen.add(p.name);
    saved++;
  }
  for (const c of comments) {
    if (seen.has(c.name)) continue;
    const ok = await download(
      dataUrl("application/json", JSON.stringify(c, null, 2)),
      `${base}comments/${c.id}.json`
    );
    if (!ok) {
      failed++;
      continue;
    }
    seen.add(c.name);
    saved++;
  }

  // Cap the seen list so it can't grow without bound.
  await store.set({ [seenKey(user)]: [...seen].slice(-8000) });
  if (saved > 0) {
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Unhideddit",
        message: `Saved ${saved} new item${saved > 1 ? "s" : ""} from u/${user}`,
      });
    } catch {}
  }
  return { saved, failed };
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
    Promise.all([
      store.get({ watchlist: [], interval: DEFAULT_INTERVAL }),
      getDownloadFolder(),
    ]).then(([s, downloadFolder]) => sendResponse({ ok: true, ...s, downloadFolder }));
    return true;
  }
  if (msg?.type === "UNHIDE_WATCH_INTERVAL") {
    store
      .set({ interval: Math.max(1, Number(msg.interval) || DEFAULT_INTERVAL) })
      .then(ensureAlarm)
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "UNHIDE_SETTINGS_SET") {
    let downloadFolder;
    try {
      downloadFolder = normalizeDownloadFolder(msg.downloadFolder);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
    const interval = Math.max(1, Number(msg.interval) || DEFAULT_INTERVAL);
    store
      .set({ downloadFolder, interval })
      .then(ensureAlarm)
      .then(() => sendResponse({ ok: true, downloadFolder, interval }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "UNKNOWN" }));
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
