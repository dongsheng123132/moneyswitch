import { createReceiver } from './receiver.mjs';
const port = Number(process.env.RECEIVER_PORT || 4021);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid receiver port');
const app = createReceiver({ payTo: process.env.RECEIVER_PAY_TO, mode: process.env.RECEIVER_MODE || "mainnet",
  onSettled: record => console.log(JSON.stringify(record)) });
const server = app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'receiver.ready', port })));
server.requestTimeout = 60000;
server.headersTimeout = 15000;
function stop() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
