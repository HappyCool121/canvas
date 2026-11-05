export const MAX_IMAGES = 600;
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;

export class AttachmentLimitError extends Error {}
export function checkImageBudget(sizes: readonly number[]) {
  if (sizes.length > MAX_IMAGES) throw new AttachmentLimitError(`A conversation can send at most ${MAX_IMAGES} images or document pages, including its ancestors.`);
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 0 || size > MAX_IMAGE_BYTES)) throw new AttachmentLimitError("Each prepared image must be 64 MiB or smaller.");
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_IMAGE_BYTES) throw new AttachmentLimitError("The selected conversation and attachments exceed the 200 MiB image budget. Select fewer pages or branch from an earlier message.");
}
