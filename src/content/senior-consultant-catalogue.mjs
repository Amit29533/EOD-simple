/**
 * The published Senior Consultant assessment catalogue: the role definition
 * and its competency framework. The question bank for this track has not been
 * published yet — the platform is content-agnostic, so the team adds (or
 * imports) the Senior Consultant questions from the Admin UI against the
 * competencies below, and allocation/test generation works the moment the
 * bank holds at least one active question.
 */

export const SC_ROLE = {
  key: 'senior-consultant',
  name: 'Senior Consultant',
  technology: 'Databricks',
  description:
    'Enterprise track for senior consultants. Validates platform architecture, data engineering, governance and security, AI/BI & GenAI delivery, performance and cost optimization, delivery and production readiness, and client advisory skills required to run senior engagements end to end.',
};

// weight totals 100. target_level is the enterprise-ready bar on the 1-5 scale.
export const SC_COMPETENCIES = [
  { key: 'platform-architecture', name: 'Data Platform Architecture & Design', category: 'architecture', weight: 20, target_level: 4, order: 1,
    description: 'Designs end-to-end data platform architectures: workspace topology, environment strategy, medallion zoning and integration choices.',
    enrichment_hint: 'Produce a one-page reference architecture for one regulated and one retail client, with justifications for every boundary.' },
  { key: 'data-engineering', name: 'Data Engineering & Pipeline Development', category: 'engineering', weight: 20, target_level: 4, order: 2,
    description: 'Builds reliable batch and streaming pipelines: ingestion, transformation, quality gates and replay/backfill discipline.',
    enrichment_hint: 'Rebuild a nightly batch pipeline as an incremental pipeline with idempotent merges and quality checks; demonstrate replay safely.' },
  { key: 'governance-security', name: 'Data Governance & Security', category: 'governance', weight: 15, target_level: 4, order: 3,
    description: 'Implements enterprise governance: catalog design, least-privilege access, lineage, audit and PII handling.',
    enrichment_hint: 'Design a multi-business-unit catalog layout with row/column masking for PII and an IdP-synced group model; present it to a peer panel.' },
  { key: 'ai-bi-genai', name: 'AI/BI & GenAI Delivery', category: 'data-ai', weight: 15, target_level: 3, order: 4,
    description: 'Delivers AI/BI and GenAI workloads: semantic layers, Genie spaces, RAG patterns, evaluation and guardrails.',
    enrichment_hint: 'Ship a small Genie space or RAG demo with a benchmark question set and a quality review; be ready to defend the trade-offs.' },
  { key: 'performance-cost', name: 'Performance, Cost & Optimization', category: 'optimization', weight: 10, target_level: 4, order: 5,
    description: 'Tunes workloads and spend: query performance, right-sizing, budgets and cost attribution with measurable evidence.',
    enrichment_hint: 'Given a real workload bill, produce a cost-analysis report with three concrete savings actions and a way to keep them durable.' },
  { key: 'delivery-production', name: 'Delivery, DevOps & Production Readiness', category: 'platform', weight: 10, target_level: 3, order: 6,
    description: 'Operates production-grade delivery: CI/CD, testing strategy, release gates, alerting, incident response and SLAs.',
    enrichment_hint: 'Automate a deploy across dev/stage/prod with tests and alerts; run a game-day incident simulation and the post-incident review.' },
  { key: 'client-advisory', name: 'Client Advisory & Stakeholder Management', category: 'advisory', weight: 10, target_level: 4, order: 7,
    description: 'Operates as a trusted advisor: discovery, expectation management, value storytelling and navigating resistance.',
    enrichment_hint: 'Run a mock steering-committee readout on a troubled project; field hostile questions without losing the room.' },
];

/** No published questions yet — the bank is authored from the Admin UI. */
export const SC_QUESTIONS = [];
