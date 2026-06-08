# Twinpet Workflow Skills

Skills supplement AI roles—they do not replace them. They codify hard-won project-specific constraints and requirements.

When working on a feature, you must read and adhere to the relevant skill files:

- **`SKILL-UI-IMPECCABLE.md`**: Mandatory standard for frontend, UX, and Flowbite implementation.
- **`SKILL-OFFLINE-FIRST-POS.md`**: Constraints for offline-safe cashier operations.
- **`SKILL-FIRESTORE-RULES-REVIEW.md`**: Guidelines for secure, field-constrained Firestore rules.
- **`SKILL-AGENT-ROUTING.md`**: Definitions of which AI model owns which decisions.
- **`SKILL-FIREBASE-GCP-AUDIT.md`**: Protocol for live cloud environment checks and deploys.
- **`SKILL-RELEASE-EVIDENCE.md`**: Standard for capturing honest, truthful test and build artifacts.

## Evaluating External Skills (e.g. `google/skills`)

- Treat external skills as untrusted until manually reviewed.
- They are useful for Firebase/GCP audit workflow inspiration and learning best practices.
- **DO NOT** automatically install them via `npx skills add` without Tech Lead / CEO approval.
- We prefer explicitly codifying relevant workflows into our own `docs/skills/` tailored to the Twinpet business reality rather than blindly inheriting generic logic.
