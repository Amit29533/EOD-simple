export const STRICT_MODULE_ROLES = new Set(['databricks-rsa', 'databricks-ai-bi-genie']);
export const hasStrictModuleAllocation = (role) => STRICT_MODULE_ROLES.has(role?.key);
export const REQUIRED_TEST_MODULES = [
  ...Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`), 'F01', 'F02',
];
export const MODULE_COMPETENCIES = {
  'databricks-rsa': {
    T01: 'lakehouse-architecture', T02: 'data-engineering', T03: 'data-engineering', T04: 'data-engineering',
    T05: 'performance-cost', T06: 'governance-security', T07: 'lakehouse-architecture', T08: 'devops-production',
    T09: 'ml-genai', T10: 'ml-genai',
  },
  'databricks-ai-bi-genie': {
    T01: 'genie-space-design', T02: 'genie-space-design', T03: 'semantic-layer-data-quality', T04: 'semantic-layer-data-quality',
    T05: 'target-architecture', T06: 'target-architecture', T07: 'unity-catalog-governance', T08: 'obo-authentication-security',
    T09: 'qa-evaluation-evidence', T10: 'release-production-readiness',
    C01: 'use-case-discovery', C02: 'use-case-discovery', C03: 'commercial-workflows-ux', C04: 'commercial-workflows-ux',
    P01: 'documentation-handover', P02: 'documentation-handover', P03: 'documentation-handover', P04: 'documentation-handover',
    F01: 'use-case-discovery', F02: 'commercial-workflows-ux',
  },
};
export const moduleCompetencyKey = (role, module) => MODULE_COMPETENCIES[role.key]?.[module]
  || (role.key === 'databricks-rsa' ? 'customer-advisory' : module);
