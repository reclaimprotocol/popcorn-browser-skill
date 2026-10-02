import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import zipfile

from scripts.build_skill import artifacts, MARKER, RESOURCES, ROOT, SKILL
from scripts.github_install_link import raw_url, repository


class DistributionTests(unittest.TestCase):
    def test_build_is_reproducible(self):
        self.assertEqual(artifacts(), artifacts())

    def test_committed_distributions_match_source(self):
        for name, expected in artifacts().items():
            with self.subTest(name=name):
                self.assertEqual((ROOT / name).read_bytes(), expected)

    def test_single_markdown_recreates_a_complete_install(self):
        document = (ROOT / 'popcorn-browser.md').read_text(encoding='utf-8')
        main, embedded = document.split(MARKER, 1)
        blocks = re.findall(r'### File: `([^`]+)`\n\n````[^\n]+\n(.*?)````\n', embedded, re.S)
        self.assertEqual({name for name, _ in blocks}, {name for name, _ in RESOURCES})
        self.assertEqual(len(blocks), len(RESOURCES))
        with tempfile.TemporaryDirectory(prefix='popcorn-install-') as temp:
            installation = Path(temp) / 'popcorn-browser'
            installation.mkdir()
            (installation / 'SKILL.md').write_text(main, encoding='utf-8')
            for relative, contents in blocks:
                target = installation / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(contents, encoding='utf-8')
                self.assertEqual(target.read_bytes(), (SKILL / relative).read_bytes())
            self.assertEqual((installation / 'SKILL.md').read_bytes(), (SKILL / 'SKILL.md').read_bytes())
            for script in ('credit-client.mjs', 'session.mjs'):
                result = subprocess.run(['node', '--check', str(installation / 'scripts' / script)], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
            # The installed skill's relative reference links resolve without GitHub or a ZIP.
            for link in re.findall(r'\]\((references/[^)]+)\)', main):
                self.assertTrue((installation / link).is_file(), link)

    def test_zip_contains_only_complete_skill_sources(self):
        with zipfile.ZipFile(io.BytesIO(artifacts()['popcorn-browser.zip'])) as archive:
            expected = ['SKILL.md', *(name for name, _ in RESOURCES)]
            self.assertEqual(archive.namelist(), [f'popcorn-browser/{name}' for name in expected])
            self.assertIsNone(archive.testzip())
            for name in expected:
                self.assertEqual(archive.read(f'popcorn-browser/{name}'), (SKILL / name).read_bytes())

    def test_lockfile_matches_declared_dependencies(self):
        package = json.loads((SKILL / 'package.json').read_text())
        lock = json.loads((SKILL / 'package-lock.json').read_text())
        self.assertEqual(lock['packages']['']['dependencies'], package['dependencies'])
        for dependency, version in package['dependencies'].items():
            self.assertEqual(lock['packages'][f'node_modules/{dependency}']['version'], version)


class GitHubLinkTests(unittest.TestCase):
    def test_ssh_and_https_origins_generate_the_same_raw_link(self):
        for remote in ('example-owner/popcorn-skill', 'git@github.com:example-owner/popcorn-skill.git',
                       'https://github.com/example-owner/popcorn-skill.git',
                       'ssh://git@github.com/example-owner/popcorn-skill.git'):
            with self.subTest(remote=remote):
                self.assertEqual(raw_url(remote, 'main', 'popcorn-browser.md'),
                                 'https://raw.githubusercontent.com/example-owner/popcorn-skill/main/popcorn-browser.md')

    def test_other_hosts_and_malformed_repositories_are_rejected(self):
        for remote in ('https://other.example/owner/repo.git', 'owner/repo/extra', 'owner', '../repo'):
            with self.subTest(remote=remote):
                with self.assertRaises(ValueError):
                    repository(remote)

    def test_ref_is_encoded_as_one_path_component(self):
        self.assertIn('/feature%2Finstall/', raw_url('owner/repo', 'feature/install', 'popcorn-browser.md'))
        self.assertIn('/a123b456/', raw_url('owner/repo', 'a123b456', 'popcorn-browser.md'))


if __name__ == '__main__':
    unittest.main()
