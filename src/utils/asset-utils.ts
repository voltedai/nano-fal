/**
 * Extract file extension from URL or Content-Type header
 * @param url The file URL from Fal
 * @param contentType Optional Content-Type header from HTTP response
 * @param assetType Type of asset ('image' or 'video')
 * @returns File extension (e.g., 'png', 'jpg', 'mp4', 'webm')
 */
export function getAssetExtension(url: string, contentType: string | null | undefined, assetType: 'image' | 'video'): string {
  // Priority 1: Extract from URL (Fal provides it)
  const urlMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i)
  if (urlMatch) {
    return urlMatch[1]
  }

  // Priority 2: Extract from Content-Type
  if (contentType) {
    if (assetType === 'image') {
      const mimeMatch = contentType.match(/image\/(?:x-)?([^;]+)/i)
      if (mimeMatch) {
        const mimeExt = mimeMatch[1].toLowerCase()
        return mimeExt === 'jpeg' ? 'jpg' : mimeExt
      }
    } else {
      const mimeMatch = contentType.match(/video\/(?:x-)?([^;]+)/i)
      if (mimeMatch) {
        const mimeExt = mimeMatch[1].toLowerCase()
        return mimeExt === 'quicktime' ? 'mov' : mimeExt
      }
    }
  }

  // Priority 3: Default based on type
  return assetType === 'image' ? 'png' : 'mp4'
}

/**
 * Generate a filename for uploaded asset (image or video)
 * @param url The file URL from Fal
 * @param contentType Optional Content-Type header from HTTP response
 * @param assetType Type of asset ('image' or 'video')
 * @returns Filename in format: upload-YYYY-MM-DDTHH-MM-SS.{ext}
 */
export function generateAssetFilename(url: string, contentType: string | null | undefined, assetType: 'image' | 'video'): string {
  const extension = getAssetExtension(url, contentType, assetType)
  const date = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
  return `upload-${date}.${extension}`
}

// Legacy exports for backward compatibility
export function getVideoExtension(videoUrl: string, contentType?: string | null): string {
  return getAssetExtension(videoUrl, contentType, 'video')
}

export function generateVideoFilename(videoUrl: string, contentType?: string | null): string {
  return generateAssetFilename(videoUrl, contentType, 'video')
}

