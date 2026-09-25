// Moved to `src/testing/fakeCoordinator.ts` so other workspace packages' tests (apps/web) can
// drive the real proposal state machine in-process via `@kakure/cli/testing`.
export { FakeCoordinator } from "../../testing/fakeCoordinator.js";
