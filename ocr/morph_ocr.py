#!/usr/bin/env python3
"""Reads a table out of an image with PaddleOCR, on this machine only.

  morph_ocr.py IMAGE.png     prints one JSON line:  {"ok": true, "html": "<table>...</table>", "cells": 12}
                              or                    {"ok": false, "error": "no_table"}
  morph_ocr.py --warmup      loads the models once (this is the only step that downloads anything)
  morph_ocr.py --selftest    checks the result parsing without PaddleOCR (used by Morph's tests)

Morph never sends the image anywhere: this script is run locally and its answer is read from its output.
"""
import json
import os
import re
import sys

# PaddlePaddle's oneDNN (MKLDNN) CPU path fails on some versions with
# "ConvertPirAttribute2RuntimeAttribute not support": run without it (a little slower, and reliable).
os.environ.setdefault("FLAGS_use_mkldnn", "0")
if "--warmup" not in sys.argv:  # after the warm-up, no network checks
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

TABLE_KEYS = ("pred_html", "html")
MAX_HTML = 400000


def find_tables(obj, out):
    """Every HTML table string anywhere in a (nested) result. The result layout differs between PaddleOCR versions."""
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key in TABLE_KEYS and isinstance(val, str) and "<table" in val.lower():
                out.append(val)
            else:
                find_tables(val, out)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            find_tables(item, out)
    return out


def as_plain(res):
    """A prediction object as plain dicts and lists."""
    for attr in ("json", "res"):
        val = getattr(res, attr, None)
        if val is not None:
            return val
    return res


def clean_table(html):
    """Just the table: PaddleOCR wraps it in <html><body>. Scripts and handlers are never kept."""
    m = re.search(r"<table.*?</table>", html, re.S | re.I)
    table = m.group(0) if m else html
    table = re.sub(r"<(script|style)\b.*?</\1>", "", table, flags=re.S | re.I)
    table = re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", table, flags=re.I)
    return table[:MAX_HTML]


def count_cells(html):
    return len(re.findall(r"<t[dh]\b", html, re.I))


def _make(cls, options):
    """Build a pipeline with the options this PaddleOCR version knows; drop the ones it does not.
    PaddleOCR reports an unknown option as a TypeError or a ValueError ("Unknown argument: x")."""
    opts = dict(options)
    while True:
        try:
            return cls(**opts)
        except (TypeError, ValueError) as e:
            bad = next((k for k in opts if k in str(e)), None)
            if not bad:
                raise
            opts.pop(bad)


# Only what each reader uses: the table reader has no seal, formula or chart parts.
PIPELINE_OPTIONS = {
    "TableRecognitionPipelineV2": {"use_doc_orientation_classify": False, "use_doc_unwarping": False, "enable_mkldnn": False},
    "PPStructureV3": {"use_doc_orientation_classify": False, "use_doc_unwarping": False, "use_seal_recognition": False,
                      "use_formula_recognition": False, "use_chart_recognition": False, "enable_mkldnn": False},
}


def build_pipeline():
    # PaddleOCR 3.x: the table-only pipeline first (fewer models to download), then the full document one.
    errors = []
    for name in ("TableRecognitionPipelineV2", "PPStructureV3"):
        try:
            mod = __import__("paddleocr", fromlist=[name])
            cls = getattr(mod, name)
        except (ImportError, AttributeError) as e:
            errors.append(str(e))
            continue
        return "v3", _make(cls, PIPELINE_OPTIONS[name])
    try:
        from paddleocr import PPStructure  # PaddleOCR 2.x
    except ImportError:
        raise RuntimeError("PaddleOCR has no table pipeline here: " + "; ".join(errors)[:150])
    return "v2", PPStructure(table=True, ocr=True, layout=True, show_log=False)


def find_ocr(obj, best=None):
    """The OCR'd words with their boxes: the dict with the most rec_texts anywhere in the result."""
    if isinstance(obj, dict):
        texts = obj.get("rec_texts")
        boxes = obj.get("rec_boxes")
        if boxes is None and obj.get("rec_polys") is not None:
            boxes = [[min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q)] for q in obj["rec_polys"]]
        if isinstance(texts, list) and boxes is not None and len(texts) == len(boxes) and (best is None or len(texts) > len(best[0])):
            best = (texts, [list(b)[:4] for b in boxes])
        for val in obj.values():
            best = find_ocr(val, best)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            best = find_ocr(item, best)
    return best


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
    kind, pipe = build_pipeline()
    if kind == "v3":
        results = [as_plain(r) for r in pipe.predict(input=path)]
    else:
        import cv2
        results = pipe(cv2.imread(path))
    # First choice: the grid rebuilt from the words' positions. Fallback: the table-structure model's HTML.
    words = find_ocr(results)
    grid = grid_from_words(*words) if words else None
    if grid:
        html = grid_html(grid)
        return {"ok": True, "html": html, "cells": count_cells(html), "how": "grid"}
    tables = find_tables(results, [])
    if not tables:
        return {"ok": False, "error": "no_table"}
    html = clean_table(max(tables, key=len))
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


def _make_drops_unknown():
    """A reader that rejects an option the way PaddleOCR 3 does is built without it."""
    class Fake:
        def __init__(self, **kw):
            for k in kw:
                if k not in ("use_doc_orientation_classify",):
                    raise ValueError("Unknown argument: " + k)
            self.kw = kw
    try:
        return _make(Fake, {"use_doc_orientation_classify": False, "use_formula_recognition": False}).kw == {"use_doc_orientation_classify": False}
    except Exception:  # noqa: BLE001
        return False


def selftest():
    v3 = [{"res": {"table_res_list": [{"pred_html": "<html><body><table><tr><td>a</td><td>b</td></tr></table></body></html>"}]}}]
    v2 = [{"type": "table", "res": {"html": "<table><tr><td>x</td></tr></table>"}}, {"type": "text", "res": [{"text": "hi"}]}]
    none = [{"res": {"overall_ocr_res": {"rec_texts": ["hello"]}}}]
    evil = '<table onclick="x()"><tr><td>1<script>alert(1)</script></td></tr></table>'
    checks = [
        find_tables(v3, []) == [v3[0]["res"]["table_res_list"][0]["pred_html"]],
        find_tables(v2, []) == ["<table><tr><td>x</td></tr></table>"],
        find_tables(none, []) == [],
        clean_table(v3[0]["res"]["table_res_list"][0]["pred_html"]) == "<table><tr><td>a</td><td>b</td></tr></table>",
        "script" not in clean_table(evil) and "onclick" not in clean_table(evil),
        count_cells("<table><tr><th>a</th><td>b</td></tr></table>") == 2,
        _make_drops_unknown(),
        _grid_salary_sheet(),
        "use_formula_recognition" not in PIPELINE_OPTIONS["TableRecognitionPipelineV2"],
        all(o.get("enable_mkldnn") is False for o in PIPELINE_OPTIONS.values()) and os.environ.get("FLAGS_use_mkldnn") == "0",
    ]
    print(json.dumps({"ok": all(checks), "checks": checks}))
    return 0 if all(checks) else 1


def main(argv):
    if len(argv) == 2 and argv[1] == "--selftest":
        return selftest()
    real_out = sys.stdout
    sys.stdout = sys.stderr  # PaddleOCR prints progress; only our one JSON line may reach stdout
    try:
        if len(argv) == 2 and argv[1] == "--warmup":
            build_pipeline()
            out = {"ok": True}
        elif len(argv) == 2 and os.path.isfile(argv[1]):
            out = read_table(argv[1])
        else:
            out = {"ok": False, "error": "usage"}
    except Exception as e:  # noqa: BLE001 - report, never crash Morph
        out = {"ok": False, "error": "failed", "detail": str(e)[:200]}
    real_out.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
