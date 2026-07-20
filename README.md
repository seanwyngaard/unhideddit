# Unhideddit 🕵️

A browser extension that shows a Reddit user's **public** posts and comments even when their profile looks empty — instantly, with no waiting.

Open any Reddit profile, click the 🕵️ button, and Unhideddit surfaces the account's public posts and comments right in a side panel, with images inline. It can also back up a profile to your computer and watch accounts to auto-save new posts as they happen.

> Unhideddit only ever shows content that is **already public**. It does not bypass privacy settings, private accounts, suspensions, or bans.

## Supported browsers

Works on any **Chromium-based browser** — **Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi**, and other Chromium builds. It also loads in **Firefox** as a temporary add-on.

**Operating systems:** cross-platform — **Windows, macOS, and Linux** (anywhere Chrome runs, including ChromeOS).

## Install

### Chrome / Edge / Brave / other Chromium

1. Download the latest `unhideddit.zip` from the [Releases](../../releases) page and unzip it (or clone this repo).
2. Go to `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped `unhideddit` folder (the one containing `manifest.json`).
5. Pin the 🕵️ icon to your toolbar if you like.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select the `manifest.json` file. (Temporary add-ons are removed when Firefox restarts.)

## How to use

- **View a profile:** open any `reddit.com/user/<name>` page and click the floating 🕵️ button (bottom-right) to open the panel. Switch between **Posts** and **Comments**, sort, filter, and toggle an NSFW filter. Click **⛶** for a full-page view.
- **Back up a profile:** click **📸 Snapshot** to save all of a user's posts, comments, and media to `Downloads/Unhideddit/<user>/`, plus a browsable `index.html`.
- **Watch accounts:** click **👁 Watch** on a profile (or add usernames from the toolbar popup). While your browser is open, Unhideddit checks watched accounts on a set interval and auto-saves any **new** posts/comments and media to `Downloads/Unhideddit/<user>/watch/`. Manage the watch list from the popup or the panel.

## How it works (short version)

Unhideddit fetches a user's public activity live from Reddit's public endpoints and public Reddit archives, then merges the results so posts missing from one source are filled in by another. Everything runs locally in your browser — there is no Unhideddit server, and nothing is sent anywhere except the requests your browser makes to Reddit and the public archives.

## Privacy

- No account, no login to the extension, no analytics, no external server.
- Requests go only to Reddit and public archive services.
- Snapshots and watch-list saves are written to your own `Downloads` folder.

## License

MIT — see [LICENSE](LICENSE).
