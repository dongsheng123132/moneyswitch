import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver, RECEIVER_PATH } from './receiver.mjs';
const payTo = '0x1111111111111111111111111111111111111111';
test('mainnet receiver quotes exact amount/address and never serves paid content without verification', async () => {
  let verifies = 0, settlements = 0;
  const facilitatorClient = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:143' }], extensions: [], signers: {} }),
    verify: async () => { verifies++; return { isValid: false, invalidReason: 'invalid_signature' }; },
    settle: async () => { settlements++; throw new Error('Must not settle a rejected payment'); },
  };
  const server = createReceiver({ payTo, facilitatorClient }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const info = await fetch(base + '/x402-receive/');
    assert.equal(info.status, 200); assert.match(await info.text(), /主网/);
    const res = await fetch(base + RECEIVER_PATH);
    assert.equal(res.status, 402);
    const quote = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString());
    assert.equal(quote.accepts.length, 1);
    const req = quote.accepts[0];
    assert.equal(req.network, 'eip155:143'); assert.equal(req.amount, '100000'); assert.equal(req.payTo, payTo);
    assert.equal(req.asset.toLowerCase(), '0x754704bc059f8c67012fed69bc8a327a5aafb603');
    const invalid = { x402Version: 2, resource: quote.resource, accepted: req,
      payload: { signature: '0x'+'00'.repeat(65), authorization: { from: payTo, to: payTo,
        value: '100000', validAfter: '0', validBefore: '9999999999', nonce: '0x'+'00'.repeat(32) } } };
    const rejected = await fetch(base + RECEIVER_PATH, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(invalid)).toString('base64') } });
    assert.equal(rejected.status, 402); assert.equal(verifies, 1); assert.equal(settlements, 0);
    assert.equal((await rejected.json()).service, undefined);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
for (const success of [false, true]) test(`settlement ${success ? 'success returns a receipt' : 'failure withholds paid content'}`, async () => {
  let settlements = 0; const audit = [];
  const facilitatorClient = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:143' }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer: payTo }),
    settle: async () => { settlements++; return { success, transaction: success ? '0x'+'11'.repeat(32) : '', network: 'eip155:143', payer: payTo, ...(success ? {} : { errorReason: 'settlement_failed' }) }; },
  };
  const server = createReceiver({ payTo, facilitatorClient, onSettled: x => audit.push(x) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}${RECEIVER_PATH}`;
  try {
    const q = await fetch(url);
    const quote = JSON.parse(Buffer.from(q.headers.get('payment-required'), 'base64').toString());
    const payload = { x402Version: 2, resource: quote.resource, accepted: quote.accepts[0], payload: {
      signature: '0x'+'00'.repeat(65), authorization: { from: payTo, to: payTo, value: '100000', validAfter: '0', validBefore: '9999999999', nonce: '0x'+'00'.repeat(32) } } };
    const res = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') } });
    assert.equal(res.status, success ? 200 : 402); assert.equal(settlements, 1);
    const body = await res.json();
    assert.equal(body.service, success ? 'x402-receive-check' : undefined);
    assert.equal(audit.length, success ? 1 : 0);
    if (success) {
      const receipt = JSON.parse(Buffer.from(res.headers.get('payment-response'), 'base64').toString());
      assert.equal(receipt.success, true); assert.equal(receipt.transaction, '0x'+'11'.repeat(32));
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
