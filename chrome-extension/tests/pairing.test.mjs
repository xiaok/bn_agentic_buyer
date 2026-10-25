import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { drawPairingQr } from '../src/pairing.mjs';

test('pairing QR pixels decode to the exact returned login URL, including nested query escapes', async () => {
  let pixels;
  const canvas = { width: 0, height: 0, getContext() { return {
    clearRect() {},
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
    putImageData(image) { pixels = image; },
  }; } };
  const urls = [
    'https://web3.binance.com/en/agent-login?expireAt=1792900000000&url=binance%3A%2F%2Fwallet%3Fid%3Dabc%26key%3Da%252Bb%253D',
    'https://www.binance.com/test-pairing?code=second&key=%2B%2F%3D',
  ];
  for (const url of urls) {
    await drawPairingQr(canvas, url);
    assert.equal(canvas.width, 280);
    assert.equal(canvas.height, 280);
    assert.equal(jsQR(pixels.data, pixels.width, pixels.height)?.data, url);
  }
});
