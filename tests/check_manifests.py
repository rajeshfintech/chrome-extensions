#!/usr/bin/env python3
"""Security invariant for both extensions' manifest.json.

The README promises "no host permissions, no network requests, no page content
access". This check fails CI if a change would quietly break that promise:
a new permission outside the allowlist, host permissions, content scripts,
a relaxed content security policy, remote code, or a non-MV3 manifest.

Run:  python3 tests/check_manifests.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ALLOWED_PERMISSIONS = {
    'tab-auto-grouper': {'tabs', 'tabGroups', 'storage'},
    'auto-tab-closer': {'tabs', 'storage', 'alarms', 'notifications'},
}
FORBIDDEN_KEYS = (
    'host_permissions', 'optional_host_permissions', 'content_scripts',
    'web_accessible_resources', 'externally_connectable', 'declarative_net_request',
    'devtools_page', 'chrome_url_overrides', 'oauth2', 'key', 'update_url',
)


def check(name):
    ext = ROOT / name / 'extension'
    manifest = json.loads((ext / 'manifest.json').read_text())
    errors = []

    if manifest.get('manifest_version') != 3:
        errors.append('manifest_version must be 3')

    perms = set(manifest.get('permissions', []))
    extra = perms - ALLOWED_PERMISSIONS[name]
    if extra:
        errors.append(f'new permission(s) {sorted(extra)} — update ALLOWED_PERMISSIONS deliberately if intended')
    if manifest.get('optional_permissions'):
        errors.append('optional_permissions must stay empty')

    for key in FORBIDDEN_KEYS:
        if key in manifest:
            errors.append(f'"{key}" must not be present')

    csp = manifest.get('content_security_policy')
    if csp:
        errors.append('content_security_policy must not be relaxed from the MV3 default')

    bg = manifest.get('background', {})
    if bg.get('service_worker') != 'background.js' or bg.get('type') != 'module':
        errors.append('background must be {"service_worker": "background.js", "type": "module"}')

    # Every script the manifest or popup references must be shipped in the extension dir
    # and must not load anything over the network.
    for js in ext.glob('*.js'):
        text = js.read_text()
        for needle in ('importScripts(', 'eval(', 'new Function(', 'http://', 'https://cdn', 'XMLHttpRequest', 'fetch(\'http', 'fetch("http'):
            if needle in text:
                errors.append(f'{js.name}: contains "{needle}"')
        for line in text.splitlines():
            if line.strip().startswith('import ') and 'from \'./' not in line and 'from "./' not in line:
                errors.append(f'{js.name}: non-relative import: {line.strip()}')
    for html in ext.glob('*.html'):
        text = html.read_text()
        if 'src="http' in text or "src='http" in text or 'onclick=' in text:
            errors.append(f'{html.name}: inline handler or remote script')

    return errors


def main():
    failed = False
    for name in ALLOWED_PERMISSIONS:
        errors = check(name)
        status = 'FAIL' if errors else 'OK'
        print(f'{status}  {name}/extension/manifest.json')
        for e in errors:
            print(f'      - {e}')
        failed |= bool(errors)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
