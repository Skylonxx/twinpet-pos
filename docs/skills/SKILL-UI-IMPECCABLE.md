# SKILL: Impeccable UI Implementation

This is the foundational frontend, UI, and UX generation skill for Twinpet POS. Every UI task must abide by these strict rules.

## 1. Component Library Mandate: Flowbite React First
- **`flowbite-react` is the absolute standard** for TSX component creation.
- Before writing raw Tailwind HTML, the Developer MUST use existing Flowbite React components where available.
  - *Examples:* Button, Modal, TextInput, Select, Card, Alert, Badge, Spinner.
- Re-inventing standard UI elements is strictly prohibited when a Flowbite equivalent exists.
- Tailwind utility classes are used mainly as modifiers for:
  - structural layout
  - flex/grid
  - spacing
  - responsive wrappers
  - minor alignment around Flowbite components
- Do not create custom handmade button/input/modal patterns unless Flowbite lacks the needed component or the deviation is explicitly approved.

## 2. Tailwind CSS Discipline
- Use Tailwind utility classes cleanly and consistently.
- No arbitrary inline styles.
- No hacky CSS overrides.
- No visually flashy marketing UI for cashier workflows.
- No random gradients/blurs/orb decorations in operational POS surfaces.
- Tailwind supports Flowbite; it does not replace the Flowbite component standard.

## 3. Non-Blocking UX
- Absolute ban on modal loading spinners that freeze cashier operations.
- Preserve optimistic/offline-first POS flow.
- No UI waiting indefinitely for server/network confirmation.
- Queued/pending wording must be async-safe.
- Never show final "success" or "completed" wording when state is only queued/pending.
- Cashier operations must remain fast during weak/no internet.

## 4. Ergonomics & Speed
- Keyboard-first cashier workflows.
- Preserve `F12` payment hotkey.
- Fast cart/payment interactions.
- Large touch targets (minimum 44px).
- No unnecessary confirmation friction.
- Checkout/cart/payment screens must prioritize cashier speed over decorative UI.

## 5. Anti-Silent Failure UI
- System rejections must surface clearly.
- Use prominent red toast or red alert for failures.
- No console-only failure.
- Do not show success if only queued/pending.
- Distinguish between:
  - locally queued
  - pending sync
  - accepted by local Firestore
  - server/reconcile confirmed (only when actually confirmed)
  - rejected/failed
- Error messages must be cashier-safe and not expose raw internal technical error strings to the user.

## 6. Responsiveness
- Mandatory visual checks at:
  - 320px
  - 768px
  - 1080px
- No overlap or horizontal scrollbars.
- Totals and buttons must remain readable.
- Cart/payment dimensions must remain stable.
- Layout must seamlessly support desktop and tablet cashier workflows.
