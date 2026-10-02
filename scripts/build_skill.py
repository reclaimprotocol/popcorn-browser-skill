#!/usr/bin/env python3
"""Build or verify the self-contained Markdown and deterministic skill ZIP."""
import argparse
import io
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / 'popcorn-browser'
RESOURCES = [
    ('package.json', 'json'),
    ('package-lock.json', 'json'),
    ('scripts/credit-client.mjs', 'javascript'),
    ('scripts/session.mjs', 'javascript'),
    ('references/credits.md', 'markdown'),
    ('references/renewal.md', 'markdown'),
]
MARKER = '\n\n## Embedded files for standalone installation\n'


def artifacts():
    text = (SKILL / 'SKILL.md').read_text(encoding='utf-8')
    text += MARKER + '''
This is the single-file distribution. When installing from a public GitHub raw
URL, download the complete document, not just a rendered preview. Save the
instructions above (before this section) as `popcorn-browser/SKILL.md`. Save each
following fenced block verbatim at its named relative path under that directory,
creating the `scripts` and `references` directories. All companion files,
including the dependency lockfile, are embedded here; no ZIP or Git clone is
needed. These blocks are source files, not commands to paste into a shell.
Never embed credentials in this distribution. Then follow the setup steps above.
'''
    for relative, language in RESOURCES:
        content = (SKILL / relative).read_text(encoding='utf-8')
        text += f'\n### File: `{relative}`\n\n````{language}\n{content}````\n'

    archive_bytes = io.BytesIO()
    # This small ZIP uses stored entries to remain byte-identical across zlib versions.
    with zipfile.ZipFile(archive_bytes, 'w', zipfile.ZIP_STORED) as archive:
        for relative in ['SKILL.md', *(name for name, _ in RESOURCES)]:
            entry = zipfile.ZipInfo(f'popcorn-browser/{relative}', (2000, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, (SKILL / relative).read_bytes())
    return {'popcorn-browser.md': text.encode('utf-8'), 'popcorn-browser.zip': archive_bytes.getvalue()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if committed distributions are stale; write nothing')
    args = parser.parse_args()
    stale = []
    for name, content in artifacts().items():
        target = ROOT / name
        if args.check:
            if not target.exists() or target.read_bytes() != content:
                stale.append(name)
        else:
            target.write_bytes(content)
    if stale:
        parser.exit(1, f"Stale distributions: {', '.join(stale)}. Run python3 scripts/build_skill.py\n")
    print('Distributions are current.' if args.check else 'Built popcorn-browser.md and popcorn-browser.zip')


if __name__ == '__main__':
    main()
