// Unhideddit — reveals a Reddit user's public posts & comments, including ones
// hidden from their profile, by querying Reddit's search index (author:"user")
// instead of the /user/<name>/submitted listing (which honors profile hiding).
(() => {
  const state = {
    username: null,
    tab: "posts", // posts | comments
    sort: "new", // new | top | hot
    filter: "",
    nsfw: "all", // all | only | hide
    posts: freshPosts(),
    comments: freshComments(),
  };

  function freshPosts() {
    return {
      items: [],
      seen: new Set(),
      search: { after: null, done: false },
      listing: { after: null, done: false },
      archive: { before: null, done: false },
      arctic: { before: null, done: false },
      loading: false,
      done: false,
      error: null,
    };
  }

  function freshComments() {
    return {
      items: [],
      seen: new Set(),
      html: { nextUrl: null, started: false, done: false },
      listing: { after: null, done: false },
      archive: { before: null, done: false },
      arctic: { before: null, done: false },
      loading: false,
      done: false,
      error: null,
    };
  }

  // Map PullPush / arctic-shift archive objects into the shapes our cards render.
  // Image-bearing fields are carried through so removed posts keep their media.
  function archivePost(p) {
    return {
      name: "t3_" + p.id,
      id: p.id,
      title: p.title || "",
      selftext: p.selftext || "",
      subreddit: p.subreddit || "",
      over_18: !!p.over_18,
      score: p.score || 0,
      num_comments: p.num_comments || 0,
      permalink: p.permalink || `/r/${p.subreddit}/comments/${p.id}/`,
      created_utc: p.created_utc ? Math.floor(p.created_utc) : 0,
      removed: !!p.removed_by_category,
      url: p.url_overridden_by_dest || p.url || "",
      post_hint: p.post_hint || "",
      is_gallery: !!p.is_gallery,
      media_metadata: p.media_metadata || null,
      gallery_data: p.gallery_data || null,
      preview: p.preview || null,
      thumbnail: p.thumbnail || "",
    };
  }

  function archiveComment(c) {
    return {
      id: "t1_" + c.id,
      permalink: c.permalink || "",
      postTitle: c.link_title || "",
      subreddit: c.subreddit || "",
      nsfw: !!c.over_18,
      body: c.body || "",
      score: c.score || 0,
      created: c.created_utc ? Math.floor(c.created_utc) : null,
      removed: !!c.removed_by_category,
    };
  }

  // Reddit fullnames come prefixed (t3_/t1_) from listings but bare from the
  // shreddit HTML search — normalize so the same item dedupes across sources.
  const normId = (id) => String(id || "").replace(/^t\d_/, "");

  // ---------- helpers ----------

  function currentProfileUser() {
    const m = location.pathname.match(/^\/(?:user|u)\/([^/]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
  }

  function timeAgo(utcSeconds) {
    if (!utcSeconds) return "";
    const s = Math.floor(Date.now() / 1000) - utcSeconds;
    const units = [[31536000, "y"], [2592000, "mo"], [86400, "d"], [3600, "h"], [60, "m"]];
    for (const [len, label] of units) if (s >= len) return `${Math.floor(s / len)}${label} ago`;
    return "just now";
  }

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  // ---------- posts (search index + profile listing, merged) ----------

  function mergePosts(list) {
    const p = state.posts;
    for (const post of list) {
      const key = normId(post.name);
      if (!key || p.seen.has(key)) continue;
      p.seen.add(key);
      p.items.push(post);
    }
  }

  async function loadPostsPage() {
    const p = state.posts;
    if (p.loading || p.done) return;
    p.loading = true;
    p.error = null;
    renderStatus();

    const jobs = [];
    // Author-search index: reveals posts hidden from the profile.
    if (!p.search.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_POSTS",
          username: state.username,
          sort: state.sort,
          t: state.sort === "top" ? "all" : null,
          after: p.search.after,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            if (p.items.length === 0) p.error = resp?.error || "UNKNOWN";
            p.search.done = true;
            return;
          }
          mergePosts(resp.posts);
          p.search.after = resp.after;
          if (!resp.after || resp.posts.length === 0) p.search.done = true;
        })
      );
    }
    // Direct /submitted listing: authoritative, complete set search may miss.
    if (!p.listing.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_LISTING",
          username: state.username,
          kind: "submitted",
          sort: state.sort,
          after: p.listing.after,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            p.listing.done = true;
            return;
          }
          mergePosts(resp.children);
          p.listing.after = resp.after;
          if (!resp.after || resp.children.length === 0) p.listing.done = true;
        })
      );
    }

    // Archive backend: mod-removed / deleted posts search & listing no longer return.
    if (!p.archive.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_ARCHIVE",
          username: state.username,
          kind: "submission",
          before: p.archive.before,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            p.archive.done = true;
            return;
          }
          mergePosts(resp.items.map(archivePost));
          p.archive.before = resp.before;
          if (!resp.before || resp.items.length === 0) p.archive.done = true;
        })
      );
    }
    // Second archive (arctic-shift): fresher; catches recently-removed posts.
    if (!p.arctic.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_ARCHIVE",
          provider: "arctic",
          username: state.username,
          kind: "submission",
          before: p.arctic.before,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            p.arctic.done = true;
            return;
          }
          mergePosts(resp.items.map(archivePost));
          p.arctic.before = resp.before;
          if (!resp.before || resp.items.length === 0) p.arctic.done = true;
        })
      );
    }

    await Promise.all(jobs);
    p.loading = false;
    p.done = p.search.done && p.listing.done && p.archive.done && p.arctic.done;
    render();
  }

  // ---------- comments (shreddit search HTML, scraped same-origin) ----------

  function commentSearchUrl() {
    const q = `author:"${state.username}"`;
    return `https://www.reddit.com/svc/shreddit/search/?q=${encodeURIComponent(q)}&type=comments&sort=${encodeURIComponent(state.sort)}`;
  }

  function parseCommentCards(doc) {
    const out = [];
    doc.querySelectorAll('[data-testid="search-sdui-comment-unit"]').forEach((card) => {
      try {
        const tracker = card.closest("search-telemetry-tracker");
        const ctxRaw = tracker && tracker.getAttribute("data-faceplate-tracking-context");
        if (!ctxRaw) return;
        const ctx = JSON.parse(ctxRaw);
        const id = ctx?.comment?.id;
        if (!id) return;
        const permalinkEl = card.querySelector('a[aria-labelledby^="comment-content-"]');
        const permalink = permalinkEl && permalinkEl.getAttribute("href");
        if (!permalink) return;
        const wrap = card.querySelector('[data-testid="search-comment-content"]');
        const bodyEl = wrap && wrap.querySelector('[id^="search-comment-"][id$="-post-rtjson-content"]');
        const paras = bodyEl ? Array.from(bodyEl.querySelectorAll("p")).map((p) => p.textContent) : [];
        const body = (paras.length ? paras.join("\n") : bodyEl?.textContent || "").trim();
        const voteEl = wrap && wrap.querySelector("faceplate-number");
        const score = voteEl ? parseInt(voteEl.getAttribute("number"), 10) || 0 : 0;
        const timeEl = wrap && wrap.querySelector("faceplate-timeago");
        const ts = timeEl && timeEl.getAttribute("ts");
        out.push({
          id,
          permalink,
          postTitle: ctx?.post?.title || "",
          subreddit: ctx?.subreddit?.name || "",
          nsfw: !!(ctx?.post?.isNsfw ?? ctx?.post?.nsfw ?? ctx?.post?.over18),
          body,
          score,
          created: ts ? Math.floor(new Date(ts).getTime() / 1000) : null,
        });
      } catch {}
    });
    return out;
  }

  function findNextCommentsUrl(doc) {
    const el = doc.querySelector('faceplate-partial[loading="lazy"]');
    const src = el && el.getAttribute("src");
    if (!src) return null;
    try {
      return new URL(src, "https://www.reddit.com").toString();
    } catch {
      return null;
    }
  }

  function mergeComments(list) {
    const c = state.comments;
    for (const cm of list) {
      const key = normId(cm.id);
      if (!key || c.seen.has(key)) continue;
      c.seen.add(key);
      c.items.push(cm);
    }
  }

  // Map a t1 listing object to the shape our comment card renders.
  function listingComment(d) {
    return {
      id: d.name,
      permalink: d.permalink,
      postTitle: d.link_title || "",
      subreddit: d.subreddit || "",
      nsfw: !!(d.over_18 || d.link_over_18),
      body: d.body || "",
      score: d.score || 0,
      created: d.created_utc || null,
    };
  }

  async function loadCommentsPage() {
    const c = state.comments;
    if (c.loading || c.done) return;
    c.loading = true;
    c.error = null;
    renderStatus();

    const jobs = [];
    // shreddit HTML search: reveals comments hidden from the profile.
    if (!c.html.done) {
      jobs.push(
        (async () => {
          try {
            const url = c.html.started ? c.html.nextUrl : commentSearchUrl();
            c.html.started = true;
            const res = await fetch(url, {
              credentials: "include",
              headers: { Accept: "text/vnd.reddit.partial+html, text/html;q=0.9" },
            });
            if (!res.ok) throw new Error(`HTTP_${res.status}`);
            const doc = new DOMParser().parseFromString(await res.text(), "text/html");
            mergeComments(parseCommentCards(doc));
            c.html.nextUrl = findNextCommentsUrl(doc);
            if (!c.html.nextUrl) c.html.done = true;
          } catch (err) {
            if (c.items.length === 0) c.error = err.message;
            c.html.done = true;
          }
        })()
      );
    }
    // Direct /comments listing: authoritative set search may miss.
    if (!c.listing.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_LISTING",
          username: state.username,
          kind: "comments",
          sort: state.sort,
          after: c.listing.after,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            c.listing.done = true;
            return;
          }
          mergeComments(resp.children.map(listingComment));
          c.listing.after = resp.after;
          if (!resp.after || resp.children.length === 0) c.listing.done = true;
        })
      );
    }

    // Archive backend: removed / deleted comments.
    if (!c.archive.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_ARCHIVE",
          username: state.username,
          kind: "comment",
          before: c.archive.before,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            c.archive.done = true;
            return;
          }
          mergeComments(resp.items.map(archiveComment));
          c.archive.before = resp.before;
          if (!resp.before || resp.items.length === 0) c.archive.done = true;
        })
      );
    }
    // Second archive (arctic-shift): fresher; catches recently-removed comments.
    if (!c.arctic.done) {
      jobs.push(
        send({
          type: "UNHIDE_FETCH_ARCHIVE",
          provider: "arctic",
          username: state.username,
          kind: "comment",
          before: c.arctic.before,
        }).then((resp) => {
          if (!resp || !resp.ok) {
            c.arctic.done = true;
            return;
          }
          mergeComments(resp.items.map(archiveComment));
          c.arctic.before = resp.before;
          if (!resp.before || resp.items.length === 0) c.arctic.done = true;
        })
      );
    }

    await Promise.all(jobs);
    c.loading = false;
    c.done = c.html.done && c.listing.done && c.archive.done && c.arctic.done;
    render();
  }

  // ---------- dispatch ----------

  function loadMore() {
    if (state.tab === "posts") loadPostsPage();
    else loadCommentsPage();
  }

  function resetTabData() {
    state.posts = freshPosts();
    state.comments = freshComments();
  }

  function reload() {
    resetTabData();
    render();
    loadMore();
  }

  // ---------- UI ----------

  let panel, fab;

  function buildFab() {
    fab = document.createElement("button");
    fab.className = "uh-fab";
    fab.title = "Unhideddit — reveal public posts & comments";
    fab.textContent = "🕵️";
    fab.addEventListener("click", togglePanel);
    document.documentElement.appendChild(fab);
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "uh-panel uh-hidden";
    panel.innerHTML = `
      <div class="uh-header">
        <span class="uh-title">🕵️ Unhideddit</span>
        <span class="uh-user"></span>
        <button class="uh-watch" title="Auto-save this user's new posts to your PC">👁 Watch</button>
        <button class="uh-expand" title="Toggle full-page view">⛶</button>
        <button class="uh-close" title="Close">×</button>
      </div>
      <div class="uh-meta"></div>
      <div class="uh-watchbar"></div>
      <div class="uh-controls">
        <div class="uh-tabs">
          <button data-tab="posts" class="uh-active">Posts</button>
          <button data-tab="comments">Comments</button>
        </div>
        <button class="uh-snapshot" title="Save all posts, comments & media to the folder selected in Unhideddit Settings">📸 Snapshot</button>
      </div>
      <div class="uh-controls uh-controls-2">
        <select class="uh-sort">
          <option value="new">New</option>
          <option value="top">Top</option>
          <option value="hot">Hot</option>
        </select>
        <select class="uh-nsfw" title="NSFW filter">
          <option value="all">All</option>
          <option value="only">NSFW only</option>
          <option value="hide">Hide NSFW</option>
        </select>
      </div>
      <input class="uh-filter" type="search" placeholder="Filter loaded items…" />
      <div class="uh-scroll">
        <div class="uh-list"></div>
        <div class="uh-status"></div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector(".uh-close").addEventListener("click", togglePanel);

    panel.querySelector(".uh-expand").addEventListener("click", () => {
      panel.classList.toggle("uh-full");
    });

    panel.querySelector(".uh-watch").addEventListener("click", toggleWatch);

    panel.querySelectorAll(".uh-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.tab === btn.dataset.tab) return;
        panel.querySelectorAll(".uh-tabs button").forEach((b) => b.classList.remove("uh-active"));
        btn.classList.add("uh-active");
        state.tab = btn.dataset.tab;
        render();
        const active = state.tab === "posts" ? state.posts : state.comments;
        if (active.items.length === 0 && !active.loading && !active.done) loadMore();
      });
    });

    panel.querySelector(".uh-sort").addEventListener("change", (e) => {
      state.sort = e.target.value;
      reload();
    });

    panel.querySelector(".uh-nsfw").addEventListener("change", (e) => {
      state.nsfw = e.target.value;
      renderList();
    });

    panel.querySelector(".uh-snapshot").addEventListener("click", snapshotNow);

    panel.querySelector(".uh-filter").addEventListener("input", (e) => {
      state.filter = e.target.value.toLowerCase();
      renderList();
    });

    const scroll = panel.querySelector(".uh-scroll");
    scroll.addEventListener("scroll", () => {
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 300) loadMore();
    });
  }

  function togglePanel() {
    const opening = panel.classList.contains("uh-hidden");
    panel.classList.toggle("uh-hidden");
    if (opening && !state.username) loadProfile();
  }

  async function loadProfile() {
    state.username = currentProfileUser();
    if (!state.username) return;
    panel.querySelector(".uh-user").textContent = `u/${state.username}`;
    refreshWatchButton();
    const meta = panel.querySelector(".uh-meta");
    meta.textContent = "Loading account info…";
    send({ type: "UNHIDE_FETCH_ABOUT", username: state.username }).then((resp) => {
      const about = resp?.ok ? resp.about : null;
      if (!about) {
        meta.textContent = "Account info unavailable.";
        return;
      }
      const created = new Date(about.created_utc * 1000).toLocaleDateString();
      meta.innerHTML =
        `<span>⬆ ${esc(String(about.link_karma ?? 0))} post karma</span>` +
        `<span>💬 ${esc(String(about.comment_karma ?? 0))} comment karma</span>` +
        `<span>📅 since ${esc(created)}</span>`;
    });
    reload();
  }

  const deent = (u) => String(u || "").replace(/&amp;/g, "&");

  const uniq = (arr) => arr.filter((u, i) => u && /^https?:\/\//.test(u) && arr.indexOf(u) === i);

  // Candidate URLs (best→fallback) for one media_metadata gallery entry.
  function galleryEntryCandidates(mm) {
    const s = mm?.s;
    const res = mm?.p; // downscaled previews, ascending
    return uniq([deent(s?.u || s?.gif), deent(res && res.length ? res[res.length - 1]?.u : "")]);
  }

  // Candidate URLs for a single (non-gallery) image post.
  function singleImageCandidates(p) {
    const img = p.preview?.images?.[0];
    const url = p.url_overridden_by_dest || p.url || "";
    const looksImg =
      p.post_hint === "image" ||
      /\.(jpe?g|png|gif|webp)$/i.test(url.split("?")[0]) ||
      /(i\.redd\.it|i\.imgur\.com)/.test(url);
    const res = img?.resolutions;
    return uniq([
      looksImg ? deent(url) : "", // original full-res file (most durable)
      deent(img?.source?.url), // signed preview
      deent(res && res.length ? res[res.length - 1].url : ""),
      p.thumbnail && /^https?:/.test(p.thumbnail) ? deent(p.thumbnail) : "",
    ]);
  }

  // One "slot" per image; each slot is its own fallback chain. Galleries yield
  // many slots (all their images), single-image posts yield one.
  function postImageSlots(p) {
    if (p.is_gallery && p.media_metadata) {
      const order =
        p.gallery_data?.items?.map((it) => it.media_id) || Object.keys(p.media_metadata);
      const slots = order
        .map((id) => galleryEntryCandidates(p.media_metadata[id]))
        .filter((c) => c.length);
      if (slots.length) return slots;
    }
    const single = singleImageCandidates(p);
    return single.length ? [single] : [];
  }

  function imageHtml(cands) {
    if (!cands.length) return "";
    const data = encodeURIComponent(JSON.stringify(cands));
    return `<img class="uh-img" loading="lazy" src="${esc(cands[0])}" data-cands="${data}" data-i="0">`;
  }

  function imagesHtml(slots) {
    if (!slots.length) return "";
    const badge = slots.length > 1 ? `<span class="uh-gallery-count">🖼 ${slots.length}</span>` : "";
    return `<div class="uh-gallery">${badge}${slots.map(imageHtml).join("")}</div>`;
  }

  function postCard(p) {
    const link = `https://www.reddit.com${p.permalink ?? ""}`;
    return `
      <div class="uh-card">
        <div class="uh-card-top">
          <span class="uh-sub">r/${esc(p.subreddit ?? "")}</span>
          <span class="uh-when">${esc(timeAgo(p.created_utc))}</span>
          <span class="uh-score">▲ ${esc(String(p.score ?? 0))}</span>
          <span class="uh-comments">💬 ${esc(String(p.num_comments ?? 0))}</span>
          ${p.over_18 ? `<span class="uh-nsfw-badge">NSFW</span>` : ""}
          ${p.removed ? `<span class="uh-removed-badge">RECOVERED</span>` : ""}
        </div>
        <a class="uh-post-title" href="${esc(link)}" target="_blank" rel="noopener">${esc(p.title ?? "")}</a>
        ${imagesHtml(postImageSlots(p))}
        ${p.selftext ? `<div class="uh-body">${esc(p.selftext)}</div>` : ""}
      </div>`;
  }

  function commentCard(c) {
    const link = `https://www.reddit.com${c.permalink ?? ""}`;
    return `
      <div class="uh-card">
        <div class="uh-card-top">
          <span class="uh-sub">r/${esc(c.subreddit)}</span>
          <span class="uh-when">${esc(timeAgo(c.created))}</span>
          <span class="uh-score">▲ ${esc(String(c.score ?? 0))}</span>
          ${c.nsfw ? `<span class="uh-nsfw-badge">NSFW</span>` : ""}
          ${c.removed ? `<span class="uh-removed-badge">RECOVERED</span>` : ""}
        </div>
        <a class="uh-context" href="${esc(link)}" target="_blank" rel="noopener">💬 on: ${esc(c.postTitle)}</a>
        <div class="uh-body">${esc(c.body ?? "")}</div>
      </div>`;
  }

  // Attach image error-fallback + click-to-open (inline handlers are CSP-blocked).
  function wireImages(container) {
    container.querySelectorAll("img.uh-img").forEach((img) => {
      img.addEventListener("error", () => {
        let cands;
        try {
          cands = JSON.parse(decodeURIComponent(img.dataset.cands));
        } catch {
          cands = [];
        }
        let i = Number(img.dataset.i || 0) + 1;
        if (i < cands.length) {
          img.dataset.i = String(i);
          img.src = cands[i];
        } else {
          img.classList.add("uh-img-dead");
        }
      });
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(img.src, "_blank", "noopener");
      });
    });
  }

  function renderList() {
    const list = panel.querySelector(".uh-list");
    const isPosts = state.tab === "posts";
    let items = isPosts ? state.posts.items : state.comments.items;
    if (state.nsfw !== "all") {
      const wantNsfw = state.nsfw === "only";
      items = items.filter((i) => Boolean(isPosts ? i.over_18 : i.nsfw) === wantNsfw);
    }
    if (state.filter) {
      items = items.filter((i) =>
        [i.title, i.body, i.selftext, i.postTitle, i.subreddit]
          .filter(Boolean)
          .some((t) => t.toLowerCase().includes(state.filter))
      );
    }
    // Two merged sources arrive interleaved — re-sort for a coherent order.
    const created = (i) => i.created_utc ?? i.created ?? 0;
    const score = (i) => i.score ?? 0;
    items = items.slice();
    if (state.sort === "new") items.sort((a, b) => created(b) - created(a));
    else items.sort((a, b) => score(b) - score(a)); // top / hot ≈ by score
    list.innerHTML = items.map(isPosts ? postCard : commentCard).join("");
    wireImages(list);
  }

  function renderStatus() {
    const status = panel.querySelector(".uh-status");
    const s = state.tab === "posts" ? state.posts : state.comments;
    const noun = state.tab === "posts" ? "posts" : "comments";
    const errMap = {
      USER_NOT_FOUND: "User not found.",
      BANNED_OR_PRIVATE: "Account is banned or suspended.",
      RATE_LIMITED: "Reddit rate-limited us — wait a moment and scroll to retry.",
      REDDIT_UNAVAILABLE: "Reddit is temporarily unavailable.",
    };
    if (s.loading) status.textContent = "Searching…";
    else if (s.error) status.textContent = errMap[s.error] || `Error: ${s.error}`;
    else if (s.items.length === 0 && s.done) status.textContent = `No public ${noun} found via search.`;
    else if (s.done) status.textContent = "— end —";
    else status.textContent = "";
  }

  function render() {
    renderList();
    renderStatus();
  }

  // ---------- snapshot to disk ----------

  function slug(s) {
    return (
      String(s || "post")
        .toLowerCase()
        .replace(/[^\w]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "post"
    );
  }

  function extOf(url) {
    const m = String(url).split("?")[0].match(/\.(jpe?g|png|gif|webp|mp4)$/i);
    return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  }

  // Return the downloadable media for a post as [{url, filename}].
  function mediaForPost(p) {
    const id = p.id || normId(p.name);
    const out = [];
    if (p.is_gallery && p.media_metadata) {
      let i = 0;
      for (const key of Object.keys(p.media_metadata)) {
        const s = p.media_metadata[key]?.s;
        const u = (s?.u || s?.gif || "").replace(/&amp;/g, "&");
        if (u) out.push({ url: u, filename: `media/${id}_${slug(p.title)}_${i++}.${extOf(u)}` });
      }
    } else {
      const url = p.url_overridden_by_dest || p.url || "";
      const clean = url.split("?")[0];
      const isImg =
        p.post_hint === "image" ||
        /\.(jpe?g|png|gif|webp)$/i.test(clean) ||
        /(i\.redd\.it|i\.imgur\.com)/.test(url);
      if (isImg && url) out.push({ url, filename: `media/${id}_${slug(p.title)}.${extOf(url)}` });
    }
    return out;
  }

  async function loadAll(kind) {
    const st = kind === "posts" ? state.posts : state.comments;
    let guard = 0;
    while (!st.done && guard++ < 300) {
      await (kind === "posts" ? loadPostsPage() : loadCommentsPage());
    }
  }

  function buildIndexHtml(user, posts, comments) {
    const rows = posts
      .map((p) => {
        const imgs = (p.media || [])
          .map((f) => `<img src="${f}" loading="lazy" style="max-width:320px;border-radius:8px;display:block;margin:6px 0">`)
          .join("");
        return `<article style="border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0">
          <div style="font-size:12px;color:#666">r/${esc(p.subreddit)} · ▲${p.score ?? 0} · 💬${p.num_comments ?? 0}${p.over_18 ? " · NSFW" : ""}${p.removed ? " · RECOVERED" : ""}</div>
          <h3 style="margin:4px 0"><a href="https://reddit.com${esc(p.permalink || "")}">${esc(p.title || "")}</a></h3>
          ${p.selftext ? `<p style="white-space:pre-wrap">${esc(p.selftext)}</p>` : ""}
          ${imgs}
        </article>`;
      })
      .join("");
    const crows = comments
      .map(
        (c) => `<article style="border:1px solid #eee;border-radius:8px;padding:10px;margin:8px 0">
          <div style="font-size:12px;color:#666">r/${esc(c.subreddit)} · ▲${c.score ?? 0}${c.removed ? " · RECOVERED" : ""} · on: ${esc(c.postTitle || "")}</div>
          <p style="white-space:pre-wrap"><a href="https://reddit.com${esc(c.permalink || "")}">${esc(c.body || "")}</a></p>
        </article>`
      )
      .join("");
    return `<!doctype html><meta charset="utf-8"><title>Unhideddit snapshot — u/${esc(user)}</title>
      <body style="max-width:760px;margin:24px auto;font-family:-apple-system,Segoe UI,sans-serif;padding:0 16px">
      <h1>🕵️ u/${esc(user)}</h1>
      <p style="color:#666">Snapshot taken ${esc(new Date().toLocaleString())} · ${posts.length} posts · ${comments.length} comments</p>
      <h2>Posts</h2>${rows || "<p>None.</p>"}
      <h2>Comments</h2>${crows || "<p>None.</p>"}`;
  }

  async function snapshotNow() {
    if (!state.username) return;
    const btn = panel.querySelector(".uh-snapshot");
    const status = panel.querySelector(".uh-status");
    btn.disabled = true;
    btn.textContent = "Loading posts…";
    await loadAll("posts");
    btn.textContent = "Loading comments…";
    await loadAll("comments");
    btn.textContent = "Saving…";

    const media = [];
    const postsOut = state.posts.items.map((p) => {
      const ms = mediaForPost(p);
      ms.forEach((m) => media.push(m));
      return {
        id: p.id || normId(p.name),
        subreddit: p.subreddit,
        title: p.title,
        selftext: p.selftext,
        url: p.url_overridden_by_dest || p.url,
        permalink: p.permalink,
        score: p.score,
        num_comments: p.num_comments,
        over_18: !!p.over_18,
        created_utc: p.created_utc,
        removed: !!p.removed,
        media: ms.map((m) => m.filename),
      };
    });
    const commentsOut = state.comments.items.map((c) => ({
      id: normId(c.id),
      subreddit: c.subreddit,
      postTitle: c.postTitle,
      body: c.body,
      permalink: c.permalink,
      score: c.score,
      created: c.created,
      removed: !!c.removed,
    }));

    const resp = await send({
      type: "UNHIDE_SNAPSHOT",
      username: state.username,
      postsJson: JSON.stringify(postsOut, null, 2),
      commentsJson: JSON.stringify(commentsOut, null, 2),
      indexHtml: buildIndexHtml(state.username, postsOut, commentsOut),
      media,
    });

    btn.disabled = false;
    btn.textContent = "📸 Snapshot";
    if (resp?.ok) {
      status.textContent = `Saved ${postsOut.length} posts, ${commentsOut.length} comments, ${resp.mediaOk} media files → ${resp.destination}`;
    } else {
      status.textContent = "Snapshot failed: " + (resp?.error || "unknown");
    }
  }

  // ---------- watch toggle ----------

  function renderWatchbar(list) {
    const bar = panel.querySelector(".uh-watchbar");
    bar.innerHTML = "";
    if (!list.length) {
      bar.classList.remove("uh-show");
      return;
    }
    bar.classList.add("uh-show");
    const label = document.createElement("span");
    label.className = "uh-watchbar-label";
    label.textContent = "👁 Watching:";
    bar.appendChild(label);
    for (const user of list) {
      const chip = document.createElement("span");
      chip.className = "uh-watch-chip";
      const name = document.createElement("span");
      name.textContent = `u/${user}`;
      const x = document.createElement("button");
      x.textContent = "✕";
      x.title = `Stop watching u/${user}`;
      x.addEventListener("click", async () => {
        const resp = await send({ type: "UNHIDE_WATCH_REMOVE", username: user });
        if (resp?.ok) {
          renderWatchbar(resp.watchlist || []);
          updateWatchButton(resp.watchlist || []);
        }
      });
      chip.append(name, x);
      bar.appendChild(chip);
    }
  }

  function updateWatchButton(list) {
    const btn = panel.querySelector(".uh-watch");
    const watched = list.some((u) => u.toLowerCase() === (state.username || "").toLowerCase());
    btn.textContent = watched ? "👁 Watching" : "👁 Watch";
    btn.classList.toggle("uh-watching", watched);
  }

  async function refreshWatchButton() {
    const resp = await send({ type: "UNHIDE_WATCH_GET" });
    const list = resp?.ok ? resp.watchlist || [] : [];
    updateWatchButton(list);
    renderWatchbar(list);
  }

  async function toggleWatch() {
    if (!state.username) return;
    const btn = panel.querySelector(".uh-watch");
    const resp = await send({ type: "UNHIDE_WATCH_GET" });
    const list = resp?.ok ? resp.watchlist || [] : [];
    const folder = resp?.ok ? resp.downloadFolder || "Unhideddit" : "Unhideddit";
    const watched = list.some((u) => u.toLowerCase() === state.username.toLowerCase());
    btn.disabled = true;
    await send({
      type: watched ? "UNHIDE_WATCH_REMOVE" : "UNHIDE_WATCH_ADD",
      username: state.username,
    });
    btn.disabled = false;
    refreshWatchButton();
    const status = panel.querySelector(".uh-status");
    if (!watched) status.textContent = `Now watching u/${state.username} — new posts will auto-save to Downloads/${folder}/${state.username}/watch/`;
  }

  // ---------- SPA navigation ----------

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const user = currentProfileUser();
    fab.style.display = user ? "" : "none";
    if (!user) {
      panel.classList.add("uh-hidden");
      return;
    }
    if (user !== state.username) {
      state.username = null;
      if (!panel.classList.contains("uh-hidden")) loadProfile();
    }
  }, 500);

  // ---------- init ----------

  buildFab();
  buildPanel();
  if (!currentProfileUser()) fab.style.display = "none";
})();
