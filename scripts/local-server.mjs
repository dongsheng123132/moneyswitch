// The desktop launcher's background host. It never creates/unlocks a wallet
// unless the operator explicitly configured a password file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = new Map();
for (let i=2;i<process.argv.length;i+=2) args.set(process.argv[i],process.argv[i+1]);
const dataDir=path.resolve(args.get('--data-dir') || '');
const port=Number(args.get('--port'));
const network=args.get('--network');
if (!args.get('--data-dir') || !Number.isInteger(port) || port<1024 || port>65535 || !['eip155:143','eip155:10143','eip155:8453','eip155:84532'].includes(network)) throw new Error('Invalid local server configuration');
process.env.MONEYSWITCH_NETWORKS=network;
process.env.MONEYSWITCH_DEFAULT_NETWORK=network;
process.env.MONEYSWITCH_DATA_DIR=dataDir;
process.env.MONEYSWITCH_HOST='127.0.0.1';
process.env.MONEYSWITCH_PORT=String(port);
process.env.MONEYSWITCH_NOTIFY_INTERVAL_MS='0';
delete process.env.MONEYSWITCH_DB_PATH;
delete process.env.MONEYSWITCH_WALLET_PASSWORD;
delete process.env.MONEYSWITCH_WALLET_PASSWORD_FILE;
if (args.get('--password-file')) process.env.MONEYSWITCH_WALLET_PASSWORD_FILE=path.resolve(args.get('--password-file'));
const {installOutboundProxy}=await import('../packages/net/dist/index.js');installOutboundProxy();
const {startServer,loadConfig}=await import('../apps/server/dist/start.js');
fs.mkdirSync(dataDir,{recursive:true});
const running=await startServer(loadConfig(),{onFirstRun:({adminToken})=>{
  fs.writeFileSync(path.join(dataDir,'admin-token.txt'),adminToken,{flag:'wx',mode:0o600});
}});
const stateFile=path.join(dataDir,'local-launcher.json');
const state={pid:process.pid,port,network,data_dir:dataDir,script:fileURLToPath(import.meta.url)};
const temporary=stateFile+'.'+process.pid+'.tmp';
fs.writeFileSync(temporary,JSON.stringify(state));fs.renameSync(temporary,stateFile);
console.log(`MoneySwitch local wallet ready: http://127.0.0.1:${port}/wallet (${network})`);
async function close(){await running.close();if(JSON.parse(fs.readFileSync(stateFile,'utf8')).pid===process.pid)fs.unlinkSync(stateFile);process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
