#!/usr/bin/env python3
"""
tabgroups — Chrome Tab Auto Grouper CLI

Commands:
  sync                  Sync ~/.config/tab-auto-grouper/config.yaml → installed extension
  validate              Check config.yaml for errors without writing anything
  config                Open config.yaml in $EDITOR
  install               Copy extension to ~/Library/Application Support and guide Chrome setup
  install --profile P   Install for a specific profile (folder name, e.g. "Default")
  remove                Remove installed extension files
  list-profiles         List Chrome profiles on this machine
  status                Show paths and installation status
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
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Template files: live next to cli.py.
# Read-only when installed via Homebrew (in libexec); writable in dev checkout.
SCRIPT_DIR         = Path(__file__).parent.resolve()
EXTENSION_TEMPLATE = SCRIPT_DIR / 'extension'
CONFIG_TEMPLATE    = SCRIPT_DIR / 'config.yaml'

# User-owned config: never touched by brew upgrade or brew reinstall.
USER_CONFIG_DIR    = Path.home() / '.config' / 'tab-auto-grouper'
CONFIG_YAML        = USER_CONFIG_DIR / 'config.yaml'

# Installed extension: writable copy managed by `tabgroups install / sync`.
INSTALL_PATH       = Path.home() / 'Library' / 'Application Support' / 'chrome-tab-grouper'
INSTALLED_EXT      = INSTALL_PATH / 'extension'
CONFIG_JSON        = INSTALLED_EXT / 'config.json'

CHROME_DIR         = Path.home() / 'Library' / 'Application Support' / 'Google' / 'Chrome'
CHROME_BINARY      = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

VALID_COLORS = {'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'}
RULE_KEYS    = ('domain', 'path', 'pattern', 'title')

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


def require_yaml():
    try:
        import yaml
        return yaml
    except ImportError:
        print('PyYAML is required.  Install with:  pip install pyyaml')
        sys.exit(1)


def ensure_user_config():
    """Copy the default template to ~/.config/tab-auto-grouper/config.yaml on first run."""
    if CONFIG_YAML.exists():
        return
    USER_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(CONFIG_TEMPLATE, CONFIG_YAML)
    ok(f'Created your config at {CONFIG_YAML}')
    info('Edit it anytime with:  tabgroups config')
    print()


def validate_rules(rules, where, errors):
    if rules is None:
        return
    if not isinstance(rules, list):
        errors.append(f'{where}: must be a list of rules')
        return
    for i, rule in enumerate(rules):
        label = f'{where}[{i}]'
        if not isinstance(rule, dict):
            errors.append(f'{label}: must be a mapping like `- domain: example.com`')
            continue
        keys = [k for k in RULE_KEYS if rule.get(k)]
        unknown = [k for k in rule if k not in RULE_KEYS]
        if unknown:
            errors.append(f'{label}: unknown key(s) {unknown}; use one of {list(RULE_KEYS)}')
        if len(keys) != 1:
            errors.append(f'{label}: exactly one of {list(RULE_KEYS)} is required')
            continue
        value = rule[keys[0]]
        if not isinstance(value, str) or not value.strip():
            errors.append(f'{label}: {keys[0]} must be a non-empty string')
        elif keys[0] == 'pattern':
            problem = check_js_regex(value)
            if problem:
                errors.append(f'{label}: {problem}')


def validate_config(config):
    """Return a list of human-readable problems; empty means the config is usable."""
    errors = []
    if not isinstance(config, dict):
        return ['config must be a mapping with a `groups:` key']

    for key in ('sort_groups', 'dedupe_tabs'):
        if key in config and not isinstance(config[key], bool):
            errors.append(f'{key}: must be true or false')

    validate_rules(config.get('exclude'), 'exclude', errors)

    groups = config.get('groups')
    if not isinstance(groups, list):
        errors.append('groups: must be a list')
        return errors

    seen = set()
    for i, g in enumerate(groups):
        label = f'groups[{i}]'
        if not isinstance(g, dict):
            errors.append(f'{label}: must be a mapping')
            continue
        name = g.get('name')
        if not isinstance(name, str) or not name.strip():
            errors.append(f'{label}: name is required')
        else:
            label = f'groups["{name}"]'
            if name in seen:
                errors.append(f'{label}: duplicate group name')
            seen.add(name)
        color = g.get('color', 'grey')
        if color not in VALID_COLORS:
            errors.append(f'{label}: color "{color}" is not one of {sorted(VALID_COLORS)}')
        if 'collapsed' in g and not isinstance(g['collapsed'], bool):
            errors.append(f'{label}: collapsed must be true or false')
        if 'priority' in g and not isinstance(g['priority'], (int, float)):
            errors.append(f'{label}: priority must be a number')
        if not g.get('rules'):
            errors.append(f'{label}: needs at least one rule')
        validate_rules(g.get('rules'), f'{label}.rules', errors)
    return errors


def load_user_config():
    yaml = require_yaml()
    try:
        config = yaml.safe_load(CONFIG_YAML.read_text())
    except yaml.YAMLError as e:
        err(f'Invalid YAML in {CONFIG_YAML}:')
        info(str(e).replace('\n', '\n     '))
        sys.exit(1)
    errors = validate_config(config)
    if errors:
        err(f'{CONFIG_YAML} has {len(errors)} problem(s):')
        for e in errors:
            info(f'- {e}')
        sys.exit(1)
    return config


def write_config_json(config, dest):
    payload = dict(config)
    payload['generated_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    dest.write_text(json.dumps(payload, indent=2) + '\n')


def read_version(ext_dir):
    try:
        return json.loads((ext_dir / 'manifest.json').read_text()).get('version')
    except (OSError, ValueError):
        return None


def warn_if_outdated():
    """Tell the user when the installed extension is older than the one this CLI ships."""
    template, installed = read_version(EXTENSION_TEMPLATE), read_version(INSTALLED_EXT)
    if template and installed and template != installed:
        err(f'Installed extension is v{installed}, this CLI ships v{template}.')
        info('Run:  tabgroups install   then reload the extension in chrome://extensions')
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


def no_browser():
    """Skip launching Chrome in CI or when explicitly asked (NO_BROWSER=1)."""
    return bool(os.environ.get('CI') or os.environ.get('NO_BROWSER'))


def open_chrome_for_profile(folder):
    """Open chrome://extensions in a specific Chrome profile (never blocks)."""
    if no_browser():
        return
    if Path(CHROME_BINARY).exists():
        subprocess.Popen([CHROME_BINARY, f'--profile-directory={folder}', 'chrome://extensions'])
    else:
        subprocess.Popen(['open', '-a', 'Google Chrome', 'chrome://extensions'])


def open_chrome_extensions():
    if no_browser():
        return
    subprocess.Popen(['open', '-a', 'Google Chrome', 'chrome://extensions'])

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_sync(_args):
    ensure_user_config()
    if not INSTALLED_EXT.exists():
        err('Extension not installed yet. Run:  tabgroups install')
        sys.exit(1)

    config = load_user_config()
    write_config_json(config, CONFIG_JSON)
    ok(f'Synced {CONFIG_YAML}')
    ok(f'      → {CONFIG_JSON}')

    groups = config.get('groups', [])
    print(f'\n  {len(groups)} group(s):')
    for g in groups:
        print(f'    {g["name"]:20} color={g.get("color", "grey"):8} rules={len(g.get("rules", []))}')

    print()
    info('The extension applies the new config on the next tab navigation,')
    info('or immediately when you click "Reload Config" in the popup.')
    print()
    warn_if_outdated()


def cmd_validate(_args):
    ensure_user_config()
    config = load_user_config()
    ok(f'{CONFIG_YAML} is valid: {len(config.get("groups", []))} group(s)')


def cmd_config(_args):
    ensure_user_config()
    editor = shlex.split(os.environ.get('EDITOR') or 'nano')
    # $EDITOR is the user's own choice on their own machine; this is the standard
    # `git config`-style editor hand-off, not untrusted input.
    subprocess.run([*editor, str(CONFIG_YAML)])  # nosemgrep


def cmd_install(args):
    ensure_user_config()
    config = load_user_config()

    # Fresh copy of the extension template to the install location
    if INSTALLED_EXT.exists():
        shutil.rmtree(INSTALLED_EXT)
    shutil.copytree(EXTENSION_TEMPLATE, INSTALLED_EXT)
    ok(f'Extension v{read_version(INSTALLED_EXT)} installed at {INSTALLED_EXT}')

    write_config_json(config, CONFIG_JSON)
    ok('config.json generated')

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
            time.sleep(1)   # brief pause so Chrome finishes opening each window


def cmd_remove(_args):
    if INSTALL_PATH.exists():
        shutil.rmtree(INSTALL_PATH)
        ok(f'Removed {INSTALL_PATH}')
    else:
        info('Nothing to remove (not installed).')
    print()
    info('To also remove from Chrome: chrome://extensions → Remove')
    open_chrome_extensions()


def cmd_list_profiles(_args):
    profiles = get_profiles()
    if not profiles:
        err('No Chrome profiles found')
        return
    print(f'  Chrome profiles  ({CHROME_DIR}):')
    for p in profiles:
        print(f'    {p["folder"]:20}  {p["name"]}')


def cmd_status(_args):
    print('  Paths:')
    info(f'Extension template  : {EXTENSION_TEMPLATE}  (v{read_version(EXTENSION_TEMPLATE)})')
    info(f'User config         : {CONFIG_YAML}')
    info(f'Installed extension : {INSTALLED_EXT}')
    info(f'config.json         : {CONFIG_JSON}')
    print()

    if INSTALLED_EXT.exists():
        ok(f'Extension installed (v{read_version(INSTALLED_EXT)})')
    else:
        err('Extension not installed  →  run: tabgroups install')

    if CONFIG_YAML.exists():
        mtime = datetime.fromtimestamp(CONFIG_YAML.stat().st_mtime)
        ok(f'User config last edited: {mtime:%Y-%m-%d %H:%M:%S}')
    else:
        info('No user config yet — will be created on first command')

    if CONFIG_JSON.exists():
        mtime = datetime.fromtimestamp(CONFIG_JSON.stat().st_mtime)
        ok(f'config.json last synced: {mtime:%Y-%m-%d %H:%M:%S}')
        if CONFIG_YAML.exists() and CONFIG_YAML.stat().st_mtime > CONFIG_JSON.stat().st_mtime:
            err('config.yaml is newer than config.json  →  run: tabgroups sync')
    else:
        err('config.json missing  →  run: tabgroups install  or  tabgroups sync')

    print()
    warn_if_outdated()
    cmd_list_profiles(None)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog='tabgroups',
        description='Chrome Tab Auto Grouper — CLI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest='cmd', metavar='command')

    sub.add_parser('sync',          help='Sync config.yaml → config.json in installed extension')
    sub.add_parser('validate',      help='Check config.yaml for errors')
    sub.add_parser('config',        help='Open config.yaml in $EDITOR')
    sub.add_parser('remove',        help='Remove installed extension files')
    sub.add_parser('list-profiles', help='List Chrome profiles')
    sub.add_parser('status',        help='Show paths and installation status')

    p_install = sub.add_parser('install', help='Install extension to Chrome profile(s)')
    p_install.add_argument('--profile', metavar='NAME',
                           help='Profile folder name (e.g. Default, "Profile 2")')

    args = parser.parse_args()
    dispatch = {
        'sync':          cmd_sync,
        'validate':      cmd_validate,
        'config':        cmd_config,
        'install':       cmd_install,
        'remove':        cmd_remove,
        'list-profiles': cmd_list_profiles,
        'status':        cmd_status,
    }
    if args.cmd in dispatch:
        dispatch[args.cmd](args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
