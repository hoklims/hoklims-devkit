#!/usr/bin/env bun

import { main } from "../src/app.js";

const code = await main(process.argv.slice(2));
process.exitCode = code;
