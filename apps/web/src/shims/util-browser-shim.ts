// Minimal browser stand-in for Node's `util` module, covering only what `@kakure/sdk`'s dependency
// chain touches at import time in a production Vite/Rollup bundle.
//
// `@aztec/foundation`'s `SecretValue` (`dest/config/secret_value.js`) does `import { inspect } from
// "util"` purely to attach a `[util.inspect.custom]` symbol method so a secret prints redacted in Node
// console/log output. Vite's default browser build externalizes Node built-ins to an empty stub module,
// which satisfies bare `import "util"` side-effect imports but has no `inspect` export -- so this named
// import fails at bundle time with a Rollup "is not exported by __vite-browser-external" error. Browsers
// never call `util.inspect` (there is no Node console formatting to hook), so a no-op is sufficient: this
// keeps the class definition valid without pulling in a full `util` polyfill for one unused symbol.
export function inspect(): string {
  return "[SecretValue]";
}
