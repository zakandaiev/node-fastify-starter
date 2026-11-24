import diagnosticsChannel from 'node:diagnostics_channel';

const LISTENING_CHANNEL = 'tracing:net.server.listen:asyncEnd';

// Preloaded with --import: a moment after the server listens, a promise rejects that nothing awaits.
diagnosticsChannel.subscribe(LISTENING_CHANNEL, () => {
  setImmediate(() => {
    Promise.reject(new Error('A promise nothing awaits rejected'));
  });
});
