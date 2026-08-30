#!/usr/bin/env python3
"""
Build src/content/rsa-question-bank.mjs from the extracted question JSON.

Pipeline:
    scripts/extract-question-bank.py  "Question bank 1.3.xlsx_4343.pdf"  bank.json
    scripts/build-question-bank.py    bank.json  src/content/rsa-question-bank.mjs  [version]

The emitted module is organised MODULE -> FAMILY -> QUESTION, which is also the
order questions appear in the file, so the catalogue reads the same way the
Admin UI presents it and a new question has exactly one place to go.

A family name is only unique *within* a module: "Advanced Technical Judgment"
exists in all ten technical modules, and "Customer Solutioning" in nine
non-technical ones. Families are therefore addressed by the compound id
`<MODULE>:<family-slug>` (e.g. `T05:delta-lake-physical-design`), which is what
makes "add this question to that family" unambiguous.

The published version printed into the generated module is the third argument
and defaults to DEFAULT_VERSION, so a re-extract of a new source PDF is one
command and the version it stamps cannot drift from the file it is named after.

Usage:  python3 scripts/build-question-bank.py <bank.json> <output.mjs> [version]
"""
import json
import re
import sys
from collections import OrderedDict

# There is NO mandatory/common question. Every question in the bank belongs to
# one of the twenty modules (T01-T10, C01-C04, P01-P04, F01-F02) and is drawn
# only by its module's quota. The item the source PDF labels "Common Question"
# is an ordinary F01 open question.

# Top-level grouping of modules. These are *groups*, not families: "family"
# is reserved throughout for the per-module question families the PDF names in
# its own "Question Family" column.
GROUPS = [
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

GROUP_OF = {'T': 'technical', 'C': 'consulting',
            'P': 'professional', 'F': 'foundation'}

# Version stamped into the generated module. The source PDF's own Version
# column trails the export's filename, so the version is an argument (defaulted
# here) rather than read off the rows.
DEFAULT_VERSION = '1.3'


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
    """Modules ordered T01-T10, then C01-C04, P01-P04, F01-F02."""
    base = {'T': 10, 'C': 20, 'P': 30, 'F': 40}[key[0]]
    return base + int(key[1:])


def family_role(questions):
    """What a family supplies, which drives the default type when authoring."""
    has_objective = any(q['objective'] for q in questions)
    has_open = any(not q['objective'] for q in questions)
    if has_objective and has_open:
        return 'mixed'
    return 'objective' if has_objective else 'open'


def build(bank_path, out_path, version=DEFAULT_VERSION):
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
    w(f' * ECOD RSA Question Bank v{version} - the published, finalized catalogue.')
    w(' *')
    w(' * Organised MODULE -> FAMILY -> QUESTION. Generated by')
    w(' * scripts/build-question-bank.py from the extracted source PDF; edit the')
    w(' * generator (or the Admin UI), not this file by hand.')
    w(' *')
    w(' *   T01-T10   Technical     3 objective + 1 open served per module')
    w(' *   C01-C04   Consulting    1 open served per module')
    w(' *   P01-P04   Professional  1 open served per module')
    w(' *   F01-F02   Foundation    1 open served per module')
    w(' *')
    w(' * Every generated test is (10 x 4) + (10 x 1) = 50 questions, shuffled so')
    w(' * objective and open questions interleave rather than arriving in blocks.')
    w(' * See src/core/test-generation.mjs for the selection logic.')
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
    w(f"export const QUESTION_BANK_VERSION = '{version}';")
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
    for key in sorted(modules, key=module_order):
        families = modules[key]
        group = GROUP_OF[key[0]]
        technical = 'true' if key[0] == 'T' else 'false'
        w(f"  {{ key: '{key}', name: {js(MODULE_TITLES[key])}, group: '{group}', order: {module_order(key)},")
        w(f"    technical: {technical},")
        w('    families: [')
        for name, members in families.items():
            # Counts describe what the family actually holds, so a family row
            # and its drill-down can never disagree.
            objective = sum(1 for q in members if q['objective'])
            w(f"      {{ id: '{key}:{slug(name)}', key: '{slug(name)}', name: {js(name)},")
            w(f"        role: '{family_role(members)}',"
              f" objective: {objective}, open: {len(members) - objective} }},")
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
        w(f'  // {total} question{"" if total == 1 else "s"}'
          f' across {len(families)} famil{"y" if len(families) == 1 else "ies"}')
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
    objective = [q for q in bank if q['objective']]
    review = sum(1 for q in objective if q.get('needs_option_review'))
    print(f'v{version}: {len(bank)} questions | {len(modules)} modules | '
          f'{pairs} module-family pairs | {review}/{len(objective)} objective '
          f'items clipped by the source export -> {out_path}')


if __name__ == '__main__':
    if not 3 <= len(sys.argv) <= 4:
        sys.exit(__doc__)
    build(sys.argv[1], sys.argv[2], *(sys.argv[3:]))
