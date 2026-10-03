import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver, TESTNET_RECEIVER_PATH } from './receiver.mjs';
const payTo = '0x1111111111111111111111111111111111111111';
const NETWORK = 'eip155:10143';
const supported = { getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} }) };

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const signedPayload = (quote, req) => ({ x402Version: 2, resource: quote.resource, accepted: req, payload: {
  signature: '0x'+'00'.repeat(65), authorization: { from: payTo, to: payTo, value: '10000', validAfter: '0', validBefore: '9999999999', nonce: '0x'+'00'.repeat(32) } } });
const header = value => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = value => JSON.parse(Buffer.from(value, 'base64').toString());

test('testnet receiver quotes exactly 0.01 test USDC to the stated address and never serves paid content without verification', async () => {
  let verifies = 0, settlements = 0;
  const facilitatorClient = { ...supported,
    verify: async () => { verifies++; return { isValid: false, invalidReason: 'invalid_signature' }; },
    settle: async () => { settlements++; throw new Error('Must not settle a rejected payment'); },
  };
  const { base, close } = await serve(createReceiver({ payTo, facilitatorClient }));
  try {
    const info = await fetch(base + '/x402-testnet/');
    assert.equal(info.status, 200); assert.match(await info.text(), /无真实价值/);
    const res = await fetch(base + TESTNET_RECEIVER_PATH);
    assert.equal(res.status, 402);
    const quote = decode(res.headers.get('payment-required'));
    assert.equal(quote.accepts.length, 1);
    const req = quote.accepts[0];
    assert.equal(req.network, NETWORK); assert.equal(req.amount, '10000'); assert.equal(req.payTo, payTo);
    assert.equal(req.asset.toLowerCase(), '0x534b2f3a21130d7a60830c2df862319e593943a3');
    const rejected = await fetch(base + TESTNET_RECEIVER_PATH, { headers: { 'PAYMENT-SIGNATURE': header(signedPayload(quote, req)) } });
    assert.equal(rejected.status, 402); assert.equal(verifies, 1); assert.equal(settlements, 0);
    assert.equal((await rejected.json()).service, undefined);
  } finally { await close(); }
});

for (const success of [false, true]) test(`settlement ${success ? 'success returns a receipt' : 'failure withholds paid content'}`, async () => {
  let settlements = 0; const audit = [];
  const facilitatorClient = { ...supported,
    verify: async () => ({ isValid: true, payer: payTo }),
    settle: async () => { settlements++; return { success, transaction: success ? '0x'+'11'.repeat(32) : '', network: NETWORK, payer: payTo, ...(success ? {} : { errorReason: 'settlement_failed' }) }; },
  };
  const { base, close } = await serve(createReceiver({ payTo, facilitatorClient, onSettled: x => audit.push(x) }));
  const url = base + TESTNET_RECEIVER_PATH;
  try {
    const q = await fetch(url);
    const quote = decode(q.headers.get('payment-required'));
    const res = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': header(signedPayload(quote, quote.accepts[0])) } });
    assert.equal(res.status, success ? 200 : 402); assert.equal(settlements, 1);
    const body = await res.json();
    assert.equal(body.service, success ? 'x402-receive-check' : undefined);
    assert.equal(audit.length, success ? 1 : 0);
    if (success) {
      assert.equal(body.network, NETWORK); assert.equal(body.price, '0.01');
      const receipt = decode(res.headers.get('payment-response'));
      assert.equal(receipt.success, true); assert.equal(receipt.transaction, '0x'+'11'.repeat(32));
      assert.equal(audit[0].amount, '0.01'); assert.equal(audit[0].network, NETWORK);
    }
  } finally { await close(); }
});

test('there is no mainnet receiver: no mainnet route, and a leftover RECEIVER_MODE=mainnet is refused instead of ignored', async () => {
  const { base, close } = await serve(createReceiver({ payTo, facilitatorClient: supported }));
  try {
    for (const route of ['/x402-receive/', '/x402-receive/mainnet/check']) assert.equal((await fetch(base + route)).status, 404, route);
  } finally { await close(); }
  assert.throws(() => createReceiver({ payTo, mode: 'mainnet', facilitatorClient: supported }), /Only the testnet receiver exists/);
  assert.doesNotThrow(() => createReceiver({ payTo, mode: 'testnet', facilitatorClient: supported }));
  assert.doesNotThrow(() => createReceiver({ payTo, mode: '', facilitatorClient: supported }));
});

test('a receiver needs a real receiving address', () => {
  for (const bad of [undefined, '', '0x1234', '0x' + '0'.repeat(40)]) assert.throws(() => createReceiver({ payTo: bad, facilitatorClient: supported }), /receiving wallet address/);
});
