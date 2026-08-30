#!/usr/bin/env python3
"""
Extract the ECOD RSA Question Bank (v1.3) from the source PDF into JSON.

The PDF is a landscape spreadsheet export: one table row per question, with
fixed-height cells. Two properties make naive text extraction wrong:

  1. `extract_text()` interleaves columns, so a record's fields run together.
  2. Cells are CLIPPED by the exporter - a long MCQ option simply is not in
     the PDF byte stream. Nothing can recover that text; it is not hidden,
     it was never written. We therefore extract what exists and flag the
     records an admin must complete.

Strategy: use pypdf's text visitor to get every fragment with its (x, y)
device coordinates, bucket fragments into columns by x, and into records by
y-range (a record owns every fragment from its own "RSA-..." id line down to
the next id line). That removes both the column interleaving and the row
bleed a pure y-bucketing approach suffers from.

Usage:  python3 scripts/extract-question-bank.py <input.pdf> <output.json>
"""
import json
import re
import sys

from pypdf import PdfReader

# Left edge of every column in the exported table, in PDF user-space units.
COLUMNS = [
    (58.0, 'qid'), (86.0, 'module'), (99.0, 'type'), (146.5, 'question'),
    (229.2, 'probes'), (298.0, 'evidence'), (369.6, 'redflags'),
    (430.1, 'gaptag'), (478.3, 'enrich'), (545.7, 'minutes'),
    (560.0, 'status'), (595.4, 'version'), (642.2, 'family'), (700.9, 'tail'),
]
QID_RE = re.compile(r'^RSA-[A-Z]\d{2}-\d{3}$')
MODULE_RE = re.compile(r'^[A-Z]\d{2}$')
# Trailing metadata, read off the flat text because those columns are narrow
# and never wrap: minutes, status, version, family, band, mode, randomizable.
TAIL_RE = re.compile(
    r'(\d+)\s+(Active|Draft|Retired|Inactive)\s+([\d.]+)\s+(.+?)\s+'
    r'(Foundation|Intermediate|Advanced|Expert)\s+'
    r'(Live assessor|Online assessment|Either|Self-directed)\s+(Yes|No)\s*$',
    re.S,
)
TYPES = (
    'Objective Question|Common Question|Customer Simulation|Architecture Case|'
    'Deep Dive|Experience Probe|Discovery|Communication|Concept|Incident|'
    'Migration|Scenario|Practical'
)
HEAD_RE = re.compile(r'^([A-Z]\d{2})\s+(' + TYPES + r')\s+([1-5])\s+(.*)$', re.S)


def column_of(x):
    name = COLUMNS[0][1]
    for edge, label in COLUMNS:
        if x >= edge - 4:
            name = label
    return name


def fragments(page):
    """
    Every non-empty text fragment as (x, y, text).

    pypdf reports the *first* line of a wrapped table cell at the origin
    (0, 0) rather than at its true position, because the exporter emits it
    before the positioning operator. Such a fragment always immediately
    precedes the rest of its own cell, so it inherits the coordinates of the
    next fragment that does carry a real position.
    """
    raw = []
    page.extract_text(
        visitor_text=lambda t, cm, tm, f, s:
            raw.append((round(tm[4], 1), round(tm[5], 1), t)) if t.strip() else None
    )
    out, pending = [], []
    for x, y, text in raw:
        if x == 0.0 and y == 0.0:
            pending.append(text)
            continue
        # Held lines belong to the SAME cell as this fragment and precede it.
        # Nudge them a hair above it so they sort first while staying well
        # inside their own record's y-interval (a full line-height offset
        # would push them past the record boundary).
        for position, held in enumerate(pending):
            out.append((x, y + (len(pending) - position) * 0.01, held))
        pending.clear()
        out.append((x, y, text))
    return sorted(out, key=lambda f: (-f[1], f[0]))


def flat_records(reader):
    """Flat text pass -> reliable trailing metadata keyed by question id."""
    text = '\n'.join((p.extract_text() or '') for p in reader.pages)
    parts = re.split(r'(RSA-[A-Z]\d{2}-\d{3})', text)
    meta = {}
    for i in range(1, len(parts) - 1, 2):
        qid, body = parts[i], parts[i + 1]
        blob = ' '.join(body.split())
        tail = TAIL_RE.search(blob)
        if not tail:
            continue
        head = HEAD_RE.match(blob[:tail.start()].strip())
        if not head:
            continue
        meta[qid] = {
            'module': head.group(1), 'type': head.group(2),
            'difficulty': int(head.group(3)),
            'minutes': int(tail.group(1)), 'status': tail.group(2),
            'version': tail.group(3), 'question_family': tail.group(4).strip(),
            'band': tail.group(5), 'mode': tail.group(6),
            'randomizable': tail.group(7) == 'Yes',
        }
    return meta


def cell_records(reader):
    """
    Coordinate pass -> per-column cell text, split by record y-interval.

    A record owns every fragment whose baseline lies in [next_start, own_start],
    i.e. from its own id line down to (but excluding) the following record's id
    line. Fragments are then concatenated per column in descending-y order,
    which reproduces the reading order inside each wrapped cell.
    """
    cells = {}
    for page in reader.pages:
        frags = fragments(page)
        starts = []  # (y, qid) for every record beginning on this page
        for x, y, text in frags:
            if column_of(x) == 'qid' and QID_RE.match(text.strip()):
                starts.append((y, text.strip()))
        starts.sort(key=lambda s: -s[0])
        if not starts:
            continue
        for index, (top, qid) in enumerate(starts):
            # Half-open interval down to the next record on the page.
            bottom = starts[index + 1][0] if index + 1 < len(starts) else -1e9
            # Strict half-open interval (bottom, top]. The exporter clips a
            # cell's last line so tightly that it can sit a fraction of a
            # point ABOVE the next record's id line - with no tolerance on
            # `bottom` that line still resolves to the record it belongs to.
            owned = [
                (x, y, t) for x, y, t in frags
                if bottom < y <= top + 1.0
            ]
            record = cells.setdefault(qid, {})
            for x, y, text in sorted(owned, key=lambda f: (-f[1], f[0])):
                col = column_of(x)
                token = text.strip()
                if col == 'qid':
                    if MODULE_RE.match(token):
                        record.setdefault('module', []).append(token)
                    continue
                record.setdefault(col, []).append(token)
    return {
        qid: {k: ' '.join(v).strip() for k, v in fields.items()}
        for qid, fields in cells.items()
    }


def strip_bleed(cell, module, qtype, difficulty):
    """
    Remove text the previous record's clipped final line bled into this cell.

    The exporter can place a record's last visible line a hair above the next
    record's id baseline, so it lands at the top of the next cell. The real
    start of a cell is always identifiable: the row's own metadata
    ("C01 Customer Simulation 5") and/or the bare difficulty digit precede it.
    Cutting at the LAST such marker discards the foreign prefix and keeps the
    genuine text intact.
    """
    text = cell.strip()
    patterns = [
        rf'{module}\s+{re.escape(qtype)}\s+[1-5]\s+',
        rf'{re.escape(qtype)}\s+[1-5]\s+',
        rf'(?<![\w-]){module}\s+',
        rf'(?<![\d.]){difficulty}\s+',
    ]
    for pattern in patterns:
        hits = list(re.finditer(pattern, text))
        if hits:
            return text[hits[-1].end():].strip()
    return text


def split_objective(question_cell, evidence_cell, correct_letter):
    """
    Recover the MCQ stem and whatever option text survived the PDF clipping.
    The correct option's *full* text is always present in the Expected
    Evidence column, so it is restored verbatim; the distractors are kept as
    far as they were exported.
    """
    # The type column's difficulty digit leaks into the first line of the
    # question cell ("4 A customer says, ..."); drop it.
    question_cell = re.sub(r'^[1-5]\s+', '', question_cell.strip())
    marks = [(m.start(), m.group(1)) for m in re.finditer(r'\b([A-D])\)\s', question_cell)]
    stem = (question_cell[:marks[0][0]] if marks else question_cell).strip()
    options = {}
    for i, (pos, letter) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(question_cell)
        options[letter] = question_cell[pos + 2:end].strip()
    if correct_letter and evidence_cell:
        options[correct_letter] = evidence_cell.strip()
    return stem, options


def main(pdf_path, out_path):
    reader = PdfReader(pdf_path)
    meta = flat_records(reader)
    cells = cell_records(reader)

    records = []
    for qid in sorted(meta):
        m, c = meta[qid], cells.get(qid, {})
        objective = m['type'] == 'Objective Question'
        probes = c.get('probes', '')
        evidence = c.get('evidence', '')
        correct = None
        rec = {
            'id': qid,
            'module': m['module'],
            'type': m['type'],
            'objective': objective,
            'difficulty': m['difficulty'],
            'question_family': m['question_family'],
            'band': m['band'],
            'mode': m['mode'],
            'minutes': m['minutes'],
            'status': m['status'],
            'version': m['version'],
            'randomizable': m['randomizable'],
            'gap_tag': c.get('gaptag', ''),
            'enrichment': c.get('enrich', ''),
        }
        cleaned = strip_bleed(c.get('question', ''), m['module'], m['type'], m['difficulty'])
        if objective:
            hit = re.search(r'Correct answer:\s*([A-D])', probes)
            correct = hit.group(1) if hit else None
            stem, options = split_objective(cleaned, evidence, correct)
            rec.update({
                'prompt': stem,
                'options': options,
                'correct': correct,
                'rationale': probes,
                'red_flags': c.get('redflags', ''),
                # Fewer than four options means the exporter clipped a
                # distractor: usable, but an admin should complete it.
                'needs_option_review': len(options) < 4,
            })
        else:
            rec.update({
                'prompt': cleaned,
                'probes': [p.strip() for p in probes.split(';') if p.strip()],
                'expected_evidence': evidence,
                'red_flags': c.get('redflags', ''),
            })
        records.append(rec)

    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(records, fh, indent=1, ensure_ascii=False)
    print(f'extracted {len(records)} questions -> {out_path}')
    return records


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
