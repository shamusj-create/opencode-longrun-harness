// A finite declared-check executor. It never creates a run, commits a receipt,
// schedules another check, starts inference, or enables automatic continuation.
import { executeReservedCheck } from './controller.js';
let accepted = false, ownerLost = false, aborted = false;
const idle = setTimeout(() => { process.exitCode = 1; process.disconnect?.(); }, 5000);
process.on('disconnect', () => {
  ownerLost = true;
  if (!accepted) clearTimeout(idle);
});
process.on('message', async message => {
  if (message?.type === 'abort') { aborted = true; return; }
  if (message?.type !== 'execute' || accepted) return;
  accepted = true; clearTimeout(idle); aborted ||= message.aborted === true;
  try {
    await executeReservedCheck(message.job, { ownerLost: () => ownerLost, aborted: () => aborted });
  } catch (error) {
    console.error(error?.stack || String(error)); process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
});
