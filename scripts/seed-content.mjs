/**
 * Seed content for the Databricks RSA assessment track.
 * PLACEHOLDER domain content: every record here is intended to be replaced or
 * extended by the ECOD domain team via the Admin UI (or by editing this file
 * and re-seeding). The platform itself is fully content-agnostic.
 */

export const RSA_ROLE = {
  key: 'databricks-rsa',
  name: 'Resident Solutions Architect (RSA)',
  technology: 'Databricks',
  description:
    'Enterprise track forDatabricks Resident Solutions Architects. Validates lakehouse architecture, data engineering, governance, ML/GenAI delivery, cost & performance optimization, DevOps maturity and customer advisory skills required to embed with enterprise clients.',
};

// weight totals 100. target_level is the enterprise-ready bar on the 1-5 scale.
export const RSA_COMPETENCIES = [
  { key: 'lakehouse-architecture', name: 'Lakehouse Architecture & Platform Design', category: 'architecture', weight: 18, target_level: 4, order: 1,
    description: 'Designs end-to-end lakehouse platforms: workspace topology, medallion zoning, storage layouts, environment strategy.',
    enrichment_hint: 'Work through a reference architecture for one regulated and one retail client; produce a one-page blueprint per environment with justifications.' },
  { key: 'data-engineering', name: 'Data Engineering with Delta & Structured Streaming', category: 'engineering', weight: 18, target_level: 4, order: 2,
    description: 'Builds reliable batch and streaming pipelines: Delta Lake internals, Auto Loader, CDC/SCD patterns, streaming state management.',
    enrichment_hint: 'Rebuild a nightly batch pipeline as an incremental streaming pipeline; demonstrate exactly-once semantics and late/out-of-order handling.' },
  { key: 'governance-security', name: 'Data Governance & Security with Unity Catalog', category: 'governance', weight: 14, target_level: 4, order: 3,
    description: 'Implements enterprise governance: Unity Catalog namespace design, fine-grained access control, lineage, audit, PII handling.',
    enrichment_hint: 'Design a 3-business-unit catalog layout including row/column masking for PII and an IdP-synced group model; present it to a peer panel.' },
  { key: 'ml-genai', name: 'ML & GenAI on Databricks', category: 'data-ai', weight: 12, target_level: 3, order: 4,
    description: 'Delivers production ML/GenAI: MLflow lifecycle, feature store, model serving, vector search, evaluation and guardrails.',
    enrichment_hint: 'Ship a small RAG demo with MLflow tracing and an evaluation set; be ready to defend quality and cost trade-offs.' },
  { key: 'performance-cost', name: 'Performance & Cost Optimization', category: 'optimization', weight: 12, target_level: 4, order: 5,
    description: 'Tunes workloads and spend: Photon, predictive optimization, serverless, system tables for observability, right-sizing and cluster policies.',
    enrichment_hint: 'Given a real workspace bill, produce a cost-analysis report using system tables and three concrete savings actions.' },
  { key: 'devops-production', name: 'DevOps, CI/CD & Production Readiness', category: 'platform', weight: 10, target_level: 3, order: 6,
    description: 'Operates production-grade platforms: asset bundles, testing strategy, workflow orchestration, alerting, incident response, SLAs.',
    enrichment_hint: 'Automate a bundle-based deploy across dev/stage/prod with tests and alerts; run a game-day incident simulation.' },
  { key: 'customer-advisory', name: 'Customer Advisory, Communication & Stakeholder Management', category: 'advisory', weight: 16, target_level: 4, order: 7,
    description: 'Operates as a trusted advisor: executive communication, expectation management, value storytelling, navigating resistance.',
    enrichment_hint: 'Run a mock steering-committee readout on a troubled project; field hostile questions without losing the room.' },
];

// 3 questions per competency: scenario MCQ, multi-select, open scenario (assessor-scored).
// The advisory competency additionally carries a self-rating scale item.
// Per competency: 4 + 4 + 6 = 14 points (advisory +3).
const O = (id, label) => ({ id, label });

export const RSA_QUESTIONS = [
  // ---------------- 1. Lakehouse Architecture & Platform Design
  { competency: 'lakehouse-architecture', type: 'mcq_single', points: 4, difficulty: 'intermediate', order: 1,
    prompt: 'A retail client runs a legacy EDW for BI and a separate S3 data lake for ML, with constant sync issues. Which target architecture do you recommend as the first move?',
    options: [
      O('a', 'Lift the EDW to a newer MPP warehouse and keep the lake for ML'),
      O('b', 'A lakehouse on open Delta tables with medallion layering, serving BI and ML from one governed copy of data'),
      O('c', 'Consolidate everything into a real-time streaming (Kappa) architecture'),
      O('d', 'Keep both systems and add a federation layer on top'),
    ],
    correct_option_ids: ['b'] },
  { competency: 'lakehouse-architecture', type: 'mcq_multi', points: 4, difficulty: 'foundation', order: 2,
    prompt: 'Which of these are defining characteristics of the medallion architecture? (Select all that apply)',
    options: [
      O('a', 'Bronze holds raw, immutable, append-oriented ingested data'),
      O('b', 'Silver holds cleansed, conformed, often deduplicated/enriched data'),
      O('c', 'Gold holds business-level aggregates shaped for consumption'),
      O('d', 'Platinum holds personalized real-time features served under 10ms'),
    ],
    correct_option_ids: ['a', 'b', 'c'] },
  { competency: 'lakehouse-architecture', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'Design the landing blueprint for an enterprise migrating from a legacy EDW to Databricks: workspace/environment topology, data zones, the Unity Catalog naming model you would put in place on day one, and the first three datasets you would onboard. Justify each choice briefly.',
    rubric: 'Expected evidence: separates workspaces or catalogs per environment (dev/qa/prod); medallion zones with clear purpose; three-level namespace (catalog.schema.table) with a consistent naming convention; cluster policies or serverless with cost guardrails; incremental, value-ordered migration of datasets rather than big-bang; mentions security/governance from day one.' },

  // ---------------- 2. Data Engineering
  { competency: 'data-engineering', type: 'mcq_single', points: 4, difficulty: 'intermediate', order: 1,
    prompt: 'Which statement about OPTIMIZE ... ZORDER BY on a Delta table is correct?',
    options: [
      O('a', 'It compacts small files and co-locates related data values so data skipping can prune files at read time'),
      O('b', 'It is a full table sort and therefore slows all future writes'),
      O('c', 'It creates a secondary B-tree index on the chosen column'),
      O('d', 'It only helps tables stored in DBFS, not cloud object storage'),
    ],
    correct_option_ids: ['a'] },
  { competency: 'data-engineering', type: 'mcq_multi', points: 4, difficulty: 'intermediate', order: 2,
    prompt: 'Which capabilities does Auto Loader (cloudFiles) provide? (Select all that apply)',
    options: [
      O('a', 'Schema inference and schema evolution for incoming files'),
      O('b', 'Exactly-once processing guarantees via checkpointing'),
      O('c', 'Directory listing and optional cloud notification-based file discovery'),
      O('d', 'Automatic conversion of CSV into governed fact/dimension models'),
    ],
    correct_option_ids: ['a', 'b', 'c'] },
  { competency: 'data-engineering', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'A Structured Streaming job consuming from Kafka shows steadily growing end-to-end latency every night around 02:00, when heavy batch jobs also run. Walk through how you would diagnose the cause and what you would change (triggers, state, resources, scheduling, sink behaviour).',
    rubric: 'Expected evidence: uses metrics/logs (input vs processing rate, state store size, watermark, spill) to localize the bottleneck; considers cluster contention at 02:00 and isolation of workloads; proposes concrete remedies (trigger tuning, maxOffsetsPerTrigger/ backpressure, state store/RocksDB, autoscaling or separate compute, optimizing MERGE/sink patterns, scheduling batch off-hours); mentions checkpointing and exactly-once.' },

  // ---------------- 3. Governance & Security
  { competency: 'governance-security', type: 'mcq_single', points: 4, difficulty: 'foundation', order: 1,
    prompt: 'In Unity Catalog, a fully qualified table reference takes the form:',
    options: [
      O('a', 'workspace.database.table'), O('b', 'catalog.schema.table'),
      O('c', 'metastore.database.table'), O('d', 'account.catalog.table'),
    ],
    correct_option_ids: ['b'] },
  { competency: 'governance-security', type: 'mcq_multi', points: 4, difficulty: 'intermediate', order: 2,
    prompt: 'Which statements about Unity Catalog are true? (Select all that apply)',
    options: [
      O('a', 'One metastore can centrally govern tables, volumes, models and other securables across workspaces in a region'),
      O('b', 'It supports fine-grained controls such as row filters and column masks'),
      O('c', 'It captures lineage and audit events for governed assets'),
      O('d', 'It governs Delta tables only - external locations cannot be secured with it'),
    ],
    correct_option_ids: ['a', 'b', 'c'] },
  { competency: 'governance-security', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'A client has three business units (Retail, Lending, Insurance) sharing one Databricks account, plus analysts who must never see raw PII. Propose a governance design: catalog/schema layout across BUs and environments, group model synced from their IdP, who can create objects, and how PII stays protected while remaining queryable by authorized analysts.',
    rubric: 'Expected evidence: catalog strategy by BU and/or environment with clear ownership; privilege model using account-level groups synced from IdP (not individual grants); separation of metastore admin vs catalog/schema owners; least-privilege grants; row filters and/or column masks (or dynamic views) for PII; discovery via Catalog Explorer with tags/descriptions; audit awareness.' },

  // ---------------- 4. ML & GenAI
  { competency: 'ml-genai', type: 'mcq_single', points: 4, difficulty: 'foundation', order: 1,
    prompt: 'Which MLflow capabilities would you use to move a model from experimentation to governed production use?',
    options: [
      O('a', 'Experiment tracking for runs/metrics, plus Model Registry for versioning and lifecycle stages'),
      O('b', 'Only notebook revision history and manual file copies'),
      O('c', 'SQL warehouses, because models are just queries'),
      O('d', 'Trigger-based retraining only, since registries add overhead'),
    ],
    correct_option_ids: ['a'] },
  { competency: 'ml-genai', type: 'mcq_multi', points: 4, difficulty: 'intermediate', order: 2,
    prompt: 'Which are production-grade patterns for serving ML on Databricks? (Select all that apply)',
    options: [
      O('a', 'Model Serving endpoints for real-time inference with scaling'),
      O('b', 'Batch/scoring jobs orchestrated via Workflows for offline predictions'),
      O('c', 'Feature Serving/online store integration for low-latency features'),
      O('d', 'Exposing a driver-node notebook session over ngrok for demos that become the prod endpoint'),
    ],
    correct_option_ids: ['a', 'b', 'c'] },
  { competency: 'ml-genai', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'A client wants a RAG assistant over internal policy documents, with measured quality and guardrails before go-live. Sketch the reference architecture you would build on Databricks (ingestion, indexing, retrieval, generation, evaluation, guardrails, monitoring) and name the platform services you would use.',
    rubric: 'Expected evidence: document ingestion/chunking pipeline; Vector Search index with sync strategy; foundation model access via Model Serving (external or provisioned); AI Gateway or equivalent for guardrails/rate limits/PII; evaluation harness with a held-out QA set (quality + toxicity metrics), MLflow for tracking/traces; monitoring of latency/cost/quality after launch; explicit human review before production.' },

  // ---------------- 5. Performance & Cost
  { competency: 'performance-cost', type: 'mcq_single', points: 4, difficulty: 'intermediate', order: 1,
    prompt: 'A SQL query that joins two large Delta tables suddenly takes 10x longer. Where do you look FIRST to confirm a data-skew hypothesis?',
    options: [
      O('a', 'Query profile / Spark UI: task duration distribution, skew indicators, spill to disk and shuffle sizes per stage'),
      O('b', 'The driver node GC logs only'),
      O('c', 'Restart the warehouse and re-run to warm caches'),
      O('d', 'The cloud provider NAT gateway metrics'),
    ],
    correct_option_ids: ['a'] },
  { competency: 'performance-cost', type: 'mcq_multi', points: 4, difficulty: 'intermediate', order: 2,
    prompt: 'Which cost/performance statements are accurate on Databricks? (Select all that apply)',
    options: [
      O('a', 'Photon is a vectorized execution engine that accelerates SQL and DataFrame workloads'),
      O('b', 'Predictive optimization can run OPTIMIZE/VACUUM automatically for Unity Catalog managed tables'),
      O('c', 'Serverless warehouses provide fast start and aggressive auto-scaling for bursty BI'),
      O('d', 'Predictive optimization requires a manually maintained weekly maintenance job'),
    ],
    correct_option_ids: ['a', 'b', 'c'] },
  { competency: 'performance-cost', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'The client\'s Databricks spend doubled in one quarter with no new product launch. Walk a CFO-adjacent audience through your cost-reduction playbook: how you attribute spend, the first three levers you would pull, and how you keep savings durable.',
    rubric: 'Expected evidence: observability first (system tables billing/usage, tags/labels for chargeback); workload attribution by team/product; levers such as serverless or right-sized compute, cluster policies (max workers, idle termination, spot where appropriate), eliminating redundant/duplicate pipelines, storage hygiene (OPTIMIZE/VACUUM, lifecycle rules); durable control via budgets/alerts, policy enforcement and a regular cost review; communicates in business terms.' },

  // ---------------- 6. DevOps & Production Readiness
  { competency: 'devops-production', type: 'mcq_single', points: 4, difficulty: 'foundation', order: 1,
    prompt: 'What problem do Databricks Asset Bundles primarily solve?',
    options: [
      O('a', 'Declarative packaging and deployment of jobs, pipelines and resources across dev/stage/prod from source control'),
      O('b', 'Realtime replication of Delta tables between regions'),
      O('c', 'Autoscaling SQL warehouses beyond the documented limits'),
      O('d', 'Bundling Python wheels for DBFS upload only'),
    ],
    correct_option_ids: ['a'] },
  { competency: 'devops-production', type: 'mcq_multi', points: 4, difficulty: 'intermediate', order: 2,
    prompt: 'Which elements belong in a healthy CI/CD pipeline for Databricks workloads? (Select all that apply)',
    options: [
      O('a', 'Unit tests for transformation logic (e.g. pytest) run on every pull request'),
      O('b', 'Bundle validate + deploy to a staging workspace for integration tests'),
      O('c', 'Data quality expectations/checks promoted together with code'),
      O('d', 'Manual notebook zip uploads from a maintainer laptop as the release mechanism'),
    ],
    correct_option_ids: ['a', 'b', 'c'] },
  { competency: 'devops-production', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'A production pipeline failed at 18:00 on a Friday, silently corrupting the executive dashboard dataset for Monday. Describe your incident response over the weekend and the concrete changes you would land afterwards to prevent recurrence.',
    rubric: 'Expected evidence: triage and blast-radius assessment (which tables/dashboards affected); data quarantine and controlled reprocessing/backfill with time travel where useful; transparent stakeholder communication with ETAs; root-cause analysis afterwards; prevention: data quality expectations gating publish steps, alerting on failure AND freshness, retries/idempotency, runbooks, on-call rota, staged rollout.' },

  // ---------------- 7. Customer Advisory
  { competency: 'customer-advisory', type: 'mcq_single', points: 4, difficulty: 'intermediate', order: 1,
    prompt: 'The client\'s platform team resists adopting Unity Catalog, fearing migration downtime and disruption. As the RSA, what is the BEST next step?',
    options: [
      O('a', 'Escalate to their CTO that the team is blocking progress'),
      O('b', 'Run a focused workshop: quantify current pain, demo UC on a small real workload, and propose a phased, low-risk migration plan with quick wins'),
      O('c', 'Bypass them and enable UC during the next maintenance window'),
      O('d', 'Drop UC from the roadmap entirely to keep the peace'),
    ],
    correct_option_ids: ['b'] },
  { competency: 'customer-advisory', type: 'scale', points: 3, difficulty: 'foundation', order: 2,
    prompt: 'Self-assessment: rate your experience leading C-level stakeholder conversations on data platform strategy (1 = no direct exposure yet, 5 = regularly lead executive readouts).',
    help_text: 'Your self-rating is calibrated against the scenario-based answers reviewed by the assessor.' },
  { competency: 'customer-advisory', type: 'text', points: 6, difficulty: 'advanced', order: 3,
    prompt: 'A VP of Data wants to cut the Databricks budget after a failed internal ML proof-of-concept. You believe the platform is under-utilized, not over-priced. Outline the talking points you would take into that meeting and a 30-60-90 day plan to rebuild executive trust and demonstrate value.',
    rubric: 'Expected evidence: acknowledges the failure without defensiveness; reframes with evidence (usage/cost analysis vs value delivered elsewhere); proposes 2-3 quick, visible wins tied to business outcomes (not platform features); 30-60-90 structure with owners and measurable milestones; addresses spend governance so the VP regains cost control; ends with a concrete decision/ask.' },
];

export const DEMO_USERS = [
  { username: 'admin', password: 'ECOD-admin-2026', name: 'Platform Admin', role: 'admin', email: 'admin@anthroprime.com' },
  { username: 'priya.nair', password: 'ECOD-assessor-2026', name: 'Priya Nair', role: 'assessor', email: 'priya.nair@anthroprime.com' },
  { username: 'arjun.mehta', password: 'ECOD-assessor-2026', name: 'Arjun Mehta', role: 'assessor', email: 'arjun.mehta@anthroprime.com' },
  { username: 'rohit.verma', password: 'ECOD-candidate-2026', name: 'Rohit Verma', role: 'candidate', email: 'rohit.verma@example.com' },
];

export const DEMO_CANDIDATES = [
  {
    key: 'rohit', name: 'Rohit Verma', email: 'rohit.verma@example.com', phone: '+91 98100 11223',
    current_title: 'Senior Data Engineer', years_experience: 8, location: 'Gurugram, IN',
    source: 'Referral', stage: 'assessment',
    notes: 'Strong Spark background; 2 years on Databricks at a BFSI client. Target: Databricks RSA.',
  },
  {
    key: 'neha', name: 'Neha Kulkarni', email: 'neha.kulkarni@example.com', phone: '+91 98220 44556',
    current_title: 'Lead Big Data Consultant', years_experience: 11, location: 'Bengaluru, IN',
    source: 'Partner pipeline', stage: 'gap_mapping',
    notes: 'Excellent architecture and client presence; production ops depth to be verified.',
  },
  {
    key: 'sana', name: 'Sana Qureshi', email: 'sana.qureshi@example.com', phone: '+91 90040 77889',
    current_title: 'Data Platform Architect', years_experience: 9, location: 'Hyderabad, IN',
    source: 'Direct application', stage: 'intake',
    notes: 'Intake complete; role mapping discussion scheduled.',
  },
];
