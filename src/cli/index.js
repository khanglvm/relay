// The rly command router.
import { CliError } from '../util.js';
import { cmdSkill, firstRunHint, skillFreshnessWarning } from './skill.js';
import { printHelp } from './help.js';
import { VERSION } from './context.js';
import { cmdAsk } from './ask.js';
import { parseArgs } from './args.js';
import { cmdHistory, cmdList, cmdOpen, cmdReopen, cmdRescue, cmdReuse, cmdRm, cmdSpec, cmdStop, cmdUpdate, cmdView } from './boards.js';
import { cmdDiff, cmdGit } from './git.js';
import { cmdResult, cmdWait } from './wait.js';
import { cmdShare } from './share.js';
import { cmdA2ui, cmdAgent, cmdConfig, cmdSchema, cmdServeInternal } from './config.js';
import { cmdInstall } from './install.js';
import { cmdUpgrade } from './upgrade.js';
import { cmdMcp } from './mcp.js';

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== '__serve') firstRunHint();
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === 'agent' || cmd === 'skill') {
    skillFreshnessWarning();
  }
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return printHelp();
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION);
        return 0;
      case 'ask':
        return await cmdAsk(parseArgs(rest), 'ask');
      case 'show':
        return await cmdAsk(parseArgs(rest), 'show');
      case 'view':
        return await cmdView(parseArgs(rest));
      case 'diff':
        return await cmdDiff(rest);
      case 'git':
        return await cmdGit(rest);
      case 'reopen':
        return await cmdReopen(parseArgs(rest));
      case 'rescue':
        return await cmdRescue(parseArgs(rest));
      case 'reuse':
        return await cmdReuse(parseArgs(rest));
      case 'update':
        return await cmdUpdate(parseArgs(rest));
      case 'wait':
        return await cmdWait(parseArgs(rest));
      case 'result':
        return await cmdResult(parseArgs(rest));
      case 'share':
        return await cmdShare(parseArgs(rest));
      case 'config':
        return cmdConfig(parseArgs(rest));
      case 'list':
        return cmdList(parseArgs(rest));
      case 'open':
        return cmdOpen(parseArgs(rest));
      case 'stop':
        return await cmdStop(parseArgs(rest));
      case 'history':
        return cmdHistory(parseArgs(rest));
      case 'spec':
        return cmdSpec(parseArgs(rest));
      case 'rm':
        return cmdRm(parseArgs(rest));
      case 'skill':
        return cmdSkill(rest);
      case 'install':
        return cmdInstall(parseArgs(rest));
      case 'upgrade':
      case 'self-update':
        return await cmdUpgrade(parseArgs(rest));
      case 'agent':
        return cmdAgent(rest[0]);
      case 'a2ui':
        return cmdA2ui();
      case 'schema':
        return cmdSchema(rest[0]);
      case 'mcp':
        return await cmdMcp(rest);
      case '__serve':
        return await cmdServeInternal(parseArgs(rest));
      default:
        throw new CliError(`unknown command "${cmd}". Run \`rly help\`.`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`rly: ${err.message}\n`);
      if (err.code === 4) process.stderr.write('run `rly agent` for the agent-oriented guide\n');
      return err.code;
    }
    throw err;
  }
}
