import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface Sora2VideoResponse {
  video?: {
    url?: string
    content_type?: string
    file_size?: number
    duration?: number
    height?: number
    width?: number
    fps?: number
    num_frames?: number
  }
}

const ASPECT_RATIOS = ['auto', '16:9', '9:16'] as const
const DURATIONS = ['4', '8', '12'] as const
const RESOLUTIONS_STANDARD = ['auto', '720p'] as const
const RESOLUTIONS_PRO = ['auto', '720p', '1080p'] as const

const ensureOption = <T extends string | number>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === typeof fallback && options.includes(value as T)) {
    return value as T
  }
  return fallback
}

const detectImageMime = (buffer: Buffer): string => {
  const signature = buffer.slice(0, 12)

  if (signature.slice(0, 4).toString('hex') === '89504e47') {
    return 'png'
  }

  if (signature.slice(0, 3).toString('hex') === 'ffd8ff') {
    return 'jpeg'
  }

  if (signature.slice(0, 4).toString('hex') === '47494638') {
    return 'gif'
  }

  if (signature.slice(0, 4).toString('hex') === '424d') {
    return 'bmp'
  }

  if (
    signature.slice(0, 4).toString('ascii') === 'RIFF' &&
    signature.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }

  return 'jpeg'
}

const bufferToDataUrl = (buffer: Buffer): string => {
  const format = detectImageMime(buffer)
  const base64 = buffer.toString('base64')
  return `data:image/${format};base64,${base64}`
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-sora-2-image-to-video',
  name: 'Sora 2 Image to Video',
  category: 'Sora / Sora 2',
  version: '1.0.0',
  type: 'server',
  description: 'Animates images into videos using Fal.ai Sora 2 models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing the video to generate'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image as asset URI'
    }
  ],
  outputs: [
    {
      name: 'video',
      type: 'asset:video',
      description: 'Generated video as asset URI'
    }
  ],
  parameters: [
    {
      name: 'model_variant',
      type: 'select',
      value: 'standard',
      default: 'standard',
      label: 'Model Variant',
      description: 'Choose Standard for faster results or Pro for higher fidelity',
      options: [
        { label: 'Standard (faster)', value: 'standard' },
        { label: 'Pro (higher quality)', value: 'pro' }
      ]
    },
    {
      name: 'resolution',
      type: 'select',
      value: 'auto',
      default: 'auto',
      label: 'Resolution',
      description: 'Resolution of the generated video (1080p available in Pro variant)',
      options: [
        { label: 'Auto (match input)', value: 'auto' },
        { label: '720p', value: '720p' },
        { label: '1080p (Pro only)', value: '1080p' }
      ]
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: 'auto',
      default: 'auto',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated video',
      options: [
        { label: 'Auto (match input)', value: 'auto' },
        { label: '16:9 - Widescreen', value: '16:9' },
        { label: '9:16 - Vertical', value: '9:16' }
      ]
    },
    {
      name: 'duration',
      type: 'select',
      value: '4',
      default: '4',
      label: 'Duration (seconds)',
      description: 'Duration of the generated video in seconds',
      options: [
        { label: '4 seconds', value: '4' },
        { label: '8 seconds', value: '8' },
        { label: '12 seconds', value: '12' }
      ]
    },
    {
      name: 'api_key',
      type: 'text',
      value: '',
      default: '',
      label: 'OpenAI API Key',
      description: 'Optional OpenAI API key to avoid billing for this request'
    }
  ]
}

const sora2ImageToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

sora2ImageToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const image = inputs.image?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!image) {
    context.sendStatus({ type: 'error', message: 'Input image is required' })
    throw new Error('Input image is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'standard')
  const modelVariant = modelVariantRaw === 'pro' ? 'pro' : 'standard'

  const resolutionValue = getParameterValue<string>(parameters, 'resolution', 'auto')
  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', 'auto')
  const durationValue = getParameterValue<string>(parameters, 'duration', '4')
  const apiKeyValue = getParameterValue<string>(parameters, 'api_key', '')

  const resolution = modelVariant === 'pro'
    ? ensureOption(resolutionValue, RESOLUTIONS_PRO, 'auto')
    : ensureOption(resolutionValue, RESOLUTIONS_STANDARD, 'auto')

  // Validate resolution for model variant
  if (modelVariant === 'standard' && resolution === '1080p') {
    context.sendStatus({ type: 'error', message: '1080p resolution is only available in Pro variant' })
    throw new Error('1080p resolution is only available in Pro variant')
  }
  const aspect_ratio = ensureOption(aspectRatioValue, ASPECT_RATIOS, 'auto')
  const duration = ensureOption(durationValue, DURATIONS, '4')

  context.sendStatus({ type: 'running', message: 'Preparing Sora 2 request...' })

  try {
    const imageBuffer: Buffer = await resolveAsset(image, { asBuffer: true }) as Buffer
    console.log(`[Sora2ImageToVideo] Image buffer size: ${imageBuffer.length} bytes`)

    const format = detectImageMime(imageBuffer)
    console.log(`[Sora2ImageToVideo] Detected image format: ${format}`)

    const blob = new Blob([new Uint8Array(imageBuffer)], { type: `image/${format}` })
    console.log(`[Sora2ImageToVideo] Created blob, size: ${blob.size} bytes, type: ${blob.type}`)

    console.log(`[Sora2ImageToVideo] Calling fal.storage.upload...`)
    const imageUrl = await fal.storage.upload(blob) as string
    console.log(`[Sora2ImageToVideo] Storage upload result: ${imageUrl}`)

    if (!imageUrl) {
      throw new Error('Fal storage upload did not return a URL')
    }

    const endpoint = modelVariant === 'pro'
      ? 'fal-ai/sora-2/image-to-video/pro'
      : 'fal-ai/sora-2/image-to-video'

    const payload: any = {
      prompt,
      image_url: imageUrl,
      resolution,
      aspect_ratio,
      duration: Number(duration)
    }

    if (apiKeyValue && apiKeyValue.trim().length > 0) {
      payload.api_key = apiKeyValue.trim()
    }

    console.log(`[Sora2ImageToVideo] Payload to ${endpoint}:`, JSON.stringify(payload, null, 2))

    let stepCount = 0
    const expectedMs = duration === '12' ? 180000 : duration === '8' ? 120000 : 90000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing video...',
      defaultInProgressMessage: (n) => `Processing step ${n}...`
    })

    const result = await fal.subscribe(endpoint, {
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        try {
          console.log(`[Sora2ImageToVideo] Queue update:`, JSON.stringify(status, null, 2))
        } catch { }
        if (status.status === 'IN_QUEUE') {
          const r = strategy.onQueue()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount += 1
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as Sora2VideoResponse

    console.log(`[Sora2ImageToVideo] Final response:`, JSON.stringify(result, null, 2))

    const videoUrl = result.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Sora 2')
    }

    const response = await fetch(videoUrl)
    const contentType = response.headers.get('content-type')
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const filename = generateVideoFilename(videoUrl, contentType)

    const uploadResult = await uploadAsset(buffer, { type: 'video', filename })

    if (!uploadResult?.uri) {
      throw new Error('Failed to upload generated video')
    }

    return {
      video: [uploadResult.uri]
    }
  } catch (error: any) {
    console.log(`[Sora2ImageToVideo] Error details:`, JSON.stringify(error, null, 2))

    let message = error?.message || 'Failed to animate image with Sora 2'

    // Extract detailed error message from Fal API response
    if (error?.body?.detail && Array.isArray(error.body.detail)) {
      const errorDetails = error.body.detail.map((detail: any) => detail.msg).join('; ')
      message = errorDetails
    }

    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default sora2ImageToVideoNode
