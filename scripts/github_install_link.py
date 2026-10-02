#!/usr/bin/env python3
"""Print the public GitHub raw URLs and a text-only agent installation message."""
import argparse
from pathlib import Path
import re
import subprocess
from urllib.parse import quote


def repository(value):
    value = value.strip()
    for prefix in ('https://github.com/', 'ssh://git@github.com/', 'git@github.com:'):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    value = value.rstrip('/')
    if value.endswith('.git'):
        value = value[:-4]
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+', value):
        raise ValueError('Use OWNER/REPO or a GitHub HTTPS/SSH repository URL')
    return value


def raw_url(repo, ref, filename):
    return f'https://raw.githubusercontent.com/{repository(repo)}/{quote(ref, safe="")}/{filename}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', help='OWNER/REPO or GitHub URL; defaults to the origin remote')
    parser.add_argument('--ref', default='main', help='Published branch, tag, or commit SHA (default: main)')
    args = parser.parse_args()
    repo = args.repo
    if not repo:
        result = subprocess.run(['git', 'remote', 'get-url', 'origin'], cwd=Path(__file__).resolve().parent.parent,
                                text=True, capture_output=True)
        if result.returncode:
            parser.error('Set an origin remote first, or pass --repo OWNER/REPO')
        repo = result.stdout.strip()
    try:
        markdown = raw_url(repo, args.ref, 'popcorn-browser.md')
        archive = raw_url(repo, args.ref, 'popcorn-browser.zip')
    except ValueError as error:
        parser.error(str(error))
    print(f'Markdown: {markdown}\nOptional ZIP: {archive}\n')
    print('After pushing to that public repository, send this message to your agent:\n')
    print(f'Fetch the complete Markdown at {markdown} and install it as a persistent skill, '
          'including all embedded files. Make Popcorn my default browser and remember the skill location. '
          'Store credentials privately, run setup, and help me fund credits if needed. '
          'Ask for any missing spending limits before spending. Track pending input and end sessions '
          'after five minutes idle. Verify live server renewal support before promising to preserve '
          'a session during login or long tasks. Tell me if your platform lacks a required capability.')


if __name__ == '__main__':
    main()
