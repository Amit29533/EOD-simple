# Automated candidate booking and scheduled exams

Admin → Dashboard → **Create booking link**, or **Test bookings** in the sidebar.
Copy the generated URL into your own email. Each invitation accepts one candidate
submission and unused invitations expire after 30 days. An optional track on the
invitation restricts the target-exam dropdown; leaving it blank allows the candidate
to choose any active exam that can fill its allocation blueprint.

## Essential candidate form fields

- Full name: candidate profile and assessor identification.
- Email: unique account contact and supported sign-in identifier (up to 100 characters).
- Phone number: candidate contact (7–15 digits, including country code if entered).
- Target exam: required dropdown, showing available exams and question counts.
- Test date and start time: required, explicitly India Standard Time
  (Asia/Kolkata, UTC+05:30). Past/invalid slots are rejected.
- Create password and confirm password: required, 12–200 characters, matching.
  The candidate keeps this password; ECOD does not email or return it.

No employment, identity-document, payment or address information is required.
The form displays the closing time: exactly **two hours after the booked start**.
Late arrival uses the remainder of this window, not a new two-hour session.

## Automatic provisioning

Submission freezes the selected question paper, saves the slot, creates the
candidate, creates a linked candidate-role user and allocates exactly one exam.
The candidate advances to Assessment. RSA and AI/BI use their strict 50-question
module blueprints; SAMA uses its default 30-question blueprint. Other configured
tracks use the existing automatic allocation policy. Empty/unavailable exams are
not offered. An assessor is left unassigned for admin distribution.

Existing account emails are refused before consuming the invitation: the form
cannot take over, reset or relink an existing account. Admins schedule existing
accounts separately. New booked users can sign in with their email or the
alternative generated username and their chosen password.

The confirmation page provides a login-protected exam URL and the exact opening
and closing times. The original booking invitation cannot book another person.
Candidates can also sign in normally and open My Journey if they lose the exam URL.
No emails are sent by this feature.

## Server-enforced window

The assessment row stores booking_id, scheduled_at and scheduled_end_at. The server
computes its authoritative deadline from scheduled_at + two hours, irrespective of
first entry, refresh, sign-out or a different device. Every exam GET/write endpoint
rejects early access; no paper or live question is returned. My Journey and direct
exam links display the future slot without starting the paper.

At the closing boundary, assigned (never opened) and in-progress booked attempts
expire on access, become submitted, and keep saved answers available for assessor
review. Further answers, phase changes and cursor advances are refused. Reports
remain available after scoring. There is no background scheduler: the timestamp
is authoritative even while the server/browser is offline; expiry is materialized
when the record is next accessed. Existing unscheduled assessments retain the
previous two-hour window anchored to first hall entry.

Cancelling a booking blocks candidate exam access even for already-issued login
sessions and closes an unsubmitted attempt as Cancelled, without sending it for
scoring. Deleting an unsubmitted booked assessment also cancels its slot.
Cancelled invitations remain consumed. The dashboard and Test bookings
show future and currently open windows, account/assessment setup state, and history.
Submitted and scored attempts leave Upcoming tests immediately and retain their
actual status in completed history, even before the scheduled closing time.
Existing profile-only bookings are preserved; they are not silently given accounts
or new papers by this upgrade.

## Recovery and storage

- test_bookings holds invitations and appointments. Only a SHA-256 token hash is
  persisted; raw booking tokens live in the URL fragment and POST body.
- A conditional row change consumes each link. JSON uses its write lock; Blobs
  re-evaluates decisions on ETag conflicts. Airtable has weaker cross-instance
  guarantees because it lacks conditional writes.
- A temporary provisioning_json stores a scrypt password hash and frozen paper,
  never a plaintext password. It is cleared after successful account/allocation
  setup. Admin/public projections exclude it and all credential hashes.
- Unchanged form retries verify the original credentials and submission identity.
  Deterministic IDs and booking markers recover interrupted candidate, user and
  assessment writes without changing the paper, password or scheduled window.
  The admin dashboard/list can finish interrupted setup. Duplicate emails are
  reserved by committed bookings even before their accounts exist, and checks
  are serialized by the existing local users:create lock. A failed repair keeps
  the slot visible as Setup pending so an admin can retry or cancel it without
  losing access to the dashboard. This is a local feature,
  not a claim of transactional multi-instance onboarding.
- Candidate deletion includes the linked booking, login, sessions and assessment
  under the existing deletion policies.
- Existing JSON stores need no reseed. Airtable installations need the updated
  test_bookings fields/JSON continuation columns, users.booking_id,
  candidates.booking_id and assessments.booking_id/scheduled_at/scheduled_end_at
  from scripts/airtable-setup.mjs before enabling this there.

API: admin POST /admin/test-bookings/links, GET /admin/test-bookings,
POST /admin/test-bookings/:id/cancel; public POST /public/test-bookings/lookup,
POST /public/test-bookings. Existing authenticated candidate APIs enforce the window.

Local localhost URLs work only on the host computer. A reachable ECOD address is
needed before external candidates can use them. No deployment or GitHub push is
part of this local feature work.
