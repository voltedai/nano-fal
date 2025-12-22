import { File } from 'node:buffer'
import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'

interface NanoBananaImage {
  url?: string
}

interface NanoBananaEditResponse {
  data?: {
    images?: NanoBananaImage[]
    description?: string
  }
  images?: NanoBananaImage[]
  description?: string
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const allowedFormats = new Set(['jpeg', 'png'])

const detectImageFormat = (buffer: Buffer): string => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }

  if (
    buffer.length >= 8 &&
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
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x39 || buffer[4] === 0x37) &&
    buffer[5] === 0x61
  ) {
    return 'gif'
  }

  if (
    buffer.length >= 12 &&
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

const nodeDefinition: NodeDefinition = {
  uid: 'fal-nano-banana-edit',
  name: 'Nano Banana Edit',
  category: 'Nano Banana / Standard',
  version: '1.0.0',
  type: 'server',
  description: 'Edits images using the Fal.ai Nano Banana edit model',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the desired changes'
    },
    {
      name: 'image1',
      type: 'asset:image',
      description: 'Primary image to edit'
    },
    {
      name: 'image2',
      type: 'asset:image',
      description: 'Optional additional reference image',
      optional: true
    },
    {
      name: 'image3',
      type: 'asset:image',
      description: 'Optional additional reference image',
      optional: true
    },
    {
      name: 'image4',
      type: 'asset:image',
      description: 'Optional additional reference image',
      optional: true
    }
  ],
  outputs: [
    {
      name: 'images',
      type: 'asset:image',
      description: 'Edited images as asset URIs'
    },
    {
      name: 'description',
      type: 'string',
      description: 'Model response describing the edits'
    }
  ],
  parameters: [
    {
      name: 'num_images',
      type: 'number',
      value: 1,
      default: 1,
      label: 'Number of Images',
      description: 'How many edited images to generate (1-4)',
      min: 1,
      max: 4
    },
    {
      name: 'output_format',
      type: 'select',
      value: 'jpeg',
      default: 'jpeg',
      label: 'Output Format',
      description: 'Format of the edited images',
      options: [
        { label: 'JPEG', value: 'jpeg' },
        { label: 'PNG', value: 'png' }
      ]
    },
    {
      name: 'sync_mode',
      type: 'boolean',
      value: false,
      default: false,
      label: 'Sync Mode',
      description: 'Return inline images instead of URLs (Fal API option)'
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: '1:1',
      default: '1:1',
      label: 'Aspect Ratio',
      description: 'Aspect ratio for generated images',
      options: [
        { label: '21:9', value: '21:9' },
        { label: '1:1', value: '1:1' },
        { label: '4:3', value: '4:3' },
        { label: '3:2', value: '3:2' },
        { label: '2:3', value: '2:3' },
        { label: '5:4', value: '5:4' },
        { label: '4:5', value: '4:5' },
        { label: '3:4', value: '3:4' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' }
      ]
    }
  ]
}

const nanoBananaEditNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

nanoBananaEditNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const imageInputs = [
    inputs.image1?.[0] as string | undefined,
    inputs.image2?.[0] as string | undefined,
    inputs.image3?.[0] as string | undefined,
    inputs.image4?.[0] as string | undefined
  ].filter((uri): uri is string => Boolean(uri))

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (imageInputs.length === 0) {
    context.sendStatus({ type: 'error', message: 'At least one image is required' })
    throw new Error('At least one image is required')
  }

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const requestedFormat = String(getParameterValue(parameters, 'output_format', 'jpeg'))
  const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'jpeg'
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const aspectRatio = String(getParameterValue(parameters, 'aspect_ratio', '1:1'))

  context.sendStatus({ type: 'running', message: 'Preparing input images...' })

  try {
    const imageUrls: string[] = []

    type FalStorageUploadInput = Parameters<typeof fal.storage.upload>[0]

    for (let index = 0; index < imageInputs.length; index++) {
      const assetUri = imageInputs[index]
      const buffer: Buffer = await resolveAsset(assetUri, { asBuffer: true }) as Buffer
      const format = detectImageFormat(buffer)
      const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : `image/${format}`
      const extension = format === 'jpeg' ? 'jpg' : format
      const filename = `reference-${index + 1}.${extension}`
      const file = new File([buffer], filename, { type: mimeType })
      const uploadedUrl = await fal.storage.upload(file as unknown as FalStorageUploadInput)

      if (!uploadedUrl) {
        throw new Error(`Fal storage upload failed for reference image ${index + 1}`)
      }

      imageUrls.push(uploadedUrl)

      context.sendStatus({
        type: 'running',
        message: `Uploaded reference image ${index + 1}/${imageInputs.length}`,
        progress: { step: Math.min(10 + (index + 1) * 5, 40), total: 100 }
      })
    }

    const requestPayload = {
      prompt,
      image_urls: imageUrls,
      num_images: numImages,
      output_format: outputFormat,
      sync_mode: syncMode,
      aspect_ratio: aspectRatio
    }

    let stepCount = 0
    const expectedMs = Math.min(180000, Math.max(20000, numImages * 9000))
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing edits...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe('fal-ai/nano-banana/edit', {
      input: requestPayload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        if (status.status === 'IN_QUEUE') {
          const r = strategy.onQueue()
          const startStep = Math.max(40, r.progress.step)
          context.sendStatus({ type: 'running', message: r.message, progress: { step: startStep, total: 100 } })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount++
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as NanoBananaEditResponse

    const images = result.data?.images ?? result.images ?? []
    if (!images.length) {
      throw new Error('No images were returned by the Nano Banana edit API')
    }

    const uploadedUris: string[] = []
    for (const image of images) {
      if (!image.url) {
        continue
      }

      const response = await fetch(image.url)
      const contentType = response.headers.get('content-type')
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const filename = generateAssetFilename(image.url, contentType, 'image')
      const uploadResult = await uploadAsset(buffer, { type: 'image', filename })

      if (!uploadResult.uri) {
        throw new Error('Failed to upload edited image')
      }

      uploadedUris.push(uploadResult.uri)
    }

    if (!uploadedUris.length) {
      throw new Error('Edited images could not be retrieved')
    }

    const description = result.data?.description ?? result.description ?? ''

    return {
      images: uploadedUris,
      description: description ? [description] : []
    }
  } catch (error: any) {
    const message = error?.message ?? 'Failed to edit images'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default nanoBananaEditNode
