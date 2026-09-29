/**
 * The `oak` bin (built unbundled to dist/index.js). The capture hooks run `oak capture` around every
 * tool call, so that command loads only the capture bundle instead of compiling the whole CLI,
 * terminal app included: 40 ms per hook against 77 ms (measured 2026-09-26). Everything else, and
 * `oak capture --help`, is the full CLI in dist/cli.js. The installed hook command is unchanged.
 */
require(process.argv[2] === 'capture' && !process.argv.includes('--help') && !process.argv.includes('-h') ? './capture.js' : './cli.js');
