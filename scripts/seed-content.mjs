/**
 * Seed-only content: demo accounts and demo candidates.
 *
 * The published RSA assessment catalogue (role, competencies, the full
 * 105-question bank) now lives in src/content/rsa-catalogue.mjs so the running
 * application can offer it too — see the "sync published catalogue" admin
 * action. This module keeps the historical import surface for scripts/seed.mjs.
 */
export { RSA_ROLE, RSA_COMPETENCIES, RSA_QUESTIONS } from '../src/content/rsa-catalogue.mjs';

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
