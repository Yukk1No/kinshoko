#!/usr/bin/env python3
"""Pre-commit gate: reject staged files larger than 5,000 tokens (tokens = bytes / 4).

Only files staged in this commit are checked, and the size is read from the
staged blob, not the working tree. Files that agents do not author by hand are
skipped: binaries, lockfiles, codegen output, and anything a .gitattributes
file marks `linguist-generated` or `linguist-vendored`.
"""

from __future__ import annotations

import fnmatch
import subprocess
import sys

MAX_TOKENS = 5_000
BYTES_PER_TOKEN = 4

# Universal patterns for files no agent writes by hand. Repo-specific
# exemptions belong in .gitattributes (`linguist-generated`), not here.
IGNORED_BASENAMES = {
    "Cargo.lock",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "flake.lock",
    "go.sum",
}
IGNORED_GLOBS = [
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.snap",
    "*.generated.*",
    "*.gen.*",
    "*_generated.*",
    "*.pb.go",
    "*_pb2.py",
    "*.log",
    "gen/*",
    "*/gen/*",
    "generated/*",
    "*/generated/*",
    "dist/*",
    "*/dist/*",
]


def git(*args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", *args], input=stdin, stdout=subprocess.PIPE, check=True
    ).stdout


def split_z(out: bytes) -> list[str]:
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def staged_paths() -> list[str]:
    return split_z(git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"))


def binary_paths(paths: list[str]) -> set[str]:
    # numstat prints "-\t-\t<path>" for blobs git treats as binary.
    out = git("diff", "--cached", "--numstat", "-z", "--diff-filter=ACMR", "--", *paths)
    binary = set()
    for record in split_z(out):
        added, deleted, path = record.split("\t", 2)
        if added == "-" and deleted == "-":
            binary.add(path)
    return binary


def attribute_exempt(paths: list[str]) -> set[str]:
    stdin = b"".join(p.encode("utf-8", "surrogateescape") + b"\0" for p in paths)
    fields = split_z(
        git(
            "check-attr", "--cached", "-z", "--stdin",
            "linguist-generated", "linguist-vendored",
            stdin=stdin,
        )
    )
    exempt = set()
    for i in range(0, len(fields) - 2, 3):
        path, _attr, value = fields[i : i + 3]
        if value in ("set", "true"):
            exempt.add(path)
    return exempt


def pattern_exempt(path: str) -> bool:
    basename = path.rsplit("/", 1)[-1]
    if basename in IGNORED_BASENAMES:
        return True
    return any(fnmatch.fnmatchcase(path, g) for g in IGNORED_GLOBS)


def staged_sizes(paths: list[str]) -> dict[str, int]:
    stdin = b"".join(b":" + p.encode("utf-8", "surrogateescape") + b"\n" for p in paths)
    lines = git("cat-file", "--batch-check=%(objectsize)", stdin=stdin).splitlines()
    return {p: int(size) for p, size in zip(paths, lines)}


def split_hint(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if ext == "rs":
        return (
            "Turn the module into a directory: move `foo.rs` to `foo/mod.rs`, then move "
            "each cohesive group of types and impls into `foo/<topic>.rs` with "
            "`mod <topic>; pub use <topic>::*;` in mod.rs. Move a large `#[cfg(test)] mod tests` "
            "block into `foo/tests.rs`, or into `tests/` if it only uses the public API."
        )
    if ext in ("ts", "tsx", "js", "jsx", "mjs", "cjs"):
        return (
            "Extract each component, hook, or helper group into its own sibling file and "
            "import it back. For a big component, move subcomponents to `<Name>/<Part>.tsx` "
            "and state logic to `use<Name>.ts`. Split a large test file by feature into "
            "`<name>.<feature>.test.tsx`, sharing fixtures via a `<name>.fixtures.ts` file."
        )
    if ext in ("css", "scss"):
        return (
            "Split by component or layer (tokens, layout, per-component rules) into separate "
            "files and pull them in with `@import` or from the components that use them."
        )
    if ext == "py":
        return (
            "Turn the module into a package: `foo.py` -> `foo/__init__.py` plus one module "
            "per responsibility, re-exporting the public names from `__init__.py`."
        )
    if ext in ("md", "mdx"):
        return (
            "Split along `##` headings: create a directory named after the document, move "
            "each major section into its own file there, and leave a short index that "
            "summarises and links to each part. Update links that point at the old anchors."
        )
    if ext in ("json", "yaml", "yml", "toml", "tsv", "csv", "txt"):
        return (
            "If a tool produces this file, it is not agent-authored: mark it "
            "`linguist-generated` in .gitattributes. If you write it by hand, split it into "
            "several files by top-level key or record group and merge them where it is loaded."
        )
    if ext in ("html", "svg"):
        return (
            "Move inline <style> and <script> blocks into separate .css/.js files, and split "
            "repeated markup into smaller files. Exported art is not agent-authored: mark "
            "it `linguist-generated` in .gitattributes."
        )
    return (
        "Split the file along its natural seams (one responsibility per file) and have a "
        "small entry file import or link the parts."
    )


def main() -> int:
    paths = staged_paths()
    if not paths:
        return 0
    skipped = binary_paths(paths) | attribute_exempt(paths)
    candidates = [p for p in paths if p not in skipped and not pattern_exempt(p)]
    if not candidates:
        return 0

    limit_bytes = MAX_TOKENS * BYTES_PER_TOKEN
    offenders = [
        (p, size) for p, size in staged_sizes(candidates).items() if size > limit_bytes
    ]
    if not offenders:
        return 0

    out = sys.stderr
    out.reconfigure(encoding="utf-8", errors="replace")
    print(
        f"\npre-commit: {len(offenders)} staged file(s) exceed {MAX_TOKENS:,} tokens "
        f"(tokens = bytes / {BYTES_PER_TOKEN}, limit {limit_bytes:,} bytes).\n",
        file=out,
    )
    for path, size in sorted(offenders, key=lambda o: -o[1]):
        tokens = -(-size // BYTES_PER_TOKEN)
        parts = -(-size // limit_bytes)  # ceil
        print(f"  {path}: ~{tokens:,} tokens ({size:,} bytes)", file=out)
        print(f"    Needs at least {parts} files; aim for {parts + 1} so each has headroom.", file=out)
        print(f"    How: {split_hint(path)}", file=out)
        print("", file=out)
    print(
        "How to split, for any file:\n"
        "  1. Find the seams: groups of code or sections that change together and only\n"
        "     talk to each other through a few names.\n"
        "  2. Move each group into its own file, verbatim. Do not rewrite logic while moving.\n"
        f"  3. Keep every resulting file under {MAX_TOKENS:,} tokens ({limit_bytes:,} bytes),\n"
        "     ideally well under so the next edit does not trip the limit again.\n"
        "  4. Re-export or link from the original location so callers and links keep working.\n"
        "  5. Run the build and tests, then `git add` the new files and commit again.\n"
        "\n"
        "Lockfiles, codegen, and binaries are skipped automatically. If this file is\n"
        "machine-generated, add `<path> linguist-generated` to .gitattributes instead\n"
        "of splitting it. Do not bypass this check with --no-verify.",
        file=out,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
