// The API takes uploads up to 4 MB (Vercel's request limit sits just above). Phone photos of a
// passport are often larger, so they are re-encoded here first; PDFs are sent as they are.

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const SHRINK_ABOVE_BYTES = 2.5 * 1024 * 1024;
const LONGEST_SIDE = 2400;

/** A large photo as a JPEG no more than 2400px on its longest side, still sharp enough to read. Anything else unchanged. */
export async function shrinkPhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.size <= SHRINK_ABOVE_BYTES) return file;
  const image = await createImageBitmap(file);
  const scale = Math.min(1, LONGEST_SIDE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ?? file;
}

export function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
