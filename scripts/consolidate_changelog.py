#!/usr/bin/env python3
"""Consolidate changelog.d/ fragments into CHANGELOG.md.

Reads every ``changelog.d/<slug>.<type>.md`` fragment (except README.md),
appends its bullets under the matching ``### <Section>`` heading inside the
``## [Unreleased]`` section of CHANGELOG.md (creating headings in
Keep-a-Changelog order as needed), then deletes the processed fragments.

Idempotent: with no fragments present it changes nothing. Run at merge time
(see .github/workflows/changelog.yml); also safe to run locally.
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FRAG_DIR = REPO / "changelog.d"
CHANGELOG = REPO / "CHANGELOG.md"

# Keep-a-Changelog section order.
SECTIONS = [
    ("added", "Added"),
    ("changed", "Changed"),
    ("deprecated", "Deprecated"),
    ("removed", "Removed"),
    ("fixed", "Fixed"),
    ("security", "Security"),
]
TYPE_TO_SECTION = dict(SECTIONS)

FRAG_RE = re.compile(r"^(?P<slug>[a-z0-9][a-z0-9-]*)\.(?P<type>[a-z]+)\.md$")


def parse_fragment(path: Path) -> tuple[str, list[str]]:
    m = FRAG_RE.match(path.name)
    if not m:
        raise ValueError(f"bad fragment name: {path.name} (want <slug>.<type>.md)")
    ftype = m.group("type")
    if ftype not in TYPE_TO_SECTION:
        raise ValueError(
            f"bad fragment type {ftype!r} in {path.name}; "
            f"want one of {sorted(TYPE_TO_SECTION)}"
        )
    bullets = [ln.rstrip() for ln in path.read_text().splitlines() if ln.strip()]
    if not bullets:
        raise ValueError(f"empty fragment: {path.name}")
    return ftype, bullets


def consolidate(frag_dir: Path = FRAG_DIR, changelog: Path = CHANGELOG) -> int:
    frags = sorted(
        (p for p in frag_dir.glob("*.md") if p.name != "README.md"),
        key=lambda p: p.name,
    )
    if not frags:
        print("no fragments to consolidate")
        return 0

    by_type: dict[str, list[str]] = {}
    for frag in frags:
        ftype, bullets = parse_fragment(frag)
        by_type.setdefault(ftype, []).extend(bullets)

    text = changelog.read_text()
    if "## [Unreleased]" not in text:
        raise ValueError(f"{changelog} has no '## [Unreleased]' section")

    head, tail = text.split("## [Unreleased]", 1)
    # tail starts right after the heading; find where the next ## section begins.
    m = re.search(r"^## \[[^\]]+\]", tail, re.M)
    unreleased_body = tail[: m.start()] if m else tail
    rest = tail[m.start() :] if m else ""

    for ftype, section in SECTIONS:
        bullets = by_type.get(ftype)
        if not bullets:
            continue
        sec_re = re.compile(rf"^### {section}\s*$", re.M)
        sm = sec_re.search(unreleased_body)
        addition = "".join(f"{b}\n" for b in bullets)
        if sm:
            # Append after the last bullet of the existing section.
            sec_start = sm.end()
            next_sec = re.search(r"^### \w+\s*$", unreleased_body[sec_start:], re.M)
            insert_at = sec_start + (next_sec.start() if next_sec else len(unreleased_body[sec_start:]))
            # Ensure exactly one blank line before the appended bullets.
            prefix = unreleased_body[:insert_at].rstrip("\n") + "\n"
            unreleased_body = prefix + addition + unreleased_body[insert_at:].lstrip("\n")
        else:
            # Insert the new section in canonical order: after the last
            # existing section that precedes it, else right after the heading.
            insert_at = 0
            for _, earlier in SECTIONS:
                if earlier == section:
                    break
                em = re.search(rf"^### {earlier}\s*$", unreleased_body, re.M)
                if em:
                    nm = re.search(r"^### \w+\s*$", unreleased_body[em.end():], re.M)
                    insert_at = em.end() + (nm.start() if nm else len(unreleased_body[em.end():]))
            prefix = unreleased_body[:insert_at].rstrip("\n") + "\n"
            new_sec = f"\n### {section}\n" + addition
            unreleased_body = prefix + new_sec + unreleased_body[insert_at:].lstrip("\n")

    changelog.write_text(head + "## [Unreleased]" + unreleased_body + rest)
    for frag in frags:
        frag.unlink()
        print(f"consolidated {frag.name}")
    return len(frags)


if __name__ == "__main__":
    try:
        n = consolidate()
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"done: {n} fragment(s)")
