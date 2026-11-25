import { serveRunnerProcess } from "../../src/runtime/js-process/serve.ts";
import { MODULE_PREPARED_RUNNER_NAME, MODULE_RUNNER_READY } from "../../src/runtime/protocol/module-frame.ts";
import { browserContext } from "../../src/wasm/runner/browser.ts";
import { runModule } from "../../src/wasm/runner/run.ts";

// The SDK-owned worker behind `spawnModule`. `serveRunnerProcess` installs `onmessage` synchronously, so
// the engine's start message cannot arrive before a handler exists, and it alone accepts the start message's
// launch description (engine ADR 0027); everything else happens in `runModule`.
serveRunnerProcess((client, context, launch) => runModule(browserContext(context, client, launch), launch));
if (self.name === MODULE_PREPARED_RUNNER_NAME) self.postMessage(MODULE_RUNNER_READY);
