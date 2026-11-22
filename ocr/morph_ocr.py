#!/usr/bin/env python3
"""Reads a table out of an image with RapidOCR, on this machine only.

  morph_ocr.py IMAGE.png     prints one JSON line:  {"ok": true, "html": "<table>...</table>", "cells": 12}
                              or                    {"ok": false, "error": "no_table"}
  morph_ocr.py --warmup      loads the text models once (the only step that may download anything)
  morph_ocr.py --selftest    checks the table building without RapidOCR (used by Morph's tests)

RapidOCR reads the words and where they are; Morph rebuilds the table from those positions (rows by height,
columns by overlapping horizontal ranges). Morph never sends the image anywhere: this script runs locally
and its answer is read from its output.
"""
import json
import sys

MAX_HTML = 400000


def make_engine():
    """RapidOCR 2.x/3.x ("rapidocr" with onnxruntime), or the older "rapidocr_onnxruntime" package."""
    try:
        from rapidocr import RapidOCR
        return "new", RapidOCR()
    except ImportError:
        from rapidocr_onnxruntime import RapidOCR
        return "old", RapidOCR()


def as_list(v):
    return v.tolist() if hasattr(v, "tolist") else list(v)


def box_of(points):
    """[x1, y1, x2, y2] from a four-point polygon (or a box already in that form)."""
    pts = as_list(points)
    if len(pts) == 4 and not isinstance(pts[0], (list, tuple)):
        return [float(v) for v in pts]
    xs = [float(p[0]) for p in pts]
    ys = [float(p[1]) for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def words_of(kind, result):
    """(texts, boxes) from either package's result."""
    if kind == "new":
        boxes = getattr(result, "boxes", None)
        txts = getattr(result, "txts", None)
        if boxes is None or txts is None:
            return [], []
        return [str(t) for t in as_list(txts)], [box_of(b) for b in as_list(boxes)]
    rows = result[0] if isinstance(result, tuple) else result
    rows = rows or []
    return [str(r[1]) for r in rows], [box_of(r[0]) for r in rows]


def count_cells(html):
    return html.count("<td>") + html.count("<th>")


def grid_from_words(texts, boxes):
    """Rebuild a table from where the words are: rows by height, columns by overlapping horizontal ranges.
    On a clean screenshot of a grid this is more faithful than the table-structure model. None if it is not a grid."""
    items = []
    for t, b in zip(texts, boxes):
        t = str(t).strip()
        try:
            x1, y1, x2, y2 = (float(v) for v in b)
        except (TypeError, ValueError):
            continue
        if t and x2 > x1 and y2 > y1:
            items.append({"t": t, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "yc": (y1 + y2) / 2})
    if len(items) < 4:
        return None
    hs = sorted(i["y2"] - i["y1"] for i in items)
    h = hs[len(hs) // 2]
    rows = []
    for it in sorted(items, key=lambda i: i["yc"]):
        if rows and abs(it["yc"] - sum(i["yc"] for i in rows[-1]) / len(rows[-1])) <= 0.5 * h:
            rows[-1].append(it)
        else:
            rows.append([it])
    most = max(len(r) for r in rows)
    if most < 2:
        return None
    # The table is the longest run of rows with at least half as many words as the fullest row (titles drop out).
    main = [len(r) >= max(2, (most + 1) // 2) for r in rows]
    best, cur = (0, 0), None
    for i, ok in enumerate(main + [False]):
        if ok and cur is None:
            cur = i
        elif not ok and cur is not None:
            if i - cur > best[1] - best[0]:
                best = (cur, i)
            cur = None
    rows = rows[best[0]:best[1]]
    if len(rows) < 2:
        return None
    # Columns from the body (the header row can be wider or narrower than its column).
    body = [w for r in (rows[1:] if len(rows) > 2 else rows) for w in r]
    bands = []
    for w in sorted(body, key=lambda i: i["x1"]):
        if bands and w["x1"] <= bands[-1][1] + 0.3 * h:
            bands[-1][1] = max(bands[-1][1], w["x2"])
        else:
            bands.append([w["x1"], w["x2"]])
    if len(bands) < 2:
        return None

    def band_of(w):
        def score(b):
            overlap = min(w["x2"], b[1]) - max(w["x1"], b[0])
            centre = abs((w["x1"] + w["x2"]) / 2 - (b[0] + b[1]) / 2)
            return (overlap, -centre)
        return max(range(len(bands)), key=lambda k: score(bands[k]))

    grid = []
    for r in rows:
        cells = [[] for _ in bands]
        for w in sorted(r, key=lambda i: i["x1"]):
            cells[band_of(w)].append(w["t"])
        grid.append([" ".join(c) for c in cells])
    filled = sum(1 for r in grid for c in r if c) / float(len(grid) * len(bands))
    return grid if filled >= 0.6 else None


def grid_html(grid):
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    head = "<tr>" + "".join("<th>" + esc(c) + "</th>" for c in grid[0]) + "</tr>"
    body = "".join("<tr>" + "".join("<td>" + esc(c) + "</td>" for c in r) + "</tr>" for r in grid[1:])
    return "<table>" + head + body + "</table>"


def read_table(path):
    kind, engine = make_engine()
    texts, boxes = words_of(kind, engine(path))
    grid = grid_from_words(texts, boxes)
    if not grid:
        return {"ok": False, "error": "no_table"}
    html = grid_html(grid)[:MAX_HTML]
    return {"ok": True, "html": html, "cells": count_cells(html)}


def _grid_salary_sheet():
    """A title, a logo, a header and three rows, as the OCR reports them (numbers right-aligned): the grid
    comes out as five clean columns with the title left out."""
    words = [("NYGGS", 80, 150, 190, 180), ("SALARY SHEET", 300, 130, 830, 200),
             ("Employee Name", 85, 245, 305, 280), ("Basic", 375, 245, 445, 280), ("Allowances", 520, 245, 680, 280),
             ("Deductions", 715, 245, 870, 280), ("Net Salary", 912, 245, 1055, 280)]
    for y, row in ((320, ("John Doe", "4.000", "1.000", "300", "4.700")), (380, ("Jane Smith", "4.500", "800", "300", "5.000")),
                   (440, ("Michael Johnson", "4.800", "1.200", "400", "5.600"))):
        xs = ((97, 97 + 12 * len(row[0])), (385, 458), (568 + (5 - len(row[2])) * 14, 640), (770, 820), (956, 1030))
        words += [(t, x[0], y, x[1], y + 32) for t, x in zip(row, xs)]
    g = grid_from_words([w[0] for w in words], [list(w[1:]) for w in words])
    return g == [["Employee Name", "Basic", "Allowances", "Deductions", "Net Salary"],
                 ["John Doe", "4.000", "1.000", "300", "4.700"], ["Jane Smith", "4.500", "800", "300", "5.000"],
                 ["Michael Johnson", "4.800", "1.200", "400", "5.600"]]


def selftest():
    class R:  # what RapidOCR 2.x/3.x returns
        boxes = [[[0, 0], [10, 0], [10, 5], [0, 5]]]
        txts = ("a",)
    checks = [
        _grid_salary_sheet(),
        box_of([[3, 4], [9, 4], [9, 8], [3, 8]]) == [3.0, 4.0, 9.0, 8.0],
        words_of("new", R()) == (["a"], [[0.0, 0.0, 10.0, 5.0]]),
        words_of("old", ([[[[1, 2], [5, 2], [5, 6], [1, 6]], "b", 0.9]], 0.1)) == (["b"], [[1.0, 2.0, 5.0, 6.0]]),
        words_of("old", (None, 0.1)) == ([], []),
        grid_from_words(["only", "words"], [[0, 0, 10, 5], [0, 20, 10, 25]]) is None,
        "<script>" not in grid_html([["<script>", "b"], ["1", "2"]]),
    ]
    print(json.dumps({"ok": all(checks), "checks": checks}))
    return 0 if all(checks) else 1


def main(argv):
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    real_out = sys.stdout
    sys.stdout = sys.stderr  # libraries may print; only our one JSON line may reach stdout
    try:
        if len(argv) == 2 and argv[1] == "--warmup":
            make_engine()
            out = {"ok": True}
        elif len(argv) == 2:
            out = read_table(argv[1])
        else:
            out = {"ok": False, "error": "usage"}
    except Exception as e:  # noqa: BLE001 - report, never crash Morph
        out = {"ok": False, "error": "failed", "detail": str(e)[:200]}
    real_out.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
