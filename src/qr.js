import QRCode from 'qrcode';

/** 终端里直接画的二维码（用半块字符，扫描效果比 ASCII 好很多）。 */
export async function terminalQr(text) {
  return QRCode.toString(text, {
    type: 'terminal',
    small: true,
    margin: 1,
    errorCorrectionLevel: 'M',
  });
}

export async function pngDataUrl(text, size = 520) {
  return QRCode.toDataURL(text, {
    margin: 2,
    width: size,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
}

export async function pngFile(file, text, size = 520) {
  return QRCode.toFile(file, text, {
    margin: 2,
    width: size,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
}
