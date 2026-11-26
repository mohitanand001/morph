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
    # Text in a screenshot is never upside down, so the orientation check stays off: it turned "900" into "006".
    try:
        from rapidocr import RapidOCR
        try:
            return "new", RapidOCR(params={"Global.use_cls": False})
        except Exception:  # noqa: BLE001 - an older 2.x without this setting
            return "new", RapidOCR()
    except ImportError:
        from rapidocr_onnxruntime import RapidOCR
        return "old", RapidOCR(use_cls=False)


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
    """Rebuild a table from where the words are. Rows: words at the same height. Columns: the horizontal ranges
    of the full rows' cells, merged only where they overlap (neighbouring columns can sit a few pixels apart).
    Lines that do not line up with those columns (a title, a logo) are left out. None if it is not a grid."""
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
    # Columns from the rows that have a word in every column (or nearly), merged only where they overlap.
    full = [r for r in rows if len(r) == most]
    if len(full) < 2:
        full = [r for r in rows if len(r) >= max(2, most - 1)]
    bands = []
    for w in sorted((w for r in full for w in r), key=lambda i: i["x1"]):
        if bands and w["x1"] < bands[-1][1]:
            bands[-1][1] = max(bands[-1][1], w["x2"])
        else:
            bands.append([w["x1"], w["x2"]])
    if len(bands) < 2:
        return None

    def inside(w):
        """The column a word sits in, if it sits mostly inside one (None: it straddles columns or none)."""
        width = w["x2"] - w["x1"]
        for k, b in enumerate(bands):
            if min(w["x2"], b[1]) - max(w["x1"], b[0]) >= 0.6 * width:
                return k
        return None

    def nearest(w):
        c = (w["x1"] + w["x2"]) / 2
        return min(range(len(bands)), key=lambda k: 0 if bands[k][0] <= c <= bands[k][1] else min(abs(c - bands[k][0]), abs(c - bands[k][1])))

    # The table is the longest run of rows whose words mostly sit inside the columns, with enough of them.
    fits = [len(r) >= 2 and sum(inside(w) is not None for w in r) * 2 > len(r) for r in rows]
    best, cur = (0, 0), None
    for i, ok in enumerate(fits + [False]):
        if ok and cur is None:
            cur = i
        elif not ok and cur is not None:
            if i - cur > best[1] - best[0]:
                best = (cur, i)
            cur = None
    rows = rows[best[0]:best[1]]
    if len(rows) < 2:
        return None
    grid = []
    for r in rows:
        cells = [[] for _ in bands]
        for w in sorted(r, key=lambda i: i["x1"]):
            k = inside(w)
            cells[k if k is not None else nearest(w)].append(w["t"])
        grid.append([" ".join(c) for c in cells])
    # Columns nobody uses are dropped.
    keep = [k for k in range(len(bands)) if any(r[k] for r in grid)]
    grid = [[r[k] for k in keep] for r in grid]
    if len(keep) < 2:
        return None
    grid = strip_sheet_labels(grid)
    if len(grid) < 2 or len(grid[0]) < 2:
        return None
    filled = sum(1 for r in grid for c in r if c) / float(len(grid) * len(grid[0]))
    return grid if filled >= 0.6 else None


def strip_sheet_labels(grid):
    """A screenshot of a spreadsheet carries its column letters (A B C) and row numbers (1 2 3): leave them out.
    Only when the letters row is there, so a real numbered column in an ordinary table stays."""
    first = [c.strip() for c in grid[0]]
    letters = [c for c in first if c]
    if len(letters) < 2 or not all(len(c) == 1 and c.isalpha() and c.isupper() for c in letters):
        return grid
    if [ord(c) for c in letters] != list(range(ord(letters[0]), ord(letters[0]) + len(letters))):
        return grid
    body = grid[1:]
    col = [r[0].strip() for r in body]
    if not first[0] and col and all(c.isdigit() for c in col) and [int(c) for c in col] == list(range(int(col[0]), int(col[0]) + len(col))):
        body = [r[1:] for r in body]
    return body


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


def _network_blocked():
    import socket
    saved = (socket.socket.connect, socket.socket.connect_ex, socket.create_connection, socket.getaddrinfo)
    try:
        no_network()
        try:
            socket.create_connection(("pypi.org", 443), timeout=1)
            return False
        except OSError as e:
            return "never use the network" in str(e)
    finally:
        socket.socket.connect, socket.socket.connect_ex, socket.create_connection, socket.getaddrinfo = saved


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
        _network_blocked(),
        strip_sheet_labels([["", "A", "B"], ["1", "Item", "Qty"], ["2", "Pens", "10"]]) == [["Item", "Qty"], ["Pens", "10"]],
        strip_sheet_labels([["#", "Name"], ["1", "Asha"], ["2", "Ravi"]]) == [["#", "Name"], ["1", "Asha"], ["2", "Ravi"]],
    ]
    print(json.dumps({"ok": all(checks), "checks": checks}))
    return 0 if all(checks) else 1


def no_network():
    """Reading a table never uses the network: the models came with the install. Any attempt fails here."""
    import socket

    def refuse(*_a, **_k):
        raise OSError("Morph: image tables never use the network")

    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse


def main(argv):
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    reading = len(argv) == 2 and argv[1] != "--warmup"
    if reading:
        no_network()
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
        # While reading a table, only the kind of error is reported: its message could quote the picture's text.
        out = {"ok": False, "error": "failed", "detail": type(e).__name__ if reading else str(e)[:200]}
    real_out.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
