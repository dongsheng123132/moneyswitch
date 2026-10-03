import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const rev = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding:'utf8'}).trim();
const pkg = path.join(root, 'apps/server-pkg');
const deps = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).dependencies;
if (JSON.stringify(deps) !== JSON.stringify({'better-sqlite3':'13.0.3'})) throw new Error('Base image dependency changed; use a full source Docker build');
const out = path.join(root, '.data/us-release', rev.slice(0,7));
fs.mkdirSync(out, {recursive:true});
for (const d of ['dist','dashboard','migrations']) fs.cpSync(path.join(pkg,d),path.join(out,d),{recursive:true});
for (const [src,dst] of [['deploy/prebuilt.Dockerfile','Dockerfile'],['deploy/moneyswitch.caddy','moneyswitch.caddy'],['deploy/activate-caddy.sh','activate-caddy.sh'],['docker-compose.yml','docker-compose.yml'],['deploy/upgrade-us.sh','upgrade-us.sh']]) fs.writeFileSync(path.join(out,dst),fs.readFileSync(path.join(root,src),'utf8').replace(/\r\n/g,'\n'));
fs.writeFileSync(path.join(out,'REVISION'),rev+'\n');
function files(dir) {return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
fs.writeFileSync(path.join(out,'SHA256SUMS'),files(out).filter(f=>!f.endsWith('SHA256SUMS')).map(f=>`${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.relative(out,f).replaceAll('\\','/')}\n`).join(''));
console.log(out);
