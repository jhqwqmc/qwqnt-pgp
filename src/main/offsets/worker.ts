import { parentPort, workerData } from 'node:worker_threads';
import { resolveWindowsX64Offsets } from './windows-x64';

if (parentPort && typeof workerData === 'string') {
  const port = parentPort;
  try {
    port.postMessage(await resolveWindowsX64Offsets(workerData));
  } catch (error) {
    port.postMessage(error instanceof Error ? error.message : String(error));
  }
}
