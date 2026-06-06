# chrome-extensions

Personal collection of Chrome extensions with CLI installers, distributed via Homebrew.

## Install the tap

```bash
brew tap rajeshfintech/tools
```

---

## Extensions

### `tab-auto-grouper`

Automatically groups Chrome tabs by URL rules (domain or path prefix). Config is a YAML file you own — `brew upgrade` never touches it.

```bash
brew install rajeshfintech/tools/tab-auto-grouper
tabgroups install        # one-time Chrome setup per profile
tabgroups config         # edit grouping rules in $EDITOR
tabgroups sync           # apply config changes to the extension
```

### `auto-tab-closer`

Automatically closes Chrome tabs that have been logged out (AWS, Google, GitHub, Microsoft, Slack, etc.). Detects the redirect to a login page and starts a 10-minute idle timer. Focusing the tab resets the timer; navigating away (e.g. after re-logging in) cancels it.

```bash
brew install rajeshfintech/tools/auto-tab-closer
tabclose install         # one-time Chrome setup per profile
tabclose config          # edit idle_minutes and login-page patterns
tabclose sync            # push config changes to the extension
```

---

## One-time Chrome setup (per profile)

After `tabgroups install` or `tabclose install`, do this once for each Chrome profile:

1. Open Chrome with that profile active
2. Go to `chrome://extensions`
3. Enable **Developer mode** (toggle, top-right)
4. Click **Load unpacked** → select the path shown by the install command

Chrome remembers the extension across restarts. After a `brew upgrade`, click the **↺ reload** icon on the extension card in `chrome://extensions`.

---

## tab-auto-grouper — details

### CLI reference

| Command | Description |
|---|---|
| `tabgroups install` | Copy extension and guide Chrome setup for all profiles |
| `tabgroups install --profile "Profile 2"` | Install for a specific profile only |
| `tabgroups sync` | Apply config changes to the running extension |
| `tabgroups config` | Open `config.yaml` in `$EDITOR` |
| `tabgroups remove` | Remove the installed extension files |
| `tabgroups list-profiles` | List Chrome profiles on this machine |
| `tabgroups status` | Show paths and installation status |

### Configuration

Your config lives at `~/.config/tab-auto-grouper/config.yaml`. Created automatically on first run, **never modified by `brew upgrade`**.

```yaml
version: 1

# Tabs matching any rule here are never grouped
exclude:
  - domain: example.com

groups:
  - name: "Work"
    color: blue          # grey | blue | red | yellow | green | pink | purple | cyan
    collapsed: false
    rules:
      - domain: github.com          # matches github.com and *.github.com
      - domain: jira.atlassian.net

  - name: "Docs"
    color: green
    rules:
      - path: docs.google.com/document     # matches hostname + path prefix
      - path: docs.google.com/spreadsheets
```

**Rule types:**

| Type | Example | Matches |
|---|---|---|
| `domain` | `github.com` | `github.com`, `api.github.com`, `gist.github.com` |
| `path` | `docs.google.com/spreadsheets` | Only URLs whose `host/path` starts with that value |

Leading `www.` is stripped automatically on both sides.

### How config updates flow

```
~/.config/tab-auto-grouper/config.yaml   ← edit this
         │
         │  tabgroups sync
         ▼
~/Library/Application Support/tab-auto-grouper/extension/config.json
         │
         │  auto-detected within 5 s (no reload needed)
         ▼
      Chrome extension
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
| `tabclose sync` | Push config changes to the running extension |
| `tabclose config` | Open `config.json` in `$EDITOR` |
| `tabclose remove` | Remove the installed extension files |
| `tabclose list-profiles` | List Chrome profiles on this machine |
| `tabclose status` | Show paths and installation status |

### Configuration

Your config lives at `~/.config/auto-tab-closer/config.json`. Created automatically on first run, **never modified by `brew upgrade`**.

```json
{
  "idle_minutes": 10,
  "patterns": [
    { "name": "AWS",       "match": "signin.aws.amazon.com" },
    { "name": "Google",    "match": "accounts.google.com/signin" },
    { "name": "GitHub",    "match": "github.com/login" },
    { "name": "Microsoft", "match": "login.microsoftonline.com" },
    { "name": "Slack",     "match": "slack.com/signin" },
    { "name": "Okta",      "match": ".okta.com/login" }
  ]
}
```

Add any site by appending a pattern entry — `match` is a substring of the login page URL.

### How the idle timer works

```
Tab navigates to a login page
         │
         │  idle_minutes countdown starts
         ▼
  User focuses the tab? ──yes──► timer resets
         │
         │ no — timer expires
         ▼
  User navigates away? ──yes──► timer cancelled
         │
         │ no
         ▼
      Tab is closed
```

### Permissions

`tabs`, `storage`, `alarms`, `action` — no host permissions, no network requests, no page content access.

---

## What survives `brew upgrade`

| Path | Safe on upgrade? |
|---|---|
| `~/.config/tab-auto-grouper/config.yaml` | **Never touched** |
| `~/.config/auto-tab-closer/config.json` | **Never touched** |
| `~/Library/Application Support/tab-auto-grouper/` | **Never touched** |
| `~/Library/Application Support/auto-tab-closer/` | **Never touched** |

After upgrading either extension, run `tabgroups install` / `tabclose install` to refresh the extension files, then reload in Chrome.

---

## Project structure

```
chrome-extensions/
├── tab-auto-grouper/
│   ├── extension/          Chrome extension source (MV3)
│   │   ├── manifest.json
│   │   ├── background.js   Service worker — reads config.json, groups tabs
│   │   ├── popup.html/js   Toolbar popup
│   │   └── icons/
│   ├── config.yaml         Default config template
│   ├── cli.py              tabgroups CLI
│   └── generate_icons.py
├── auto-tab-closer/
│   ├── extension/          Chrome extension source (MV3)
│   │   ├── manifest.json
│   │   ├── background.js   Service worker — detects login redirects, manages alarms
│   │   ├── popup.html/js   Toolbar popup with live countdown
│   │   ├── config.json     Bundled default config (patterns + idle_minutes)
│   │   └── icons/
│   ├── cli.py              tabclose CLI
│   └── generate_icons.py
└── LICENSE
```
