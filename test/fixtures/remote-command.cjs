exports.decodeRemoteCommand = (command) => {
  const match = /^\{ printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| sh; \} 3<&0$/.exec(command);
  return match ? Buffer.from(match[1], 'base64').toString('utf8').replace(/ <&3 3<&-\n$/, '') : command;
};

exports.decodeRemoteLog = (log) => log.split('\n').map(exports.decodeRemoteCommand).join('\n');
