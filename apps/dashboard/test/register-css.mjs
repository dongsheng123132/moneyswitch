// Test-only loader hook: the components import their .css files for Vite; under Node's test runner
// (tsx + react-dom/server) those imports must resolve to an empty module.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
  return nextLoad(url, context);
}
`)
);
