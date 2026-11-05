'use strict';
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PUBLIC_MODE === 'true' ? '0.0.0.0' : '127.0.0.1');

createApp().listen(PORT, HOST, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\nAPI Playground is running\n  Practice console  ${base}\n  Swagger docs      ${base}/docs\n  OpenAPI spec      ${base}/openapi.json\n`);
});
