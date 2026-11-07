# chrome-extensions

Personal collection of Chrome extensions with CLI installers, distributed via Homebrew.

## Install the tap

```bash
brew tap rajeshfintech/tools
```

---

## Extensions

### `tab-auto-grouper`

Automatically groups Chrome tabs by URL and title rules. Config is a YAML file you own — `brew upgrade` never touches it. Rules can also be added straight from the toolbar popup.

```bash
brew install rajeshfintech/tools/tab-auto-grouper
tabgroups install        # one-time Chrome setup per profile
tabgroups config         # edit grouping rules in $EDITOR
tabgroups sync           # validate + apply config changes to the extension
```

### `auto-tab-closer`

Automatically closes Chrome tabs that have been logged out (AWS, Google, GitHub, Microsoft, Slack, etc.). Detects the redirect to a login page and starts an idle timer. Focusing the tab resets the timer; navigating away (e.g. after re-logging in) cancels it; a tab that is in front when the timer fires is never closed. You get a notification a minute before, can pause everything from the popup, and can reopen anything it closed.

```bash
brew install rajeshfintech/tools/auto-tab-closer
tabclose install         # one-time Chrome setup per profile
tabclose config          # edit idle_minutes and login-page patterns
tabclose sync            # validate + push config changes to the extension
```

---

## One-time Chrome setup (per profile)

`tabgroups install` and `tabclose install` only copy files to disk. Chrome does not pick them up until you load each extension once, in each Chrome profile where you want it:

1. Open Chrome with that profile active
2. Go to `chrome://extensions`
3. Enable **Developer mode** (toggle, top-right)
4. Click **Load unpacked**, press **Cmd+Shift+G**, paste the folder for the extension, press Enter, then click **Select**:

| Extension | Folder to load |
|---|---|
| Tab Auto Grouper | `~/Library/Application Support/chrome-tab-grouper/extension` |
| Auto Tab Closer | `~/Library/Application Support/auto-tab-closer/extension` |

Each extension is loaded separately: loading Tab Auto Grouper does not add Auto Tab Closer. `~/Library` is hidden in the macOS file picker, which is why Cmd+Shift+G is the easy way in. `tabgroups status` / `tabclose status` print the same folder.

**Extension missing from `chrome://extensions`?** It was never loaded in that profile (or was removed). Repeat step 4 with its folder. If the card appears but is greyed out or shows an error, check `chrome://policy`: a managed (work) profile can restrict extensions.

Set `NO_BROWSER=1` to stop the CLIs from opening Chrome windows (CI does this automatically). Chrome remembers the extension across restarts. After a `brew upgrade`, run the install command again. From v1.2.1 each extension notices its files were replaced and reloads itself within a few seconds of its next tab event; if a popup ever shows **Reload extension**, click it. Upgrading from 1.2.0 or older needs one manual click on the **↺ reload** icon in `chrome://extensions`. `status` and `sync` warn you when the installed extension is older than the one the CLI ships.

---

## tab-auto-grouper — details

### CLI reference

| Command | Description |
|---|---|
| `tabgroups install` | Copy extension and guide Chrome setup for all profiles |
| `tabgroups install --profile "Profile 2"` | Install for a specific profile only |
| `tabgroups sync` | Validate config and apply it to the running extension |
| `tabgroups validate` | Check `config.yaml` without writing anything |
| `tabgroups config` | Open `config.yaml` in `$EDITOR` |
| `tabgroups remove` | Remove the installed extension files |
| `tabgroups list-profiles` | List Chrome profiles on this machine |
| `tabgroups status` | Show paths, versions, and installation status |

### Configuration

Your config lives at `~/.config/tab-auto-grouper/config.yaml`. Created automatically on first run, **never modified by `brew upgrade`**.

```yaml
version: 1
sort_groups: true        # keep managed groups in this order, left to right
dedupe_tabs: false       # focus an existing tab instead of opening a duplicate

# Tabs matching any rule here are never grouped
exclude:
  - domain: example.com

groups:
  - name: "Work"
    color: blue          # grey | blue | red | yellow | green | pink | purple | cyan | orange
    collapsed: false
    rules:
      - domain: github.com          # matches github.com and *.github.com
      - domain: jira.atlassian.net
      - title: "[JIRA]"             # tab title contains this text

  - name: "Docs"
    color: green
    priority: 10                    # optional: these rules win even when shorter
    rules:
      - path: docs.google.com/document     # matches hostname + path prefix
      - pattern: "^https://[^/]+\\.notion\\.site/"   # regex on the full URL
```

**Rule types** (one key per rule, usable in `groups` and `exclude`):

| Type | Example | Matches |
|---|---|---|
| `domain` | `github.com` | `github.com`, `api.github.com`, `gist.github.com` |
| `path` | `docs.google.com/spreadsheets` | URLs whose `host/path` starts with that value |
| `pattern` | `^https://[^/]+\.okta\.com/` | Case-insensitive regex on the full URL |
| `title` | `[JIRA]` | Case-insensitive substring of the tab title |

Leading `www.` is stripped automatically on both sides.

**Precedence.** When several rules match, the longest matching rule wins, so `domain: gemini.google.com` beats `domain: google.com` no matter which group lists it. Ties keep config order. A group with `priority: N` beats any group with a lower priority regardless of rule length. Rules in `exclude` win outright.

**Pinned tabs** are never grouped. Tabs in groups whose name is not in your config are never touched.

### Popup

- **Group all open tabs** / **Reload Config** / **Collapse All** (also `Alt+Shift+G`, configurable at `chrome://extensions/shortcuts`)
- Each group shows a live tab count.
- **Add current site to group** adds a `domain` rule for the active tab to the chosen group without editing YAML. These rules are stored in the extension (`chrome.storage.local`), merged with `config.yaml`, and survive `sync` and upgrades. Remove them with **×**.
- **Copy current groups as YAML** turns whatever groups you have built by hand in Chrome into `config.yaml` text on the clipboard, so you can bootstrap a config from real usage.

### How config updates flow

```
~/.config/tab-auto-grouper/config.yaml   ← edit this
         │
         │  tabgroups sync   (validates first)
         ▼
~/Library/Application Support/chrome-tab-grouper/extension/config.json
         │
         │  picked up on the next tab navigation, or instantly via "Reload Config"
         ▼
      Chrome extension   → regroups every open tab once per config change
```

### Permissions

`tabs`, `tabGroups`, `storage` — no host permissions, no network requests, no page content access.

---

## auto-tab-closer — details

### CLI reference

| Command | Description |
|---|---|
| `tabclose install` | Copy extension and guide Chrome setup for all profiles |
| `tabclose install --profile "Profile 2"` | Install for a specific profile only |
| `tabclose sync` | Validate config and push it to the running extension |
| `tabclose validate` | Check `config.json` without writing anything |
| `tabclose config` | Open `config.json` in `$EDITOR` |
| `tabclose config --merge-defaults` | Append login-page patterns added in newer releases to your config |
| `tabclose remove` | Remove the installed extension files |
| `tabclose list-profiles` | List Chrome profiles on this machine |
| `tabclose status` | Show paths, versions, and installation status |

### Configuration

Your config lives at `~/.config/auto-tab-closer/config.json`. Created automatically on first run, **never modified by `brew upgrade`**. When a release adds new default patterns, `tabclose status` tells you and `tabclose config --merge-defaults` appends them.

```json
{
  "idle_minutes": 10,
  "warn_minutes": 1,
  "patterns": [
    { "name": "AWS",       "path": "signin.aws.amazon.com" },
    { "name": "Google",    "path": "accounts.google.com/signin" },
    { "name": "GitHub",    "path": "github.com/login" },
    { "name": "Microsoft", "domain": "login.microsoftonline.com" },
    { "name": "Slack",     "path": "slack.com/signin", "idle_minutes": 30 },
    { "name": "Okta",      "pattern": "^https://[^/]+\\.okta\\.com/login" }
  ]
}
```

- `idle_minutes` — default countdown. Any pattern can override it with its own `idle_minutes`.
- `warn_minutes` — show a notification this many minutes before closing (`0` disables). The notification's **Keep open** button cancels the close; clicking the notification focuses the tab, which resets the timer.
- `patterns` — each entry has a `name` and exactly one rule: `domain`, `path`, `pattern` (regex), `title`, or `match` (raw URL substring). Same rule syntax as tab-auto-grouper; the most specific matching pattern wins.

### How the idle timer works

```
Tab navigates to a login page
         │
         │  idle_minutes countdown starts (reloads do NOT restart it)
         ▼
  User focuses the tab? ──yes──► timer resets
         │
         │ no — timer expires
         ▼
  User navigated away? ──yes──► timer was cancelled
         │
         │ no
         ▼
  Tab is active and window focused? ──yes──► timer restarts (never closes what you are looking at)
         │
         │ no
         ▼
      Tab is closed and added to "Recently closed"
```

Every browser start wipes stale timers and rescans open tabs, because Chrome reuses tab IDs across sessions.

### Popup

- Pending tabs with live countdowns and a **Keep** button each; **Cancel All**.
- **Pause** clears every timer and stops new ones until you **Resume** (badge shows `II`). Resuming rescans open tabs.
- **Reload Config** re-reads config, re-arms pending timers with the new `idle_minutes`, and rescans.
- **Watched links**: **+ Watch current tab** adds a `path` rule for the active tab; **Add** takes any URL substring (e.g. `example.com/dashboard`). These live in `chrome.storage.local` and survive `sync` and upgrades.
- **Recently closed**: the last 20 tabs it closed, with **Reopen**.

### Permissions

`tabs`, `storage`, `alarms`, `notifications` — no host permissions, no network requests, no page content access.

---

## What survives `brew upgrade`

| Path | Safe on upgrade? |
|---|---|
| `~/.config/tab-auto-grouper/config.yaml` | **Never touched** |
| `~/.config/auto-tab-closer/config.json` | **Never touched** |
| `~/Library/Application Support/chrome-tab-grouper/` | **Never touched** |
| `~/Library/Application Support/auto-tab-closer/` | **Never touched** |
| Rules and watched links added from the popups | **Never touched** (extension storage) |

After upgrading either extension, run `tabgroups install` / `tabclose install` to refresh the extension files, then reload in Chrome.

---

## Development

```bash
node --test tests/                           # rule matcher tests
python3 -m unittest discover -s tests -v     # CLI config validation tests
uvx ruff check .                             # lint
python3 tests/test_cli.py --regen            # regenerate the bundled tab-auto-grouper/extension/config.json after editing config.yaml
CHROME_BIN=/path/to/chromium node tests/smoke.mjs   # end-to-end: loads both extensions in a real browser (local only)
CHROME_BIN=/path/to/chromium node tests/upgrade.mjs ...   # upgrade path: stale-worker banner and self-reload (see file header)
```

The smoke test needs a Chromium or Chrome for Testing binary (Playwright's cached one works); Google Chrome itself ignores `--load-extension` since v137.

### GitHub Actions

Every pull request runs three workflows; all actions are pinned to commit SHAs.

| Workflow | What it checks |
|---|---|
| `validate` | JS syntax, `node --test` matcher tests, ruff, `unittest` CLI tests, the two `rules.js` copies are identical, both CLIs start and validate their default configs |
| `security` | Extension permission invariant (`tests/check_manifests.py`: no new permissions, host permissions, content scripts, remote code or relaxed CSP), TruffleHog verified-secret scan, ruff security rules, Semgrep (`p/javascript`, `p/python`, `p/secrets`), CodeQL for JavaScript and Python. Also runs weekly. |
| `integration` | Loads both extensions into Chrome for Testing on Linux and drives them end to end (`tests/smoke.mjs`), then checks the upgrade path from the previous releases (`tests/upgrade.mjs`); runs the full `install → validate → sync → status → remove` CLI flow for both tools on a macOS runner, including bad-config rejection, version-drift warning and `--merge-defaults`. |

Both extensions share `extension/rules.js`; edit the copy in `tab-auto-grouper` and copy it over, the test suite fails if they differ. CI runs all of the above on every push and PR.

## Project structure

```
chrome-extensions/
├── tab-auto-grouper/
│   ├── extension/          Chrome extension source (MV3, ES modules)
│   │   ├── manifest.json
│   │   ├── background.js   Service worker — groups tabs, merges popup rules
│   │   ├── rules.js        Shared rule matcher (identical copy in auto-tab-closer)
│   │   ├── self-update.js  Shared: reload when installed files change (identical copy)
│   │   ├── popup.html/js   Toolbar popup
│   │   ├── config.json     Bundled default, generated from config.yaml
│   │   └── icons/
│   ├── config.yaml         Default config template
│   ├── cli.py              tabgroups CLI
│   └── generate_icons.py
├── auto-tab-closer/
│   ├── extension/          Chrome extension source (MV3, ES modules)
│   │   ├── manifest.json
│   │   ├── background.js   Service worker — detects login redirects, manages alarms
│   │   ├── rules.js        Shared rule matcher
│   │   ├── self-update.js  Shared self-reload after install
│   │   ├── popup.html/js   Toolbar popup with live countdown
│   │   ├── config.json     Bundled default config (patterns + idle_minutes)
│   │   └── icons/
│   ├── cli.py              tabclose CLI
│   └── generate_icons.py
├── tests/                  node --test + unittest
├── .github/workflows/ci.yml
└── LICENSE
```
