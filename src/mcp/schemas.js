// Tool input schemas. They stay small on purpose: the exact block and question shapes come from relay_help.
import * as z from 'zod';
import { AGENT_TOPICS } from '../cli/agent-topics.js';

const loose = z.record(z.string(), z.unknown());

/** The relay_board input: the spec's top-level fields, with blocks and questions left open. */
export const boardInput = z.looseObject({
  specFile: z.string().optional().describe('Absolute path to a board JSON file under a server file root. Inline blocks and questions append.'),
  title: z.string().optional().describe('Board heading'),
  intro: z.string().optional().describe('One line of context under the heading'),
  blocks: z.array(loose).optional().describe('Content blocks, shown above the questions'),
  questions: z.array(loose).optional().describe('Questions to answer; leave out for a display-only board'),
  responseRequired: z.boolean().optional(),
});

const boardId = z.string();
const token = z.string();

/** The deprecated relay_ask and relay_show take the same fields, but their schema stays empty so the tool list stays small. */
export const aliasInput = z.looseObject({});

export const viewInput = z.object({ boardId, token });
export const draftInput = z.object({ boardId, token, draft: loose });
export const submitInput = z.object({ boardId, token, payload: loose });
/** A widget button click (`blockId`, `name`, `context`), or a renderer event (`action`, plus the surface's `dataModel`). */
export const actionInput = z.object({
  boardId,
  token,
  blockId: z.string().optional(),
  name: z.string().optional(),
  context: loose.optional(),
  action: loose.optional(),
  dataModel: loose.optional(),
});
export const assetInput = z.object({ name: z.string(), index: z.number().int().min(0).default(0) });

export const helpInput = z.object({
  topic: z.enum(Object.keys(AGENT_TOPICS)).optional().describe('Guide topic; omit for the list'),
  schema: z.string().optional().describe('A block or question type, for its exact fields: chart, checklist, ...'),
});

export const resultInput = z.object({
  boardId,
  wait_seconds: z.number().min(0).optional().describe('Block up to this many seconds (at most 50) for the submission; default 0 returns now. Call again while the status is open.'),
});
