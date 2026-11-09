const fs = require('node:fs');
const { call } = require('./client.cjs');
const { tools } = require('./schema.cjs');

async function run(args) {
  if (args.includes('--mcp')) {
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    const server = new Server({ name: 'recorder', version: '1.1.1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const method = request.params.name.replaceAll('_', '.');
        const result = await call(method, request.params.arguments || {});
        if (method === 'source.preview') return { content: [
          { type: 'image', mimeType: 'image/png', data: result.thumbnail.split(',')[1] },
          { type: 'text', text: JSON.stringify({ sourceId: result.sourceId, geometry: result.geometry }) },
        ] };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
    await server.connect(new StdioServerTransport());
    process.stdin.once('end', () => { server.close().finally(() => process.exit(0)); });
    return;
  }
  const index = args.indexOf('--cli');
  const method = args[index + 1];
  if (!method || method === 'help') {
    process.stdout.write(JSON.stringify({ usage: 'Recorder.exe --cli METHOD [JSON | --file recipe.json] [--request-id UUID]', methods: tools().map(t => t.name.replaceAll('_', '.')) }) + '\n');
  } else if (method === 'tools') process.stdout.write(JSON.stringify(tools()) + '\n');
  else {
    const raw = args[index + 2];
    const params = raw === '--file' ? JSON.parse(fs.readFileSync(args[index + 3], 'utf8')) : raw && !raw.startsWith('--') ? JSON.parse(raw) : {};
    const requestIndex = args.indexOf('--request-id');
    const result = await call(method, params, { requestId: requestIndex >= 0 ? args[requestIndex + 1] : undefined });
    process.stdout.write(JSON.stringify({ result }) + '\n');
  }
  return 'done';
}
if (require.main === module) run(process.argv.slice(2)).catch(error => { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; });
module.exports = { run };
