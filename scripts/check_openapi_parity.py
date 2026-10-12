#!/usr/bin/env python3
"""OpenAPI parity check: the router in server/src/index.ts vs docs/openapi.yaml.

Extracts route patterns from the dispatch block in routeRequest() and diffs
them against the spec's paths. Fails (non-zero exit, clear message) on:
  - a route in code with no matching spec path (undocumented route),
  - a spec path+method with no matching code route (stale spec),
  - stale prose (the known-bad 429 / 400-gate sentences),
  - client_too_old missing from the ErrorCode enum.

Allowlist: GET / (dashboard HTML, not part of the API contract) and
endpoints tagged `x-spec-note: PROPOSED` (spec'd but not yet implemented).

Route-pattern extraction handles the dispatch idioms used in index.ts:
  - `path === '/v1/x' && method === 'GET'`
  - `path.startsWith('/v1/a/') && path.endsWith('/b') && method === 'POST'`
  - `const r = /^\\/v1\\/x\\/([^/]+)$/.exec(path); if (r && method === 'GET')`
Any dispatch idiom the extractor does not recognize fails the check loudly
so new route styles force a script update instead of passing silently.
"""

import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INDEX_TS = Path(os.environ.get("PARITY_INDEX_TS", REPO / "server" / "src" / "index.ts"))
OPENAPI = Path(os.environ.get("PARITY_OPENAPI", REPO / "docs" / "openapi.yaml"))

VERBS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")


# ---------------------------------------------------------------------------
# Regex -> path template expansion.
# ---------------------------------------------------------------------------

class RegexConvertError(Exception):
    pass


def _expand(node):
    """Expand a parsed regex node into a list of segment lists."""
    kind = node[0]
    if kind == "lit":
        return [[node[1]]]
    if kind == "param":
        return [["{param}"]]
    if kind == "alt":
        out = []
        for branch in node[1]:
            for seq in _expand_seq(branch):
                out.append(seq)
        return out
    if kind == "opt":
        with_seq = _expand_seq(node[1])
        return [[]] + with_seq
    raise RegexConvertError(f"unknown node {kind}")


def _expand_seq(nodes):
    out = [[]]
    for node in nodes:
        piece = _expand(node)
        out = [a + b for a in out for b in piece]
    return out


def _parse_group(s, i):
    """Parse '(' ... ')' starting at s[i] == '('; returns (node, next_i)."""
    assert s[i] == "("
    # Param shorthands are checked BEFORE consuming '(' as a group open.
    if s.startswith("([^/]+)", i):
        return ("param",), i + len("([^/]+)")
    if s.startswith("(.+)", i):
        return ("param",), i + len("(.+)")
    i += 1
    branches = [[]]
    buf = ""
    while True:
        if i >= len(s):
            raise RegexConvertError("unterminated group")
        c = s[i]
        if c == "(":
            if s.startswith("([^/]+)", i):
                if buf:
                    branches[-1].append(("lit", buf))
                    buf = ""
                branches[-1].append(("param",))
                i += len("([^/]+)")
            elif s.startswith("(.+)", i):
                if buf:
                    branches[-1].append(("lit", buf))
                    buf = ""
                branches[-1].append(("param",))
                i += len("(.+)")
            else:
                if buf:
                    branches[-1].append(("lit", buf))
                    buf = ""
                node, i = _parse_group(s, i)
                branches[-1].append(node)
        elif c == ")":
            if buf:
                branches[-1].append(("lit", buf))
                buf = ""
            i += 1
            optional = i < len(s) and s[i] == "?"
            if optional:
                i += 1
            if len(branches) == 1 and all(n[0] in ("lit", "param") for n in branches[0]):
                # Single branch, no alternation: literal-or-param sequence.
                node = ("seq", branches[0])
            else:
                node = ("alt", branches)
            if optional:
                return ("opt", [node] if node[0] != "seq" else node[1]), i
            if node[0] == "seq":
                return ("seqnode", node[1]), i
            return node, i
        elif c == "|":
            if buf:
                branches[-1].append(("lit", buf))
                buf = ""
            branches.append([])
            i += 1
        elif c == "\\":
            # Only \/ escapes occur in these route regexes.
            if s.startswith("\\/", i):
                buf += "/"
                i += 2
            else:
                raise RegexConvertError(f"unsupported escape at {s[i:i+4]!r}")
        else:
            buf += c
            i += 1


def regex_to_templates(source):
    """Convert a route regex source (no ^$ anchors) to path templates."""
    nodes = []
    i, buf = 0, ""
    while i < len(source):
        c = source[i]
        if c == "(":
            if buf:
                nodes.append(("lit", buf))
                buf = ""
            node, i = _parse_group(source, i)
            if node[0] == "seqnode":
                nodes.extend(node[1])
            else:
                nodes.append(node)
        elif source.startswith("([^/]+)", i):
            if buf:
                nodes.append(("lit", buf))
                buf = ""
            nodes.append(("param",))
            i += len("([^/]+)")
        elif source.startswith("(.+)", i):
            if buf:
                nodes.append(("lit", buf))
                buf = ""
            nodes.append(("param",))
            i += len("(.+)")
        elif source.startswith("\\/", i):
            buf += "/"
            i += 2
        else:
            buf += c
            i += 1
    if buf:
        nodes.append(("lit", buf))
    templates = []
    for seq in _expand_seq(nodes):
        # Merge adjacent literal chars, keep {param} as segments.
        merged: list[str] = []
        for piece in seq:
            if piece == "{param}":
                merged.append(piece)
            elif merged and not merged[-1].startswith("{"):
                merged[-1] += piece
            else:
                merged.append(piece)
        path = "".join(merged)
        if not path.startswith("/"):
            raise RegexConvertError(f"template does not start with /: {path!r}")
        templates.append(path)
    # De-dupe, keep order.
    return list(dict.fromkeys(templates))


# ---------------------------------------------------------------------------
# Code side: extract routes from routeRequest().
# ---------------------------------------------------------------------------

def _if_conditions(body):
    """Yield the raw condition text of every `if (...)` in body.

    Balanced-paren scan: a regex like [^)]* would truncate conditions that
    contain calls (path.startsWith('...')).
    """
    for m in re.finditer(r"\bif\s*\(", body):
        i = m.end()
        depth = 1
        while i < len(body) and depth:
            if body[i] == "(":
                depth += 1
            elif body[i] == ")":
                depth -= 1
            i += 1
        yield body[m.end():i - 1]


def extract_code_routes(src):
    m = re.search(r"async function routeRequest\(.*?\n(.*?)\n// Worker entry point", src, re.S)
    if not m:
        raise SystemExit("check_openapi_parity: cannot find routeRequest() body")
    body = m.group(1)
    routes = []  # (method|'ANY', template)

    def method_of(cond):
        mm = re.search(r"method === '([A-Z]+)'", cond)
        return mm.group(1) if mm else None

    # 1) Exact: if (path === '/x' && method === 'GET')
    # 2) Prefix+suffix: path.startsWith('/a/') && path.endsWith('/b')
    #    (or the bare /i/ prefix for the onboarding pages).
    for cond in _if_conditions(body):
        verb = method_of(cond)
        for lit in re.findall(r"path === '([^']+)'", cond):
            if not lit.startswith("/"):
                continue
            if verb is None:
                continue  # e.g. 404 guards, apiMajorOf — not routes
            routes.append((verb, lit))
        pre = re.search(r"path\.startsWith\('([^']+)'\)", cond)
        suf = re.search(r"path\.endsWith\('([^']+)'\)", cond)
        if pre and suf and verb:
            routes.append((verb, pre.group(1) + "{param}" + suf.group(1)))
        elif pre and pre.group(1) == "/i/" and verb and not suf:
            # /i/ pages: GET /i/<token> (the .json form is content
            # negotiation on the same route).
            routes.append((verb, "/i/{token}"))

    # 3) Regex dispatch: const name = /.../.exec(path);
    # The handling block may branch on method per sub-action (e.g. topicSub
    # serves GET history but POST entries): collect every `method === 'V'`
    # between this declaration and the next regex declaration. Exactly one
    # distinct verb -> that verb; otherwise the route is method-agnostic.
    decls = list(re.finditer(r"const (\w+) = /(\^.*?\$)/\.exec\(path\);", body))
    for di, mm in enumerate(decls):
        name, source = mm.group(1), mm.group(2)
        if not (source.startswith("^") and source.endswith("$")):
            raise SystemExit(f"check_openapi_parity: regex for {name} lacks ^$ anchors")
        templates = regex_to_templates(source[1:-1])
        block_end = decls[di + 1].start() if di + 1 < len(decls) else len(body)
        verbs = sorted(set(re.findall(r"method === '([A-Z]+)'", body[mm.end():block_end])))
        verb = verbs[0] if len(verbs) == 1 else "ANY"
        for t in templates:
            routes.append((verb, t))

    # De-dupe, keep order.
    seen, out = set(), []
    for r in routes:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


# ---------------------------------------------------------------------------
# Spec side: parse paths + methods + PROPOSED tags from openapi.yaml.
# ---------------------------------------------------------------------------

def extract_spec_routes(text):
    paths_sec = text.split("\npaths:", 1)[1].split("\ncomponents:", 1)[0]
    lines = paths_sec.split("\n")
    routes = []  # (method, path, proposed)
    cur_path, cur_method, proposed = None, None, False
    method_indent = None

    def flush():
        if cur_path and cur_method:
            routes.append((cur_method, cur_path, proposed))

    for line in lines:
        mp = re.match(r"^  (/[^:]*):$", line)
        if mp:
            flush()
            cur_path, cur_method, proposed = mp.group(1), None, False
            continue
        mm = re.match(r"^    ([a-z]+):$", line)
        if mm and mm.group(1) in ("get", "post", "put", "patch", "delete", "head", "options"):
            flush()
            cur_method, proposed = mm.group(1).upper(), False
            method_indent = 4
            continue
        if cur_method and re.match(r"^      x-spec-note:\s*PROPOSED", line):
            proposed = True
    flush()
    return routes


# ---------------------------------------------------------------------------
# Diff.
# ---------------------------------------------------------------------------

def template_match(code_t, spec_t):
    cs, ss = code_t.split("/"), spec_t.split("/")
    if len(cs) != len(ss):
        return False
    for c, s in zip(cs, ss):
        if c == s:
            continue
        if c.startswith("{") or s.startswith("{"):
            continue
        return False
    return True


def main():
    src = INDEX_TS.read_text()
    spec = OPENAPI.read_text()
    errors = []

    code_routes = extract_code_routes(src)
    spec_routes = extract_spec_routes(spec)

    # Code -> spec: every code route needs a spec path (method checked when
    # the code route pins one).
    for verb, template in code_routes:
        if (verb, template) == ("GET", "/"):
            continue  # allowlist: dashboard HTML
        matches = [s for s in spec_routes if template_match(template, s[1])]
        if not matches:
            errors.append(f"undocumented route in code: {verb} {template}")
            continue
        if verb != "ANY" and not any(s[0] == verb for s in matches):
            errors.append(
                f"route {verb} {template} has no matching method in openapi.yaml "
                f"(spec has: {sorted({s[0] for s in matches})})"
            )

    # Spec -> code: every spec path+method needs a code route, unless PROPOSED.
    for verb, path, proposed in spec_routes:
        if proposed:
            continue  # allowlist: spec'd but not yet implemented
        matches = [c for c in code_routes if template_match(c[1], path)]
        if not matches:
            errors.append(f"stale spec path with no code route: {verb} {path}")
        elif not any(c[0] in ("ANY", verb) for c in matches):
            errors.append(f"spec documents {verb} {path} but code has no such method")

    # Stale prose checks.
    if "the worker itself enforces NO rate limits" in spec:
        errors.append("stale 429 prose: in-worker rate limiting exists since v0.11.0")
    if "rejected with 400 `client_too_old`" in spec:
        errors.append("stale gate prose: client_too_old is 426 now, not 400")
    m = re.search(r"ErrorCode:\n(?:.*\n)*?.*?enum: \[([^\]]*)\]", spec)
    if not m or "client_too_old" not in m.group(1):
        errors.append("ErrorCode enum is missing client_too_old")

    if errors:
        print("openapi parity FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(
        f"openapi parity OK: {len(code_routes)} code routes, "
        f"{len(spec_routes)} spec operations"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
