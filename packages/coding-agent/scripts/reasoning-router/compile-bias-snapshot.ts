#!/usr/bin/env node

/** Source-checkout wrapper for the shipped `omk router-feedback compile-bias` command. */

import { runRouterFeedbackCli } from "../../src/commands/router-feedback-cli.ts";

const result = runRouterFeedbackCli(["router-feedback", "compile-bias", ...process.argv.slice(2)]);
process.exitCode = result.exitCode;
