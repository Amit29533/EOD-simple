import { effectiveBank } from './bank-service.mjs';
import { moduleBankFor } from '../content/module-banks.mjs';
import { generateTest, isActive } from '../core/test-generation.mjs';
import { dedupeQuestions } from '../core/question-selection.mjs';
import { REQUIRED_TEST_MODULES, moduleCompetencyKey } from '../core/module-allocation-policy.mjs';
import { catalogueForRoleKey } from './catalogue-service.mjs';

/** Module quotas choose questions; existing competency settings still determine report weights. */
export async function attachModuleBank(store, bank, allCompetencies) {
  const definition = moduleBankFor(bank.role.key);
  const raw = dedupeQuestions(await effectiveBank(store, bank.role.key));
  const byKey = new Map(allCompetencies.map((c) => [c.key, c]));
  const published = new Map((catalogueForRoleKey(bank.role.key)?.competencies || []).map((c) => [c.key, c]));
  const competencies = [...bank.competencies];
  const ids = new Map();
  for (const module of definition.modules) {
    const key = moduleCompetencyKey(bank.role, module.key);
    let c = byKey.get(key);
    if (!c) {
      // Old/custom workspaces can lack a published competency. Include its
      // definition in the frozen paper without mutating admin configuration.
      c = { key, name: module.name, weight: 0, target_level: 4, ...published.get(key), id: `module-${key}`, active: true };
      byKey.set(key, c); competencies.push(c);
    }
    if (c.active !== false) ids.set(module.key, c.id);
  }
  const questions = raw.filter((q) => isActive(q) && ids.has(q.module)).map((q) => ({
    ...q, competency_id: ids.get(q.module), type: q.type === 'objective' ? 'mcq_single' : 'text',
    difficulty: /foundation/i.test(q.band || '') ? 'foundation' : /advanced|expert/i.test(q.band || '') ? 'advanced' : 'intermediate',
    points: q.type === 'objective' ? 4 : 6, audio_required: q.type !== 'objective', pin_first: false, question_set: '',
    help_text: '', rubric: q.type === 'objective' ? '' : [q.rubric, ...(q.probes || [])].filter(Boolean).join('\n'),
  }));
  return { ...bank, competencies, questions, module_definition: definition.modules };
}

export function moduleSnapshot(bank, requested = null) {
  if (requested !== null && requested !== undefined && requested !== '' && Number(requested) !== 50) return null;
  const modules = bank.module_definition;
  if (modules?.length !== 20 || !REQUIRED_TEST_MODULES.every((key) => modules.some((m) => m.key === key))) return null;
  const generated = generateTest({ modules, questions: bank.questions.map((q) => ({ ...q, type: q.type === 'text' ? 'open' : 'objective' })) });
  if (generated.warnings.length || generated.counts.total !== 50 || generated.counts.technical_objective !== 30
    || generated.counts.technical_open !== 10 || generated.counts.non_technical_open !== 10
    || !generated.sections.every((s) => s.objective === (s.technical ? 3 : 0) && s.open === 1)) return null;
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  return JSON.parse(JSON.stringify({ role: bank.role, framework: bank.framework, competencies: bank.competencies,
    questions: generated.questions.map((q, i) => ({ ...byId.get(q.id), position: i + 1 })),
    question_limit: 50, bank_total: bank.questions.length,
    allocation_blueprint: { mode: 'module', total: 50, technical_objective: 30, technical_open: 10, non_technical_open: 10, sections: generated.sections },
  }));
}
