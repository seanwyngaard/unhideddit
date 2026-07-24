const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const clean = (v) => v.trim().replace(/^\/?u(?:ser)?\//i, "").replace(/^\/+|\/+$/g, "");

function openSettings() {
  chrome.runtime.openOptionsPage();
}

document.getElementById("open-settings").addEventListener("click", openSettings);
document.getElementById("manage-settings").addEventListener("click", openSettings);

document.getElementById("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = clean(document.getElementById("username").value);
  if (name) chrome.tabs.create({ url: `https://www.reddit.com/user/${encodeURIComponent(name)}/` });
});

function renderList(watchlist) {
  const ul = document.getElementById("watch-list");
  document.getElementById("watch-count").textContent = String(watchlist.length);
  ul.innerHTML = "";
  if (!watchlist.length) {
    ul.innerHTML = `<li class="empty">No accounts followed yet.</li>`;
    return;
  }
  for (const user of watchlist) {
    const li = document.createElement("li");

    const avatar = document.createElement("span");
    avatar.className = "watch-avatar";
    avatar.textContent = user.slice(0, 2);
    avatar.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "watch-copy";
    const link = document.createElement("a");
    link.href = `https://www.reddit.com/user/${encodeURIComponent(user)}/`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `u/${user}`;
    const status = document.createElement("small");
    status.textContent = "Auto-saving new activity";
    copy.append(link, status);

    const btn = document.createElement("button");
    btn.className = "remove-watch";
    btn.textContent = "×";
    btn.title = `Stop following u/${user}`;
    btn.setAttribute("aria-label", `Stop following u/${user}`);
    btn.addEventListener("click", async () => {
      const resp = await send({ type: "UNHIDE_WATCH_REMOVE", username: user });
      if (resp?.ok) renderList(resp.watchlist);
    });
    li.append(avatar, copy, btn);
    ul.append(li);
  }
}

document.getElementById("watch-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("watch-username");
  const name = clean(input.value);
  if (!name) return;
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "…";
  const resp = await send({ type: "UNHIDE_WATCH_ADD", username: name });
  btn.disabled = false;
  btn.textContent = "Watch";
  if (resp?.ok) {
    input.value = "";
    renderList(resp.watchlist);
  }
});

document.getElementById("interval").addEventListener("change", (e) => {
  send({ type: "UNHIDE_WATCH_INTERVAL", interval: Number(e.target.value) });
});

(async () => {
  const s = await send({ type: "UNHIDE_WATCH_GET" });
  if (s?.ok) {
    document.getElementById("interval").value = String(s.interval || 1);
    document.getElementById("download-path").textContent =
      `Downloads/${s.downloadFolder || "Unhideddit"}/…`;
    renderList(s.watchlist || []);
  }
})();
