/**
 * `@kakure/cli/testing`: test-only helpers for OTHER workspace packages. Nothing here is part of
 * the CLI's runtime surface; `fastify` (a devDependency of this package) is left external, so
 * this entry only resolves inside the pnpm workspace where that devDependency is installed.
 */
export { FakeCoordinator } from "./testing/fakeCoordinator.js";
