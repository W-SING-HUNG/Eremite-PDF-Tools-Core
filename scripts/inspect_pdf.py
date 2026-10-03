#!/usr/bin/env python3
"""
PDF document-level feature inspector (qpdf-backed via pikepdf).

Used by the P2 test suite to EMPIRICALLY assert document-level preservation /
loss behavior of real qpdf outputs (outlines, annotations, forms, page labels,
page count, per-page rotation). Prints a single JSON line to stdout.

This is a test/diagnostic helper only; it never ships in the runtime path.
"""
import sys
import json
import pikepdf


def inspect(path):
    with pikepdf.open(path) as pdf:
        root = pdf.Root
        pages = len(pdf.pages)

        has_outline = "/Outlines" in root
        has_form = "/AcroForm" in root
        has_pagelabels = "/PageLabels" in root

        annotation_count = 0
        for page in pdf.pages:
            if "/Annots" in page:
                annotation_count += len(page.Annots)

        rotations = []
        for page in pdf.pages:
            try:
                r = int(page.get("/Rotate", 0))
            except Exception:
                r = 0
            rotations.append(r % 360)

    return {
        "pages": pages,
        "has_outline": has_outline,
        "has_form": has_form,
        "has_pagelabels": has_pagelabels,
        "annotation_count": annotation_count,
        "rotations": rotations,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: inspect_pdf.py <file.pdf>"}))
        sys.exit(2)
    try:
        info = inspect(sys.argv[1])
        print(json.dumps(info))
        sys.exit(0)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
