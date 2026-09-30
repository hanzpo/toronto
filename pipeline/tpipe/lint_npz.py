"""Guard against a memory trap: indexing a lazy NpzFile (np.load of .npz)
inside a loop or comprehension decompresses the whole array on every access,
which ran the tiler up to ~94 GB. Flags `name["key"][...]` inside for/while
loops and comprehensions when `name` was assigned from np.load(...).

    uv run python -m tpipe.lint_npz   (exit 1 on findings)
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path


def check(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(), str(path))
    npz_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            f = node.value.func
            if isinstance(f, ast.Attribute) and f.attr == "load" and isinstance(f.value, ast.Name) and f.value.id == "np":
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        npz_names.add(t.id)
    out = []

    def visit(node, in_loop):
        loop = isinstance(node, (ast.For, ast.While, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp))
        if in_loop and isinstance(node, ast.Subscript) and isinstance(node.value, ast.Subscript):
            inner = node.value
            if isinstance(inner.value, ast.Name) and inner.value.id in npz_names and isinstance(inner.slice, ast.Constant):
                out.append(f"{path}:{node.lineno}: {inner.value.id}[{inner.slice.value!r}][...] inside a loop")
        for child in ast.iter_child_nodes(node):
            # the iterable of a for/comprehension is evaluated once: not "in loop"
            visit(child, in_loop or (loop and child is not getattr(node, "iter", None)))

    visit(tree, False)
    return out


def main() -> int:
    root = Path(__file__).resolve().parent
    found = [f for p in sorted(root.rglob("*.py")) for f in check(p)]
    for f in found:
        print(f)
    print(f"{len(found)} lazy-npz access(es) in loops")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
