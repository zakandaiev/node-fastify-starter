import { initEnv } from '#config/env.js';
import { createConfig } from '#config/index.js';
import { findEnabledChannels } from '#core/alert/channels/index.js';
import { alert } from '#core/alert/index.js';
import { createContext, runInContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { uuidv7 } from '#utils/id.js';

const LABEL = 'Alert test';
const TITLE = 'Alert test';
const MESSAGE = 'A manual test (npm run alert:test): this process reaches the channels of alerts';

// The verdict lines are the output; a channel that refused writes its own line with the reason and a hint.
const LOG_LEVEL = 'warn';

const EXIT_OK = 0;
const EXIT_FAILED = 1;

function describeChannel(name, outcome) {
  return outcome.isDelivered
    ? `✅ ${LABEL}: ${name} delivered`
    : `❌ ${LABEL}: ${name} not delivered (${outcome.reason})`;
}

// Sends for real, to every channel that has its settings: one silent message under a key of its own, so it is
// never deduped. Without Redis, so the throttle of the running app does not hold it back either.
export async function runAlertTest({ readConfig, print = console.log } = {}) {
  try {
    const config = readConfig();
    const names = findEnabledChannels(config.alert).map((channel) => channel.name);

    if (!names.length) {
      print(`❌ ${LABEL} failed: no channel has its settings, set one of the APP_ALERT_* variables`);

      return EXIT_FAILED;
    }

    print(`⏳ ${LABEL} sends to: ${names.join(', ')} (APP_MODE=${config.app.mode})`);

    const context = createContext({ config, log: createLogger({ level: LOG_LEVEL }) });
    const result = await runInContext(context, () => alert({
      title: TITLE,
      dedupeKey: `alert-test:${uuidv7()}`,
      error: { message: MESSAGE },
      isSilent: true,
    }));
    const outcomes = names.map((name) => result.channels[name] ?? { isDelivered: false, reason: 'not sent' });

    names.forEach((name, index) => print(describeChannel(name, outcomes[index])));

    return outcomes.every((outcome) => outcome.isDelivered)
      ? EXIT_OK
      : EXIT_FAILED;
  } catch (error) {
    print(`❌ ${LABEL} failed: ${error.message}`);

    return EXIT_FAILED;
  }
}

if (import.meta.main) {
  process.exitCode = await runAlertTest({ readConfig: () => createConfig(initEnv()) });
}
