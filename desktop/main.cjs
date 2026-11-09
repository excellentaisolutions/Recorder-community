const { app } = require('electron');
if (process.argv.includes('--mcp') || process.argv.includes('--cli')) {
  require('./agents/entry.cjs').run(process.argv).then(result => {
    if (result === 'done') process.stdout.write('', () => app.exit(0));
  }).catch(error => { process.stderr.write(JSON.stringify({ error: error.message }) + '\n', () => app.exit(1)); });
} else require('./app.cjs');
