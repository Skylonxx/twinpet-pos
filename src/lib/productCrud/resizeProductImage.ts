const TARGET_WIDTH = 400;
const TARGET_HEIGHT = 300;
const TARGET_ASPECT = TARGET_WIDTH / TARGET_HEIGHT;
const OUTPUT_QUALITY = 0.7;

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('โหลดรูปภาพไม่สำเร็จ'));
    };
    img.src = url;
  });
}

function centerCropSource(img: HTMLImageElement) {
  const srcAspect = img.naturalWidth / img.naturalHeight;
  if (srcAspect > TARGET_ASPECT) {
    const sh = img.naturalHeight;
    const sw = sh * TARGET_ASPECT;
    return {
      sx: (img.naturalWidth - sw) / 2,
      sy: 0,
      sw,
      sh,
    };
  }
  const sw = img.naturalWidth;
  const sh = sw / TARGET_ASPECT;
  return {
    sx: 0,
    sy: (img.naturalHeight - sh) / 2,
    sw,
    sh,
  };
}

/** Resize + center-crop to 400×300, encode as WebP or JPEG base64 data URL. */
export async function resizeProductImageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('กรุณาเลือกไฟล์รูปภาพ');
  }

  const img = await loadImageFromFile(file);
  const { sx, sy, sw, sh } = centerCropSource(img);

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = TARGET_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('ไม่สามารถประมวลผลรูปภาพได้');
  }

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);

  const webp = canvas.toDataURL('image/webp', OUTPUT_QUALITY);
  if (webp.startsWith('data:image/webp')) {
    return webp;
  }

  return canvas.toDataURL('image/jpeg', OUTPUT_QUALITY);
}
