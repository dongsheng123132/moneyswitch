import express from 'express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware } from '@x402/express';
import { MAINNET, TESTNET } from '../../packages/x402/dist/networks.js';

export const RECEIVER_PATH = '/x402-receive/mainnet/check';
export const TESTNET_RECEIVER_PATH = '/x402-testnet/check';
export const RECEIVER_PRICE = '0.1';

/** A standalone seller: no administrator tokens, payer keys or wallet files. */
export function createReceiver({ payTo, mode = "mainnet", facilitatorClient, onSettled = () => {} }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo ?? '') || /^0x0{40}$/.test(payTo)) throw new Error('A receiving wallet address is required');
  if (!['mainnet', 'testnet'].includes(mode)) throw new Error('Invalid receiver network mode');
  const testnet = mode === 'testnet';
  const network = testnet ? TESTNET : MAINNET;
  if (network.caip2 !== (testnet ? 'eip155:10143' : 'eip155:143')) throw new Error('Receiver network mismatch');
  const route = testnet ? TESTNET_RECEIVER_PATH : RECEIVER_PATH;
  const price = testnet ? '0.01' : RECEIVER_PRICE;
  const atomicAmount = testnet ? '10000' : '100000';
  const networkNotice = testnet ? 'Monad 测试网 · 每次 0.01 测试 USDC（无真实价值）' : 'Monad 主网 · 每次 0.1 USDC 真金付款';
  const scheme = new ExactEvmScheme();
  scheme.registerMoneyParser(async () => ({ amount: atomicAmount, asset: network.usdcAddress,
    extra: { name: network.usdcDomainName, version: network.usdcDomainVersion } }));
  const server = new x402ResourceServer(facilitatorClient ?? new HTTPFacilitatorClient({
    url: network.facilitatorUrl, timeoutMs: 20000,
  })).register(network.caip2, scheme);
  server.onAfterSettle(async ({ result, requirements }) => {
    if (result.success) onSettled({ event: 'x402.settled', network: result.network,
      tx_hash: result.transaction, payer: result.payer, pay_to: requirements.payTo, amount: price });
  });
  const app = express();
  app.disable('x-powered-by');
  // The container port is published only on loopback, behind one Caddy proxy.
  app.set('trust proxy', 1);
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res) => res.json({ ok: true, network: network.caip2 }));
  app.get(testnet ? '/x402-testnet/' : '/x402-receive/', (_req, res) => res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MoneySwitch · x402 收款验证</title><style>body{max-width:780px;margin:64px auto;padding:0 24px;font:18px/1.7 system-ui;color:#17233b}code{overflow-wrap:anywhere}strong{color:#a43b14}</style><h1>x402 收款验证</h1><p><strong>${networkNotice}</strong></p><p>收款钱包：<code>${payTo}</code></p><p>给 AI 的收费接口：<br><code>GET https://app.moneyswitch.dev${route}</code></p><p>用 MoneySwitch 调用 <code>POST /v1/fetch</code>，将 <code>url</code> 设为上面的接口，<code>max_price</code> 设为 <code>${price}</code>。</p><p>普通浏览器访问收费接口会返回 HTTP 402，这是报价，不会扣款。付款成功会返回验证结果和 PAYMENT-RESPONSE 收据。付款钱包必须解锁；收款方无需提供私钥。</p><p>${testnet ? '测试网接口只接受 Monad 测试 USDC。创建 MoneyKey 时允许域名 app.moneyswitch.dev:443，在「付款测试」中填写此接口。' : '这是独立的主网收款接口，现有测试网管理面板不会把这里的主网收入显示成测试币。'}</p></html>`));
  app.use(paymentMiddleware({ [`GET ${route}`]: {
    accepts: { scheme: 'exact', payTo, price, network: network.caip2 },
    description: networkNotice,
    mimeType: 'application/json',
  } }, server));
  app.get(route, (_req, res) => res.json({ ok: true, service: 'x402-receive-check',
    network: network.caip2, price, currency: 'USDC', pay_to: payTo,
    message: 'x402 payment accepted; retain the PAYMENT-RESPONSE receipt.', at: new Date().toISOString() }));
  app.use((_error, _req, res, _next) => res.status(502).json({ error: 'RECEIVER_UNAVAILABLE',
    message: 'Check any payment receipt before retrying a signed request.' }));
  return app;
}
