"use strict";

const { start } = require("./server");

start().catch((error) => {
    console.error(`[latc] failed to start: ${error.message}`);
    process.exit(1);
});
