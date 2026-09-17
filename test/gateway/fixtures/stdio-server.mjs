import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const configIndex = process.argv.indexOf('--config');
const configFile = process.argv[configIndex + 1];
const profile = JSON.parse(readFileSync(configFile, 'utf8'));
const assertionFile = profile.servers[0].credentialRef.slice('file:'.length);
const assertion = readFileSync(assertionFile, 'utf8');

serveStdio(() => {
  const server = new McpServer(
    { name: 'gateway-worker-fixture', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  server.registerTool(
    'custody',
    { inputSchema: z.object({}) },
    () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: {
        argv_contains_assertion: process.argv.includes(assertion),
        env_contains_assertion: Object.values(process.env).includes(assertion),
        api_base_url: profile.servers[0].apiBaseUrl
      }
    })
  );
  return server;
});
