import { NanoSDK, NodeDefinition, NodeInstance, resolveAsset, uploadAsset } from '@nanograph/sdk'
import { QueueStatus } from '@fal-ai/client'
import { configureFalClient, fal } from '../../utils/fal-client.js'
import { getParameterValue } from '../../utils/parameter-utils.js'
import { createProgressStrategy } from '../../utils/progress-strategy.js'
import { ensureOption, uploadBufferAsImageUrl } from './utils.js'
import { generateVideoFilename } from '../../utils/asset-utils.js'

interface Veo31ImageToVideoResponse {
  data?: {
    video?: {
      url?: string
    }
  }
}

const ASPECT_RATIOS = ['16:9', '9:16'] as const
const RESOLUTIONS = ['720p', '1080p'] as const
const DURATIONS = ['8s'] as const

const nodeDefinition: NodeDefinition = {
  uid: 'fal-veo31-image-to-video',
  name: 'Veo 3.1 Image to Video',
  category: 'Video Generation',
  version: '1.0.0',
  type: 'server',
  description: 'Animates input images into videos using Fal.ai Veo 3.1 models',
  inputs: [
    {
      name: 'prompt',
      type: 'string',
      description: 'Text prompt describing how the image should be animated'
    },
    {
      name: 'image',
      type: 'asset:image',
      description: 'Input image asset URI (16:9 or 9:16 aspect ratio recommended)'
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
      value: '16:9',
      default: '16:9',
      label: 'Aspect Ratio',
      description: 'Aspect ratio of the generated animation (image is cropped if needed)',
      options: [
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
      description: 'Rendering resolution',
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

const veo31ImageToVideoNode: NodeInstance = NanoSDK.registerNode(nodeDefinition)

veo31ImageToVideoNode.execute = async ({ inputs, parameters, context }) => {
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

  const aspectRatioValue = getParameterValue<string>(parameters, 'aspect_ratio', '16:9')
  const resolutionValue = getParameterValue<string>(parameters, 'resolution', '720p')
  const durationValue = getParameterValue<string>(parameters, 'duration', '8s')
  const generateAudioValue = getParameterValue<boolean>(parameters, 'generate_audio', true)

  const aspect_ratio = ensureOption(aspectRatioValue, ASPECT_RATIOS, '16:9')
  const resolution = ensureOption(resolutionValue, RESOLUTIONS, '720p')
  const duration = ensureOption(durationValue, DURATIONS, '8s')
  const generate_audio = Boolean(generateAudioValue)

  context.sendStatus({ type: 'running', message: 'Uploading image for Veo 3.1 animation...' })

  const imageBuffer = await resolveAsset(imageUri, { asBuffer: true }) as Buffer
  const imageUrl = await uploadBufferAsImageUrl(imageBuffer, 'veo31-source')

  const endpoint = modelVariant === 'fast'
    ? 'fal-ai/veo3.1/fast/image-to-video'
    : 'fal-ai/veo3.1/image-to-video'

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
          console.log('[Veo31ImageToVideo] Queue update:', JSON.stringify(status))
        } catch {}

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
    }) as Veo31ImageToVideoResponse

    const videoUrl = result.data?.video?.url

    if (!videoUrl) {
      throw new Error('No video was generated by Veo 3.1')
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

export default veo31ImageToVideoNode
