const normalize = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function choiceErrors(question, at) {
  const errors = [];
  const options = Array.isArray(question.options) ? question.options : [];
  const correct = Array.isArray(question.correct_option_ids) ? question.correct_option_ids.map(String) : [];
  if (options.length < 2) errors.push(`${at}: objective question needs at least two options`);
  const ids = options.map((o) => String(o?.id ?? '').trim());
  const labels = options.map((o) => normalize(o?.label));
  if (ids.some((id) => !id)) errors.push(`${at}: every option needs an id`);
  if (labels.some((label) => !label)) errors.push(`${at}: every option needs a label`);
  if (new Set(ids).size !== ids.length) errors.push(`${at}: duplicate option id`);
  if (new Set(labels).size !== labels.length) errors.push(`${at}: duplicate option label`);
  if (question.type === 'mcq_single' && correct.length !== 1) errors.push(`${at}: single-choice question needs exactly one correct option`);
  if (question.type === 'mcq_multi' && correct.length < 2) errors.push(`${at}: multi-choice question needs at least two correct options`);
  if (question.type === 'objective' && correct.length < 1) errors.push(`${at}: objective question needs a correct option`);
  for (const id of correct) if (!ids.includes(id)) errors.push(`${at}: correct option "${id}" does not exist`);
  return errors;
}

/** Validate one role catalogue before it is installed into a workspace. */
export function auditCatalogue(name, questions) {
  const errors = [];
  const prompts = new Map();
  const allowedTypes = new Set(['mcq_single', 'mcq_multi', 'scale', 'text']);
  const allowedDifficulty = new Set(['foundation', 'basic', 'intermediate', 'advanced']);
  questions.forEach((question, index) => {
    const at = `${name}[${index + 1}]`;
    const prompt = normalize(question.prompt);
    if (!prompt) errors.push(`${at}: missing prompt`);
    else if (prompts.has(prompt)) errors.push(`${at}: duplicate prompt (also ${prompts.get(prompt)})`);
    else prompts.set(prompt, at);
    if (!allowedTypes.has(question.type)) errors.push(`${at}: unsupported type "${question.type}"`);
    if (!normalize(question.competency)) errors.push(`${at}: missing competency`);
    if (!allowedDifficulty.has(question.difficulty)) errors.push(`${at}: unsupported difficulty "${question.difficulty}"`);
    if (!(Number(question.points) > 0)) errors.push(`${at}: points must be positive`);
    if (question.type === 'mcq_single' || question.type === 'mcq_multi') errors.push(...choiceErrors(question, at));
    if (question.type === 'text' && !normalize(question.rubric)) errors.push(`${at}: open question needs an assessor rubric`);
  });
  return { name, total: questions.length, errors };
}

/** Validate the richer module/family bank used by the authoring screen. */
export function auditModuleBank(name, questions) {
  const errors = [];
  const ids = new Map();
  const prompts = new Map();
  questions.forEach((question, index) => {
    const at = `${name}[${index + 1}]`;
    const id = String(question.id ?? '').trim();
    const prompt = normalize(question.prompt);
    if (!id) errors.push(`${at}: missing id`);
    else if (ids.has(id)) errors.push(`${at}: duplicate id "${id}" (also ${ids.get(id)})`);
    else ids.set(id, at);
    if (!prompt) errors.push(`${at}: missing prompt`);
    else if (prompts.has(prompt)) errors.push(`${at}: duplicate prompt (also ${prompts.get(prompt)})`);
    else prompts.set(prompt, at);
    if (!normalize(question.module)) errors.push(`${at}: missing module`);
    if (!normalize(question.family_id)) errors.push(`${at}: missing family id`);
    if (!['objective', 'open'].includes(question.type)) errors.push(`${at}: unsupported type "${question.type}"`);
    if (question.type === 'objective') errors.push(...choiceErrors(question, at));
    if (question.type === 'open' && !normalize(question.rubric) && !normalize(question.rationale)) {
      errors.push(`${at}: open question needs a rubric or rationale`);
    }
  });
  return { name, total: questions.length, errors };
}

export function duplicatePromptsAcross(catalogues) {
  const duplicates = [];
  const seen = new Map();
  for (const [name, questions] of catalogues) {
    for (const question of questions) {
      const prompt = normalize(question.prompt);
      if (!prompt) continue;
      const previous = seen.get(prompt);
      if (previous && previous.name !== name) duplicates.push({ prompt: question.prompt, banks: [previous.name, name] });
      else seen.set(prompt, { name });
    }
  }
  return duplicates;
}

