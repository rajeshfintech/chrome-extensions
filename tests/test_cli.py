"""Run with:  python3 -m unittest discover -s tests"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


grouper = load('tabgroups_cli', ROOT / 'tab-auto-grouper' / 'cli.py')
closer = load('tabclose_cli', ROOT / 'auto-tab-closer' / 'cli.py')


class GrouperConfigValidation(unittest.TestCase):
    def test_template_is_valid(self):
        yaml = grouper.require_yaml()
        config = yaml.safe_load((ROOT / 'tab-auto-grouper' / 'config.yaml').read_text())
        self.assertEqual(grouper.validate_config(config), [])

    def test_bundled_config_json_matches_template(self):
        yaml = grouper.require_yaml()
        expected = yaml.safe_load((ROOT / 'tab-auto-grouper' / 'config.yaml').read_text())
        bundled = json.loads((ROOT / 'tab-auto-grouper' / 'extension' / 'config.json').read_text())
        bundled.pop('generated_at', None)
        self.assertEqual(bundled, expected,
                         'regenerate with: python3 tests/test_cli.py --regen')

    def test_reports_problems(self):
        errors = grouper.validate_config({'groups': [
            {'color': 'blue', 'rules': [{'domain': 'a.com'}]},                    # no name
            {'name': 'X', 'color': 'magenta', 'rules': [{'domain': 'a.com'}]},    # bad colour
            {'name': 'Y', 'rules': []},                                           # no rules
            {'name': 'Z', 'rules': [{'domain': 'a.com', 'path': 'b'}]},           # two keys
            {'name': 'W', 'rules': [{'pattern': '['}]},                           # bad regex
            {'name': 'W', 'rules': [{'host': 'a.com'}]},                          # dup + unknown key
        ], 'exclude': 'nope', 'sort_groups': 'yes'})
        joined = '\n'.join(errors)
        for needle in ('name is required', 'magenta', 'at least one rule', 'exactly one of',
                       'invalid regex', 'duplicate group name', 'unknown key', 'exclude: must be a list',
                       'sort_groups'):
            self.assertIn(needle, joined)

    def test_js_regex_dialect(self):
        for bad in ('(?P<x>a)', '(?i)abc', r'\Afoo', 'a++', '(?#c)x', '['):
            self.assertTrue(grouper.check_js_regex(bad), bad)
            self.assertTrue(closer.check_js_regex(bad), bad)
        for good in ('^https://[^/]+\\.okta\\.com/', '(?<name>a)+', 'a{2,}b?'):
            self.assertIsNone(grouper.check_js_regex(good), good)

    def test_not_a_mapping(self):
        self.assertTrue(grouper.validate_config(['x']))
        self.assertTrue(grouper.validate_config({'groups': 'x'}))


class CloserConfigValidation(unittest.TestCase):
    def test_bundled_default_is_valid(self):
        cfg = json.loads((ROOT / 'auto-tab-closer' / 'extension' / 'config.json').read_text())
        self.assertEqual(closer.validate_config(cfg), [])

    def test_reports_problems(self):
        errors = closer.validate_config({
            'idle_minutes': 0, 'warn_minutes': -1,
            'patterns': [
                {'match': 'a'},                                   # no name
                {'name': 'A', 'match': 'x', 'domain': 'y'},       # two keys
                {'name': 'B'},                                    # no rule
                {'name': 'C', 'pattern': '('},                    # bad regex
                {'name': 'D', 'match': 'dup'},
                {'name': 'E', 'match': 'DUP '},                   # duplicate (case/space-insensitive)
                {'name': 'F', 'match': 'f', 'idle_minutes': True},
            ]})
        joined = '\n'.join(errors)
        for needle in ('idle_minutes: must be greater than 0', 'warn_minutes', 'name is required',
                       'exactly one of', 'invalid regex', 'duplicate of an earlier pattern',
                       'idle_minutes must be a number'):
            self.assertIn(needle, joined)

    def test_rule_key(self):
        self.assertEqual(closer.rule_key({'name': 'x', 'path': ' A/B '}), 'path:a/b')
        self.assertEqual(closer.rule_key({'name': 'x'}), '')

    def test_missing_defaults(self):
        defaults = json.loads(closer.DEFAULT_CONFIG.read_text())['patterns']
        self.assertEqual(closer.missing_defaults({'patterns': defaults}), [])
        missing = closer.missing_defaults({'patterns': defaults[:-2]})
        self.assertEqual([p['name'] for p in missing], [p['name'] for p in defaults[-2:]])


class RefreshKeepsConfig(unittest.TestCase):
    """`refresh` (run by brew upgrade) swaps the code and keeps the installed config.json."""

    def run_cli(self, cli, home, *args, user_home=None):
        env = {**os.environ, 'TABCLOSE_HOME': str(home), 'TABGROUPS_HOME': str(home), 'NO_BROWSER': '1'}
        if user_home:
            env['HOME'] = str(user_home)
        return subprocess.run([sys.executable, '-I', str(cli), *args], env=env,
                              capture_output=True, text=True, check=True).stdout

    def check(self, name):
        cli = ROOT / name / 'cli.py'
        bundled = (ROOT / name / 'extension' / 'config.json').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'var'
            ext = home / 'extension'
            out = self.run_cli(cli, home, 'refresh')
            self.assertIn('bundled config', out)
            self.assertEqual((ext / 'config.json').read_bytes(), bundled)

            (ext / 'config.json').write_text('{"mine": true}\n')
            (ext / 'stale.js').write_text('old file')
            self.run_cli(cli, home, 'refresh')
            self.assertEqual((ext / 'config.json').read_text(), '{"mine": true}\n')
            self.assertFalse((ext / 'stale.js').exists(), 'files dropped from a release must go')
            self.assertEqual(json.loads((ext / 'manifest.json').read_text())['version'],
                             json.loads((ROOT / name / 'extension' / 'manifest.json').read_text())['version'])
            self.assertEqual(sorted(p.name for p in home.iterdir()), ['extension'])

    def check_recovers_interrupted_swap(self, name):
        cli = ROOT / name / 'cli.py'
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'var'
            (home / 'extension.old').mkdir(parents=True)
            (home / 'extension.old' / 'config.json').write_text('{"mine": true}\n')
            self.run_cli(cli, home, 'refresh')
            self.assertEqual((home / 'extension' / 'config.json').read_text(), '{"mine": true}\n')

    def check_legacy_and_remove(self, name, legacy_name):
        cli = ROOT / name / 'cli.py'
        with tempfile.TemporaryDirectory() as tmp:
            user_home = Path(tmp) / 'home'
            legacy = user_home / 'Library' / 'Application Support' / legacy_name
            (legacy / 'extension').mkdir(parents=True)
            home = Path(tmp) / 'var'
            self.run_cli(cli, home, 'refresh', user_home=user_home)
            self.assertIn('Old copy still at', self.run_cli(cli, home, 'status', user_home=user_home))

            (home / 'keep-me.txt').write_text('not ours')
            self.run_cli(cli, home, 'remove', user_home=user_home)
            self.assertEqual(sorted(p.name for p in home.iterdir()), ['keep-me.txt'],
                             'remove must only delete the folders it creates')
            self.assertTrue(legacy.exists(), 'plain remove must not touch the old copy')

            self.run_cli(cli, home, 'remove', '--legacy', user_home=user_home)
            self.assertFalse(legacy.exists())
            self.assertIn('No old copy', self.run_cli(cli, home, 'remove', '--legacy', user_home=user_home))

    def test_closer(self):
        self.check('auto-tab-closer')
        self.check_recovers_interrupted_swap('auto-tab-closer')
        self.check_legacy_and_remove('auto-tab-closer', 'auto-tab-closer')

    def test_grouper(self):
        self.check('tab-auto-grouper')
        self.check_recovers_interrupted_swap('tab-auto-grouper')
        self.check_legacy_and_remove('tab-auto-grouper', 'chrome-tab-grouper')


if __name__ == '__main__':
    if '--regen' in sys.argv:
        yaml = grouper.require_yaml()
        config = yaml.safe_load((ROOT / 'tab-auto-grouper' / 'config.yaml').read_text())
        out = ROOT / 'tab-auto-grouper' / 'extension' / 'config.json'
        out.write_text(json.dumps(config, indent=2) + '\n')
        print(f'wrote {out}')
    else:
        unittest.main()
