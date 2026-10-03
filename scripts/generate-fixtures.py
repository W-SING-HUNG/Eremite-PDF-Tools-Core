#!/usr/bin/env python3
"""
Generate P2 real-engine fixtures (qpdf 12.4.0, win-x64).

All "good" fixtures are produced with pikepdf (the official qpdf binding), so the
V1 structural gate (qpdf --check, exit 0) accepts them. Deliberately broken
variants (encrypted / malformed / recoverable anomaly) are produced by other
means and are expected to FAIL the gate.

Categories (P2 contract):
  alpha-multi          5-page plain baseline
  alpha-multi-b        3-page plain (merge second input)
  alpha-single         1-page boundary
  alpha-outlines       bookmarks / outlines
  alpha-forms          AcroForm text field
  alpha-annotations    text annotation
  alpha-pagelabels     decimal page labels
  alpha-encrypted      encrypted (gate -> pdf_validation.encrypted)
  alpha-malformed      not a parseable PDF (gate -> pdf_validation.malformed)
  alpha-recoverable    missing MediaBox on page 1 (gate -> recoverable_anomaly)
"""

import os
import subprocess
import sys
import shutil

import pikepdf
from pikepdf import Name, String, Array, Dictionary, Object

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QPDF = shutil.which("qpdf")
FIX = os.path.join(PROJECT, "tests", "fixtures")
TMP = os.path.join(PROJECT, ".fixture-tmp")
os.makedirs(FIX, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

PAGE_SIZE = (612, 792)


def blank(n):
    pdf = pikepdf.new()
    for _ in range(n):
        pdf.add_blank_page(page_size=PAGE_SIZE)
    return pdf


def save(pdf, name):
    out = os.path.join(FIX, name + ".pdf")
    pdf.save(out, normalize_content=True,
             object_stream_mode=pikepdf.ObjectStreamMode.disable)
    return out


def check_exit(path):
    r = subprocess.run([QPDF, "--check", path], capture_output=True, text=True)
    return r.returncode


def is_enc_exit(path):
    r = subprocess.run([QPDF, "--is-encrypted", path], capture_output=True, text=True)
    return r.returncode


def main():
    assert QPDF, "external qpdf 12.4.0 not found on PATH"
    version = subprocess.run([QPDF, "--version"], capture_output=True, text=True, check=True)
    assert version.stdout.splitlines()[0].strip() == "qpdf version 12.4.0", "qpdf 12.4.0 required"

    # 1) plain multi-page baseline (5 pages)
    save(blank(5), "alpha-multi")
    # 1b) second plain doc for merge (3 pages)
    save(blank(3), "alpha-multi-b")
    # 1c) single-page boundary
    save(blank(1), "alpha-single")

    # 2) outlines / bookmarks to pages 1, 3, 5
    pdf = blank(5)
    with pdf.open_outline() as outline:
        for i in (0, 2, 4):
            outline.add(f"Bookmark {(i // 2) + 1}", destination=pdf.pages[i].obj)
    save(pdf, "alpha-outlines")

    # 3) forms (AcroForm with one text field on page 1)
    pdf = blank(5)
    page0 = pdf.pages[0]
    widget = pdf.make_indirect(Dictionary(
        Type=Name("/Annot"),
        Subtype=Name("/Widget"),
        Rect=Array([100, 100, 260, 130]),
        F=4,
        T=String("field1"),
    ))
    field = pdf.make_indirect(Dictionary(
        T=String("field1"),
        FT=Name("/Tx"),
        V=String(""),
        Kids=Array([widget]),
    ))
    widget.Parent = field
    if Name("/Annots") in page0:
        page0.Annots.append(widget)
    else:
        page0.Annots = pdf.make_indirect(Array([widget]))
    acro = pdf.make_indirect(Dictionary(
        Fields=Array([field]),
        NeedAppearances=True,
    ))
    pdf.Root.AcroForm = acro
    save(pdf, "alpha-forms")

    # 4) annotations (text annotation on page 1)
    pdf = blank(5)
    page0 = pdf.pages[0]
    annot = pdf.make_indirect(Dictionary(
        Type=Name("/Annot"),
        Subtype=Name("/Text"),
        Rect=Array([72, 600, 220, 660]),
        Contents=String("Sticky note"),
        Open=False,
    ))
    if Name("/Annots") in page0:
        page0.Annots.append(annot)
    else:
        page0.Annots = pdf.make_indirect(Array([annot]))
    save(pdf, "alpha-annotations")

    # 5) page labels (decimal from 1)
    pdf = blank(5)
    pdf.Root.PageLabels = pdf.make_indirect(Dictionary(
        Nums=Array([0, Dictionary(S=Name("/D"))])
    ))
    save(pdf, "alpha-pagelabels")

    # 6) encrypted (via qpdf --encrypt on the clean baseline)
    src = os.path.join(FIX, "alpha-multi.pdf")
    enc = os.path.join(FIX, "alpha-encrypted.pdf")
    r = subprocess.run([QPDF, "--encrypt", "userpw", "ownerpw", "256", "--", src, enc],
                       capture_output=True, text=True)
    print(f"encrypt rc={r.returncode}")

    # 7) malformed (not a parseable PDF)
    with open(os.path.join(FIX, "alpha-malformed.pdf"), "wb") as f:
        f.write(b"%PDF-1.4\n")
        f.write(b"this file is not a valid PDF document, no objects, no xref\n")
        f.write(b"%%EOF\n")

    # 8) recoverable anomaly (page 1 missing /MediaBox -> qpdf warns, exit 3)
    #    Hand-built raw PDF whose page 1 lacks MediaBox.
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] /Count 5 >>")
    for i in range(5):
        if i == 0:
            # page 1 intentionally missing /MediaBox
            objs.append(b"<< /Type /Page /Parent 2 0 R "
                        b"/Resources << /Font << /F1 8 0 R >> >> /Contents 9 0 R >>")
        else:
            objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                        b"/Resources << /Font << /F1 8 0 R >> >> /Contents %d 0 R >>" % (9 + i))
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i in range(5):
        stream = ("BT /F1 14 Tf 72 720 Td (PDF page %d) Tj ET" % (i + 1)).encode()
        objs.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    n = len(objs)
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for idx, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{idx} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {n + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += b"trailer\n<< /Size " + str(n + 1).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref).encode() + b"\n%%EOF\n"
    with open(os.path.join(FIX, "alpha-recoverable.pdf"), "wb") as f:
        f.write(bytes(out))

    # Diagnosis
    print("--- gate diagnostics (good fixtures expect check_exit=0) ---")
    for n in ["alpha-multi", "alpha-multi-b", "alpha-single", "alpha-outlines",
              "alpha-forms", "alpha-annotations", "alpha-pagelabels"]:
        p = os.path.join(FIX, n + ".pdf")
        print(f"  {n}: check_exit={check_exit(p)} is_enc={is_enc_exit(p)}")
    print(f"  alpha-encrypted: is_enc={is_enc_exit(os.path.join(FIX,'alpha-encrypted.pdf'))} check={check_exit(os.path.join(FIX,'alpha-encrypted.pdf'))}")
    print(f"  alpha-malformed: is_enc={is_enc_exit(os.path.join(FIX,'alpha-malformed.pdf'))} check={check_exit(os.path.join(FIX,'alpha-malformed.pdf'))}")
    print(f"  alpha-recoverable: is_enc={is_enc_exit(os.path.join(FIX,'alpha-recoverable.pdf'))} check={check_exit(os.path.join(FIX,'alpha-recoverable.pdf'))}")


if __name__ == "__main__":
    main()
