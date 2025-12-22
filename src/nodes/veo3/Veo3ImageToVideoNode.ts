import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { uploadBufferToFal } from '../../utils/fal-storage.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface Veo3ImageToVideoResponse {
  data?: {
    video?: {
      url?: string
    }
  }
}

const ASPECT_RATIOS = ['auto', '16:9', '9:16'] as const
const RESOLUTIONS = ['720p', '1080p'] as const
const DURATIONS = ['8s'] as const

const ensureOption = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => {
  if (typeof value === 'string' && options.includes(value as T)) {
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

const uploadBufferAsImageUrl = async (buffer: Buffer, filenamePrefix: string): Promise<string> => {
  const format = detectImageMime(buffer)
  return uploadBufferToFal(buffer, format, { filenamePrefix })
}

const nodeDefinition: NodeDefinition = {
  uid: 'fal-veo3-image-to-video',
  name: 'Veo 3 Image to Video',
  category: 'Veo / Veo 3',
  version: '1.0.0',
  type: 'server',
  description: 'Animates input images into videos using Fal.ai Veo 3 models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing how the image should be animated'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image asset URI (720p or higher recommended)'
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
      description: 'Choose Standard for highest fidelity or Fast for quicker renders',
      options: [
        { label: 'Standard (highest fidelity)', value: 'standard' },
        { label: 'Fast (quicker results)', value: 'fast' }
      ]
    },
    {
      name: 'aspect_ratio',
      type: 'select',
      value: 'auto',
      default: 'auto',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated animation',
      options: [
        { label: 'Auto (match input)', value: 'auto' },
        { label: '16:9 - Widescreen', value: '16:9' },
        { label: '9:16 - Vertical', value: '9:16' }
      ]
    },
    {
      name: 'resolution',
      type: 'select',
      value: '720p',
      default: '720p',
      label: 'Resolution',
      description: 'Rendering resolution (1080p available in Standard variant)',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' }
      ]
    },
    {
      name: 'duration',
      type: 'select',
      value: '8s',
      default: '8s',
      label: 'Duration',
      description: 'Clip duration (currently fixed at 8 seconds)',
      options: [
        { label: '8 seconds', value: '8s' }
      ]
    },
    {
      name: 'generate_audio',
      type: 'boolean',
      value: true,
      default: true,
      label: 'Generate Audio',
      description: 'Include automatically generated audio narration in the output'
    }
  ]
}

const veo3ImageToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

veo3ImageToVideoNode.execute = async ({ inputs, parameters, context }) => {
  configureFalClient()

  const prompt = inputs.prompt?.[0] as string
  const imageUri = inputs.image?.[0] as string

  if (!prompt) {
    context.sendStatus({ type: 'error', message: 'Prompt is required' })
    throw new Error('Prompt is required')
  }

  if (!imageUri) {
    context.sendStatus({ type: 'error', message: 'Input image is required' })
    throw new Error('Input image is required')
  }

  const modelVariantRaw = getParameterValue<string>(parameters, 'model_variant', 'standard')
  const modelVariant = modelVariantRaw === 'fast' ? 'fast' : 'standard'

  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', 'auto')
  const resolutionValue = getParameterValue<string>(parameters, 'resolution', '720p')
  const durationValue = getParameterValue<string>(parameters, 'duration', '8s')
  const generateAudioValue = getParameterValue<boolean>(parameters, 'generate_audio', true)

  const aspect_ratio = ensureOption(aspectRatioValue, ASPECT_RATIOS, 'auto')
  const resolution = ensureOption(resolutionValue, RESOLUTIONS, '720p')
  const duration = ensureOption(durationValue, DURATIONS, '8s')
  const generate_audio = Boolean(generateAudioValue)

  context.sendStatus({ type: 'running', message: 'Preparing image for Veo 3 animation...' })

  const imageBuffer = await resolveAsset(imageUri, { asBuffer: true }) as Buffer
  const imageUrl = await uploadBufferAsImageUrl(imageBuffer, 'veo3-source')

  const endpoint = modelVariant === 'fast'
    ? 'fal-ai/veo3/fast/image-to-video'
    : 'fal-ai/veo3/image-to-video'

  const payload = {
    prompt,
    image_url: imageUrl,
    aspect_ratio,
    resolution,
    duration,
    generate_audio
  }

  try {
    let stepCount = 0
    let expectedMs = modelVariant === 'fast' ? 60000 : 120000
    if (resolution === '1080p') expectedMs += 30000
    if (generate_audio) expectedMs += 5000
    const strategy = createProgressStrategy({
      expectedMs,
      inQueueMessage: 'Waiting in queue...',
      finalizingMessage: 'Finalizing video...',
      defaultInProgressMessage: (n) => `Animating frame ${n}...`
    })
    const result = await fal.subscribe(endpoint, {
      input: payload,
      logs: true,
      onQueueUpdate: (status: QueueStatus) => {
        try {
          console.log('[Veo3ImageToVideo] Queue update:', JSON.stringify(status))
        } catch { }
        if (status.status === 'IN_QUEUE') {
          context.sendStatus({
            type: 'running',
            message: 'Waiting in queue...',
            progress: { step: 5, total: 100 }
          })
        } else if (status.status === 'IN_PROGRESS') {
          stepCount += 1
          const r = strategy.onProgress(status, stepCount)
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        } else if (status.status === 'COMPLETED') {
          const r = strategy.onCompleted()
          context.sendStatus({ type: 'running', message: r.message, progress: r.progress })
        }
      }
    }) as Veo3ImageToVideoResponse

    const videoUrl = result.data?.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Veo 3')
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
    const message = error?.message || 'Failed to animate image'
    context.sendStatus({ type: 'error', message })
    throw error
  }
}

export default veo3ImageToVideoNode
