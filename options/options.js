const send = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });

const cleanUsername = (value) =>
  String(value || "")
    .trim()
    .replace(/^\/?u(?:ser)?\//i, "")
    .replace(/^\/+|\/+$/g, "");

function avatarHue(username) {
  let hash = 0;
  for (const char of username) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function renderFollowing(watchlist) {
  const list = document.getElementById("following-list");
  const count = document.getElementById("following-count");
  const total = watchlist.length;
  count.textContent = `${total} ${total === 1 ? "account" : "accounts"}`;
  list.replaceChildren();

  if (!total) {
    const empty = document.createElement("div");
    empty.className = "following-empty";
    empty.textContent = "No accounts followed yet. Add a Reddit username above to start.";
    list.appendChild(empty);
    return;
  }

  for (const username of watchlist) {
    const row = document.createElement("div");
    row.className = "account";

    const avatar = document.createElement("div");
    avatar.className = "account-avatar";
    avatar.style.setProperty("--avatar-hue", avatarHue(username));
    avatar.textContent = username.slice(0, 2);
    avatar.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "account-copy";
    const link = document.createElement("a");
    link.className = "account-name";
    link.href = `https://www.reddit.com/user/${encodeURIComponent(username)}/`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `u/${username}`;
    const activity = document.createElement("span");
    activity.className = "account-status";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");
    activity.append(dot, "Watching new posts and comments");
    copy.append(link, activity);

    const remove = document.createElement("button");
    remove.className = "remove-account";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Stop following u/${username}`;
    remove.setAttribute("aria-label", `Stop following u/${username}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      const response = await send({ type: "UNHIDE_WATCH_REMOVE", username });
      if (response?.ok) {
        renderFollowing(response.watchlist || []);
        setStatus(document.getElementById("watch-status"), `Stopped following u/${username}.`);
      } else {
        remove.disabled = false;
        setStatus(
          document.getElementById("watch-status"),
          `Could not remove u/${username}.`,
          true
        );
      }
    });

    row.append(avatar, copy, remove);
    list.appendChild(row);
  }
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const status = document.getElementById("settings-status");
  button.disabled = true;
  button.textContent = "Saving…";

  const response = await send({
    type: "UNHIDE_SETTINGS_SET",
    downloadFolder: document.getElementById("download-folder").value,
    interval: Number(document.getElementById("interval").value),
  });

  button.disabled = false;
  button.textContent = "Save settings";
  if (response?.ok) {
    document.getElementById("download-folder").value = response.downloadFolder;
    setStatus(status, "Settings saved.");
  } else {
    const message =
      response?.error === "INVALID_DOWNLOAD_FOLDER"
        ? "Use a relative folder name without .. or special filename characters."
        : "Could not save settings.";
    setStatus(status, message, true);
  }
});

document.getElementById("watch-add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("watch-username");
  const username = cleanUsername(input.value);
  if (!username) return;

  const button = event.currentTarget.querySelector('button[type="submit"]');
  const status = document.getElementById("watch-status");
  button.disabled = true;
  button.textContent = "Following…";
  setStatus(status, "");

  const response = await send({ type: "UNHIDE_WATCH_ADD", username });
  button.disabled = false;
  button.textContent = "Follow account";
  if (response?.ok) {
    input.value = "";
    renderFollowing(response.watchlist || []);
    setStatus(status, `Now following u/${username}.`);
  } else {
    setStatus(status, `Could not follow u/${username}. Check the username and try again.`, true);
  }
});

(async () => {
  const response = await send({ type: "UNHIDE_WATCH_GET" });
  if (!response?.ok) {
    setStatus(document.getElementById("settings-status"), "Could not load settings.", true);
    return;
  }
  document.getElementById("download-folder").value = response.downloadFolder || "Unhideddit";
  document.getElementById("interval").value = String(response.interval || 1);
  renderFollowing(response.watchlist || []);
})();
