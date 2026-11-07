#!/usr/bin/env python3
"""
tabclose — Auto Tab Closer CLI

Commands:
  install               Copy extension to ~/Library/Application Support and guide Chrome setup
  install --profile P   Install for a specific profile (folder name, e.g. "Default")
  remove                Remove installed extension files
  status                Show paths and installation status
  list-profiles         List Chrome profiles on this machine
  config                Open config.json in $EDITOR
  config --merge-defaults
                        Append login-page patterns added in newer releases to your config
  validate              Check config.json for errors without writing anything
  sync                  Push ~/.config/auto-tab-closer/config.json into the installed extension
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR         = Path(__file__).parent.resolve()
EXTENSION_TEMPLATE = SCRIPT_DIR / 'extension'
DEFAULT_CONFIG     = EXTENSION_TEMPLATE / 'config.json'

USER_CONFIG_DIR    = Path.home() / '.config' / 'auto-tab-closer'
USER_CONFIG_JSON   = USER_CONFIG_DIR / 'config.json'

INSTALL_PATH       = Path.home() / 'Library' / 'Application Support' / 'auto-tab-closer'
INSTALLED_EXT      = INSTALL_PATH / 'extension'
INSTALLED_CONFIG   = INSTALLED_EXT / 'config.json'

CHROME_DIR         = Path.home() / 'Library' / 'Application Support' / 'Google' / 'Chrome'
CHROME_BINARY      = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

RULE_KEYS = ('domain', 'path', 'match', 'pattern', 'title')

# Python's `re` accepts syntax that JavaScript's RegExp rejects or reads
# differently; the extension compiles `pattern` rules as a JavaScript RegExp.
JS_INCOMPATIBLE_REGEX = (
    (re.compile(r'\(\?P[<=]'), 'named groups must be (?<name>...) not (?P<name>...)'),
    (re.compile(r'\(\?[a-zA-Z]+\)'), 'inline flags like (?i) are not supported; patterns are already case-insensitive'),
    (re.compile(r'\\[AZ]'), r'\A and \Z are not supported; use ^ and $'),
    (re.compile(r'[+*?}]\+'), 'possessive quantifiers (++, *+, ?+) are not supported'),
    (re.compile(r'\(\?#'), 'comments (?#...) are not supported'),
)


def check_js_regex(value):
    """Return an error string if `value` will not compile or behave the same as a JS RegExp."""
    for needle, why in JS_INCOMPATIBLE_REGEX:
        if needle.search(value):
            return f'regex uses Python-only syntax ({why})'
    # JS named groups are (?<name>...); Python spells them (?P<name>...).
    # Translate before compiling (lookbehinds (?<= / (?<! are untouched).
    try:
        re.compile(re.sub(r'\(\?<([A-Za-z_])', r'(?P<\1', value))
    except re.error as e:
        return f'invalid regex: {e}'
    return None

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ok(msg):   print(f'  ✓  {msg}')
def err(msg):  print(f'  ✗  {msg}')
def info(msg): print(f'     {msg}')


def ensure_user_config():
    """Copy the bundled default config.json to ~/.config/auto-tab-closer/ on first run."""
    if USER_CONFIG_JSON.exists():
        return
    USER_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(DEFAULT_CONFIG, USER_CONFIG_JSON)
    ok(f'Created your config at {USER_CONFIG_JSON}')
    info('Edit it anytime with:  tabclose config')
    print()


def rule_key(pattern):
    """Stable identity of a pattern entry: the first rule key and its value."""
    for k in RULE_KEYS:
        v = pattern.get(k) if isinstance(pattern, dict) else None
        if v:
            return f'{k}:{str(v).strip().lower()}'
    return ''


def validate_config(cfg):
    """Return a list of human-readable problems; empty means the config is usable."""
    errors = []
    if not isinstance(cfg, dict):
        return ['config must be a JSON object']

    for key in ('idle_minutes', 'warn_minutes'):
        if key in cfg:
            v = cfg[key]
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                errors.append(f'{key}: must be a number')
            elif key == 'idle_minutes' and v <= 0:
                errors.append('idle_minutes: must be greater than 0')
            elif key == 'warn_minutes' and v < 0:
                errors.append('warn_minutes: must be 0 or more (0 disables the warning)')

    patterns = cfg.get('patterns')
    if not isinstance(patterns, list):
        errors.append('patterns: must be a list')
        return errors

    seen = set()
    for i, p in enumerate(patterns):
        label = f'patterns[{i}]'
        if not isinstance(p, dict):
            errors.append(f'{label}: must be an object')
            continue
        name = p.get('name')
        if not isinstance(name, str) or not name.strip():
            errors.append(f'{label}: name is required')
        else:
            label = f'patterns["{name}"]'
        keys = [k for k in RULE_KEYS if p.get(k)]
        if len(keys) != 1:
            errors.append(f'{label}: exactly one of {list(RULE_KEYS)} is required')
            continue
        value = p[keys[0]]
        if not isinstance(value, str) or not value.strip():
            errors.append(f'{label}: {keys[0]} must be a non-empty string')
        elif keys[0] == 'pattern':
            problem = check_js_regex(value)
            if problem:
                errors.append(f'{label}: {problem}')
        if 'idle_minutes' in p and (isinstance(p['idle_minutes'], bool)
                                    or not isinstance(p['idle_minutes'], (int, float))
                                    or p['idle_minutes'] <= 0):
            errors.append(f'{label}: idle_minutes must be a number greater than 0')
        key = rule_key(p)
        if key in seen:
            errors.append(f'{label}: duplicate of an earlier pattern ({key})')
        seen.add(key)
    return errors


def load_json(path):
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        err(f'Invalid JSON in {path}: {e}')
        sys.exit(1)


def load_user_config():
    cfg = load_json(USER_CONFIG_JSON)
    errors = validate_config(cfg)
    if errors:
        err(f'{USER_CONFIG_JSON} has {len(errors)} problem(s):')
        for e in errors:
            info(f'- {e}')
        sys.exit(1)
    return cfg


def read_version(ext_dir):
    try:
        return json.loads((ext_dir / 'manifest.json').read_text()).get('version')
    except (OSError, ValueError):
        return None


def warn_if_outdated():
    template, installed = read_version(EXTENSION_TEMPLATE), read_version(INSTALLED_EXT)
    if template and installed and template != installed:
        err(f'Installed extension is v{installed}, this CLI ships v{template}.')
        info('Run:  tabclose install   then reload the extension in chrome://extensions')
        print()


def get_profiles():
    profiles = []
    local_state = CHROME_DIR / 'Local State'
    if local_state.exists():
        try:
            state = json.loads(local_state.read_text())
            for folder, pinfo in state.get('profile', {}).get('info_cache', {}).items():
                p = CHROME_DIR / folder
                if p.exists():
                    profiles.append({'folder': folder,
                                     'name': pinfo.get('name', folder),
                                     'path': p})
        except Exception:
            pass
    if not profiles and CHROME_DIR.exists():
        for p in sorted(CHROME_DIR.iterdir()):
            if p.is_dir() and (p.name == 'Default' or p.name.startswith('Profile ')):
                profiles.append({'folder': p.name, 'name': p.name, 'path': p})
    return profiles


def open_chrome_for_profile(folder):
    if Path(CHROME_BINARY).exists():
        subprocess.Popen([CHROME_BINARY, f'--profile-directory={folder}', 'chrome://extensions'])
    else:
        subprocess.run(['open', '-a', 'Google Chrome', 'chrome://extensions'], check=False)


def open_chrome_extensions():
    subprocess.run(['open', '-a', 'Google Chrome', 'chrome://extensions'], check=False)

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_install(args):
    ensure_user_config()
    load_user_config()

    if INSTALLED_EXT.exists():
        shutil.rmtree(INSTALLED_EXT)
    shutil.copytree(EXTENSION_TEMPLATE, INSTALLED_EXT)
    ok(f'Extension v{read_version(INSTALLED_EXT)} installed at {INSTALLED_EXT}')

    shutil.copy(USER_CONFIG_JSON, INSTALLED_CONFIG)
    ok('config.json applied')

    all_profiles = get_profiles()
    if args.profile:
        targets = [p for p in all_profiles
                   if p['folder'] == args.profile or p['name'] == args.profile]
        if not targets:
            err(f"Profile '{args.profile}' not found.")
            cmd_list_profiles(None)
            sys.exit(1)
    else:
        targets = all_profiles

    print(f'\n  Target profile(s): {len(targets)} found')
    print(f"""
  ── One-time setup per profile ───────────────────────────────────────────
    1. Enable  "Developer mode"  (top-right toggle)
    2. Click   "Load unpacked"
    3. Select:  {INSTALLED_EXT}
  Chrome remembers the extension across restarts once loaded.
  Already loaded?  Just click the reload icon (↺) on the extension card.
  ─────────────────────────────────────────────────────────────────────────
""")

    for i, p in enumerate(targets):
        print(f'  [{i+1}/{len(targets)}] Opening Chrome — {p["name"]}  ({p["folder"]})')
        open_chrome_for_profile(p['folder'])
        if i < len(targets) - 1:
            time.sleep(1)


def cmd_remove(_args):
    if INSTALL_PATH.exists():
        shutil.rmtree(INSTALL_PATH)
        ok(f'Removed {INSTALL_PATH}')
    else:
        info('Nothing to remove (not installed).')
    print()
    info('To also remove from Chrome: chrome://extensions → Remove')
    open_chrome_extensions()


def cmd_status(_args):
    print('  Paths:')
    info(f'Extension template  : {EXTENSION_TEMPLATE}  (v{read_version(EXTENSION_TEMPLATE)})')
    info(f'User config         : {USER_CONFIG_JSON}')
    info(f'Installed extension : {INSTALLED_EXT}')
    info(f'Installed config    : {INSTALLED_CONFIG}')
    print()

    if INSTALLED_EXT.exists():
        ok(f'Extension installed (v{read_version(INSTALLED_EXT)})')
    else:
        err('Extension not installed  →  run: tabclose install')

    if USER_CONFIG_JSON.exists():
        mtime = datetime.fromtimestamp(USER_CONFIG_JSON.stat().st_mtime)
        cfg = load_json(USER_CONFIG_JSON)
        ok(f'User config last edited: {mtime:%Y-%m-%d %H:%M:%S}')
        info(f'idle_minutes={cfg.get("idle_minutes", "?")}  '
             f'warn_minutes={cfg.get("warn_minutes", "?")}  patterns={len(cfg.get("patterns", []))}')
        missing = missing_defaults(cfg)
        if missing:
            info(f'{len(missing)} newer default pattern(s) not in your config  →  tabclose config --merge-defaults')
    else:
        info('No user config yet — will be created on first command')

    if INSTALLED_CONFIG.exists():
        mtime = datetime.fromtimestamp(INSTALLED_CONFIG.stat().st_mtime)
        ok(f'Installed config last synced: {mtime:%Y-%m-%d %H:%M:%S}')
        if USER_CONFIG_JSON.exists() and USER_CONFIG_JSON.stat().st_mtime > INSTALLED_CONFIG.stat().st_mtime:
            err('config.json in ~/.config is newer than the installed one  →  run: tabclose sync')
    else:
        err('config.json missing  →  run: tabclose install  or  tabclose sync')

    print()
    warn_if_outdated()
    cmd_list_profiles(None)


def cmd_list_profiles(_args):
    profiles = get_profiles()
    if not profiles:
        err('No Chrome profiles found')
        return
    print(f'  Chrome profiles  ({CHROME_DIR}):')
    for p in profiles:
        print(f'    {p["folder"]:20}  {p["name"]}')


def missing_defaults(cfg):
    """Default patterns (from the bundled config) that the user's config lacks."""
    defaults = load_json(DEFAULT_CONFIG).get('patterns', [])
    have = {rule_key(p) for p in cfg.get('patterns', []) if isinstance(p, dict)}
    return [p for p in defaults if rule_key(p) not in have]


def cmd_config(args):
    ensure_user_config()
    if args.merge_defaults:
        cfg = load_user_config()
        missing = missing_defaults(cfg)
        if not missing:
            ok('Your config already has every default pattern.')
            return
        print(f'  Adding {len(missing)} pattern(s) from the bundled defaults:')
        for p in missing:
            info(f'{p["name"]:14} {rule_key(p)}')
        cfg.setdefault('patterns', []).extend(missing)
        USER_CONFIG_JSON.write_text(json.dumps(cfg, indent=2) + '\n')
        print()
        ok(f'Updated {USER_CONFIG_JSON}')
        info('Run:  tabclose sync   to push it to the extension')
        return
    editor = shlex.split(os.environ.get('EDITOR') or 'nano')
    # $EDITOR is the user's own choice on their own machine; this is the standard
    # `git config`-style editor hand-off, not untrusted input.
    subprocess.run([*editor, str(USER_CONFIG_JSON)])  # nosemgrep


def cmd_validate(_args):
    ensure_user_config()
    cfg = load_user_config()
    ok(f'{USER_CONFIG_JSON} is valid: {len(cfg.get("patterns", []))} pattern(s), '
       f'idle {cfg.get("idle_minutes", 10)} min')


def cmd_sync(_args):
    ensure_user_config()
    if not INSTALLED_EXT.exists():
        err('Extension not installed yet. Run:  tabclose install')
        sys.exit(1)

    cfg = load_user_config()
    INSTALLED_CONFIG.write_text(json.dumps(cfg, indent=2) + '\n')
    ok(f'Synced {USER_CONFIG_JSON}')
    ok(f'     → {INSTALLED_CONFIG}')
    print()
    info(f'idle_minutes : {cfg.get("idle_minutes", 10)}')
    info(f'warn_minutes : {cfg.get("warn_minutes", 1)}')
    info(f'patterns     : {len(cfg.get("patterns", []))} site(s)')
    print()
    info('New patterns apply within a few seconds. Timers already running keep')
    info('the old idle_minutes until you click "Reload Config" in the popup.')
    print()
    warn_if_outdated()

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog='tabclose',
        description='Auto Tab Closer — CLI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest='cmd', metavar='command')

    p_install = sub.add_parser('install', help='Install extension to Chrome profile(s)')
    p_install.add_argument('--profile', metavar='NAME',
                           help='Profile folder name (e.g. Default, "Profile 2")')

    sub.add_parser('remove',        help='Remove installed extension files')
    sub.add_parser('status',        help='Show paths and installation status')
    sub.add_parser('list-profiles', help='List Chrome profiles')
    p_config = sub.add_parser('config', help='Open config.json in $EDITOR')
    p_config.add_argument('--merge-defaults', action='store_true',
                          help='Append bundled default patterns missing from your config')
    sub.add_parser('validate',      help='Check config.json for errors')
    sub.add_parser('sync',          help='Push ~/.config/auto-tab-closer/config.json to installed extension')

    args = parser.parse_args()
    dispatch = {
        'install':       cmd_install,
        'remove':        cmd_remove,
        'status':        cmd_status,
        'list-profiles': cmd_list_profiles,
        'config':        cmd_config,
        'validate':      cmd_validate,
        'sync':          cmd_sync,
    }
    if args.cmd in dispatch:
        dispatch[args.cmd](args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
