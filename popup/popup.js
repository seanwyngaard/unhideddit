const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const clean = (v) => v.trim().replace(/^\/?u(?:ser)?\//i, "").replace(/^\/+|\/+$/g, "");

document.getElementById("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = clean(document.getElementById("username").value);
  if (name) chrome.tabs.create({ url: `https://www.reddit.com/user/${encodeURIComponent(name)}/` });
});

function renderList(watchlist) {
  const ul = document.getElementById("watch-list");
  ul.innerHTML = "";
  if (!watchlist.length) {
    ul.innerHTML = `<li class="empty">No one watched yet.</li>`;
    return;
  }
  for (const user of watchlist) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `u/${user}`;
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Stop watching";
    btn.addEventListener("click", async () => {
      const resp = await send({ type: "UNHIDE_WATCH_REMOVE", username: user });
      if (resp?.ok) renderList(resp.watchlist);
    });
    li.append(span, btn);
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
    renderList(s.watchlist || []);
  }
})();
