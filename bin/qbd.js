#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main(process.argv.slice(2));
process.exitCode = code ?? 0;
// Safety net: if some handle lingers after the work is done (e.g. a browser
// keep-alive socket that survived server.close), force the exit. unref'd, so
// a clean run exits naturally before this fires.
setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
