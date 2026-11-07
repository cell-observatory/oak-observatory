// Preload (`node --require`): every `require` of core's dist entry gets index-listing-shim.cjs instead, so a test file
// that loads core directly runs its listings and searches through the local index, each checked against the old one.
const real = require.resolve('../../dist/index.js');
require(real);
require.cache[real].exports = require('./index-listing-shim.cjs');
