import { resolveAsset, uploadAsset } from '@nanograph/sdk'
import { Readable } from 'node:stream'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'

export interface FalImageReference {
  url?: string
}

export const detectImageFormat = (buffer: Buffer): 'jpeg' | 'png' | 'webp' => {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }

  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png'
  }

  if (
    buffer.length > 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp'
  }

  return 'jpeg'
}

export const bufferToDataUrl = async (buffer: Buffer, format?: 'jpeg' | 'png' | 'webp'): Promise<string> => {
  const detected = format ?? detectImageFormat(buffer)
  return uploadBufferToFal(buffer, detected, { filenamePrefix: 'flux-pro-source' })
}

export const assetToDataUrl = async (uri: string): Promise<string> => {
  const asset = await resolveAsset(uri, { asBuffer: true })

  if (!asset) {
    throw new Error('Failed to resolve asset')
  }

  if (Buffer.isBuffer(asset)) {
    return bufferToDataUrl(asset)
  }

  if (asset instanceof Uint8Array) {
    return bufferToDataUrl(Buffer.from(asset))
  }

  if (asset instanceof ArrayBuffer) {
    return bufferToDataUrl(Buffer.from(asset))
  }

  if (asset instanceof Readable) {
    const chunks: Buffer[] = []

    for await (const chunk of asset) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk)
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk))
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk))
      }
    }

    if (!chunks.length) {
      throw new Error('Received empty stream while resolving asset')
    }

    return bufferToDataUrl(Buffer.concat(chunks))
  }

  throw new Error('Unsupported asset type returned by resolver')
}

export const uploadGeneratedImages = async (images: FalImageReference[]): Promise<string[]> => {
  return Promise.all(images.map(async (image) => {
    if (!image?.url) {
      throw new Error('Fal response did not contain an image URL')
    }

    const response = await fetch(image.url)
    const contentType = response.headers.get('content-type')
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const filename = generateAssetFilename(image.url, contentType, 'image')
    const uploadResult = await uploadAsset(buffer, { type: 'image', filename })

    if (!uploadResult?.uri) {
      throw new Error('Failed to upload generated image')
    }

    return uploadResult.uri
  }))
}
