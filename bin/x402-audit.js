#!/usr/bin/env node
import("../dist/src/cli.js").then((m) => m.main(process.argv.slice(2)));
