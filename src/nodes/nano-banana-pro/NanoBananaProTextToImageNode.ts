import { NanoSDK, NodeDefinition, NodeInstance, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { generateAssetFilename } from '../../utils/asset-utils.js'

interface NanoBananaProImage {
  url?: string
  file_name?: string
  content_type?: string
}

interface NanoBananaProTextToImageResponse {
  data?: {
    images?: NanoBananaProImage[]
    description?: string
  }
  images?: NanoBananaProImage[]
  description?: string
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const allowedFormats = new Set(['jpeg', 'png', 'webp'])

const nodeDefinition: NodeDefinition = {
  uid: 'fal-nano-banana-pro-text-to-image',
  name: 'Nano Banana Pro Text to Image',
  category: 'Image Generation',
  version: '1.0.0',
  type: 'server',
  description: 'Generates images from text prompts using the Fal.ai Nano Banana Pro model',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the desired image'
    }
  ],
  outputs: [
    {
      name: 'images',
      type: 'asset:image',
      description: 'Generated images as asset URIs'
    },
    {
      name: 'description',
      type: 'string',
      description: 'Model response describing the generated images'
    }
  ],
  parameters: [
    {
      name: 'num_images',
      type: 'number',
      value: 1,
      default: 1,
      label: 'Number of Images',
      description: 'How many images to generate (1-4)',
      min: 1,
      max: 4
    },
    {
      name: 'resolution',
      type: 'select',
      value: '1K',
      default: '1K',
      label: 'Resolution',
      description: 'Resolution of the generated image',
      options: [
        { label: '1K', value: '1K' },
        { label: '2K', value: '2K' },
        { label: '4K', value: '4K' }
      ]
    },
    {
      name: 'output_format',
      type: 'select',
      value: 'jpeg',
      default: 'jpeg',
      label: 'Output Format',
      description: 'Format of the generated images',
      options: [
        { label: 'JPEG', value: 'jpeg' },
        { label: 'PNG', value: 'png' },
        { label: 'WebP', value: 'webp' }
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
        { label: '16:9', value: '16:9' },
        { label: '3:2', value: '3:2' },
        { label: '4:3', value: '4:3' },
        { label: '5:4', value: '5:4' },
        { label: '1:1', value: '1:1' },
        { label: '4:5', value: '4:5' },
        { label: '3:4', value: '3:4' },
        { label: '2:3', value: '2:3' },
        { label: '9:16', value: '9:16' }
      ]
    }
  ]
}

const nanoBananaProTextToImageNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

nanoBananaProTextToImageNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  const numImages = clamp(Number(getParameterValue(parameters, 'num_images', 1)), 1, 4)
  const resolution = String(getParameterValue(parameters, 'resolution', '1K'))
  const requestedFormat = String(getParameterValue(parameters, 'output_format', 'jpeg'))
  const outputFormat = allowedFormats.has(requestedFormat) ? requestedFormat : 'jpeg'
  const syncMode = Boolean(getParameterValue(parameters, 'sync_mode', false))
  const aspectRatio = String(getParameterValue(parameters, 'aspect_ratio', '1:1'))

  context.sendStatus({ type: 'running', message: 'Submitting request to Fal...' })

  try {
    const requestPayload = {
      prompt,
      num_images: numImages,
      resolution,
      output_format: outputFormat,
      sync_mode: syncMode,
      aspect_ratio: aspectRatio
    }

    let stepCount = 0
    const expectedMs = Math.min(120000, Math.max(15000, numImages * 8000))
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing images...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe('fal-ai/nano-banana-pro', {
      input: requestPayload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        if (status.status === 'IN_QUEUE') {
          const r = strategy.onQueue()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount++
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as NanoBananaProTextToImageResponse

    const images = result.data?.images ?? result.images ?? []
    if (!images.length) {
      throw new Error('No images were returned by the Nano Banana Pro API')
    }

    const uploadedUris: string[] = []
    for (const image of images) {
      if (!image.url) {
        continue
      }

      const response = await fetch(image.url)
      const contentType = response.headers.get('content-type') ?? image.content_type
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const filename = generateAssetFilename(image.url, contentType, 'image')
      const uploadResult = await uploadAsset(buffer, { type: 'image', filename })

      if (!uploadResult.uri) {
        throw new Error('Failed to upload generated image')
      }

      uploadedUris.push(uploadResult.uri)
    }

    if (!uploadedUris.length) {
      throw new Error('Generated images could not be retrieved')
    }

    const description = result.data?.description ?? result.description ?? ''

    return {
      images: uploadedUris,
      description: description ? [description] : []
    }
  } catch (error: any) {
    const message = error?.message ?? 'Failed to generate images'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default nanoBananaProTextToImageNode

