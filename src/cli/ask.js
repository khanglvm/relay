// rly ask: build a board from a spec and serve it.
import { assertSpecReady, normalizeSpec } from '../spec/index.js';
import { createBoard } from '../store.js';
import { cliFileRoots, resolveSpecInput, runOrDetach } from './io.js';

export async function cmdAsk(args, mode) {
  const raw = await resolveSpecInput(args, mode);
  const fileRoots = cliFileRoots(args);
  const spec = normalizeSpec(raw, { fileRoots });
  await assertSpecReady(spec);
  const record = createBoard(spec, { fileRoots });
  return runOrDetach(record, spec.responseRequired === false ? { ...args, detach: true } : args);
}
