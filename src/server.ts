import { isDirectExecution, runAutomationEntry } from './automation-composition-root.js';

export { runAutomationEntry } from './automation-composition-root.js';

if (isDirectExecution(import.meta.url)) {
  void runAutomationEntry().catch((error: unknown) => {
    const detail = error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'UnknownError', message: String(error) };
    console.error(JSON.stringify({
      service: 'aidcp-automation',
      event: 'startup_blocked',
      ...detail,
    }));
    process.exitCode = 1;
  });
}
