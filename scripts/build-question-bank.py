#!/usr/bin/env python3
"""
Build src/content/rsa-question-bank.mjs from the extracted question JSON.

Pipeline:
    scripts/extract-question-bank.py  "Question bank 1.2.pdf"  bank.json
    scripts/build-question-bank.py    bank.json                src/content/rsa-question-bank.mjs

The emitted module is organised MODULE -> FAMILY -> QUESTION, which is also the
order questions appear in the file, so the catalogue reads the same way the
Admin UI presents it and a new question has exactly one place to go.

A family name is only unique *within* a module: "Advanced Technical Judgment"
exists in all ten technical modules, and "Customer Solutioning" in nine
non-technical ones. Families are therefore addressed by the compound id
`<MODULE>:<family-slug>` (e.g. `T05:delta-lake-physical-design`), which is what
makes "add this question to that family" unambiguous.

Usage:  python3 scripts/build-question-bank.py <bank.json> <output.mjs>
"""
import json
import re
import sys
from collections import OrderedDict

# The mandatory question - the single "Common Question" in the bank. It is
# served first on every paper and lives in its own synthetic module, M00.
MANDATORY_ID = 'RSA-F01-002'

# Top-level grouping of modules. These are *groups*, not families: "family"
# is reserved throughout for the per-module question families the PDF names in
# its own "Question Family" column.
GROUPS = [
    ('mandatory',    'Mandatory',                        0,
     'Always served, on every generated test.'),
    ('technical',    'Technical',                        1,
     'Databricks platform depth: architecture, engineering, governance, performance and AI.'),
    ('consulting',   'Consulting & Client Skills',       2,
     'Discovery, solution options, objection handling and engagement accountability.'),
    ('professional', 'Professional & Communication',     3,
     'Executive communication, listening, presentation and technical translation.'),
    ('foundation',   'Foundation & Integrated Judgment', 4,
     'Databricks value, the RSA role and whole-engagement judgment.'),
]

MODULE_TITLES = {
    'F01': 'Databricks Value & RSA Role',
    'F02': 'Integrated Client Engagement & Validation',
    'T01': 'Databricks Architecture, Lakehouse & Data Intelligence',
    'T02': 'Data Ingestion, Streaming & Change Processing',
    'T03': 'Lakeflow Pipelines, Jobs & Data Quality',
    'T04': 'SQL, PySpark & Data Engineering',
    'T05': 'Delta Lake, Performance, Compute & Cost Optimization',
    'T06': 'Unity Catalog, Security & Data Governance',
    'T07': 'APIs, Integration & Serving',
    'T08': 'Migration, Troubleshooting & Production Operations',
    'T09': 'AI/BI, Semantic Layer & Genie',
    'T10': 'GenAI, RAG & Agent Operations',
    'C01': 'Discovery & Requirement Structuring',
    'C02': 'Solution Options & Commercial Judgment',
    'C03': 'Objection Handling & Consultative Influence',
    'C04': 'Engagement Communication & Accountability',
    'P01': 'Executive Communication & Value Framing',
    'P02': 'Active Listening & Conflict Navigation',
    'P03': 'Architecture Presentation & Whiteboarding',
    'P04': 'Technical-to-Business Translation',
}

GROUP_OF = {'T': 'technical', 'C': 'consulting', 'P': 'professional', 'F': 'foundation'}


def slug(text):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', text.lower())).strip('-')


def flat(text):
    """Collapse whitespace - used in generated comments."""
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def js(value):
    """Emit a JS single-quoted string literal."""
    text = re.sub(r'\s+', ' ', str(value or '')).strip()
    return "'" + text.replace('\\', '\\\\').replace("'", "\\'") + "'"


def module_order(key):
    """Modules ordered M00, then T01-T10, C01-C04, P01-P04, F01-F02."""
    base = {'T': 10, 'C': 20, 'P': 30, 'F': 40}[key[0]]
    return base + int(key[1:])


def family_role(questions):
    """What a family supplies, which drives the default type when authoring."""
    has_objective = any(q['objective'] for q in questions)
    has_open = any(not q['objective'] for q in questions)
    if has_objective and has_open:
        return 'mixed'
    return 'objective' if has_objective else 'open'


def build(bank_path, out_path):
    bank = json.load(open(bank_path, encoding='utf-8'))

    # ---- group questions: module -> family -> [questions] --------------
    modules = OrderedDict()
    for question in bank:
        key = question['module']
        modules.setdefault(key, OrderedDict())

    for key in sorted(modules, key=module_order):
        rows = [q for q in bank if q['module'] == key]
        families = OrderedDict()
        # Objective-holding families first (a module's core), then the open
        # families alphabetically - stable, and it reads well in the UI.
        for name in sorted(
            {q['question_family'] for q in rows},
            key=lambda n: (
                not any(q['objective'] for q in rows if q['question_family'] == n),
                n,
            ),
        ):
            members = [q for q in rows if q['question_family'] == name]
            members.sort(key=lambda q: (not q['objective'], q['id']))
            families[name] = members
        modules[key] = families

    lines = []
    w = lines.append

    w('/**')
    w(' * ECOD RSA Question Bank v1.2 - the published, finalized catalogue.')
    w(' *')
    w(' * Organised MODULE -> FAMILY -> QUESTION. Generated by')
    w(' * scripts/build-question-bank.py from the extracted source PDF; edit the')
    w(' * generator (or the Admin UI), not this file by hand.')
    w(' *')
    w(' *   M00       Mandatory     1 question, served first on every test')
    w(' *   T01-T10   Technical     3 objective + 1 open served per module')
    w(' *   C01-C04   Consulting    1 open served per module')
    w(' *   P01-P04   Professional  1 open served per module')
    w(' *   F01-F02   Foundation    1 open served per module')
    w(' *')
    w(' * Every generated test is 1 + (10 x 4) + (10 x 1) = 51 questions. See')
    w(' * src/core/test-generation.mjs for the selection logic.')
    w(' *')
    w(' * FAMILIES ARE SCOPED TO A MODULE. A family name is not unique on its own -')
    w(' * "Advanced Technical Judgment" exists in all ten technical modules - so the')
    w(' * addressable unit is the compound id `<MODULE>:<family-slug>`, e.g.')
    w(' * `T05:delta-lake-physical-design`. A new question is added to exactly one')
    w(' * such family, and `family_id` is what pins it there.')
    w(' *')
    w(' * `needs_option_review` marks an objective question whose distractor text the')
    w(' * source PDF clipped on export; its stem and correct answer are complete and')
    w(' * the item is fully usable, but an admin should finish the remaining options.')
    w(' */')
    w('')
    w("export const QUESTION_BANK_VERSION = '1.2';")
    w('')
    w('/** The mandatory question served first on every test. */')
    w(f"export const MANDATORY_QUESTION_ID = '{MANDATORY_ID}';")
    w('')
    w('/** Top-level grouping of modules (not to be confused with question families). */')
    w('export const MODULE_GROUPS = [')
    for key, name, order, description in GROUPS:
        w(f"  {{ key: '{key}', name: {js(name)}, order: {order},")
        w(f"    description: {js(description)} }},")
    w('];')
    w('')

    # ---- modules, each carrying its own families -----------------------
    w('/**')
    w(' * Every module, with the families that live inside it. `role` says what a')
    w(' * family supplies, so the question editor can default the answer type:')
    w(" * 'objective', 'open', or 'mixed'.")
    w(' */')
    w('export const MODULES = [')
    w("  { key: 'M00', name: 'Mandatory Common Question', group: 'mandatory', order: 0,")
    w('    mandatory: true, technical: false,')
    w("    description: 'The common question every candidate answers, served first on every test.',")
    w('    families: [')
    w("      { id: 'M00:common-question', key: 'common-question', name: 'Common Question',")
    w("        role: 'open', objective: 0, open: 1 },")
    w('    ] },')
    for key in sorted(modules, key=module_order):
        families = modules[key]
        group = GROUP_OF[key[0]]
        technical = 'true ' if key[0] == 'T' else 'false'
        w(f"  {{ key: '{key}', name: {js(MODULE_TITLES[key])}, group: '{group}', order: {module_order(key)},")
        w(f"    mandatory: false, technical: {technical},")
        w('    families: [')
        for name, members in families.items():
            served = [q for q in members if q['id'] != MANDATORY_ID]
            objective = sum(1 for q in served if q['objective'])
            w(f"      {{ id: '{key}:{slug(name)}', key: '{slug(name)}', name: {js(name)},")
            w(f"        role: '{family_role(served) if served else 'open'}',"
              f" objective: {objective}, open: {len(served) - objective} }},")
        w('    ] },')
    w('];')
    w('')

    # ---- the questions themselves, module by module, family by family ---
    w('/** Every question, ordered by module and then by family. */')
    w('export const QUESTIONS = [')
    for key in sorted(modules, key=module_order):
        families = modules[key]
        total = sum(len(v) for v in families.values())
        w(f'  // ==================================================================')
        w(f'  // {key} - {flat(MODULE_TITLES[key])}')
        w(f'  // {total} questions across {len(families)} famil'
          f'{"y" if len(families) == 1 else "ies"}')
        w(f'  // ==================================================================')
        for name, members in families.items():
            objective = sum(1 for q in members if q['objective'])
            w(f'  // -- {key} / {flat(name)} '
              f'({objective} objective / {len(members) - objective} open)')
            for q in members:
                w('  {')
                w(f"    id: '{q['id']}', module: '{key}',")
                w(f"    family_id: '{key}:{slug(name)}', family: {js(name)},")
                w(f"    type: '{'objective' if q['objective'] else 'open'}',"
                  f" source_type: {js(q['type'])},")
                w(f"    difficulty: {q['difficulty']}, band: {js(q['band'])}, mode: {js(q['mode'])},")
                w(f"    minutes: {q['minutes']}, status: {js(q['status'])}, version: {js(q['version'])},")
                w(f"    randomizable: {'true' if q['randomizable'] else 'false'},")
                w(f"    mandatory: {'true' if q['id'] == MANDATORY_ID else 'false'},")
                w(f"    prompt: {js(q['prompt'])},")
                if q['objective']:
                    w('    options: [')
                    for letter in sorted(q['options']):
                        w(f"      {{ id: '{letter.lower()}', label: {js(q['options'][letter])} }},")
                    w('    ],')
                    w(f"    correct_option_ids: ['{(q['correct'] or 'a').lower()}'],")
                    w(f"    rationale: {js(q['rationale'])},")
                    w(f"    needs_option_review: {'true' if q['needs_option_review'] else 'false'},")
                else:
                    w(f"    probes: [{', '.join(js(p) for p in q['probes'])}],")
                    w(f"    rubric: {js(q['expected_evidence'])},")
                w(f"    red_flags: {js(q['red_flags'])},")
                w(f"    gap_tag: {js(q['gap_tag'])},")
                w(f"    enrichment: {js(q['enrichment'])},")
                w('  },')
    w('];')
    w('')
    w('/** Every family in the bank, flattened, for lookup by compound id. */')
    w('export const FAMILIES = MODULES.flatMap((m) =>')
    w('  m.families.map((f) => ({ ...f, module: m.key, group: m.group })));')
    w('')
    w('/** Resolve a compound family id (e.g. "T05:cost-finops"). */')
    w('export function findFamily(familyId) {')
    w('  return FAMILIES.find((f) => f.id === familyId) || null;')
    w('}')
    w('')

    with open(out_path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')

    pairs = sum(len(v) for v in modules.values())
    print(f'{len(bank)} questions | {len(modules)} modules | {pairs} module-family pairs -> {out_path}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build(sys.argv[1], sys.argv[2])
