import QRCode from 'qrcode';

// Encode the returned login URL verbatim, as the official CLI's --image does.
// Render locally: the pairing URL never goes to a QR image service.
export function drawPairingQr(canvas, url) {
  return QRCode.toCanvas(canvas, url, {
    width: 280, margin: 4, errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
