#!/usr/bin/env python3
"""
tabgroups — Chrome Tab Auto Grouper CLI

Commands:
  sync                  Sync ~/.config/tab-auto-grouper/config.yaml → installed extension
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
import shutil
import subprocess
import sys
import time
from datetime import datetime
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
    if not profiles:
        for p in sorted(CHROME_DIR.iterdir()):
            if p.is_dir() and (p.name == 'Default' or p.name.startswith('Profile ')):
                profiles.append({'folder': p.name, 'name': p.name, 'path': p})
    return profiles


CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

def open_chrome_for_profile(folder):
    """Open chrome://extensions in a specific Chrome profile."""
    if Path(CHROME_BINARY).exists():
        subprocess.Popen([CHROME_BINARY, f'--profile-directory={folder}', 'chrome://extensions'])
    else:
        # Fallback if Chrome is not in the default location
        subprocess.run(['open', '-a', 'Google Chrome', 'chrome://extensions'], check=False)

def open_chrome_extensions():
    subprocess.run(['open', '-a', 'Google Chrome', 'chrome://extensions'], check=False)

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_sync(_args):
    ensure_user_config()
    yaml = require_yaml()

    if not INSTALLED_EXT.exists():
        err('Extension not installed yet. Run:  tabgroups install')
        sys.exit(1)

    config = yaml.safe_load(CONFIG_YAML.read_text())
    CONFIG_JSON.write_text(json.dumps(config, indent=2))
    ok(f'Synced {CONFIG_YAML}')
    ok(f'      → {CONFIG_JSON}')

    groups = config.get('groups', [])
    print(f'\n  {len(groups)} group(s):')
    for g in groups:
        print(f'    {g["name"]:20} color={g.get("color","grey"):8} rules={len(g.get("rules", []))}')

    print()
    info('Extension auto-detects config changes within 5 s.')
    info('Or click "Reload Config" in the extension popup.')


def cmd_config(_args):
    ensure_user_config()
    editor = os.environ.get('EDITOR', 'nano')
    subprocess.run([editor, str(CONFIG_YAML)])


def cmd_install(args):
    ensure_user_config()
    yaml = require_yaml()

    # Fresh copy of the extension template to the install location
    if INSTALLED_EXT.exists():
        shutil.rmtree(INSTALLED_EXT)
    shutil.copytree(EXTENSION_TEMPLATE, INSTALLED_EXT)
    ok(f'Extension installed at {INSTALLED_EXT}')

    # Generate config.json from the user's config.yaml
    config = yaml.safe_load(CONFIG_YAML.read_text())
    CONFIG_JSON.write_text(json.dumps(config, indent=2))
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
    info(f'Extension template  : {EXTENSION_TEMPLATE}')
    info(f'User config         : {CONFIG_YAML}')
    info(f'Installed extension : {INSTALLED_EXT}')
    info(f'config.json         : {CONFIG_JSON}')
    print()

    if INSTALLED_EXT.exists():
        ok('Extension installed')
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
    else:
        err('config.json missing  →  run: tabgroups install  or  tabgroups sync')

    print()
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
