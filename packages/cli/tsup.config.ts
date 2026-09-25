import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/testing.ts"],
  // `testing.ts` imports fastify (a devDependency): keep it external rather than bundling a server.
  external: ["fastify"],
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
