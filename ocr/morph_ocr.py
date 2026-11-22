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
    "TableRecognitionPipelineV2": {"use_doc_orientation_classify": False, "use_doc_unwarping": False},
    "PPStructureV3": {"use_doc_orientation_classify": False, "use_doc_unwarping": False, "use_seal_recognition": False,
                      "use_formula_recognition": False, "use_chart_recognition": False},
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


def read_table(path):
    kind, pipe = build_pipeline()
    if kind == "v3":
        results = [as_plain(r) for r in pipe.predict(input=path)]
    else:
        import cv2
        results = pipe(cv2.imread(path))
    tables = find_tables(results, [])
    if not tables:
        return {"ok": False, "error": "no_table"}
    html = clean_table(max(tables, key=len))
    return {"ok": True, "html": html, "cells": count_cells(html)}


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
        "use_formula_recognition" not in PIPELINE_OPTIONS["TableRecognitionPipelineV2"],
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
