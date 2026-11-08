const Module = require('node:module');
const load = Module._load;
let attempted = false;
process.on('exit', () => { if (attempted) process.exitCode = 90; });
Module._load = function (name, ...args) {
  if (name === 'node:sqlite' || /index[\/]api(?:\.js)?$/.test(name)) { attempted = true; throw new Error('capture loaded the database'); }
  return load.call(this, name, ...args);
};
