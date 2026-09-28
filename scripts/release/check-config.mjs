#!/usr/bin/env node

import { assertReleaseConfig, readReleaseConfig } from "./lib.mjs";

assertReleaseConfig(readReleaseConfig());
console.log("public release unit configuration passed");
